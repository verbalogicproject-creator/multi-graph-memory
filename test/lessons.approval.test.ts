import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { approveLesson, proposeLesson, recordReuse, revokeLesson } from "../src/core/lessons.ts";
import { deriveLessonId } from "../src/core/canonical.ts";
import { openEpisode } from "../src/core/episodes.ts";
import { recordEvidence } from "../src/core/evidence.ts";
import { makeStorage, PROJECT, reuseEpisode, seedProposedLesson, T2 } from "./helpers/factory.ts";

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

/* --------------------------------------------------- component identity (R1) -- */

test("two lessons differing only by component do not collide", () => {
  // The defect that blocked a file-scoped lesson producer. `proposeLesson`
  // returns the existing row on an id match, so while the component was excluded
  // from the derivation the FIRST file to raise a given trigger kept it
  // permanently and every later file silently inherited that file's component.
  const storage = makeStorage();
  const episode = openEpisode(storage, { projectId: PROJECT, objective: "o", baseRevisionId: "r" });
  const evidence = recordEvidence(storage, { projectId: PROJECT, kind: "verification.result", ref: "run://1" });

  const base = {
    projectId: PROJECT,
    trigger: "an import does not resolve",
    recommendation: "Check the path against the file set.",
    scope: ["build"],
    domain: "build" as const,
    sourceEpisodeIds: [episode.id],
    evidenceIds: [evidence.id],
  };

  const first = proposeLesson(storage, { ...base, component: "build:b1/src/App.tsx" });
  const second = proposeLesson(storage, { ...base, component: "build:b1/src/main.tsx" });

  assert.notEqual(first.id, second.id, "the same guidance about two files is two lessons");
  assert.equal(first.component, "build:b1/src/App.tsx");
  assert.equal(second.component, "build:b1/src/main.tsx", "the second must not inherit the first's file");
});

test("a lesson with no component derives the id it always derived", () => {
  // The migration guarantee, and the reason the component is folded in only when
  // present: every lesson in this estate carries a NULL component, so none of
  // them may be renamed by this change.
  assert.equal(
    deriveLessonId(PROJECT, "t", "r", "build"),
    deriveLessonId(PROJECT, "t", "r", "build", undefined),
  );
  assert.notEqual(
    deriveLessonId(PROJECT, "t", "r", "build"),
    deriveLessonId(PROJECT, "t", "r", "build", "repo:x/y.ts"),
  );
});
