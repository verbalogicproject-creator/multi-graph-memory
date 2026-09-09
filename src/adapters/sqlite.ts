/**
 * SQLite storage adapter -- the system of record.
 *
 * Uses Node's built-in `node:sqlite`, so there is no native compilation and no
 * npm SQLite dependency: it runs on Termux/ARM64 unchanged.
 *
 * Two things here are deliberately unlike the antigravity-memory-os engine this
 * package descends from:
 *
 *   1. Real transactions. That engine has no BEGIN/COMMIT anywhere, so a
 *      multi-statement write can tear. Ruling 4's resumable outbox drain depends
 *      on atomicity, so `transact` is a genuine BEGIN/COMMIT with SAVEPOINT
 *      nesting and rollback on throw.
 *   2. Round-trip fidelity. A NULL column decodes to an ABSENT key, never to
 *      `undefined` or `null`. Canonical identity depends on field presence, so a
 *      sloppy decode would change an event's id on reopen and break checksums.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Episode, Evidence, Lesson, MemoryEvent } from "../core/types.ts";
import type { EventQuery, LessonQuery, LexicalHit, LexicalIndex, StorageAdapter, StorageTx } from "./storage.ts";
import { byOccurredAtDesc, byOpenedAtDesc, byRecordedAtDesc, byUpdatedAtDesc, eventMatches, lessonMatches } from "./filters.ts";
import { CURRENT_SCHEMA_VERSION } from "../core/migrate.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  occurred_at           TEXT NOT NULL,
  project_id            TEXT NOT NULL,
  cycle_id              TEXT NOT NULL,
  phase_id              TEXT NOT NULL,
  step_id               TEXT,
  contract_version      INTEGER,
  base_revision_id      TEXT,
  candidate_revision_id TEXT,
  episode_id            TEXT,
  supersedes_event_id   TEXT,
  component             TEXT,
  domain                TEXT,
  trigger_tags          TEXT,
  provider              TEXT,
  model                 TEXT,
  surface               TEXT,
  payload               TEXT NOT NULL,
  evidence_ids          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_project   ON events(project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_episode   ON events(episode_id);
CREATE INDEX IF NOT EXISTS idx_events_component ON events(project_id, component);
CREATE INDEX IF NOT EXISTS idx_events_domain    ON events(project_id, domain);

CREATE TABLE IF NOT EXISTS episodes (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  objective         TEXT NOT NULL,
  base_revision_id  TEXT NOT NULL,
  contract_version  INTEGER,
  opened_at         TEXT NOT NULL,
  closed_at         TEXT,
  outcome           TEXT,
  provider          TEXT,
  model             TEXT,
  applied_lesson_ids TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_project ON episodes(project_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS lessons (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  status              TEXT NOT NULL,
  trigger_text        TEXT NOT NULL,
  recommendation      TEXT NOT NULL,
  scope               TEXT NOT NULL,
  domain              TEXT NOT NULL,
  component           TEXT,
  trigger_tags        TEXT,
  source_episode_ids  TEXT NOT NULL,
  reuse_episode_id    TEXT,
  evidence_ids        TEXT NOT NULL,
  contradiction_ids   TEXT NOT NULL,
  deviation_ids       TEXT NOT NULL,
  limits              TEXT NOT NULL,
  approved_by         TEXT,
  approved_at         TEXT,
  revoked_at          TEXT,
  revoked_reason      TEXT,
  reuse_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_project ON lessons(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_lessons_status  ON lessons(project_id, status);
CREATE INDEX IF NOT EXISTS idx_lessons_domain  ON lessons(project_id, domain);

CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  digest      TEXT,
  summary     TEXT,
  supersedes_evidence_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_ref ON evidence(project_id, kind, ref);
`;

/** Full-text index over lesson prose. Populated here; queried by the relevance layer. */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
  lesson_id UNINDEXED,
  trigger_text,
  recommendation,
  scope,
  trigger_tags,
  tokenize='porter unicode61'
);
`;

type Row = Record<string, unknown>;

const json = (value: unknown): string => JSON.stringify(value ?? []);
const parseJson = <T,>(value: unknown, fallback: T): T =>
  typeof value === "string" ? (JSON.parse(value) as T) : fallback;

/** Adds `key` only when the column was not NULL, preserving field presence exactly. */
function put<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== null && value !== undefined) (target as Record<string, unknown>)[key] = value;
}

function decodeEvent(row: Row): MemoryEvent {
  const event: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    projectId: row.project_id,
    cycleId: row.cycle_id,
    phaseId: row.phase_id,
    payload: parseJson(row.payload, {}),
    evidenceIds: parseJson<string[]>(row.evidence_ids, []),
  };
  put(event, "stepId", row.step_id);
  put(event, "contractVersion", row.contract_version);
  put(event, "baseRevisionId", row.base_revision_id);
  put(event, "candidateRevisionId", row.candidate_revision_id);
  put(event, "episodeId", row.episode_id);
  put(event, "supersedesEventId", row.supersedes_event_id);
  put(event, "component", row.component);
  put(event, "domain", row.domain);
  put(event, "provider", row.provider);
  put(event, "model", row.model);
  put(event, "surface", row.surface);
  if (row.trigger_tags !== null && row.trigger_tags !== undefined) {
    event.triggerTags = parseJson<string[]>(row.trigger_tags, []);
  }
  return event as unknown as MemoryEvent;
}

function decodeEpisode(row: Row): Episode {
  const episode: Record<string, unknown> = {
    id: row.id,
    projectId: row.project_id,
    objective: row.objective,
    baseRevisionId: row.base_revision_id,
    openedAt: row.opened_at,
    appliedLessonIds: parseJson<string[]>(row.applied_lesson_ids, []),
  };
  put(episode, "contractVersion", row.contract_version);
  put(episode, "closedAt", row.closed_at);
  put(episode, "outcome", row.outcome);
  put(episode, "provider", row.provider);
  put(episode, "model", row.model);
  return episode as unknown as Episode;
}

function decodeLesson(row: Row): Lesson {
  const lesson: Record<string, unknown> = {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    trigger: row.trigger_text,
    recommendation: row.recommendation,
    scope: parseJson<string[]>(row.scope, []),
    domain: row.domain,
    sourceEpisodeIds: parseJson<string[]>(row.source_episode_ids, []),
    evidenceIds: parseJson<string[]>(row.evidence_ids, []),
    contradictionIds: parseJson<string[]>(row.contradiction_ids, []),
    deviationIds: parseJson<string[]>(row.deviation_ids, []),
    limits: parseJson<string[]>(row.limits, []),
    reuseCount: row.reuse_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  put(lesson, "component", row.component);
  if (row.trigger_tags !== null && row.trigger_tags !== undefined) {
    lesson.triggerTags = parseJson<string[]>(row.trigger_tags, []);
  }
  put(lesson, "reuseEpisodeId", row.reuse_episode_id);
  put(lesson, "approvedBy", row.approved_by);
  put(lesson, "approvedByHumanAt", row.approved_at);
  put(lesson, "revokedAt", row.revoked_at);
  put(lesson, "revokedReason", row.revoked_reason);
  return lesson as unknown as Lesson;
}

function decodeEvidence(row: Row): Evidence {
  const evidence: Record<string, unknown> = {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    ref: row.ref,
    recordedAt: row.recorded_at,
  };
  put(evidence, "digest", row.digest);
  put(evidence, "summary", row.summary);
  put(evidence, "supersedesEvidenceId", row.supersedes_evidence_id);
  return evidence as unknown as Evidence;
}

class SqliteTx implements StorageTx {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  getEvent(id: string): MemoryEvent | null {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Row | undefined;
    return row ? decodeEvent(row) : null;
  }

  putEventIfAbsent(event: MemoryEvent): boolean {
    if (this.getEvent(event.id)) return false;
    this.db
      .prepare(
        `INSERT INTO events (id, kind, occurred_at, project_id, cycle_id, phase_id, step_id,
           contract_version, base_revision_id, candidate_revision_id, episode_id, supersedes_event_id,
           component, domain, trigger_tags, provider, model, surface, payload, evidence_ids)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.id, event.kind, event.occurredAt, event.projectId, event.cycleId, event.phaseId,
        event.stepId ?? null, event.contractVersion ?? null, event.baseRevisionId ?? null,
        event.candidateRevisionId ?? null, event.episodeId ?? null, event.supersedesEventId ?? null,
        event.component ?? null, event.domain ?? null,
        event.triggerTags === undefined ? null : json(event.triggerTags),
        event.provider ?? null, event.model ?? null, event.surface ?? null,
        JSON.stringify(event.payload), json(event.evidenceIds),
      );
    return true;
  }

  /**
   * SQL narrows on indexed columns; the shared JS predicate then applies the
   * exact same rule the projection uses, so the two can never disagree.
   */
  listEvents(query: EventQuery): MemoryEvent[] {
    const clauses = ["project_id = ?"];
    const params: unknown[] = [query.projectId];
    if (query.episodeId !== undefined) { clauses.push("episode_id = ?"); params.push(query.episodeId); }
    if (query.component !== undefined) { clauses.push("component = ?"); params.push(query.component); }
    if (query.domain !== undefined) { clauses.push("domain = ?"); params.push(query.domain); }
    if (query.provider !== undefined) { clauses.push("provider = ?"); params.push(query.provider); }
    if (query.model !== undefined) { clauses.push("model = ?"); params.push(query.model); }
    if (query.surface !== undefined) { clauses.push("surface = ?"); params.push(query.surface); }
    if (query.since !== undefined) { clauses.push("occurred_at >= ?"); params.push(query.since); }

    const rows = this.db
      .prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC, id ASC`)
      .all(...(params as never[])) as Row[];

    const out = rows.map(decodeEvent).filter((e) => eventMatches(e, query));
    out.sort(byOccurredAtDesc);
    return query.limit === undefined ? out : out.slice(0, query.limit);
  }

  countEvents(projectId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?").get(projectId) as Row;
    return Number(row.n ?? 0);
  }

  getEpisode(id: string): Episode | null {
    const row = this.db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as Row | undefined;
    return row ? decodeEpisode(row) : null;
  }

  putEpisode(episode: Episode): void {
    this.db
      .prepare(
        `INSERT INTO episodes (id, project_id, objective, base_revision_id, contract_version,
           opened_at, closed_at, outcome, provider, model, applied_lesson_ids)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET closed_at=excluded.closed_at, outcome=excluded.outcome,
           provider=excluded.provider, model=excluded.model,
           applied_lesson_ids=excluded.applied_lesson_ids`,
      )
      .run(
        episode.id, episode.projectId, episode.objective, episode.baseRevisionId,
        episode.contractVersion ?? null, episode.openedAt, episode.closedAt ?? null,
        episode.outcome ?? null, episode.provider ?? null, episode.model ?? null,
        json(episode.appliedLessonIds),
      );
  }

  listEpisodes(projectId: string): Episode[] {
    const rows = this.db
      .prepare("SELECT * FROM episodes WHERE project_id = ? ORDER BY opened_at DESC, id ASC")
      .all(projectId) as Row[];
    const out = rows.map(decodeEpisode);
    out.sort(byOpenedAtDesc);
    return out;
  }

  getLesson(id: string): Lesson | null {
    const row = this.db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Row | undefined;
    return row ? decodeLesson(row) : null;
  }

  putLesson(lesson: Lesson): void {
    this.db
      .prepare(
        `INSERT INTO lessons (id, project_id, status, trigger_text, recommendation, scope, domain,
           component, trigger_tags, source_episode_ids, reuse_episode_id, evidence_ids,
           contradiction_ids, deviation_ids, limits, approved_by, approved_at, revoked_at,
           revoked_reason, reuse_count, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, scope=excluded.scope,
           reuse_episode_id=excluded.reuse_episode_id, evidence_ids=excluded.evidence_ids,
           contradiction_ids=excluded.contradiction_ids, deviation_ids=excluded.deviation_ids,
           limits=excluded.limits, approved_by=excluded.approved_by, approved_at=excluded.approved_at,
           revoked_at=excluded.revoked_at, revoked_reason=excluded.revoked_reason,
           reuse_count=excluded.reuse_count, updated_at=excluded.updated_at`,
      )
      .run(
        lesson.id, lesson.projectId, lesson.status, lesson.trigger, lesson.recommendation,
        json(lesson.scope), lesson.domain, lesson.component ?? null,
        lesson.triggerTags === undefined ? null : json(lesson.triggerTags),
        json(lesson.sourceEpisodeIds), lesson.reuseEpisodeId ?? null, json(lesson.evidenceIds),
        json(lesson.contradictionIds), json(lesson.deviationIds), json(lesson.limits),
        lesson.approvedBy ?? null, lesson.approvedByHumanAt ?? null, lesson.revokedAt ?? null,
        lesson.revokedReason ?? null, lesson.reuseCount, lesson.createdAt, lesson.updatedAt,
      );

    this.db.prepare("DELETE FROM lessons_fts WHERE lesson_id = ?").run(lesson.id);
    this.db
      .prepare("INSERT INTO lessons_fts (lesson_id, trigger_text, recommendation, scope, trigger_tags) VALUES (?,?,?,?,?)")
      .run(
        lesson.id, lesson.trigger, lesson.recommendation,
        lesson.scope.join(" "), (lesson.triggerTags ?? []).join(" "),
      );
  }

  listLessons(query: LessonQuery): Lesson[] {
    const clauses = ["project_id = ?"];
    const params: unknown[] = [query.projectId];
    if (query.domain !== undefined) { clauses.push("domain = ?"); params.push(query.domain); }
    if (query.component !== undefined) { clauses.push("component = ?"); params.push(query.component); }

    const rows = this.db
      .prepare(`SELECT * FROM lessons WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id ASC`)
      .all(...(params as never[])) as Row[];

    const out = rows.map(decodeLesson).filter((l) => lessonMatches(l, query));
    out.sort(byUpdatedAtDesc);
    return query.limit === undefined ? out : out.slice(0, query.limit);
  }

  getEvidence(id: string): Evidence | null {
    const row = this.db.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as Row | undefined;
    return row ? decodeEvidence(row) : null;
  }

  putEvidenceIfAbsent(evidence: Evidence): boolean {
    if (this.getEvidence(evidence.id)) return false;
    this.db
      .prepare(
        "INSERT INTO evidence (id, project_id, kind, ref, recorded_at, digest, summary, supersedes_evidence_id) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        evidence.id, evidence.projectId, evidence.kind, evidence.ref, evidence.recordedAt,
        evidence.digest ?? null, evidence.summary ?? null, evidence.supersedesEvidenceId ?? null,
      );
    return true;
  }

  listEvidence(projectId: string): Evidence[] {
    const rows = this.db
      .prepare("SELECT * FROM evidence WHERE project_id = ? ORDER BY recorded_at DESC, id ASC")
      .all(projectId) as Row[];
    const out = rows.map(decodeEvidence);
    out.sort(byRecordedAtDesc);
    return out;
  }
}

export interface SqliteOptions {
  /** ":memory:" for an ephemeral store. */
  path: string;
  /**
   * How long a write waits for a competing writer before failing, in ms.
   *
   * This store has two legitimate writers -- the host server holding a
   * long-lived connection, and the human CLI approving a lesson. Without a
   * timeout the second one fails instantly with SQLITE_BUSY on any overlap.
   */
  busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 2_000;

/** Column names actually present on a table. Table names here are literals, never input. */
function columnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * FTS5 MATCH is a query language, not a literal. Every term is quoted so that
 * user text containing operators (AND, NEAR, "*", quotes) is treated as words
 * rather than syntax -- and cannot produce a parse error or an injected clause.
 */
export function toFtsQuery(raw: string): string {
  const terms = raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return terms.join(" OR ");
}

export class SqliteStorageAdapter implements StorageAdapter, LexicalIndex {
  readonly name = "sqlite";
  private readonly path: string;
  private readonly busyTimeoutMs: number;
  private db: DatabaseSync | null = null;
  private depth = 0;

  constructor(options: SqliteOptions) {
    this.path = options.path;
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  }

  private handle(): DatabaseSync {
    if (!this.db) throw new Error("SqliteStorageAdapter is not open; call open() first.");
    return this.db;
  }

  open(): void {
    if (this.db) return;
    // A first run should not fail because the cluster directory is absent.
    if (this.path !== ":memory:" && !this.path.startsWith("file:")) {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`PRAGMA busy_timeout = ${Number(this.busyTimeoutMs)};`);
    this.db.exec(SCHEMA);
    try {
      this.db.exec(FTS_SCHEMA);
    } catch {
      // FTS5 is present in Node's bundled SQLite, but a build without it should
      // degrade to deterministic scanning rather than refusing to open at all.
    }

    // A fresh file gets CURRENT directly: SCHEMA above already created every
    // column. An existing file walks the ladder one step at a time.
    const version = this.getSchemaVersion();
    if (version === 0) this.setSchemaVersion(CURRENT_SCHEMA_VERSION);
    else if (version < CURRENT_SCHEMA_VERSION) this.upgradeFrom(version);

    // Indexes over columns the ladder may have just added, and therefore only
    // safe once every column exists. Keeping them in SCHEMA would make opening
    // a v1 file fail on an index that references a column not yet added.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_events_provider ON events(project_id, provider);");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_evidence_ref ON evidence(project_id, kind, ref);");
  }

  /**
   * The on-disk ladder.
   *
   * Every step checks what the table actually has rather than wrapping an ALTER
   * in try/catch. A swallowed exception makes "already applied" and "failed"
   * indistinguishable; a column-presence check makes the step idempotent AND
   * lets a genuine failure throw, which is the whole point of having a ladder.
   */
  private upgradeFrom(version: number): void {
    const db = this.handle();

    if (version < 2) {
      const eventColumns = columnNames(db, "events");
      if (!eventColumns.has("provider")) db.exec("ALTER TABLE events ADD COLUMN provider TEXT");
      if (!eventColumns.has("model")) db.exec("ALTER TABLE events ADD COLUMN model TEXT");
      if (!eventColumns.has("surface")) db.exec("ALTER TABLE events ADD COLUMN surface TEXT");

      const episodeColumns = columnNames(db, "episodes");
      if (!episodeColumns.has("provider")) db.exec("ALTER TABLE episodes ADD COLUMN provider TEXT");
      if (!episodeColumns.has("model")) db.exec("ALTER TABLE episodes ADD COLUMN model TEXT");

    }

    if (version < 3) {
      const evidenceColumns = columnNames(db, "evidence");
      if (!evidenceColumns.has("supersedes_evidence_id")) {
        db.exec("ALTER TABLE evidence ADD COLUMN supersedes_evidence_id TEXT");
      }
    }

    this.setSchemaVersion(CURRENT_SCHEMA_VERSION);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  getSchemaVersion(): number {
    const row = this.handle().prepare("PRAGMA user_version").get() as Row;
    return Number(row.user_version ?? 0);
  }

  setSchemaVersion(version: number): void {
    this.handle().exec(`PRAGMA user_version = ${Number(version)}`);
  }

  /**
   * BM25 over lesson prose. bm25() returns lower-is-better, so it is mapped into
   * a 0..1 higher-is-better score for fusion with the other signals.
   */
  searchLessons(projectId: string, query: string, limit: number): LexicalHit[] {
    const match = toFtsQuery(query);
    if (match.length === 0) return [];
    try {
      const rows = this.handle()
        .prepare(
          `SELECT f.lesson_id AS lesson_id, bm25(lessons_fts) AS rank
             FROM lessons_fts f
             JOIN lessons l ON l.id = f.lesson_id
            WHERE lessons_fts MATCH ? AND l.project_id = ?
            ORDER BY rank
            LIMIT ?`,
        )
        .all(match, projectId, limit) as Row[];
      return rows.map((row) => ({
        lessonId: String(row.lesson_id),
        score: 1 / (1 + Math.max(0, -Number(row.rank ?? 0))),
      }));
    } catch {
      // No FTS5 in this build: the caller falls back to deterministic scanning.
      return [];
    }
  }

  /**
   * A consistent single-file copy, safe to take while the store is in use.
   *
   * `cp` is not: WAL mode leaves recent commits in a `-wal` companion, so copying
   * the `.db` alone silently yields a stale snapshot -- during development that
   * lost an approval and an entire lesson. `VACUUM INTO` reads through the WAL
   * inside a transaction and writes one already-checkpointed file.
   */
  /**
   * The project ids actually present in this file.
   *
   * A caller pointed at an arbitrary `.db` cannot know what scope it holds, and
   * guessing from the filename is wrong the moment a file is renamed or copied --
   * a backup named `demo-1-backup.db` holds records scoped to `demo-1`, and a
   * filename guess would quietly show an empty project.
   */
  distinctProjectIds(): string[] {
    const rows = this.handle()
      .prepare(
        `SELECT project_id FROM episodes
         UNION SELECT project_id FROM lessons
         UNION SELECT project_id FROM events
         UNION SELECT project_id FROM evidence`,
      )
      .all() as Row[];
    return rows.map((row) => String(row.project_id)).filter(Boolean);
  }

  backupTo(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true });
    this.handle().prepare("VACUUM INTO ?").run(destination);
  }

  transact<T>(fn: (tx: StorageTx) => T): T {
    const db = this.handle();

    if (this.depth > 0) {
      const name = `sp_${this.depth}`;
      db.exec(`SAVEPOINT ${name}`);
      this.depth += 1;
      try {
        const result = fn(new SqliteTx(db));
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.depth -= 1;
      }
    }

    db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = fn(new SqliteTx(db));
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth = 0;
    }
  }
}
