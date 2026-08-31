import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { approveLesson, recordReuse, revokeLesson } from "../src/core/lessons.ts";
import { reuseEpisode, seedProposedLesson, T2 } from "./helpers/factory.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

test("gate 4: a merely proposed lesson cannot be approved", () => {
  const s = seedProposedLesson();
  assert.throws(
    () => approveLesson(s.storage, s.lessonId, "eyal"),
    (e: unknown) => code(e) === "LESSON_TRANSITION_INVALID",
  );
});

test("gate 4: approval requires a named human approver", () => {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  assert.throws(
    () => approveLesson(s.storage, s.lessonId, "   "),
    (e: unknown) => code(e) === "HUMAN_APPROVAL_REQUIRED",
  );
});

test("a qualified lesson approves, and records who and when", () => {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  const approved = approveLesson(s.storage, s.lessonId, "eyal", T2);

  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "eyal");
  assert.equal(approved.approvedByHumanAt, T2);
});

test("approval is idempotent", () => {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  const first = approveLesson(s.storage, s.lessonId, "eyal", T2);
  const second = approveLesson(s.storage, s.lessonId, "eyal", T2);
  assert.deepEqual(first, second);
});

test("a revoked lesson cannot be approved, and keeps its history", () => {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  const revoked = revokeLesson(s.storage, s.lessonId, "superseded by a framework upgrade", T2);

  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedReason, "superseded by a framework upgrade");
  // history retained
  assert.equal(revoked.reuseCount, 1);
  assert.deepEqual(revoked.evidenceIds.includes(s.evidenceId), true);

  assert.throws(
    () => approveLesson(s.storage, s.lessonId, "eyal"),
    (e: unknown) => code(e) === "LESSON_TRANSITION_INVALID",
  );
});

test("revocation requires a reason", () => {
  const s = seedProposedLesson();
  assert.throws(
    () => revokeLesson(s.storage, s.lessonId, ""),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});
