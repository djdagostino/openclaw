import { z } from "zod";

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const cogneeConfigSchema = z.object({
  // Cognee connection
  cogneeUrl: z.string().url().default("http://localhost:8000"),

  // LLM provider for Cognee (used for entity extraction, graph building)
  llmProvider: z.enum(["openai", "anthropic", "ollama"]).default("openai"),
  llmApiKey: z.string().optional(),
  llmModel: z.string().default("gpt-4o-mini"),

  // Embedding provider
  embeddingProvider: z.enum(["openai", "ollama", "local"]).default("openai"),
  embeddingModel: z.string().default("text-embedding-3-small"),
  embeddingApiKey: z.string().optional(),

  // Graph database (Cognee supports multiple)
  graphStore: z.enum(["networkx", "neo4j", "falkordb"]).default("networkx"),
  neo4jUrl: z.string().optional(),
  neo4jUser: z.string().optional(),
  neo4jPassword: z.string().optional(),

  // Vector store
  vectorStore: z.enum(["lancedb", "qdrant", "weaviate", "pgvector"]).default("lancedb"),
  vectorUrl: z.string().optional(),

  // Data directory for Cognee
  dataDir: z.string().default("~/.openclaw/memory/cognee"),

  // Behavior
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  autoCognify: z.boolean().default(true), // Auto-build knowledge graph

  // Search settings
  searchLimit: z.number().min(1).max(20).default(5),
  searchMinScore: z.number().min(0).max(1).default(0.3),

  // Graph traversal depth for context retrieval
  graphDepth: z.number().min(1).max(5).default(2),

  // Capture settings
  captureMaxChars: z.number().default(2000),

  // Conversation ingestion settings
  ingestConversation: z.boolean().default(true), // Ingest full conversations
  ingestUserMessages: z.boolean().default(true), // Include user messages
  ingestAssistantMessages: z.boolean().default(true), // Include agent responses
  ingestMinLength: z.number().default(20), // Minimum message length to ingest
  ingestBatchSize: z.number().default(10), // Max messages per cognify batch
  cognifyAfterMessages: z.number().default(5), // Run cognify every N messages
  conversationSummary: z.boolean().default(false), // Generate conversation summary for ingestion

  // Memory Policy settings (determines what qualifies as durable knowledge)
  memoryPolicy: z.boolean().default(true), // Enable memory policy filtering
  minDurabilityScore: z.number().min(0).max(1).default(0.4), // Minimum score to persist (0-1)
  recurrenceFilter: z.boolean().default(false), // Require topic recurrence before persisting
  recurrenceMinMentions: z.number().default(2), // Number of mentions required
  llmDurabilityCheck: z.boolean().default(false), // Use LLM to evaluate durability (slower, more accurate)
  logPolicyDecisions: z.boolean().default(false), // Log all policy decisions for debugging
});

export type CogneeConfig = z.infer<typeof cogneeConfigSchema>;

export const DEFAULT_CAPTURE_MAX_CHARS = 500;
