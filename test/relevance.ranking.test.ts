import { test } from "node:test";
import assert from "node:assert/strict";
import { DeterministicRelevanceAdapter } from "../src/relevance/deterministic.ts";
import { scoreLexical, tokenize } from "../src/relevance/lexical.ts";
import { calculateTimeDecay, reciprocalRankFusion } from "../src/relevance/vendored/rank_fusion.ts";
import { cosineSimilarity } from "../src/relevance/vendored/math.ts";
import type { Lesson, LessonDomain } from "../src/core/types.ts";

const NOW = Date.parse("2026-08-31T00:00:00.000Z");

function lesson(id: string, over: Partial<Lesson> = {}): Lesson {
  return {
    id,
    status: "approved",
    trigger: `trigger for ${id}`,
    recommendation: `recommendation for ${id}`,
    scope: ["build"],
    sourceEpisodeIds: ["epi_1"],
    evidenceIds: ["evd_1"],
    contradictionIds: [],
    projectId: "p",
    domain: "build" as LessonDomain,
    limits: [],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    reuseCount: 0,
    deviationIds: [],
    ...over,
  };
}

test("an exact trigger-tag match outranks mere prose overlap", async () => {
  const adapter = new DeterministicRelevanceAdapter({ now: () => NOW });
  const tagged = lesson("tagged", { triggerTags: ["ERR_REQUIRE_ESM"], trigger: "esm interop" });
  const prosey = lesson("prosey", { trigger: "the build sometimes fails", recommendation: "check the build" });

  const ranked = await adapter.rank([prosey, tagged], {
    projectId: "p",
    task: "build fails with ERR_REQUIRE_ESM",
    triggerTags: ["ERR_REQUIRE_ESM"],
  });

  assert.equal(ranked[0]?.lesson.id, "tagged");
});

test("a fresher lesson outranks a stale one, all else equal", async () => {
  const adapter = new DeterministicRelevanceAdapter({ now: () => NOW });
  const fresh = lesson("fresh", { updatedAt: "2026-08-30T00:00:00.000Z" });
  const stale = lesson("stale", { updatedAt: "2026-01-01T00:00:00.000Z" });

  const ranked = await adapter.rank([stale, fresh], { projectId: "p", task: "recommendation" });
  assert.equal(ranked[0]?.lesson.id, "fresh");
});

test("ranking is deterministic and total: repeated runs agree exactly", async () => {
  const adapter = new DeterministicRelevanceAdapter({ now: () => NOW });
  const candidates = Array.from({ length: 12 }, (_, i) => lesson(`l${i}`));
  const first = await adapter.rank(candidates, { projectId: "p", task: "build failure" });
  const second = await adapter.rank([...candidates].reverse(), { projectId: "p", task: "build failure" });
  assert.deepEqual(first.map((r) => r.lesson.id), second.map((r) => r.lesson.id));
});

test("the adapter never mutates a lesson or changes its status", async () => {
  const adapter = new DeterministicRelevanceAdapter({ now: () => NOW });
  const original = lesson("l1", { status: "proposed" });
  const snapshot = JSON.stringify(original);
  const ranked = await adapter.rank([original], { projectId: "p", task: "anything" });
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(ranked[0]?.lesson.status, "proposed", "relevance cannot promote");
});

test("an empty candidate set ranks to nothing", async () => {
  const adapter = new DeterministicRelevanceAdapter({ now: () => NOW });
  assert.deepEqual(await adapter.rank([], { projectId: "p", task: "x" }), []);
});

test("limit is honoured", async () => {
  const adapter = new DeterministicRelevanceAdapter({ now: () => NOW });
  const candidates = Array.from({ length: 10 }, (_, i) => lesson(`l${i}`));
  const ranked = await adapter.rank(candidates, { projectId: "p", task: "build", limit: 3 });
  assert.equal(ranked.length, 3);
});

test("vendored time decay: reuse raises weight, age lowers it, with a floor", () => {
  const day = 86_400_000;
  const fresh = calculateTimeDecay(NOW - day, 14, 0.1, NOW);
  const old = calculateTimeDecay(NOW - 60 * day, 14, 0.1, NOW);
  const reused = calculateTimeDecay(NOW - day, 14, 0.1, NOW, undefined, 50);

  assert.ok(fresh > old, "older decays further");
  assert.ok(reused > fresh, "confirmed reuse raises weight");
  assert.ok(old >= 0.1, "never decays below the floor");
  assert.equal(calculateTimeDecay(undefined, 14, 0.1, NOW), 1, "no timestamp means no penalty");
});

test("vendored RRF sums agreeing signals", () => {
  const both = reciprocalRankFusion(
    [{ id: "a", score: 1 }, { id: "b", score: 0.9 }],
    [{ id: "b", score: 1 }, { id: "a", score: 0.1 }],
    [],
    "general",
    60,
    14,
    NOW,
  );
  const ids = both.map((c) => c.id);
  assert.deepEqual(new Set(ids), new Set(["a", "b"]));
  assert.ok(both.every((c) => c.finalScore > 0));
});

test("vendored cosine similarity behaves at the edges", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, "zero vector is safe, not NaN");
  assert.throws(() => cosineSimilarity([1], [1, 2]), /Dimension mismatch/);
});

test("lexical scoring drops stopwords and rewards exact tags", () => {
  assert.deepEqual(tokenize("the build is a failure"), ["build", "failure"]);
  const withTag = scoreLexical("ERR_REQUIRE_ESM", {
    id: "a", trigger: "x", recommendation: "y", scope: ["z"], triggerTags: ["err_require_esm"],
  });
  const without = scoreLexical("ERR_REQUIRE_ESM", {
    id: "b", trigger: "x", recommendation: "y", scope: ["z"],
  });
  assert.ok(withTag && withTag.score > 0);
  assert.equal(without, null);
  assert.equal(scoreLexical("", { id: "c", trigger: "x", recommendation: "y", scope: [] }), null);
});
