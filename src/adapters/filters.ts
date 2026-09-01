/**
 * Shared, storage-neutral predicates.
 *
 * The in-memory adapter and the IndexedDB projection both filter in JS, and they
 * must agree exactly with what the SQLite adapter expresses in SQL -- otherwise a
 * projection would answer a query differently from the system of record.
 */

import type { Episode, Evidence, Lesson, MemoryEvent } from "../core/types.ts";
import type { EventQuery, LessonQuery } from "./storage.ts";

function matchesTags(recordTags: readonly string[] | undefined, wanted: readonly string[]): boolean {
  if (wanted.length === 0) return true;
  if (!recordTags || recordTags.length === 0) return false;
  const have = new Set(recordTags);
  return wanted.some((tag) => have.has(tag));
}

export function eventMatches(event: MemoryEvent, query: EventQuery): boolean {
  if (event.projectId !== query.projectId) return false;
  if (query.episodeId !== undefined && event.episodeId !== query.episodeId) return false;
  if (query.kinds && !query.kinds.includes(event.kind)) return false;
  if (query.component !== undefined && event.component !== query.component) return false;
  if (query.domain !== undefined && event.domain !== query.domain) return false;
  if (query.triggerTags && !matchesTags(event.triggerTags, query.triggerTags)) return false;
  if (query.provider !== undefined && event.provider !== query.provider) return false;
  if (query.model !== undefined && event.model !== query.model) return false;
  if (query.surface !== undefined && event.surface !== query.surface) return false;
  if (query.since !== undefined && event.occurredAt < query.since) return false;
  return true;
}

export function lessonMatches(lesson: Lesson, query: LessonQuery): boolean {
  if (lesson.projectId !== query.projectId) return false;
  if (query.statuses && !query.statuses.includes(lesson.status)) return false;
  if (query.domain !== undefined && lesson.domain !== query.domain) return false;
  if (query.component !== undefined && lesson.component !== query.component) return false;
  if (query.triggerTags && !matchesTags(lesson.triggerTags, query.triggerTags)) return false;
  return true;
}

/** Newest first, with the id as a deterministic tiebreak so ordering is total. */
export function byOccurredAtDesc(a: MemoryEvent, b: MemoryEvent): number {
  if (a.occurredAt === b.occurredAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.occurredAt < b.occurredAt ? 1 : -1;
}

export function byUpdatedAtDesc(a: Lesson, b: Lesson): number {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

export function byOpenedAtDesc(a: Episode, b: Episode): number {
  if (a.openedAt === b.openedAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.openedAt < b.openedAt ? 1 : -1;
}

export function byRecordedAtDesc(a: Evidence, b: Evidence): number {
  if (a.recordedAt === b.recordedAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.recordedAt < b.recordedAt ? 1 : -1;
}
