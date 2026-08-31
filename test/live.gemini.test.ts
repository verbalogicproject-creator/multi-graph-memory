/**
 * LIVE provider check. Skipped unless GEMINI_API_KEY is set, so the default
 * suite -- and `verify:pure` -- never needs a credential or a network.
 *
 * This is acceptance evidence, not a unit test: it confirms the documented
 * behaviour of gemini-embedding-2 actually holds, in particular that the
 * prompt-prefix format works WITHOUT the task_type field the old provider sent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiEmbeddingProvider } from "../src/providers/gemini.ts";
import { guardedEmbed } from "../src/relevance/embedding-port.ts";
import { cosineSimilarity } from "../src/relevance/vendored/math.ts";

const LIVE = Boolean(process.env.GEMINI_API_KEY);
const options = { skip: LIVE ? false : "GEMINI_API_KEY not set" };

function norm(v: Float32Array): number {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.sqrt(sum);
}

test("live: gemini-embedding-2 returns 768 dims without a task_type field", options, async () => {
  const provider = new GeminiEmbeddingProvider({ dimensions: 768 });
  const result = await guardedEmbed(provider, {
    text: "vite build fails with ERR_REQUIRE_ESM on Node 24",
    role: "query",
    task: "code-retrieval",
  });

  assert.equal(result.values.length, 768);
  assert.equal(result.metadata.modelId, "gemini-embedding-2");
  assert.equal(result.metadata.promptFormatVersion, "gemini2-prefix-v1");
});

test("live: truncated dimensions arrive auto-normalized (docs claim)", options, async () => {
  const provider = new GeminiEmbeddingProvider({ dimensions: 768 });
  const { values } = await guardedEmbed(provider, {
    text: "pin the plugin to its ESM build",
    role: "document",
    title: "ESM build failure",
  });

  const magnitude = norm(values);
  assert.ok(
    Math.abs(magnitude - 1) < 0.01,
    `expected a unit vector without manual normalization, got magnitude ${magnitude}`,
  );
});

test("live: asymmetric query/document formatting retrieves the right document", options, async () => {
  const provider = new GeminiEmbeddingProvider({ dimensions: 768 });

  const query = await guardedEmbed(provider, {
    text: "how do I fix an ESM require error during the build",
    role: "query",
    task: "search",
  });
  const relevant = await guardedEmbed(provider, {
    text: "Pin the plugin to its ESM build and set type=module in package.json.",
    role: "document",
    title: "vite build fails with ERR_REQUIRE_ESM",
  });
  const unrelated = await guardedEmbed(provider, {
    text: "Use a warmer accent colour and increase the hero letter-spacing.",
    role: "document",
    title: "visual direction notes",
  });

  const relevantScore = cosineSimilarity(query.values, relevant.values);
  const unrelatedScore = cosineSimilarity(query.values, unrelated.values);

  assert.ok(
    relevantScore > unrelatedScore,
    `relevant (${relevantScore.toFixed(4)}) must outrank unrelated (${unrelatedScore.toFixed(4)})`,
  );
  console.log(`    live similarity: relevant=${relevantScore.toFixed(4)} unrelated=${unrelatedScore.toFixed(4)}`);
});
