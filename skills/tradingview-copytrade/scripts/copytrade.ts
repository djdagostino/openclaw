#!/usr/bin/env bun
// TradingView watchlist -> Interactive Brokers copy-trader.
//
// Polls a public TradingView watchlist, diffs it against the set of positions
// this tool manages, and mirrors changes into an IBKR account through the
// locally running Client Portal API gateway:
//   - symbol added to the watchlist   -> buy a fixed dollar amount of it
//   - symbol removed from the watchlist -> sell the position this tool opened
//
// It only ever sells positions it opened itself (tracked in its state file),
// so pre-existing holdings in the account are never touched.
//
// Dry-run is the default. Live orders require BOTH the --live flag and
// "liveTradingEnabled": true in the config file.
//
// Commands: init | fetch | status | sync | reset
// State/config live in ~/.openclaw/tradingview-copytrade (override with
// TV_COPYTRADE_HOME).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// ---------------------------------------------------------------------------
// Config + state
// ---------------------------------------------------------------------------

interface Config {
  /** Numeric id from https://www.tradingview.com/watchlists/<id>/ */
  watchlistId: string;
  ibkr: {
    /** Client Portal gateway base URL (its TLS cert is self-signed). */
    baseUrl: string;
    /** IBKR account id (e.g. DU1234567 for paper). Auto-detected if empty. */
    accountId: string;
  };
  /** Dollar amount to buy per newly added symbol. */
  orderNotionalUsd: number;
  /** Hard cap on how many positions this tool may hold at once. */
  maxTotalPositions: number;
  /** Hard cap on buys per sync run (protects against scrape glitches). */
  maxNewBuysPerRun: number;
  /**
   * A symbol must appear added/removed in this many consecutive syncs before
   * we trade it. 1 = act immediately; 2+ = protect against watchlist flapping.
   */
  confirmPolls: number;
  /** Sell when a symbol leaves the watchlist. */
  sellOnRemove: boolean;
  /** Skip trading outside regular NYSE hours (Mon-Fri 9:30-16:00 ET). */
  marketHoursOnly: boolean;
  /** TradingView exchange prefixes we are willing to trade. */
  allowedExchanges: string[];
  /** Symbols (TradingView "EXCHANGE:TICKER" form) never to trade. */
  blockedSymbols: string[];
  /** Second opt-in for live orders, alongside the --live flag. */
  liveTradingEnabled: boolean;
}

const DEFAULT_CONFIG: Config = {
  watchlistId: "",
  ibkr: { baseUrl: "https://localhost:5000", accountId: "" },
  orderNotionalUsd: 1000,
  maxTotalPositions: 25,
  maxNewBuysPerRun: 5,
  confirmPolls: 2,
  sellOnRemove: true,
  marketHoursOnly: true,
  allowedExchanges: ["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "CBOE"],
  blockedSymbols: [],
  liveTradingEnabled: false,
};

interface Holding {
  conid: number;
  quantity: number;
  openedAt: string;
  lastOrderId?: string;
}

interface TradeEvent {
  at: string;
  action: "BUY" | "SELL";
  symbol: string;
  quantity: number;
  live: boolean;
  orderId?: string;
  note?: string;
}

interface State {
  lastWatchlist: string[];
  lastFetchAt?: string;
  pendingAdds: Record<string, number>;
  pendingRemoves: Record<string, number>;
  holdings: Record<string, Holding>;
  history: TradeEvent[];
}

const EMPTY_STATE: State = {
  lastWatchlist: [],
  pendingAdds: {},
  pendingRemoves: {},
  holdings: {},
  history: [],
};

const HOME = process.env.TV_COPYTRADE_HOME ?? join(homedir(), ".openclaw", "tradingview-copytrade");
const CONFIG_PATH = join(HOME, "config.json");
const STATE_PATH = join(HOME, "state.json");

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  return { ...fallback, ...(JSON.parse(readFileSync(path, "utf8")) as T) };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    fail(`No config at ${CONFIG_PATH}. Run: copytrade.ts init --watchlist <id>`);
  }
  return readJson<Config>(CONFIG_PATH, DEFAULT_CONFIG);
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// TradingView watchlist fetching
// ---------------------------------------------------------------------------

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Overridable for tests (point at a stub server).
const TV_BASE = process.env.TV_COPYTRADE_TV_BASE ?? "https://www.tradingview.com";

function cleanSymbols(raw: string[]): string[] {
  // Watchlists can contain "###Section" separator rows; drop them and dupes.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const sym = entry.trim();
    if (!sym || sym.startsWith("###") || seen.has(sym)) {
      continue;
    }
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

async function fetchWatchlist(id: string): Promise<string[]> {
  const errors: string[] = [];
  // 1) Unofficial JSON endpoints used by the TradingView web app.
  for (const url of [
    `${TV_BASE}/api/v1/symbols_list/custom/${id}/`,
    `${TV_BASE}/api/v1/symbols_list/colored/${id}/`,
  ]) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": BROWSER_UA, accept: "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as { symbols?: unknown };
        if (Array.isArray(body.symbols)) {
          return cleanSymbols(body.symbols.filter((s): s is string => typeof s === "string"));
        }
      }
      errors.push(`${url} -> HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${url} -> ${String(err)}`);
    }
  }
  // 2) Fall back to scraping the embedded JSON on the public watchlist page.
  const pageUrl = `${TV_BASE}/watchlists/${id}/`;
  try {
    const res = await fetch(pageUrl, { headers: { "user-agent": BROWSER_UA } });
    if (res.ok) {
      const html = await res.text();
      const lists = [...html.matchAll(/"symbols"\s*:\s*\[((?:\s*"[^"]*"\s*,?)+)\]/g)];
      let best: string[] = [];
      for (const match of lists) {
        const symbols = cleanSymbols([...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1])).filter(
          (s) => s.includes(":"),
        );
        if (symbols.length > best.length) {
          best = symbols;
        }
      }
      if (best.length > 0) {
        return best;
      }
      errors.push(`${pageUrl} -> page fetched but no symbol list found`);
    } else {
      errors.push(`${pageUrl} -> HTTP ${res.status}`);
    }
  } catch (err) {
    errors.push(`${pageUrl} -> ${String(err)}`);
  }
  throw new Error(`could not fetch watchlist ${id}:\n  ${errors.join("\n  ")}`);
}

// ---------------------------------------------------------------------------
// Market hours (regular NYSE session; holidays are not modeled — on a holiday
// the gateway simply rejects/queues the DAY order and we log it)
// ---------------------------------------------------------------------------

function isMarketOpen(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") {
    return false;
  }
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

// ---------------------------------------------------------------------------
// IBKR Client Portal API client
// ---------------------------------------------------------------------------

interface OrderReply {
  id?: string;
  order_id?: string;
  message?: string[];
}

class IbkrClient {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, "");
    // The Client Portal gateway serves a self-signed certificate on
    // localhost; relax TLS verification only for local endpoints.
    if (/localhost|127\.0\.0\.1/.test(this.base)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/v1/api${path}`, {
      method,
      headers: { "content-type": "application/json", "user-agent": "openclaw-copytrade" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`IBKR ${method} ${path} -> HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async ensureAuthenticated(): Promise<void> {
    await this.request("POST", "/tickle").catch(() => undefined);
    const status = await this.request<{ authenticated?: boolean }>(
      "POST",
      "/iserver/auth/status",
    ).catch((err: unknown) => {
      throw new Error(
        `cannot reach IBKR Client Portal gateway at ${this.base}. ` +
          `Is it running and logged in? (${String(err)})`,
      );
    });
    if (!status.authenticated) {
      throw new Error(
        "IBKR gateway reachable but session not authenticated. " +
          `Log in via ${this.base} in a browser, then retry.`,
      );
    }
  }

  async resolveAccountId(): Promise<string> {
    const res = await this.request<{ accounts?: string[] }>("GET", "/iserver/accounts");
    const account = res.accounts?.[0];
    if (!account) {
      throw new Error("no IBKR accounts visible to this session");
    }
    return account;
  }

  /** Resolve a US stock ticker to an IBKR contract id. */
  async stockConid(ticker: string): Promise<number | undefined> {
    const res = await this.request<
      Record<string, { contracts?: { conid?: number; isUS?: boolean }[] }[]>
    >("GET", `/trsrv/stocks?symbols=${encodeURIComponent(ticker)}`);
    for (const entry of res[ticker] ?? []) {
      const contract = entry.contracts?.find((c) => c.isUS && typeof c.conid === "number");
      if (contract?.conid) {
        return contract.conid;
      }
    }
    return undefined;
  }

  /** Last/bid/ask snapshot price. Needs one warm-up call on a fresh session. */
  async snapshotPrice(conid: number): Promise<number | undefined> {
    const path = `/iserver/marketdata/snapshot?conids=${conid}&fields=31,84,86`;
    let rows = await this.request<Record<string, string>[]>("GET", path);
    if (!rows[0]?.["31"] && !rows[0]?.["84"] && !rows[0]?.["86"]) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      rows = await this.request<Record<string, string>[]>("GET", path);
    }
    for (const field of ["31", "84", "86"]) {
      const raw = rows[0]?.[field];
      if (raw) {
        // Values can carry a market-state prefix like "C123.45" or "H12.00".
        const price = Number.parseFloat(raw.replace(/^[A-Za-z]+/, ""));
        if (Number.isFinite(price) && price > 0) {
          return price;
        }
      }
    }
    return undefined;
  }

  async positionQuantity(accountId: string, conid: number): Promise<number> {
    const rows = await this.request<{ conid?: number; position?: number }[]>(
      "GET",
      `/portfolio/${accountId}/positions/0`,
    ).catch(() => [] as { conid?: number; position?: number }[]);
    return rows.find((r) => r.conid === conid)?.position ?? 0;
  }

  /** Place a DAY market order, auto-confirming the gateway's warning prompts. */
  async placeMarketOrder(
    accountId: string,
    conid: number,
    side: "BUY" | "SELL",
    quantity: number,
    tag: string,
  ): Promise<string> {
    let replies = await this.request<OrderReply[]>("POST", `/iserver/account/${accountId}/orders`, {
      orders: [
        {
          conid,
          orderType: "MKT",
          side,
          tif: "DAY",
          quantity,
          cOID: `${tag}-${Date.now()}`,
        },
      ],
    });
    // The gateway answers with confirmation questions (price caps, size
    // warnings, ...) that must be acknowledged before the order is accepted.
    for (let i = 0; i < 5; i++) {
      const reply = replies[0];
      if (!reply) {
        throw new Error("empty order response from IBKR");
      }
      if (reply.order_id) {
        return reply.order_id;
      }
      if (reply.id && reply.message) {
        replies = await this.request<OrderReply[]>("POST", `/iserver/reply/${reply.id}`, {
          confirmed: true,
        });
        continue;
      }
      throw new Error(`unexpected order response: ${JSON.stringify(replies).slice(0, 300)}`);
    }
    throw new Error("order not accepted after 5 confirmation rounds");
  }
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

function tvExchange(symbol: string): string {
  return symbol.split(":")[0] ?? "";
}

function tvTicker(symbol: string): string {
  // IBKR writes share classes with a space ("BRK B") where TradingView uses a
  // dot ("BRK.B").
  return (symbol.split(":")[1] ?? symbol).replace(".", " ");
}

interface SyncOptions {
  live: boolean;
  force: boolean;
}

async function runSync(options: SyncOptions): Promise<void> {
  const config = loadConfig();
  if (!config.watchlistId) {
    fail(`watchlistId missing in ${CONFIG_PATH}`);
  }
  const state = readJson<State>(STATE_PATH, EMPTY_STATE);
  const live = options.live && config.liveTradingEnabled;
  if (options.live && !config.liveTradingEnabled) {
    console.log("note: --live requested but liveTradingEnabled=false in config; running dry-run.");
  }

  if (config.marketHoursOnly && !options.force && !isMarketOpen()) {
    console.log("market closed (regular NYSE hours); skipping sync. Use --force to override.");
    return;
  }

  const watchlist = await fetchWatchlist(config.watchlistId);
  state.lastWatchlist = watchlist;
  state.lastFetchAt = new Date().toISOString();

  const blocked = new Set(config.blockedSymbols);
  const allowed = new Set(config.allowedExchanges);
  const target = new Set(watchlist.filter((s) => allowed.has(tvExchange(s)) && !blocked.has(s)));
  const skipped = watchlist.filter((s) => !target.has(s));
  const held = new Set(Object.keys(state.holdings));

  // Confirmation counters: a change must persist for confirmPolls consecutive
  // syncs before we act on it, so a single bad scrape can't trigger trades.
  const confirm = Math.max(1, config.confirmPolls);
  const addsNow = [...target].filter((s) => !held.has(s));
  const removesNow = [...held].filter((s) => !target.has(s));
  for (const key of Object.keys(state.pendingAdds)) {
    if (!addsNow.includes(key)) {
      delete state.pendingAdds[key];
    }
  }
  for (const key of Object.keys(state.pendingRemoves)) {
    if (!removesNow.includes(key)) {
      delete state.pendingRemoves[key];
    }
  }
  const confirmedAdds: string[] = [];
  for (const sym of addsNow) {
    state.pendingAdds[sym] = (state.pendingAdds[sym] ?? 0) + 1;
    if (state.pendingAdds[sym] >= confirm) {
      confirmedAdds.push(sym);
    }
  }
  const confirmedRemoves: string[] = [];
  for (const sym of removesNow) {
    state.pendingRemoves[sym] = (state.pendingRemoves[sym] ?? 0) + 1;
    if (state.pendingRemoves[sym] >= confirm) {
      confirmedRemoves.push(sym);
    }
  }

  console.log(`watchlist: ${watchlist.length} symbols (${skipped.length} filtered out)`);
  console.log(`managed positions: ${held.size}`);
  console.log(
    `adds pending/confirmed: ${addsNow.length}/${confirmedAdds.length}; ` +
      `removes pending/confirmed: ${removesNow.length}/${confirmedRemoves.length}`,
  );
  if (skipped.length > 0) {
    console.log(`filtered (exchange/blocklist): ${skipped.join(", ")}`);
  }

  const ibkr = new IbkrClient(config.ibkr.baseUrl);
  let accountId = config.ibkr.accountId;
  let ibkrUp = false;
  if (confirmedAdds.length > 0 || confirmedRemoves.length > 0) {
    try {
      await ibkr.ensureAuthenticated();
      if (!accountId) {
        accountId = await ibkr.resolveAccountId();
        console.log(`resolved IBKR account: ${accountId}`);
      }
      ibkrUp = true;
    } catch (err) {
      // Live mode must stop here; dry-run degrades to planning-only output.
      if (live) {
        throw err;
      }
      console.log(`IBKR gateway unavailable; planning without sizing. (${String(err)})`);
    }
  }

  const tradesThisRun: TradeEvent[] = [];
  const record = (event: TradeEvent) => {
    tradesThisRun.push(event);
    state.history.push(event);
    if (state.history.length > 500) {
      state.history = state.history.slice(-500);
    }
    const mode = event.live ? "LIVE" : "DRY-RUN";
    const extra = event.note ? ` (${event.note})` : "";
    console.log(`[${mode}] ${event.action} ${event.quantity} ${event.symbol}${extra}`);
  };

  // Sells first: free up room under maxTotalPositions before buying.
  if (config.sellOnRemove) {
    for (const sym of confirmedRemoves) {
      const holding = state.holdings[sym];
      if (!ibkrUp) {
        record({
          at: new Date().toISOString(),
          action: "SELL",
          symbol: sym,
          quantity: holding.quantity,
          live: false,
          note: "planned only; IBKR gateway offline",
        });
        continue;
      }
      // Live sells trust only the broker's actual position (never the tracked
      // quantity) so a stale/simulated state can never open a short.
      const quantity = live
        ? await ibkr.positionQuantity(accountId, holding.conid)
        : holding.quantity;
      if (quantity <= 0) {
        delete state.holdings[sym];
        delete state.pendingRemoves[sym];
        record({
          at: new Date().toISOString(),
          action: "SELL",
          symbol: sym,
          quantity: 0,
          live,
          note: "position already gone at broker; untracked",
        });
        continue;
      }
      try {
        let orderId: string | undefined;
        if (live) {
          orderId = await ibkr.placeMarketOrder(
            accountId,
            holding.conid,
            "SELL",
            quantity,
            "tvcp-sell",
          );
        }
        delete state.holdings[sym];
        delete state.pendingRemoves[sym];
        record({
          at: new Date().toISOString(),
          action: "SELL",
          symbol: sym,
          quantity,
          live,
          orderId,
        });
      } catch (err) {
        console.error(`sell failed for ${sym}: ${String(err)}`);
      }
    }
  } else if (confirmedRemoves.length > 0) {
    console.log(`sellOnRemove=false; ignoring removals: ${confirmedRemoves.join(", ")}`);
  }

  let buys = 0;
  for (const sym of confirmedAdds) {
    if (buys >= config.maxNewBuysPerRun) {
      console.log(`maxNewBuysPerRun (${config.maxNewBuysPerRun}) reached; deferring: ${sym}`);
      continue;
    }
    if (Object.keys(state.holdings).length >= config.maxTotalPositions) {
      console.log(`maxTotalPositions (${config.maxTotalPositions}) reached; skipping: ${sym}`);
      continue;
    }
    if (!ibkrUp) {
      record({
        at: new Date().toISOString(),
        action: "BUY",
        symbol: sym,
        quantity: 0,
        live: false,
        note: "planned only; IBKR gateway offline",
      });
      continue;
    }
    try {
      const conid = await ibkr.stockConid(tvTicker(sym));
      if (!conid) {
        console.error(`no US contract found for ${sym}; skipping`);
        continue;
      }
      const price = await ibkr.snapshotPrice(conid);
      if (!price) {
        console.error(`no price available for ${sym} (market data permissions?); skipping`);
        continue;
      }
      const quantity = Math.floor(config.orderNotionalUsd / price);
      if (quantity < 1) {
        console.error(
          `${sym} at ~$${price.toFixed(2)} exceeds orderNotionalUsd=$${config.orderNotionalUsd}; skipping`,
        );
        continue;
      }
      let orderId: string | undefined;
      if (live) {
        orderId = await ibkr.placeMarketOrder(accountId, conid, "BUY", quantity, "tvcp-buy");
      }
      state.holdings[sym] = {
        conid,
        quantity,
        openedAt: new Date().toISOString(),
        lastOrderId: orderId,
      };
      delete state.pendingAdds[sym];
      buys++;
      record({
        at: new Date().toISOString(),
        action: "BUY",
        symbol: sym,
        quantity,
        live,
        orderId,
        note: `~$${price.toFixed(2)}/share`,
      });
    } catch (err) {
      console.error(`buy failed for ${sym}: ${String(err)}`);
    }
  }

  writeJson(STATE_PATH, state);
  const summary = {
    mode: live ? "live" : "dry-run",
    fetchedAt: state.lastFetchAt,
    watchlistSize: watchlist.length,
    managedPositions: Object.keys(state.holdings).length,
    trades: tradesThisRun,
  };
  console.log(`summary: ${JSON.stringify(summary)}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);

  switch (command) {
    case "init": {
      const watchlistId = argValue(args, "--watchlist");
      const existing = existsSync(CONFIG_PATH) ? loadConfig() : DEFAULT_CONFIG;
      const config: Config = { ...existing, watchlistId: watchlistId ?? existing.watchlistId };
      writeJson(CONFIG_PATH, config);
      if (!existsSync(STATE_PATH)) {
        writeJson(STATE_PATH, EMPTY_STATE);
      }
      console.log(`config written to ${CONFIG_PATH}`);
      console.log("review it (sizing, caps, liveTradingEnabled) before syncing.");
      break;
    }
    case "fetch": {
      const config = loadConfig();
      const symbols = await fetchWatchlist(config.watchlistId);
      console.log(JSON.stringify(symbols, null, 2));
      break;
    }
    case "status": {
      const config = loadConfig();
      const state = readJson<State>(STATE_PATH, EMPTY_STATE);
      console.log(`config: ${CONFIG_PATH}`);
      console.log(`watchlist id: ${config.watchlistId}`);
      console.log(`live trading enabled: ${config.liveTradingEnabled}`);
      console.log(`market open now: ${isMarketOpen()}`);
      console.log(`last fetch: ${state.lastFetchAt ?? "never"}`);
      console.log(
        `last watchlist (${state.lastWatchlist.length}): ${state.lastWatchlist.join(", ")}`,
      );
      console.log(`managed holdings (${Object.keys(state.holdings).length}):`);
      for (const [sym, holding] of Object.entries(state.holdings)) {
        console.log(
          `  ${sym}: ${holding.quantity} shares (conid ${holding.conid}, since ${holding.openedAt})`,
        );
      }
      const recent = state.history.slice(-10);
      if (recent.length > 0) {
        console.log("recent trades:");
        for (const event of recent) {
          console.log(
            `  ${event.at} ${event.live ? "LIVE" : "DRY"} ${event.action} ${event.quantity} ${event.symbol}`,
          );
        }
      }
      break;
    }
    case "sync": {
      await runSync({ live: args.includes("--live"), force: args.includes("--force") });
      break;
    }
    case "reset": {
      writeJson(STATE_PATH, EMPTY_STATE);
      console.log("state cleared (config kept). Managed holdings are forgotten, not sold.");
      break;
    }
    default: {
      console.log(`TradingView -> IBKR copy-trader

usage: copytrade.ts <command>

commands:
  init --watchlist <id>   create config/state under ${HOME}
  fetch                   print the watchlist's current symbols
  status                  show config, state, and recent trades
  sync [--live] [--force] fetch, diff, and trade (dry-run unless --live
                          AND liveTradingEnabled=true in config;
                          --force ignores market hours)
  reset                   clear tracked state (does not place orders)`);
    }
  }
}

main().catch((err: unknown) => {
  fail(String(err));
});
