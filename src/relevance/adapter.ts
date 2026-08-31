/**
 * The relevance seam.
 *
 * Ruling 1: relevance owns recall and ranking, nothing else. An adapter may
 * reorder what a query returns. It may never qualify a lesson, satisfy reuse,
 * declare a contradiction, widen scope, or grant authority — none of which are
 * even expressible through this interface, which is the point.
 */

import type { Lesson } from "../core/types.ts";
import type { LessonDomain, LessonStatus } from "../core/types.ts";

export interface RelevanceQuery {
  projectId: string;
  task: string;
  component?: string;
  domain?: LessonDomain;
  triggerTags?: string[];
  statuses?: readonly LessonStatus[];
  limit?: number;
}

export interface ScoredLesson {
  lesson: Lesson;
  score: number;
  reason: string;
  signals: {
    lexical?: number;
    semantic?: number;
    recency?: number;
  };
}

export interface RelevanceAdapter {
  readonly name: string;
  /** Ranks candidates. Never filters on authority, and never mutates a lesson. */
  rank(candidates: readonly Lesson[], query: RelevanceQuery): Promise<ScoredLesson[]>;
}
