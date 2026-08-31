/**
 * Ruling 7: successful deviation is NOT automatically a contradiction.
 *
 * When the model departs from a lesson and its candidate verifies anyway, that is
 * an observation worth keeping -- it is the mechanism that stops the ratchet from
 * ossifying. But it becomes contradiction evidence only after passing four
 * independent checks:
 *
 *   1. the lesson's trigger and scope actually match the deviating context
 *   2. the new candidate verifies
 *   3. the comparison is recorded
 *   4. the transition passes domain validation
 *
 * Matching is EXACT set intersection, never similarity. Similarity or model
 * judgement alone can never mark a lesson contradicted -- which is the same
 * invariant that keeps embeddings out of the promotion path entirely.
 */

import { refuse } from "./errors.ts";
import { appendEventTx } from "./events.ts";
import { requireEpisode } from "./episodes.ts";
import { recordEvidenceTx } from "./evidence.ts";
import { requireLesson } from "./lessons.ts";
import { LESSON_DOMAINS } from "./types.ts";
import type { Lesson, MemoryEvent } from "./types.ts";
import type { StorageAdapter } from "../adapters/storage.ts";

export interface DeviationComparison {
  /** What the lesson recommended. */
  lessonRecommendation: string;
  /** What was actually done instead. */
  takenApproach: string;
  /** What was observed as a result. */
  observedOutcome: string;
}

export interface DeviationContext {
  component?: string;
  triggerTags?: string[];
  /** Scope tokens describing where the deviation happened. */
  scope: string[];
}

export interface RecordDeviationInput {
  lessonId: string;
  episodeId: string;
  cycleId: string;
  phaseId: string;
  stepId?: string;
  candidateRevisionId?: string;
  comparison: DeviationComparison;
  context: DeviationContext;
  evidenceIds?: string[];
  occurredAt?: string;
}

export interface DeviationRecord {
  event: MemoryEvent;
  lesson: Lesson;
}

/**
 * Step one: record that a departure happened. This never changes lesson status.
 * A deviation is an observation, not a verdict.
 */
export function recordDeviation(storage: StorageAdapter, input: RecordDeviationInput): DeviationRecord {
  return storage.transact((tx) => {
    const lesson = requireLesson(tx, input.lessonId);
    const episode = requireEpisode(tx, input.episodeId);

    const { event } = appendEventTx(tx, {
      kind: "deviation.observed",
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      projectId: lesson.projectId,
      cycleId: input.cycleId,
      phaseId: input.phaseId,
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      ...(input.candidateRevisionId === undefined ? {} : { candidateRevisionId: input.candidateRevisionId }),
      episodeId: episode.id,
      ...(input.context.component === undefined ? {} : { component: input.context.component }),
      domain: lesson.domain,
      ...(input.context.triggerTags === undefined ? {} : { triggerTags: input.context.triggerTags }),
      payload: {
        lessonId: lesson.id,
        comparison: { ...input.comparison },
        context: { ...input.context },
      },
      evidenceIds: input.evidenceIds ?? [],
    });

    const updated: Lesson = lesson.deviationIds.includes(event.id)
      ? lesson
      : { ...lesson, deviationIds: [...lesson.deviationIds, event.id], updatedAt: event.occurredAt };
    if (updated !== lesson) tx.putLesson(updated);

    return { event, lesson: updated };
  });
}

export interface QualifyDeviationInput {
  lessonId: string;
  deviationEventId: string;
  /** The episode in which the deviating candidate was verified. */
  episodeId: string;
  /** Evidence that the candidate actually verified. */
  verificationEvidenceId: string;
  qualifiedAt?: string;
}

export interface QualificationCheck {
  check: string;
  passed: boolean;
  detail: string;
}

function intersects(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a || !b || a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((item) => set.has(item));
}

/**
 * Evaluates the four checks without mutating anything. Exposed so a caller (or a
 * test) can see exactly which gate a deviation failed.
 */
export function evaluateDeviation(storage: StorageAdapter, input: QualifyDeviationInput): QualificationCheck[] {
  return storage.transact((tx) => {
    const lesson = requireLesson(tx, input.lessonId);
    const event = tx.getEvent(input.deviationEventId);
    const episode = tx.getEpisode(input.episodeId);
    const evidence = tx.getEvidence(input.verificationEvidenceId);
    const checks: QualificationCheck[] = [];

    /* 1. trigger and scope actually match -- exact, never fuzzy */
    const payload = (event?.payload ?? {}) as { context?: DeviationContext; comparison?: DeviationComparison };
    const context = payload.context;
    const scopeMatches = intersects(lesson.scope, context?.scope);
    const componentMatches =
      lesson.component === undefined || lesson.component === context?.component;
    const tagsMatch =
      lesson.triggerTags === undefined ||
      lesson.triggerTags.length === 0 ||
      intersects(lesson.triggerTags, context?.triggerTags);
    checks.push({
      check: "trigger-and-scope-match",
      passed: Boolean(event) && scopeMatches && componentMatches && tagsMatch,
      detail: `scope=${scopeMatches} component=${componentMatches} triggerTags=${tagsMatch}`,
    });

    /* 2. the new candidate verifies */
    checks.push({
      check: "candidate-verified",
      passed: episode?.outcome === "verified" && episode.closedAt !== undefined,
      detail: `episode outcome=${episode?.outcome ?? "missing"}`,
    });

    /* 3. the comparison is recorded */
    const c = payload.comparison;
    checks.push({
      check: "comparison-recorded",
      passed: Boolean(
        c && c.lessonRecommendation?.trim() && c.takenApproach?.trim() && c.observedOutcome?.trim(),
      ),
      detail: c ? "comparison present" : "comparison missing",
    });

    /* 4. domain validation, plus the evidence and event actually existing */
    const domainValid = LESSON_DOMAINS.includes(lesson.domain);
    checks.push({
      check: "domain-and-evidence-valid",
      passed: domainValid && Boolean(evidence) && event?.kind === "deviation.observed",
      detail: `domain=${lesson.domain} evidence=${Boolean(evidence)} kind=${event?.kind ?? "missing"}`,
    });

    return checks;
  });
}

/**
 * Step two: promote a recorded deviation into contradiction evidence, but only if
 * all four checks pass. Otherwise refuse and say which gate failed.
 */
export function qualifyDeviationAsContradiction(
  storage: StorageAdapter,
  input: QualifyDeviationInput,
): Lesson {
  const checks = evaluateDeviation(storage, input);
  const failed = checks.filter((c) => !c.passed);
  if (failed.length > 0) {
    refuse(
      "DEVIATION_NOT_QUALIFIED",
      `Deviation does not qualify as contradiction evidence: ${failed.map((f) => f.check).join(", ")}.`,
      { lessonId: input.lessonId, deviationEventId: input.deviationEventId, checks },
    );
  }

  return storage.transact((tx) => {
    const lesson = requireLesson(tx, input.lessonId);
    const timestamp = input.qualifiedAt ?? new Date().toISOString();

    // The contradiction is itself recorded as evidence pointing at the deviation,
    // so the reason a lesson was contradicted stays chaseable.
    const contradiction = recordEvidenceTx(tx, {
      projectId: lesson.projectId,
      kind: "deviation.qualified",
      ref: `deviation:${input.deviationEventId}`,
      summary: `Verified departure from lesson ${lesson.id} in episode ${input.episodeId}`,
      recordedAt: timestamp,
    });

    if (lesson.contradictionIds.includes(contradiction.id)) return lesson;

    const updated: Lesson = {
      ...lesson,
      status: lesson.status === "revoked" ? "revoked" : "contradicted",
      contradictionIds: [...lesson.contradictionIds, contradiction.id],
      updatedAt: timestamp,
    };
    tx.putLesson(updated);
    return updated;
  });
}
