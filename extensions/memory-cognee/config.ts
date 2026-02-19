export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type CogneeConfig = {
  // Cognee connection
  cogneeUrl: string;

  // Data directory for Cognee
  dataDir: string;

  // Behavior
  autoRecall: boolean;
  autoCapture: boolean;
  autoCognify: boolean;

  // Search settings
  searchLimit: number;
  searchMinScore: number;

  // Graph traversal depth for context retrieval
  graphDepth: number;

  // Capture settings
  captureMaxChars: number;

  // Conversation ingestion settings
  ingestConversation: boolean;
  ingestUserMessages: boolean;
  ingestAssistantMessages: boolean;
  ingestMinLength: number;
  ingestBatchSize: number;
  cognifyAfterMessages: number;
  conversationSummary: boolean;

  // Memory Policy settings
  memoryPolicy: boolean;
  minDurabilityScore: number;
  recurrenceFilter: boolean;
  recurrenceMinMentions: number;
  llmDurabilityCheck: boolean;
  logPolicyDecisions: boolean;
};

export const DEFAULT_CAPTURE_MAX_CHARS = 500;

const DEFAULTS: CogneeConfig = {
  cogneeUrl: "http://localhost:8000",
  dataDir: "~/.openclaw/memory/cognee",
  autoRecall: true,
  autoCapture: true,
  autoCognify: true,
  searchLimit: 5,
  searchMinScore: 0.3,
  graphDepth: 2,
  captureMaxChars: 2000,
  ingestConversation: true,
  ingestUserMessages: true,
  ingestAssistantMessages: true,
  ingestMinLength: 20,
  ingestBatchSize: 10,
  cognifyAfterMessages: 5,
  conversationSummary: false,
  memoryPolicy: true,
  minDurabilityScore: 0.4,
  recurrenceFilter: false,
  recurrenceMinMentions: 2,
  llmDurabilityCheck: false,
  logPolicyDecisions: false,
};

export const cogneeConfigSchema = {
  parse(value: unknown): CogneeConfig {
    const cfg = (value && typeof value === "object" && !Array.isArray(value))
      ? (value as Record<string, unknown>)
      : {};

    return {
      cogneeUrl: typeof cfg.cogneeUrl === "string" ? cfg.cogneeUrl : DEFAULTS.cogneeUrl,
      dataDir: typeof cfg.dataDir === "string" ? cfg.dataDir : DEFAULTS.dataDir,
      autoRecall: typeof cfg.autoRecall === "boolean" ? cfg.autoRecall : DEFAULTS.autoRecall,
      autoCapture: typeof cfg.autoCapture === "boolean" ? cfg.autoCapture : DEFAULTS.autoCapture,
      autoCognify: typeof cfg.autoCognify === "boolean" ? cfg.autoCognify : DEFAULTS.autoCognify,
      searchLimit: typeof cfg.searchLimit === "number" ? cfg.searchLimit : DEFAULTS.searchLimit,
      searchMinScore: typeof cfg.searchMinScore === "number" ? cfg.searchMinScore : DEFAULTS.searchMinScore,
      graphDepth: typeof cfg.graphDepth === "number" ? cfg.graphDepth : DEFAULTS.graphDepth,
      captureMaxChars: typeof cfg.captureMaxChars === "number" ? cfg.captureMaxChars : DEFAULTS.captureMaxChars,
      ingestConversation: typeof cfg.ingestConversation === "boolean" ? cfg.ingestConversation : DEFAULTS.ingestConversation,
      ingestUserMessages: typeof cfg.ingestUserMessages === "boolean" ? cfg.ingestUserMessages : DEFAULTS.ingestUserMessages,
      ingestAssistantMessages: typeof cfg.ingestAssistantMessages === "boolean" ? cfg.ingestAssistantMessages : DEFAULTS.ingestAssistantMessages,
      ingestMinLength: typeof cfg.ingestMinLength === "number" ? cfg.ingestMinLength : DEFAULTS.ingestMinLength,
      ingestBatchSize: typeof cfg.ingestBatchSize === "number" ? cfg.ingestBatchSize : DEFAULTS.ingestBatchSize,
      cognifyAfterMessages: typeof cfg.cognifyAfterMessages === "number" ? cfg.cognifyAfterMessages : DEFAULTS.cognifyAfterMessages,
      conversationSummary: typeof cfg.conversationSummary === "boolean" ? cfg.conversationSummary : DEFAULTS.conversationSummary,
      memoryPolicy: typeof cfg.memoryPolicy === "boolean" ? cfg.memoryPolicy : DEFAULTS.memoryPolicy,
      minDurabilityScore: typeof cfg.minDurabilityScore === "number" ? cfg.minDurabilityScore : DEFAULTS.minDurabilityScore,
      recurrenceFilter: typeof cfg.recurrenceFilter === "boolean" ? cfg.recurrenceFilter : DEFAULTS.recurrenceFilter,
      recurrenceMinMentions: typeof cfg.recurrenceMinMentions === "number" ? cfg.recurrenceMinMentions : DEFAULTS.recurrenceMinMentions,
      llmDurabilityCheck: typeof cfg.llmDurabilityCheck === "boolean" ? cfg.llmDurabilityCheck : DEFAULTS.llmDurabilityCheck,
      logPolicyDecisions: typeof cfg.logPolicyDecisions === "boolean" ? cfg.logPolicyDecisions : DEFAULTS.logPolicyDecisions,
    };
  },
  uiHints: {
    cogneeUrl: {
      label: "Cognee Bridge URL",
      placeholder: "http://localhost:8000",
      help: "URL of the Cognee bridge server",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoCognify: {
      label: "Auto-Cognify",
      help: "Automatically build knowledge graph after capturing content",
    },
    memoryPolicy: {
      label: "Memory Policy",
      help: "Filter ephemeral vs durable content before storing",
    },
    minDurabilityScore: {
      label: "Min Durability Score",
      help: "Minimum score (0-1) for content to be persisted",
      advanced: true,
    },
    logPolicyDecisions: {
      label: "Log Policy Decisions",
      help: "Log all memory policy decisions for debugging",
      advanced: true,
    },
  },
};
