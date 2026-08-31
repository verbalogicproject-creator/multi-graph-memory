import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { closeEpisode, openEpisode, recordAppliedLesson } from "../src/core/episodes.ts";
import { getLesson, proposeLesson, recordReuse } from "../src/core/lessons.ts";
import { PROJECT, reuseEpisode, seedProposedLesson, T2 } from "./helpers/factory.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

test("a proposal starts at 'proposed' with no reuse", () => {
  const s = seedProposedLesson();
  const lesson = getLesson(s.storage, s.lessonId);
  assert.equal(lesson?.status, "proposed");
  assert.equal(lesson?.reuseCount, 0);
});

test("gate 2: reuse in a SOURCE episode is refused", () => {
  const s = seedProposedLesson();
  recordAppliedLesson(s.storage, s.sourceEpisodeId, s.lessonId);
  assert.throws(
    () => recordReuse(s.storage, s.lessonId, s.sourceEpisodeId, [s.evidenceId]),
    (e: unknown) => code(e) === "REUSE_SAME_EPISODE",
  );
});

test("gate 2: reuse in a distinct verified episode qualifies the lesson", () => {
  const s = seedProposedLesson();
  const second = reuseEpisode(s);
  const lesson = recordReuse(s.storage, s.lessonId, second, [s.evidenceId], T2);

  assert.equal(lesson.status, "qualified");
  assert.equal(lesson.reuseCount, 1);
  assert.equal(lesson.reuseEpisodeId, second);
});

test("an episode that never applied the lesson cannot count as reuse", () => {
  const s = seedProposedLesson();
  const other = openEpisode(s.storage, {
    projectId: PROJECT,
    objective: "unrelated work",
    baseRevisionId: "rev-9",
    openedAt: T2,
  });
  closeEpisode(s.storage, other.id, "verified", T2);

  assert.throws(
    () => recordReuse(s.storage, s.lessonId, other.id, [s.evidenceId]),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});

test("an unverified episode cannot qualify reuse", () => {
  const s = seedProposedLesson();
  const failing = openEpisode(s.storage, {
    projectId: PROJECT,
    objective: "failed attempt",
    baseRevisionId: "rev-3",
    openedAt: T2,
  });
  recordAppliedLesson(s.storage, failing.id, s.lessonId);
  closeEpisode(s.storage, failing.id, "failed", T2);

  assert.throws(
    () => recordReuse(s.storage, s.lessonId, failing.id, [s.evidenceId]),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});

test("reuse requires real evidence, not an assertion", () => {
  const s = seedProposedLesson();
  const second = reuseEpisode(s);
  assert.throws(
    () => recordReuse(s.storage, s.lessonId, second, []),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
  assert.throws(
    () => recordReuse(s.storage, s.lessonId, second, ["evd_does_not_exist"]),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});

test("a proposal referencing an unknown source episode is refused", () => {
  const s = seedProposedLesson();
  assert.throws(
    () =>
      proposeLesson(s.storage, {
        projectId: PROJECT,
        trigger: "some trigger",
        recommendation: "some recommendation",
        scope: ["build"],
        domain: "build",
        sourceEpisodeIds: ["epi_does_not_exist"],
        evidenceIds: [s.evidenceId],
      }),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});

test("a lesson cannot cite a source episode from another project", () => {
  const s = seedProposedLesson();
  const foreign = openEpisode(s.storage, {
    projectId: "other-project",
    objective: "foreign work",
    baseRevisionId: "rev-x",
    openedAt: T2,
  });
  assert.throws(
    () =>
      proposeLesson(s.storage, {
        projectId: PROJECT,
        trigger: "cross-project trigger",
        recommendation: "should not be allowed",
        scope: ["build"],
        domain: "build",
        sourceEpisodeIds: [foreign.id],
        evidenceIds: [s.evidenceId],
      }),
    (e: unknown) => code(e) === "PROJECT_MISMATCH",
  );
});
