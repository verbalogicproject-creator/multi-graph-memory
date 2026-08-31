/**
 * Lesson lifecycle -- the ratchet.
 *
 *   proposed --(reuse in a DISTINCT episode)--> qualified
 *   qualified --(explicit human approval)-----> approved
 *   any --(contradicting evidence)------------> contradicted
 *   any --(revocation)------------------------> revoked
 *
 * Four gates, all enforced here rather than documented elsewhere:
 *   1. verified source evidence           -- a proposal needs evidence, not confidence
 *   2. reuse in a separate episode        -- one success can never promote a lesson
 *   3. no unresolved contradiction        -- contradiction blocks promotion outright
 *   4. explicit human approval            -- never reachable from a model surface
 *
 * Contradiction remains visible after revocation, and nothing deletes the original
 * evidence: a revoked lesson keeps its history so the record of why stays readable.
 */

import { deriveLessonId } from "./canonical.ts";
import { refuse } from "./errors.ts";
import { assertRedactionBoundary } from "./redaction.ts";
import { lessonProposalSchema } from "./schema.ts";
import { assertProjectMatch, requireScope } from "./scope.ts";
import { requireEpisode } from "./episodes.ts";
import type { Lesson, LessonProposal, LessonStatus, ProjectScope } from "./types.ts";
import type { LessonQuery, StorageAdapter, StorageTx } from "../adapters/storage.ts";

/** Statuses from which a lesson can still be promoted toward approval. */
const PROMOTABLE: readonly LessonStatus[] = ["proposed", "qualified"];

export function requireLesson(tx: StorageTx, lessonId: string): Lesson {
  const lesson = tx.getLesson(lessonId);
  if (!lesson) {
    refuse("VALIDATION_FAILED", `Unknown lesson "${lessonId}".`, { lessonId });
  }
  return lesson;
}

function assertNotRevoked(lesson: Lesson, action: string): void {
  if (lesson.status === "revoked") {
    refuse("LESSON_TRANSITION_INVALID", `Cannot ${action}: lesson "${lesson.id}" is revoked.`, {
      lessonId: lesson.id,
      status: lesson.status,
    });
  }
}

/**
 * Gate 3. A lesson carrying unresolved contradictions cannot be promoted, whatever
 * else is true of it.
 */
function assertNoContradiction(lesson: Lesson, action: string): void {
  if (lesson.contradictionIds.length > 0 || lesson.status === "contradicted") {
    refuse(
      "CONTRADICTION_BLOCKS_PROMOTION",
      `Cannot ${action}: lesson "${lesson.id}" has ${lesson.contradictionIds.length} unresolved contradiction(s).`,
      { lessonId: lesson.id, contradictionIds: lesson.contradictionIds },
    );
  }
}

/* ------------------------------------------------------------------ propose -- */

export function proposeLesson(storage: StorageAdapter, proposal: LessonProposal, now?: string): Lesson {
  const parsed = lessonProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    refuse("VALIDATION_FAILED", "Lesson proposal failed schema validation.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const input = parsed.data;

  // Ruling 3: a lesson is stored text, so it passes the persistence gate too.
  assertRedactionBoundary(input, "persistence");

  const timestamp = now ?? new Date().toISOString();

  return storage.transact((tx) => {
    // Gate 1: every source episode must exist. Evidence cannot be asserted into being.
    for (const episodeId of input.sourceEpisodeIds) {
      const episode = requireEpisode(tx, episodeId);
      assertProjectMatch(episode.projectId, { workspace: "default", projectId: input.projectId }, "source episode");
    }

    const id = deriveLessonId(input.projectId, input.trigger, input.recommendation, input.domain);
    const existing = tx.getLesson(id);
    if (existing) return existing;

    const lesson: Lesson = {
      id,
      status: "proposed",
      trigger: input.trigger,
      recommendation: input.recommendation,
      scope: input.scope,
      sourceEpisodeIds: input.sourceEpisodeIds,
      evidenceIds: input.evidenceIds,
      contradictionIds: [],
      projectId: input.projectId,
      domain: input.domain,
      limits: input.limits ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
      reuseCount: 0,
      deviationIds: [],
      ...(input.component === undefined ? {} : { component: input.component }),
      ...(input.triggerTags === undefined ? {} : { triggerTags: input.triggerTags }),
    };

    tx.putLesson(lesson);
    return lesson;
  });
}

/* -------------------------------------------------------------------- reuse -- */

/**
 * Gate 2. The reuse episode must be genuinely distinct from every source episode,
 * must have actually applied the lesson, and must have closed verified. Confidence
 * that it worked is not evidence that it worked.
 */
export function recordReuse(
  storage: StorageAdapter,
  lessonId: string,
  episodeId: string,
  evidenceIds: readonly string[],
  now?: string,
): Lesson {
  if (evidenceIds.length === 0) {
    refuse("VALIDATION_FAILED", "Recording reuse requires at least one evidence reference.", { lessonId, episodeId });
  }

  return storage.transact((tx) => {
    const lesson = requireLesson(tx, lessonId);
    assertNotRevoked(lesson, "record reuse");
    assertNoContradiction(lesson, "record reuse");

    if (lesson.sourceEpisodeIds.includes(episodeId)) {
      refuse(
        "REUSE_SAME_EPISODE",
        `Episode "${episodeId}" is a source episode for lesson "${lessonId}"; reuse must occur in a distinct episode.`,
        { lessonId, episodeId, sourceEpisodeIds: lesson.sourceEpisodeIds },
      );
    }
    if (lesson.reuseEpisodeId === episodeId) {
      refuse("REUSE_SAME_EPISODE", `Episode "${episodeId}" already counted as the reuse episode.`, {
        lessonId,
        episodeId,
      });
    }

    const episode = requireEpisode(tx, episodeId);
    assertProjectMatch(episode.projectId, { workspace: "default", projectId: lesson.projectId }, "reuse episode");

    if (!episode.appliedLessonIds.includes(lessonId)) {
      refuse(
        "VALIDATION_FAILED",
        `Episode "${episodeId}" never recorded applying lesson "${lessonId}"; it cannot count as reuse.`,
        { lessonId, episodeId },
      );
    }
    if (episode.outcome !== "verified") {
      refuse(
        "VALIDATION_FAILED",
        `Episode "${episodeId}" closed with outcome "${episode.outcome ?? "open"}"; only a verified episode qualifies reuse.`,
        { lessonId, episodeId, outcome: episode.outcome ?? null },
      );
    }

    for (const evidenceId of evidenceIds) {
      if (!tx.getEvidence(evidenceId)) {
        refuse("VALIDATION_FAILED", `Unknown evidence "${evidenceId}".`, { evidenceId });
      }
    }

    const updated: Lesson = {
      ...lesson,
      status: "qualified",
      reuseEpisodeId: episodeId,
      reuseCount: lesson.reuseCount + 1,
      evidenceIds: [...new Set([...lesson.evidenceIds, ...evidenceIds])],
      updatedAt: now ?? new Date().toISOString(),
    };
    tx.putLesson(updated);
    return updated;
  });
}

/* ------------------------------------------------------------ contradiction -- */

/**
 * Records contradicting evidence. Reachable directly for an observed failure; the
 * successful-deviation route goes through deviation.ts, which qualifies first
 * (Ruling 7).
 */
export function recordContradiction(
  storage: StorageAdapter,
  lessonId: string,
  evidenceId: string,
  now?: string,
): Lesson {
  return storage.transact((tx) => {
    const lesson = requireLesson(tx, lessonId);
    if (!tx.getEvidence(evidenceId)) {
      refuse("VALIDATION_FAILED", `Unknown evidence "${evidenceId}".`, { evidenceId });
    }
    if (lesson.contradictionIds.includes(evidenceId)) return lesson;

    const updated: Lesson = {
      ...lesson,
      // A revoked lesson keeps its revoked status; the contradiction still attaches
      // so it remains visible after revocation.
      status: lesson.status === "revoked" ? "revoked" : "contradicted",
      contradictionIds: [...lesson.contradictionIds, evidenceId],
      updatedAt: now ?? new Date().toISOString(),
    };
    tx.putLesson(updated);
    return updated;
  });
}

/* ----------------------------------------------------------------- approval -- */

/**
 * Gate 4. Human approval, and only from a human surface: this function is exposed
 * on the CLI and the library port, and is deliberately absent from the MCP server
 * and the model-facing context port.
 */
export function approveLesson(
  storage: StorageAdapter,
  lessonId: string,
  approvedBy: string,
  now?: string,
): Lesson {
  if (!approvedBy || approvedBy.trim().length === 0) {
    refuse("HUMAN_APPROVAL_REQUIRED", "Approval requires a named human approver.", { lessonId });
  }

  return storage.transact((tx) => {
    const lesson = requireLesson(tx, lessonId);
    assertNotRevoked(lesson, "approve");
    assertNoContradiction(lesson, "approve");

    if (lesson.status === "approved") return lesson;

    if (!PROMOTABLE.includes(lesson.status)) {
      refuse("LESSON_TRANSITION_INVALID", `Cannot approve a lesson in status "${lesson.status}".`, {
        lessonId,
        status: lesson.status,
      });
    }
    if (lesson.status !== "qualified" || lesson.reuseCount < 1) {
      refuse(
        "LESSON_TRANSITION_INVALID",
        `Lesson "${lessonId}" has not qualified: approval requires successful reuse in a distinct episode first.`,
        { lessonId, status: lesson.status, reuseCount: lesson.reuseCount },
      );
    }

    const timestamp = now ?? new Date().toISOString();
    const updated: Lesson = {
      ...lesson,
      status: "approved",
      approvedBy,
      approvedByHumanAt: timestamp,
      updatedAt: timestamp,
    };
    tx.putLesson(updated);
    return updated;
  });
}

export function revokeLesson(storage: StorageAdapter, lessonId: string, reason: string, now?: string): Lesson {
  if (!reason || reason.trim().length === 0) {
    refuse("VALIDATION_FAILED", "Revocation requires a reason.", { lessonId });
  }
  return storage.transact((tx) => {
    const lesson = requireLesson(tx, lessonId);
    const timestamp = now ?? new Date().toISOString();
    const updated: Lesson = {
      ...lesson,
      status: "revoked",
      revokedAt: timestamp,
      revokedReason: reason,
      updatedAt: timestamp,
      // History is retained in full: evidence, contradictions and reuse all survive.
    };
    tx.putLesson(updated);
    return updated;
  });
}

/* ------------------------------------------------------------------ reading -- */

export function listLessons(storage: StorageAdapter, query: LessonQuery): Lesson[] {
  requireScope({ projectId: query.projectId });
  return storage.transact((tx) => tx.listLessons(query));
}

export function getLesson(storage: StorageAdapter, lessonId: string, scope?: Partial<ProjectScope>): Lesson | null {
  return storage.transact((tx) => {
    const lesson = tx.getLesson(lessonId);
    if (lesson && scope) assertProjectMatch(lesson.projectId, requireScope(scope), "lesson");
    return lesson;
  });
}
