import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { closeEpisode, openEpisode, recordAppliedLesson } from "../src/core/episodes.ts";
import { recordEvidence } from "../src/core/evidence.ts";
import { evaluateDeviation, qualifyDeviationAsContradiction, recordDeviation } from "../src/core/deviation.ts";
import { getLesson } from "../src/core/lessons.ts";
import { PROJECT, seedProposedLesson, T2, type Seeded } from "./helpers/factory.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

const MATCHING_CONTEXT = {
  component: "build-pipeline",
  triggerTags: ["ERR_REQUIRE_ESM"],
  scope: ["build", "vite"],
};

const COMPARISON = {
  lessonRecommendation: "Pin the plugin to its ESM build and set type=module.",
  takenApproach: "Upgraded the plugin to v6, which ships dual builds.",
  observedOutcome: "Build succeeded without pinning.",
};

function deviate(s: Seeded, episodeId: string, context = MATCHING_CONTEXT) {
  return recordDeviation(s.storage, {
    lessonId: s.lessonId,
    episodeId,
    cycleId: "cycle-2",
    phaseId: "phase-4",
    comparison: COMPARISON,
    context,
    occurredAt: T2,
  });
}

function verifiedEpisode(s: Seeded, objective = "deviating attempt"): string {
  const ep = openEpisode(s.storage, {
    projectId: PROJECT,
    objective,
    baseRevisionId: "rev-4",
    openedAt: T2,
  });
  recordAppliedLesson(s.storage, ep.id, s.lessonId);
  closeEpisode(s.storage, ep.id, "verified", T2);
  return ep.id;
}

test("Ruling 7: recording a deviation does NOT contradict the lesson", () => {
  const s = seedProposedLesson();
  const episodeId = verifiedEpisode(s);
  const { event, lesson } = deviate(s, episodeId);

  assert.equal(event.kind, "deviation.observed");
  assert.equal(lesson.status, "proposed", "status must be untouched by an observation");
  assert.equal(lesson.contradictionIds.length, 0);
  assert.deepEqual(lesson.deviationIds, [event.id]);
});

test("a fully qualified deviation becomes contradiction evidence", () => {
  const s = seedProposedLesson();
  const episodeId = verifiedEpisode(s);
  const { event } = deviate(s, episodeId);
  const verification = recordEvidence(s.storage, {
    projectId: PROJECT,
    kind: "verification.result",
    ref: "run://build/deviation-verified",
    recordedAt: T2,
  });

  const checks = evaluateDeviation(s.storage, {
    lessonId: s.lessonId,
    deviationEventId: event.id,
    episodeId,
    verificationEvidenceId: verification.id,
  });
  assert.ok(checks.every((c) => c.passed), JSON.stringify(checks, null, 2));

  const contradicted = qualifyDeviationAsContradiction(s.storage, {
    lessonId: s.lessonId,
    deviationEventId: event.id,
    episodeId,
    verificationEvidenceId: verification.id,
    qualifiedAt: T2,
  });
  assert.equal(contradicted.status, "contradicted");
  assert.equal(contradicted.contradictionIds.length, 1);
});

test("check 1: a deviation whose scope does not match the lesson is refused", () => {
  const s = seedProposedLesson();
  const episodeId = verifiedEpisode(s);
  const { event } = deviate(s, episodeId, { component: "gallery", triggerTags: ["OTHER"], scope: ["styling"] });
  const verification = recordEvidence(s.storage, {
    projectId: PROJECT, kind: "verification.result", ref: "run://x", recordedAt: T2,
  });

  assert.throws(
    () =>
      qualifyDeviationAsContradiction(s.storage, {
        lessonId: s.lessonId,
        deviationEventId: event.id,
        episodeId,
        verificationEvidenceId: verification.id,
      }),
    (e: unknown) => code(e) === "DEVIATION_NOT_QUALIFIED",
  );
});

test("check 2: an unverified candidate cannot qualify a deviation", () => {
  const s = seedProposedLesson();
  const failing = openEpisode(s.storage, {
    projectId: PROJECT, objective: "failed deviation", baseRevisionId: "rev-5", openedAt: T2,
  });
  recordAppliedLesson(s.storage, failing.id, s.lessonId);
  closeEpisode(s.storage, failing.id, "failed", T2);
  const { event } = deviate(s, failing.id);
  const verification = recordEvidence(s.storage, {
    projectId: PROJECT, kind: "verification.result", ref: "run://y", recordedAt: T2,
  });

  const checks = evaluateDeviation(s.storage, {
    lessonId: s.lessonId, deviationEventId: event.id, episodeId: failing.id,
    verificationEvidenceId: verification.id,
  });
  assert.equal(checks.find((c) => c.check === "candidate-verified")?.passed, false);

  assert.throws(
    () =>
      qualifyDeviationAsContradiction(s.storage, {
        lessonId: s.lessonId, deviationEventId: event.id, episodeId: failing.id,
        verificationEvidenceId: verification.id,
      }),
    (e: unknown) => code(e) === "DEVIATION_NOT_QUALIFIED",
  );
});

test("check 4: missing verification evidence is refused", () => {
  const s = seedProposedLesson();
  const episodeId = verifiedEpisode(s);
  const { event } = deviate(s, episodeId);

  assert.throws(
    () =>
      qualifyDeviationAsContradiction(s.storage, {
        lessonId: s.lessonId, deviationEventId: event.id, episodeId,
        verificationEvidenceId: "evd_missing",
      }),
    (e: unknown) => code(e) === "DEVIATION_NOT_QUALIFIED",
  );
  assert.equal(getLesson(s.storage, s.lessonId)?.status, "proposed");
});
