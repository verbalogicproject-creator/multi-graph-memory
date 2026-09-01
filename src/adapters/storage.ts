/**
 * The storage adapter contract.
 *
 * Two contracts, not one, and the split is deliberate:
 *
 *   StorageAdapter    -- the system of record (in-memory, SQLite). Fully
 *                        synchronous, so `transact()` is genuinely atomic:
 *                        no await can interleave between statements.
 *   ProjectionAdapter -- the browser projection + append outbox (IndexedDB).
 *                        Necessarily async, and deliberately narrower: a
 *                        projection is not an authority.
 *
 * Ruling 4 requires one adapter-neutral domain model and one migration ladder
 * across all of them, which is why nothing here references a SQLite or
 * IndexedDB type.
 */

import type {
  Episode,
  Evidence,
  Lesson,
  LessonDomain,
  MemoryEvent,
  MemoryEventKind,
} from "../core/types.ts";

/**
 * Ruling 5: every query carries an explicit project scope. `projectId` is
 * required at the type level so an unscoped read cannot be expressed, let
 * alone executed.
 */
export interface EventQuery {
  projectId: string;
  episodeId?: string;
  kinds?: readonly MemoryEventKind[];
  component?: string;
  domain?: LessonDomain;
  /** Matched exactly. A record matches if it carries any of these tags. */
  triggerTags?: readonly string[];
  /** Schema version 2 attribution, all matched exactly. */
  provider?: string;
  model?: string;
  surface?: string;
  /** ISO-8601 lower bound, inclusive. */
  since?: string;
  limit?: number;
}

export interface LessonQuery {
  projectId: string;
  statuses?: readonly Lesson["status"][];
  domain?: LessonDomain;
  component?: string;
  triggerTags?: readonly string[];
  limit?: number;
}

/** The transactional surface. All operations are synchronous by contract. */
export interface StorageTx {
  /* events -- append-only */
  getEvent(id: string): MemoryEvent | null;
  /**
   * Idempotent append. Returns true when the event was newly written, false
   * when an identical event was already present. Never overwrites: event
   * identities are immutable.
   */
  putEventIfAbsent(event: MemoryEvent): boolean;
  listEvents(query: EventQuery): MemoryEvent[];
  countEvents(projectId: string): number;

  /* episodes */
  getEpisode(id: string): Episode | null;
  putEpisode(episode: Episode): void;
  listEpisodes(projectId: string): Episode[];

  /* lessons */
  getLesson(id: string): Lesson | null;
  putLesson(lesson: Lesson): void;
  listLessons(query: LessonQuery): Lesson[];

  /* evidence -- append-only */
  getEvidence(id: string): Evidence | null;
  putEvidenceIfAbsent(evidence: Evidence): boolean;
  listEvidence(projectId: string): Evidence[];
}

export interface StorageAdapter {
  readonly name: string;
  open(): void;
  close(): void;
  getSchemaVersion(): number;
  setSchemaVersion(version: number): void;
  /**
   * Runs `fn` atomically. A throw rolls the whole unit back -- which is what
   * makes a partially drained outbox safe to replay.
   */
  transact<T>(fn: (tx: StorageTx) => T): T;
}

/* ------------------------------------------------------- browser projection -- */

export interface OutboxEntry {
  /** The deterministic event id. Doubles as the dedupe key on drain. */
  id: string;
  event: MemoryEvent;
  enqueuedAt: string;
}

/**
 * The browser side. Writes are queued, never authoritative; reads are bounded and
 * deterministic (Ruling 4: the projection keeps lexical/facet/recency queries and
 * must remain useful with no vectors present).
 */
export interface ProjectionAdapter {
  readonly name: string;
  open(): Promise<void>;
  close(): Promise<void>;

  enqueue(event: MemoryEvent): Promise<void>;
  /** Oldest-first, bounded. Does not remove: removal happens only after a confirmed drain. */
  peekOutbox(limit: number): Promise<OutboxEntry[]>;
  /** Removes exactly the ids the drain confirmed. Unknown ids are ignored. */
  acknowledge(ids: readonly string[]): Promise<void>;
  outboxSize(): Promise<number>;

  /** Read-side projection, mirrored from the system of record. */
  putProjectedEvent(event: MemoryEvent): Promise<void>;
  listProjectedEvents(query: EventQuery): Promise<MemoryEvent[]>;
}

/**
 * Optional capability: a real full-text index.
 *
 * The SQLite adapter implements it; the in-memory and IndexedDB adapters do not,
 * and the relevance layer falls back to deterministic scanning when it is absent.
 * Ruling 4 requires the projection to stay useful without it.
 */
export interface LexicalIndex {
  /** BM25-ranked lesson ids, best first. Returns [] when the index is unavailable. */
  searchLessons(projectId: string, query: string, limit: number): LexicalHit[];
}

export interface LexicalHit {
  lessonId: string;
  /** Normalized to 0..1, higher is better. */
  score: number;
}

export function hasLexicalIndex(value: unknown): value is LexicalIndex {
  return typeof (value as LexicalIndex | null)?.searchLessons === "function";
}
