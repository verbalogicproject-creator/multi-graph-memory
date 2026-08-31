/**
 * In-memory storage adapter.
 *
 * The reference implementation of StorageAdapter and the default for tests.
 * Transactions are real: `transact` operates on cloned maps and commits only on
 * success, so a throw mid-unit leaves no partial writes behind. That property is
 * what the outbox replay tests depend on.
 */

import type { Episode, Evidence, Lesson, MemoryEvent } from "../core/types.ts";
import type { EventQuery, LessonQuery, StorageAdapter, StorageTx } from "./storage.ts";
import {
  byOccurredAtDesc,
  byOpenedAtDesc,
  byRecordedAtDesc,
  byUpdatedAtDesc,
  eventMatches,
  lessonMatches,
} from "./filters.ts";
import { CURRENT_SCHEMA_VERSION } from "../core/migrate.ts";

interface Tables {
  events: Map<string, MemoryEvent>;
  episodes: Map<string, Episode>;
  lessons: Map<string, Lesson>;
  evidence: Map<string, Evidence>;
}

function cloneTables(t: Tables): Tables {
  return {
    events: new Map(t.events),
    episodes: new Map(t.episodes),
    lessons: new Map(t.lessons),
    evidence: new Map(t.evidence),
  };
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

class MemoryTx implements StorageTx {
  private readonly t: Tables;

  constructor(tables: Tables) {
    this.t = tables;
  }

  getEvent(id: string): MemoryEvent | null {
    return this.t.events.get(id) ?? null;
  }

  putEventIfAbsent(event: MemoryEvent): boolean {
    if (this.t.events.has(event.id)) return false;
    this.t.events.set(event.id, freeze({ ...event }));
    return true;
  }

  listEvents(query: EventQuery): MemoryEvent[] {
    const out: MemoryEvent[] = [];
    for (const event of this.t.events.values()) {
      if (eventMatches(event, query)) out.push(event);
    }
    out.sort(byOccurredAtDesc);
    return query.limit === undefined ? out : out.slice(0, query.limit);
  }

  countEvents(projectId: string): number {
    let n = 0;
    for (const event of this.t.events.values()) if (event.projectId === projectId) n += 1;
    return n;
  }

  getEpisode(id: string): Episode | null {
    return this.t.episodes.get(id) ?? null;
  }

  putEpisode(episode: Episode): void {
    this.t.episodes.set(episode.id, freeze({ ...episode }));
  }

  listEpisodes(projectId: string): Episode[] {
    const out = [...this.t.episodes.values()].filter((e) => e.projectId === projectId);
    out.sort(byOpenedAtDesc);
    return out;
  }

  getLesson(id: string): Lesson | null {
    return this.t.lessons.get(id) ?? null;
  }

  putLesson(lesson: Lesson): void {
    this.t.lessons.set(lesson.id, freeze({ ...lesson }));
  }

  listLessons(query: LessonQuery): Lesson[] {
    const out: Lesson[] = [];
    for (const lesson of this.t.lessons.values()) {
      if (lessonMatches(lesson, query)) out.push(lesson);
    }
    out.sort(byUpdatedAtDesc);
    return query.limit === undefined ? out : out.slice(0, query.limit);
  }

  getEvidence(id: string): Evidence | null {
    return this.t.evidence.get(id) ?? null;
  }

  putEvidenceIfAbsent(evidence: Evidence): boolean {
    if (this.t.evidence.has(evidence.id)) return false;
    this.t.evidence.set(evidence.id, freeze({ ...evidence }));
    return true;
  }

  listEvidence(projectId: string): Evidence[] {
    const out = [...this.t.evidence.values()].filter((e) => e.projectId === projectId);
    out.sort(byRecordedAtDesc);
    return out;
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  readonly name = "memory";
  private tables: Tables = {
    events: new Map(),
    episodes: new Map(),
    lessons: new Map(),
    evidence: new Map(),
  };
  private schemaVersion = CURRENT_SCHEMA_VERSION;
  private depth = 0;

  open(): void {}

  close(): void {}

  getSchemaVersion(): number {
    return this.schemaVersion;
  }

  setSchemaVersion(version: number): void {
    this.schemaVersion = version;
  }

  transact<T>(fn: (tx: StorageTx) => T): T {
    // Nested transactions join the outer unit rather than starting a second one.
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return fn(new MemoryTx(this.tables));
      } finally {
        this.depth -= 1;
      }
    }

    const staged = cloneTables(this.tables);
    this.depth = 1;
    try {
      const result = fn(new MemoryTx(staged));
      this.tables = staged; // commit
      return result;
    } finally {
      this.depth = 0;
    }
  }
}
