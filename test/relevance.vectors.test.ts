import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import {
  assertSameSpace,
  guardedEmbed,
  metadataMatches,
  partitionBySpace,
  type EmbeddingAdapter,
  type VectorMetadata,
} from "../src/relevance/embedding-port.ts";
import { formatForEmbedding, MAX_INPUT_CHARS, PROMPT_FORMAT_VERSION } from "../src/providers/gemini.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

const ACTIVE: VectorMetadata = { modelId: "gemini-embedding-2", dimensions: 768, promptFormatVersion: "gemini2-prefix-v1" };

test("identical metadata matches; any differing field does not", () => {
  assert.equal(metadataMatches(ACTIVE, { ...ACTIVE }), true);
  assert.equal(metadataMatches(ACTIVE, { ...ACTIVE, modelId: "gemini-embedding-001" }), false);
  assert.equal(metadataMatches(ACTIVE, { ...ACTIVE, dimensions: 1536 }), false);
  assert.equal(metadataMatches(ACTIVE, { ...ACTIVE, promptFormatVersion: "v2" }), false);
});

test("a different embedding space forces a refusal, never a silent comparison", () => {
  assert.throws(
    () => assertSameSpace({ ...ACTIVE, modelId: "gemini-embedding-001" }, ACTIVE),
    (e: unknown) => code(e) === "EMBEDDING_SPACE_MISMATCH",
  );
  assert.doesNotThrow(() => assertSameSpace({ ...ACTIVE }, ACTIVE));
});

test("stored vectors partition into usable and needs-re-embed", () => {
  const records = [
    { id: "a", metadata: { ...ACTIVE } },
    { id: "b", metadata: { ...ACTIVE, dimensions: 3072 } },
    { id: "c", metadata: { ...ACTIVE, promptFormatVersion: "old" } },
    { id: "d", metadata: { ...ACTIVE } },
  ];
  const { usable, needsReembed } = partitionBySpace(records, ACTIVE);
  assert.deepEqual(usable.map((r) => r.id), ["a", "d"]);
  assert.deepEqual(needsReembed.map((r) => r.id), ["b", "c"]);
});

test("an adapter returning the wrong dimension count is refused", async () => {
  const wrong: EmbeddingAdapter = {
    metadata: ACTIVE,
    async embed() {
      return new Float32Array(64);
    },
  };
  await assert.rejects(
    () => guardedEmbed(wrong, { text: "hello", role: "query" }),
    (e: unknown) => code(e) === "EMBEDDING_SPACE_MISMATCH",
  );
});

test("query formatting uses the documented task prefixes", () => {
  assert.equal(
    formatForEmbedding({ text: "why does the build fail", role: "query" }),
    "task: search result | query: why does the build fail",
  );
  assert.equal(
    formatForEmbedding({ text: "find the retry helper", role: "query", task: "code-retrieval" }),
    "task: code retrieval | query: find the retry helper",
  );
  assert.equal(
    formatForEmbedding({ text: "is this true", role: "query", task: "fact-checking" }),
    "task: fact checking | query: is this true",
  );
});

test("document formatting uses title/text, defaulting title to none", () => {
  assert.equal(
    formatForEmbedding({ text: "pin the plugin", role: "document", title: "ESM build failure" }),
    "title: ESM build failure | text: pin the plugin",
  );
  assert.equal(
    formatForEmbedding({ text: "pin the plugin", role: "document" }),
    "title: none | text: pin the plugin",
  );
  assert.equal(
    formatForEmbedding({ text: "pin the plugin", role: "document", title: "   " }),
    "title: none | text: pin the plugin",
  );
});

test("input longer than the token limit is truncated, not sent whole", () => {
  const formatted = formatForEmbedding({ text: "x".repeat(MAX_INPUT_CHARS * 2), role: "document" });
  assert.ok(formatted.length < MAX_INPUT_CHARS + 100);
});

test("the prompt format version is part of the vector identity", () => {
  assert.equal(PROMPT_FORMAT_VERSION, ACTIVE.promptFormatVersion);
});
