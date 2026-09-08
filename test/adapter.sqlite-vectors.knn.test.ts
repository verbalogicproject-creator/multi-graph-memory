/**
 * The vector index must agree with the scan it accelerates.
 *
 * `SqliteVectorStore` has always stored embeddings as raw Float32 bytes and let the
 * relevance layer score them one at a time in JS (`src/relevance/embedded.ts`). That
 * scan is the reference implementation: it is simple, it is what every existing result
 * was produced by, and it is correct by construction.
 *
 * `sqlite-vec` adds a `vec0` shadow over the same bytes so the same question can be
 * answered in SQL. An index that returns a *different* answer than the scan is not an
 * optimisation, it is a second opinion nobody asked for -- so the contract asserted here
 * is agreement, not speed: same ordering, same scores to float precision, same project
 * isolation.
 *
 * The index is also optional by design. `sqlite-vec` is an optionalDependency; when it
 * is missing `knn()` returns null and the scan answers alone. That is why the assertions
 * below branch on `knnAvailable` rather than requiring it -- a cluster with no extension
 * is a supported configuration, not a broken one, and `verify:pure` depends on it staying
 * that way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteVectorStore } from "../src/adapters/sqlite-vectors.ts";
import { cosineSimilarity } from "../src/relevance/vendored/math.ts";
import type { StoredLessonVector } from "../src/relevance/vector-store.ts";

const DIM = 32;
const K = 10;

/** Deterministic pseudo-random vectors: the same corpus every run. */
function corpus(n: number): StoredLessonVector[] {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  return Array.from({ length: n }, (_, i) => ({
    lessonId: `les_${i}`,
    projectId: i % 3 === 0 ? "other-project" : "p1",
    values: Float32Array.from({ length: DIM }, rnd),
    metadata: { modelId: "m", dimensions: DIM, promptFormatVersion: "v1" },
    contentDigest: "digest",
    embeddedAt: "2026-01-01T00:00:00.000Z",
  }));
}

function scanRanking(vectors: StoredLessonVector[], query: Float32Array, projectId: string) {
  return vectors
    .filter((v) => v.projectId === projectId)
    .map((v) => ({ lessonId: v.lessonId, score: cosineSimilarity(query, v.values) }))
    .sort((a, b) => b.score - a.score || a.lessonId.localeCompare(b.lessonId))
    .slice(0, K);
}

test("the vec0 index returns the same ranking as the JS scan", () => {
  const store = new SqliteVectorStore(":memory:");
  const vectors = corpus(200);
  for (const v of vectors) store.put(v);
  const query = vectors[7]!.values;

  const indexed = store.knn("p1", query, K);
  if (!store.knnAvailable) {
    assert.equal(indexed, null, "without the extension, knn must answer null rather than guess");
    store.close();
    return;
  }

  const expected = scanRanking(vectors, query, "p1");
  assert.ok(indexed, "knn must return results when the extension loaded");
  assert.deepEqual(
    indexed!.map((r) => r.lessonId),
    expected.map((r) => r.lessonId),
    "index ordering must match the scan exactly",
  );
  for (const [i, row] of indexed!.entries()) {
    assert.ok(
      Math.abs(row.score - expected[i]!.score) < 1e-5,
      `score for ${row.lessonId} drifted from the scan: ${row.score} vs ${expected[i]!.score}`,
    );
  }
  store.close();
});

test("knn never returns a lesson belonging to another project", () => {
  const store = new SqliteVectorStore(":memory:");
  const vectors = corpus(120);
  for (const v of vectors) store.put(v);
  const indexed = store.knn("p1", vectors[4]!.values, K);
  if (!store.knnAvailable) { store.close(); return; }
  const byId = new Map(vectors.map((v) => [v.lessonId, v.projectId]));
  for (const row of indexed!) {
    assert.equal(byId.get(row.lessonId), "p1", `${row.lessonId} leaked across the project boundary`);
  }
  store.close();
});

test("a removed lesson disappears from the index, not just the table", () => {
  const store = new SqliteVectorStore(":memory:");
  const vectors = corpus(40);
  for (const v of vectors) store.put(v);
  const query = vectors[1]!.values;
  const before = store.knn("p1", query, K);
  if (!store.knnAvailable) { store.close(); return; }
  const victim = before![0]!.lessonId;
  store.remove(victim);
  assert.equal(store.get(victim), null, "row must be gone from the table");
  const after = store.knn("p1", query, K);
  assert.ok(!after!.some((r) => r.lessonId === victim), "stale index entry survived a remove");
  store.close();
});

test("a dimension the index was not built for is refused, not answered wrongly", () => {
  const store = new SqliteVectorStore(":memory:");
  for (const v of corpus(20)) store.put(v);
  if (!store.knnAvailable) { store.close(); return; }
  assert.equal(store.knn("p1", new Float32Array(DIM + 8), K), null,
    "a mismatched embedding space must return null rather than a meaningless neighbour");
  store.close();
});
