/**
 * Memory Policy - Determines what qualifies as durable knowledge
 *
 * Not every conversation warrants persistence. This module evaluates:
 * - Relevance: Is this meaningful information?
 * - Recurrence: Has this topic come up before?
 * - Long-term utility: Will this be useful in the future?
 * - Graph relationship: Does this connect to existing knowledge?
 */

import type { CogneeConfig } from "./config.js";

// ============================================================================
// Types
// ============================================================================

export type MemoryCandidate = {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
};

export type PolicyDecision = {
  persist: boolean;
  reason: string;
  score: number; // 0-1, higher = more worth persisting
  category?: string;
  extractedEntities?: string[];
};

export type MemoryPolicyConfig = {
  // Minimum score to persist (0-1)
  minDurabilityScore: number;

  // Weight factors for scoring
  weights: {
    relevance: number;
    utility: number;
    specificity: number;
    graphRelation: number;
  };

  // Recurrence tracking
  recurrence: {
    enabled: boolean;
    minMentions: number; // Require N mentions before persisting
    windowMinutes: number; // Time window for counting mentions
  };

  // LLM evaluation (optional, more accurate but slower)
  llmEvaluation: {
    enabled: boolean;
    threshold: number; // LLM must score above this
  };
};

// ============================================================================
// Ephemeral Content Patterns (never persist)
// ============================================================================

const EPHEMERAL_PATTERNS = [
  // Greetings
  /^(hi|hello|hey|howdy|greetings|good\s*(morning|afternoon|evening))[\s!.]*$/i,

  // Acknowledgments
  /^(ok|okay|sure|alright|got\s*it|understood|makes\s*sense|i\s*see|right|yep|yeah|yes|no|nope)[\s!.]*$/i,

  // Thanks
  /^(thanks|thank\s*you|thx|ty|cheers|appreciated)[\s!.]*$/i,

  // Farewells
  /^(bye|goodbye|see\s*you|later|cya|ttyl)[\s!.]*$/i,

  // Filler
  /^(um+|uh+|hmm+|well|so|anyway)[\s,.]*$/i,

  // Single words or very short
  /^[\w]{1,3}[\s!.?]*$/,

  // Just punctuation or emoji
  /^[\s\p{Emoji}\p{P}]*$/u,

  // "Let me..." agent preamble (low signal)
  /^let\s*me\s*(check|see|look|think|find)/i,

  // Status updates (transient)
  /^(done|finished|completed|working\s*on\s*it|one\s*moment|hold\s*on)[\s!.]*$/i,
];

// ============================================================================
// High-Signal Patterns (boost persistence score)
// ============================================================================

const HIGH_SIGNAL_PATTERNS: Array<{ pattern: RegExp; boost: number; category: string }> = [
  // Decisions
  { pattern: /\b(decided|decision|chose|chosen|will\s+use|going\s+with|settled\s+on)\b/i, boost: 0.3, category: "decision" },

  // Preferences
  { pattern: /\b(prefer|preference|like|dislike|want|don't\s+want|always|never)\b/i, boost: 0.25, category: "preference" },

  // Requirements
  { pattern: /\b(must|require|need|should|have\s+to|necessary|important|critical)\b/i, boost: 0.2, category: "requirement" },

  // Definitions
  { pattern: /\b(means|defined\s+as|refers\s+to|is\s+called|known\s+as)\b/i, boost: 0.25, category: "definition" },

  // Configuration/Setup
  { pattern: /\b(configured|config|setup|installed|deployed|created|implemented)\b/i, boost: 0.2, category: "configuration" },

  // Credentials/Secrets (important but handle carefully)
  { pattern: /\b(api\s*key|password|token|secret|credential|auth)\b/i, boost: 0.15, category: "credential" },

  // Architecture
  { pattern: /\b(architecture|design|pattern|structure|flow|pipeline)\b/i, boost: 0.2, category: "architecture" },

  // Relationships
  { pattern: /\b(connects?\s+to|depends\s+on|requires|uses|calls|imports|extends)\b/i, boost: 0.2, category: "relationship" },

  // Explicit memory request
  { pattern: /\b(remember|don't\s+forget|keep\s+in\s+mind|note\s+that|important\s+to\s+know)\b/i, boost: 0.4, category: "explicit" },

  // Facts with specifics
  { pattern: /\b(version|port|path|url|endpoint|ip|address)\s*[:=]?\s*[\w\d./:-]+/i, boost: 0.2, category: "fact" },

  // Named entities (projects, tools)
  { pattern: /\b(project|repo|repository|service|database|server|client)\s+\w+/i, boost: 0.15, category: "entity" },
];

// ============================================================================
// Low-Signal Patterns (reduce persistence score)
// ============================================================================

const LOW_SIGNAL_PATTERNS: Array<{ pattern: RegExp; penalty: number; reason: string }> = [
  // Questions without answers
  { pattern: /^(what|how|why|when|where|who|can\s+you|could\s+you|would\s+you)\b.*\?$/i, penalty: 0.2, reason: "question" },

  // Agent thinking out loud
  { pattern: /^(i('ll|\s+will)\s+(check|look|search|find|try)|let\s+me|searching|looking)/i, penalty: 0.3, reason: "process" },

  // Generic responses
  { pattern: /^(here('s|\s+is)|i('ve|\s+have)\s+(found|created|done|finished))/i, penalty: 0.1, reason: "generic" },

  // Error messages (unless they contain resolution)
  { pattern: /\b(error|failed|exception|traceback|stack\s*trace)\b/i, penalty: 0.1, reason: "error" },

  // Code blocks without context (raw output)
  { pattern: /^```[\s\S]*```$/m, penalty: 0.15, reason: "code-only" },

  // Lists without context
  { pattern: /^(\s*[-*]\s+.+\n){3,}$/m, penalty: 0.1, reason: "list-only" },
];

// ============================================================================
// Entity Extraction (simple rule-based)
// ============================================================================

const ENTITY_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  // Technologies
  { pattern: /\b(PostgreSQL|MySQL|MongoDB|Redis|Elasticsearch|Kafka|RabbitMQ)\b/i, type: "database" },
  { pattern: /\b(React|Vue|Angular|Svelte|Next\.?js|Nuxt)\b/i, type: "framework" },
  { pattern: /\b(TypeScript|JavaScript|Python|Rust|Go|Java|Ruby|PHP)\b/i, type: "language" },
  { pattern: /\b(Docker|Kubernetes|AWS|GCP|Azure|Vercel|Heroku)\b/i, type: "platform" },
  { pattern: /\b(GitHub|GitLab|Bitbucket|Jira|Notion|Slack|Discord)\b/i, type: "tool" },

  // Project patterns
  { pattern: /\b(?:project|repo)\s+["']?(\w+)["']?/i, type: "project" },

  // File paths
  { pattern: /\b(\/[\w./+-]+|[\w]+\.(ts|js|py|md|json|yaml|yml|toml|env))\b/g, type: "file" },

  // URLs
  { pattern: /https?:\/\/[^\s]+/g, type: "url" },

  // Environment variables
  { pattern: /\b[A-Z][A-Z0-9_]{2,}\b/g, type: "env_var" },
];

function extractEntities(text: string): string[] {
  const entities: string[] = [];

  for (const { pattern } of ENTITY_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      entities.push(...matches.map(m => m.trim()));
    }
  }

  // Dedupe and limit
  return [...new Set(entities)].slice(0, 10);
}

// ============================================================================
// Memory Policy Implementation
// ============================================================================

export class MemoryPolicy {
  private recurrenceMap: Map<string, { count: number; firstSeen: number }> = new Map();
  private existingEntities: Set<string> = new Set();

  constructor(private config: MemoryPolicyConfig) {}

  /**
   * Update the set of entities already in the knowledge graph.
   * Called periodically to check graph relationships.
   */
  updateExistingEntities(entities: string[]): void {
    this.existingEntities = new Set(entities.map(e => e.toLowerCase()));
  }

  /**
   * Evaluate whether a message should be persisted.
   */
  evaluate(candidate: MemoryCandidate): PolicyDecision {
    const { text, role } = candidate;
    const normalizedText = text.trim();

    // Quick rejection: empty or too short
    if (normalizedText.length < 10) {
      return { persist: false, reason: "too_short", score: 0 };
    }

    // Quick rejection: ephemeral content
    for (const pattern of EPHEMERAL_PATTERNS) {
      if (pattern.test(normalizedText)) {
        return { persist: false, reason: "ephemeral", score: 0 };
      }
    }

    // Calculate base score
    let score = 0.3; // Base score for non-ephemeral content
    let category: string | undefined;
    const reasons: string[] = [];

    // Apply high-signal boosts
    for (const { pattern, boost, category: cat } of HIGH_SIGNAL_PATTERNS) {
      if (pattern.test(normalizedText)) {
        score += boost;
        category = category || cat;
        reasons.push(`+${boost.toFixed(2)} ${cat}`);
      }
    }

    // Apply low-signal penalties
    for (const { pattern, penalty, reason } of LOW_SIGNAL_PATTERNS) {
      if (pattern.test(normalizedText)) {
        score -= penalty;
        reasons.push(`-${penalty.toFixed(2)} ${reason}`);
      }
    }

    // Extract entities
    const entities = extractEntities(normalizedText);

    // Boost for specificity (having concrete entities)
    const specificityBoost = Math.min(entities.length * 0.05, 0.2);
    score += specificityBoost * this.config.weights.specificity;
    if (entities.length > 0) {
      reasons.push(`+${(specificityBoost * this.config.weights.specificity).toFixed(2)} specificity`);
    }

    // Boost for graph relationship (connects to existing knowledge)
    const relatedEntities = entities.filter(e => this.existingEntities.has(e.toLowerCase()));
    if (relatedEntities.length > 0) {
      const relationBoost = Math.min(relatedEntities.length * 0.1, 0.3);
      score += relationBoost * this.config.weights.graphRelation;
      reasons.push(`+${(relationBoost * this.config.weights.graphRelation).toFixed(2)} graph_relation`);
    }

    // Length-based utility (longer, substantive content is often more valuable)
    const lengthScore = Math.min(normalizedText.length / 500, 1) * 0.1;
    score += lengthScore * this.config.weights.utility;

    // Role-based adjustment (agent responses with actions are valuable)
    if (role === "assistant" && /\b(created|configured|implemented|fixed|updated|added)\b/i.test(normalizedText)) {
      score += 0.1;
      reasons.push("+0.10 agent_action");
    }

    // Recurrence check
    if (this.config.recurrence.enabled) {
      const recurrenceKey = this.getRecurrenceKey(normalizedText);
      const recurrence = this.trackRecurrence(recurrenceKey);

      if (recurrence.count < this.config.recurrence.minMentions) {
        // Not enough mentions yet, but don't fully reject - reduce score
        score *= 0.5;
        reasons.push(`recurrence: ${recurrence.count}/${this.config.recurrence.minMentions}`);
      } else {
        // Meets recurrence threshold, slight boost
        score += 0.1;
        reasons.push("+0.10 recurrence_met");
      }
    }

    // Clamp score
    score = Math.max(0, Math.min(1, score));

    // Final decision
    const persist = score >= this.config.minDurabilityScore;

    return {
      persist,
      reason: persist
        ? `score=${score.toFixed(2)} [${reasons.join(", ")}]`
        : `below_threshold (${score.toFixed(2)} < ${this.config.minDurabilityScore})`,
      score,
      category,
      extractedEntities: entities.length > 0 ? entities : undefined,
    };
  }

  /**
   * Batch evaluate multiple candidates.
   */
  evaluateBatch(candidates: MemoryCandidate[]): Array<{ candidate: MemoryCandidate; decision: PolicyDecision }> {
    return candidates.map(candidate => ({
      candidate,
      decision: this.evaluate(candidate),
    }));
  }

  /**
   * Generate a recurrence key from text (normalized topic fingerprint).
   */
  private getRecurrenceKey(text: string): string {
    // Extract key terms for fingerprinting
    const entities = extractEntities(text);
    if (entities.length > 0) {
      return entities.slice(0, 3).sort().join("|").toLowerCase();
    }

    // Fallback: first significant words
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 5);

    return words.sort().join("|");
  }

  /**
   * Track topic recurrence over time.
   */
  private trackRecurrence(key: string): { count: number; firstSeen: number } {
    const now = Date.now();
    const windowMs = this.config.recurrence.windowMinutes * 60 * 1000;

    const existing = this.recurrenceMap.get(key);

    if (existing) {
      // Check if within window
      if (now - existing.firstSeen < windowMs) {
        existing.count++;
        return existing;
      } else {
        // Window expired, reset
        const fresh = { count: 1, firstSeen: now };
        this.recurrenceMap.set(key, fresh);
        return fresh;
      }
    }

    // First occurrence
    const fresh = { count: 1, firstSeen: now };
    this.recurrenceMap.set(key, fresh);
    return fresh;
  }

  /**
   * Clear stale recurrence data (call periodically).
   */
  pruneRecurrence(): void {
    const now = Date.now();
    const windowMs = this.config.recurrence.windowMinutes * 60 * 1000;

    for (const [key, data] of this.recurrenceMap) {
      if (now - data.firstSeen > windowMs * 2) {
        this.recurrenceMap.delete(key);
      }
    }
  }
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_POLICY_CONFIG: MemoryPolicyConfig = {
  minDurabilityScore: 0.4,

  weights: {
    relevance: 1.0,
    utility: 0.8,
    specificity: 1.0,
    graphRelation: 1.2, // Boost content that relates to existing knowledge
  },

  recurrence: {
    enabled: false, // Off by default (can be noisy for active conversations)
    minMentions: 2,
    windowMinutes: 60,
  },

  llmEvaluation: {
    enabled: false, // Off by default (adds latency + cost)
    threshold: 0.6,
  },
};

/**
 * Create a memory policy from plugin config.
 */
export function createMemoryPolicy(cfg: Partial<CogneeConfig>): MemoryPolicy {
  const policyConfig: MemoryPolicyConfig = {
    ...DEFAULT_POLICY_CONFIG,
    minDurabilityScore: cfg.minDurabilityScore ?? DEFAULT_POLICY_CONFIG.minDurabilityScore,
    recurrence: {
      ...DEFAULT_POLICY_CONFIG.recurrence,
      enabled: cfg.recurrenceFilter ?? DEFAULT_POLICY_CONFIG.recurrence.enabled,
      minMentions: cfg.recurrenceMinMentions ?? DEFAULT_POLICY_CONFIG.recurrence.minMentions,
    },
    llmEvaluation: {
      ...DEFAULT_POLICY_CONFIG.llmEvaluation,
      enabled: cfg.llmDurabilityCheck ?? DEFAULT_POLICY_CONFIG.llmEvaluation.enabled,
    },
  };

  return new MemoryPolicy(policyConfig);
}
