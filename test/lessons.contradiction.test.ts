import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { recordEvidence } from "../src/core/evidence.ts";
import { approveLesson, getLesson, recordContradiction, recordReuse, revokeLesson } from "../src/core/lessons.ts";
import { PROJECT, reuseEpisode, seedProposedLesson, T2 } from "./helpers/factory.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

function contradictingEvidence(storage: Parameters<typeof recordEvidence>[0]) {
  return recordEvidence(storage, {
    projectId: PROJECT,
    kind: "verification.result",
    ref: "run://build/contradiction",
    recordedAt: T2,
  });
}

test("gate 3: contradiction blocks approval outright", () => {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  recordContradiction(s.storage, s.lessonId, contradictingEvidence(s.storage).id, T2);

  assert.throws(
    () => approveLesson(s.storage, s.lessonId, "eyal"),
    (e: unknown) => code(e) === "CONTRADICTION_BLOCKS_PROMOTION",
  );
});

test("contradiction blocks further reuse too", () => {
  const s = seedProposedLesson();
  recordContradiction(s.storage, s.lessonId, contradictingEvidence(s.storage).id, T2);
  assert.throws(
    () => recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId]),
    (e: unknown) => code(e) === "CONTRADICTION_BLOCKS_PROMOTION",
  );
});

test("an already-approved lesson becomes contradicted by later evidence", () => {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  approveLesson(s.storage, s.lessonId, "eyal", T2);

  const contradicted = recordContradiction(s.storage, s.lessonId, contradictingEvidence(s.storage).id, T2);
  assert.equal(contradicted.status, "contradicted");
  // The approval record survives; history is never erased.
  assert.equal(contradicted.approvedBy, "eyal");
});

test("contradiction remains visible after revocation", () => {
  const s = seedProposedLesson();
  const evidence = contradictingEvidence(s.storage);
  recordContradiction(s.storage, s.lessonId, evidence.id, T2);
  const revoked = revokeLesson(s.storage, s.lessonId, "no longer applicable", T2);

  assert.equal(revoked.status, "revoked");
  assert.deepEqual(revoked.contradictionIds, [evidence.id]);

  // A contradiction recorded after revocation still attaches, and does not
  // resurrect the lesson out of 'revoked'.
  const later = recordContradiction(s.storage, s.lessonId, recordEvidence(s.storage, {
    projectId: PROJECT,
    kind: "diagnostic",
    ref: "run://build/later",
    recordedAt: T2,
  }).id, T2);
  assert.equal(later.status, "revoked");
  assert.equal(later.contradictionIds.length, 2);
});

test("contradiction is idempotent for the same evidence", () => {
  const s = seedProposedLesson();
  const evidence = contradictingEvidence(s.storage);
  recordContradiction(s.storage, s.lessonId, evidence.id, T2);
  recordContradiction(s.storage, s.lessonId, evidence.id, T2);
  assert.equal(getLesson(s.storage, s.lessonId)?.contradictionIds.length, 1);
});

test("contradiction requires real evidence", () => {
  const s = seedProposedLesson();
  assert.throws(
    () => recordContradiction(s.storage, s.lessonId, "evd_nope"),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});
