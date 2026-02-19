/**
 * Test script for the Memory Policy.
 *
 * Run with: npx tsx test-policy.ts
 */

import { createMemoryPolicy } from "./memory-policy.js";

const policy = createMemoryPolicy({
  minDurabilityScore: 0.4,
  recurrenceFilter: false,
});

const testCases = [
  // Should REJECT (ephemeral)
  { role: "user" as const, text: "Hello!", expected: false },
  { role: "user" as const, text: "ok", expected: false },
  { role: "user" as const, text: "thanks", expected: false },
  { role: "user" as const, text: "got it", expected: false },
  { role: "assistant" as const, text: "Let me check that for you.", expected: false },
  { role: "user" as const, text: "bye", expected: false },
  { role: "user" as const, text: "hmm", expected: false },

  // Should PERSIST (durable)
  { role: "user" as const, text: "We decided to use PostgreSQL for the database.", expected: true },
  { role: "user" as const, text: "I prefer dark mode and TypeScript.", expected: true },
  { role: "user" as const, text: "Remember that the API key is in .env file.", expected: true },
  { role: "assistant" as const, text: "I've configured PostgreSQL with connection pooling and created the users table.", expected: true },
  { role: "user" as const, text: "The server must always use HTTPS in production.", expected: true },
  { role: "assistant" as const, text: "Created the authentication middleware that connects to Redis for session storage.", expected: true },

  // Edge cases
  { role: "user" as const, text: "What is PostgreSQL?", expected: false }, // Question without answer
  { role: "user" as const, text: "The architecture uses a microservices pattern with Kafka for messaging.", expected: true },
];

console.log("=".repeat(70));
console.log("MEMORY POLICY TEST");
console.log("=".repeat(70));
console.log();

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  const decision = policy.evaluate(tc);
  const correct = decision.persist === tc.expected;

  const status = correct ? "✓" : "✗";
  const action = decision.persist ? "PERSIST" : "REJECT";

  console.log(`${status} [${tc.role}] "${tc.text.slice(0, 50)}..."`);
  console.log(`  → ${action} (score: ${decision.score.toFixed(2)}) ${decision.reason}`);

  if (correct) {
    passed++;
  } else {
    failed++;
    console.log(`  → EXPECTED: ${tc.expected ? "PERSIST" : "REJECT"}`);
  }
  console.log();
}

console.log("=".repeat(70));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(70));

process.exit(failed > 0 ? 1 : 0);
