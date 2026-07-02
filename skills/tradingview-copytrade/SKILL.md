---
name: tradingview-copytrade
description: Mirror a public TradingView watchlist into an Interactive Brokers account. Polls the watchlist, buys symbols when they are added, sells when they are removed, via the local IBKR Client Portal gateway. Trigger when asked to copy-trade a TradingView watchlist, sync/replicate someone's TradingView portfolio, or check the copy-trader's status.
metadata: { "openclaw": { "emoji": "📈", "requires": { "anyBins": ["bun", "node"] } } }
---

# TradingView -> IBKR copy-trader

## Overview

Follows a **public** TradingView watchlist (`https://www.tradingview.com/watchlists/<id>/`)
and mirrors it into an Interactive Brokers account:

- symbol **added** to the watchlist -> buy a fixed dollar amount (`orderNotionalUsd`)
- symbol **removed** -> sell the position this tool opened

It only manages positions it opened itself (tracked in its state file), so
pre-existing holdings in the account are never sold. Dry-run is the default;
live orders require **both** the `--live` flag and `"liveTradingEnabled": true`
in the config.

Run everything with `bun` (or `node --experimental-strip-types` on Node 22+):

```bash
bun {baseDir}/scripts/copytrade.ts <command>
```

## Requirements

- IBKR **Client Portal API gateway** running locally (default `https://localhost:5000`)
  and logged in via its browser page. Download: search "IBKR Client Portal API gateway".
  The session expires roughly daily and needs a re-login; `sync` reports when it does.
- The watchlist must be public (viewable in an incognito browser window).
- Strongly recommended: point it at an IBKR **paper trading** account first
  (`accountId` starting with `DU`).

## Setup

```bash
bun {baseDir}/scripts/copytrade.ts init --watchlist 326877343
# then review ~/.openclaw/tradingview-copytrade/config.json
bun {baseDir}/scripts/copytrade.ts fetch    # verify the watchlist is readable
bun {baseDir}/scripts/copytrade.ts sync     # dry-run a full cycle
```

Config knobs (`~/.openclaw/tradingview-copytrade/config.json`):

- `orderNotionalUsd` – dollars to buy per new symbol (default 1000)
- `maxTotalPositions`, `maxNewBuysPerRun` – hard caps
- `confirmPolls` – how many consecutive polls a change must persist before
  trading (default 2; protects against scrape glitches/flapping)
- `sellOnRemove`, `marketHoursOnly`, `allowedExchanges`, `blockedSymbols`
- `liveTradingEnabled` – must be flipped to `true` by the user, never by the agent
- `ibkr.baseUrl`, `ibkr.accountId` (auto-detected when empty)

## Commands

- `fetch` – print the watchlist's current symbols (JSON)
- `status` – config, managed holdings, recent trades, market-open flag
- `sync [--live] [--force]` – fetch, diff, trade; `--force` ignores market hours
- `reset` – forget tracked state (places no orders)

## Running 24/7

Schedule sync every 5 minutes during US market hours with the Gateway cron
scheduler (isolated session, announce results so trades reach your chat):

```bash
openclaw cron add \
  --name "TradingView copytrade sync" \
  --cron "*/5 9-16 * * 1-5" \
  --tz "America/New_York" \
  --session isolated \
  --message "Run the tradingview-copytrade skill: execute 'sync --live' and report any trades or errors. If the IBKR session is unauthenticated, tell me to re-login instead of retrying." \
  --announce
```

(The script itself also gates on market hours, so an over-broad schedule is
harmless. For a token-free alternative, use system cron on the script
directly: `*/5 * * * 1-5 bun <baseDir>/scripts/copytrade.ts sync --live`.)

## Agent guardrails

- Never set `liveTradingEnabled: true` yourself; only the user edits that.
- Dry-run simulates holdings in the state file. Before the user flips to live,
  run `reset` so simulated positions are not treated as real (live sells only
  ever use the broker's actual position, but stale state is still noise).
- If `sync` reports the IBKR gateway unreachable/unauthenticated, notify the
  user to restart/re-login the gateway — do not loop retries.
- Surface every LIVE trade line to the user when announcing cron results.

## Limitations (tell the user when relevant)

- A TradingView watchlist is a **symbol list**: it carries no position sizes,
  entry prices, or timing, so "copying" means equal-dollar buys on add and
  full exits on remove — not true trade replication.
- Polling means minutes of delay; fills use market orders, so slippage vs.
  the followed trader is expected.
- Watchlist scraping relies on TradingView's unofficial endpoints/page markup
  and may break or be against their ToS; `fetch` failing loudly is the signal.
- US market holidays are not modeled (orders on a holiday just won't fill;
  `marketHoursOnly` covers weekends/overnight).
- Not financial advice; blindly mirroring an unknown account is risky.
