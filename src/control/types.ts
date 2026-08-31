/**
 * Control-tier model (Ruling 6, Layer 2).
 *
 * The control tier may hold ONLY: project registry metadata, learning-loop
 * scheduling state, de-identified generalized lessons, and pointers back to the
 * clusters that own the originals. It never copies project content.
 *
 * Without that rule, a cross-project leak stops being a bad search result and
 * becomes one project's proprietary text transmitted on another's behalf --
 * which, once embeddings are involved, means sent to a provider.
 */

import type { LessonDomain } from "../core/types.ts";

export interface RegisteredProject {
  projectId: string;
  workspace: string;
  /** Where the cluster lives. A pointer, never a copy of its contents. */
  databasePath: string;
  schemaVersion: number;
  registeredAt: string;
  lastSeenAt: string;
}

/** A pointer home. The generalized lesson never inlines the original's text. */
export interface LessonPointer {
  projectId: string;
  lessonId: string;
}

/**
 * Ruling 6: automated de-identification is NOT proof. A human decides, and the
 * decision plus its supporting evidence is recorded so the judgement is
 * inspectable later.
 */
export interface NoProprietaryContentDecision {
  decidedBy: string;
  decidedAt: string;
  rationale: string;
  /** What the decision was based on. */
  evidenceRefs: string[];
}

export interface GeneralizedLesson {
  id: string;
  trigger: string;
  recommendation: string;
  scope: string[];
  domain: LessonDomain;
  /** Must name at least two DISTINCT projects. */
  sourceProjects: string[];
  pointers: LessonPointer[];
  approvedBy: string;
  approvedAt: string;
  decision: NoProprietaryContentDecision;
  createdAt: string;
}

export interface ScheduleState {
  key: string;
  lastRunAt?: string;
  nextDueAt?: string;
  note?: string;
}
