import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { appendEvent, queryEvents } from "../src/core/events.ts";
import { assertRedactionBoundary, scanForSecrets } from "../src/core/redaction.ts";
import { guardedEmbed, type EmbeddingAdapter } from "../src/relevance/embedding-port.ts";
import { event, makeStorage, PROJECT } from "./helpers/factory.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

/** Records every call so we can prove the adapter was never reached. */
function spyAdapter(): EmbeddingAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    metadata: { modelId: "test-model", dimensions: 4, promptFormatVersion: "v1" },
    async embed(request) {
      calls.push(request.text);
      return new Float32Array([0, 0, 0, 1]);
    },
  };
}

const SECRETS: Array<[string, string]> = [
  ["google api key", "key is AIzaSyA1234567890abcdefghijklmnopqrstuvw"],
  ["openai key", "sk-abcdefghijklmnopqrstuvwxyz012345"],
  ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"],
  ["credentialed url", "postgres://admin:hunter2@db.internal:5432/app"],
  ["assigned secret", 'password = "correct-horse-battery"'],
  ["bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
];

for (const [label, text] of SECRETS) {
  test(`persistence gate refuses a ${label}`, () => {
    const storage = makeStorage();
    assert.throws(
      () => appendEvent(storage, event({ payload: { note: text } })),
      (e: unknown) => code(e) === "SECRET_DETECTED",
    );
    assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 0, "nothing may be stored");
  });
}

test("forbidden content classes are refused structurally, not by regex", () => {
  const storage = makeStorage();
  for (const key of ["thoughtSignature", "chainOfThought", "rawProviderTrace", "audioData"]) {
    assert.throws(
      () => appendEvent(storage, event({ payload: { [key]: "anything at all" } })),
      (e: unknown) => code(e) === "SECRET_DETECTED",
      `${key} must be refused`,
    );
  }
});

test("oversized payloads are refused before anything is written", () => {
  const storage = makeStorage();
  assert.throws(
    () => appendEvent(storage, event({ payload: { blob: "x".repeat(100_000) } })),
    (e: unknown) => code(e) === "PAYLOAD_TOO_LARGE",
  );
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 0);
});

test("Ruling 3: refused material NEVER reaches the embedding adapter", async () => {
  const adapter = spyAdapter();

  await assert.rejects(
    () => guardedEmbed(adapter, { text: "token AIzaSyA1234567890abcdefghijklmnopqrstuvw", role: "document" }),
    (e: unknown) => code(e) === "SECRET_DETECTED",
  );

  assert.deepEqual(adapter.calls, [], "the adapter must not have been called at all");
});

test("clean material does reach the adapter", async () => {
  const adapter = spyAdapter();
  const result = await guardedEmbed(adapter, { text: "vite build fails on Node 24", role: "query" });
  assert.equal(adapter.calls.length, 1);
  assert.equal(result.metadata.modelId, "test-model");
  assert.equal(result.values.length, 4);
});

test("ordinary engineering prose is not flagged", () => {
  const benign = [
    "The build failed because the plugin ships a CommonJS entrypoint.",
    "Set type=module in package.json and re-run npm ci.",
    "See src/core/packet.ts:42 for the budget clamp.",
  ];
  for (const text of benign) {
    assert.deepEqual(scanForSecrets(text), [], `false positive on: ${text}`);
    assert.doesNotThrow(() => assertRedactionBoundary({ note: text }, "persistence"));
  }
});

test("all five gates are enforced by the same function", () => {
  const dirty = { note: "sk-ant-abcdefghijklmnopqrstuvwxyz0123" };
  for (const gate of ["persistence", "embedding", "transmission", "export", "promotion"] as const) {
    assert.throws(
      () => assertRedactionBoundary(dirty, gate),
      (e: unknown) => code(e) === "SECRET_DETECTED" && (e as GraphMemoryError).detail.gate === gate,
    );
  }
});
