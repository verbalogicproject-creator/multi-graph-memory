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

test("live: the embedded adapter ranks by genuine cosine, not a stand-in", options, async () => {
  const { EmbeddedRelevanceAdapter } = await import("../src/relevance/embedded.ts");
  const { MemoryVectorStore } = await import("../src/relevance/vector-store.ts");
  const { GeminiEmbeddingProvider: Provider } = await import("../src/providers/gemini.ts");

  const now = Date.parse("2026-08-31T00:00:00.000Z");
  const base = {
    status: "approved" as const, scope: ["x"], sourceEpisodeIds: ["e"], evidenceIds: ["v"],
    contradictionIds: [], projectId: "p", limits: [], createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z", reuseCount: 0, deviationIds: [],
  };

  // Deliberately share no vocabulary with the query, so ONLY a semantic signal
  // can retrieve the right one. Lexical matching would find neither.
  const lessons = [
    { ...base, id: "l_esm", domain: "build" as const,
      trigger: "Bundler halts on a CommonJS-only plugin",
      recommendation: "Choose a package release that publishes an ES module entrypoint." },
    { ...base, id: "l_colour", domain: "taste" as const,
      trigger: "Palette felt cold",
      recommendation: "Warm the accent hue and soften the contrast between panels." },
  ];

  const adapter = new EmbeddedRelevanceAdapter({
    embedder: new Provider({ dimensions: 768 }),
    vectors: new MemoryVectorStore(),
    now: () => now,
  });

  const indexed = await adapter.indexLessons(lessons);
  assert.equal(indexed.embedded, 2);

  const ranked = await adapter.rank(lessons, {
    projectId: "p",
    task: "my build breaks because a dependency ships require() only",
  });

  assert.ok(ranked.length > 0, "a semantic signal must retrieve something");
  assert.equal(ranked[0]?.lesson.id, "l_esm", "cosine must pick the module-format lesson");
  assert.ok(ranked[0]!.signals.semantic !== undefined, "the semantic signal must be real");
  assert.match(ranked[0]!.reason, /cosine 0\.\d+/);
  console.log(`    live ranking: ${ranked.map((r) => `${r.lesson.id}(${r.signals.semantic?.toFixed(3)})`).join(" > ")}`);
});

test("live: re-embedding is forced when the lesson text changes", options, async () => {
  const { EmbeddedRelevanceAdapter } = await import("../src/relevance/embedded.ts");
  const { MemoryVectorStore } = await import("../src/relevance/vector-store.ts");
  const { GeminiEmbeddingProvider: Provider } = await import("../src/providers/gemini.ts");

  const store = new MemoryVectorStore();
  const adapter = new EmbeddedRelevanceAdapter({
    embedder: new Provider({ dimensions: 768 }),
    vectors: store,
  });

  const lesson = {
    id: "l1", status: "approved" as const, trigger: "t", recommendation: "original recommendation",
    scope: ["x"], sourceEpisodeIds: ["e"], evidenceIds: ["v"], contradictionIds: [],
    projectId: "p", domain: "build" as const, limits: [], createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z", reuseCount: 0, deviationIds: [],
  };

  assert.deepEqual(await adapter.indexLessons([lesson]), { embedded: 1, reused: 0, reEmbedded: 0 });
  assert.deepEqual(await adapter.indexLessons([lesson]), { embedded: 0, reused: 1, reEmbedded: 0 });

  const edited = { ...lesson, recommendation: "a materially different recommendation" };
  assert.deepEqual(await adapter.indexLessons([edited]), { embedded: 0, reused: 0, reEmbedded: 1 });
});
