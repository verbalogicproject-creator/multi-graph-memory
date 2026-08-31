/**
 * Control-tier store (Layer 2).
 *
 * A separate database from every cluster, holding registry metadata, schedule
 * state, generalized lessons and pointers -- and nothing else. There is
 * deliberately no table here that could hold events, episodes, evidence or
 * lesson bodies from a project.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { refuse } from "../core/errors.ts";
import type { FederationAdmission } from "../core/types.ts";
import type { GeneralizedLesson, RegisteredProject, ScheduleState } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id     TEXT PRIMARY KEY,
  workspace      TEXT NOT NULL,
  database_path  TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  registered_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generalized_lessons (
  id              TEXT PRIMARY KEY,
  trigger_text    TEXT NOT NULL,
  recommendation  TEXT NOT NULL,
  scope           TEXT NOT NULL,
  domain          TEXT NOT NULL,
  source_projects TEXT NOT NULL,
  pointers        TEXT NOT NULL,
  approved_by     TEXT NOT NULL,
  approved_at     TEXT NOT NULL,
  decision        TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admissions (
  workspace     TEXT PRIMARY KEY,
  approved_by   TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  allowed_workspaces TEXT NOT NULL,
  allowed_projects   TEXT,
  admitted_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule (
  key          TEXT PRIMARY KEY,
  last_run_at  TEXT,
  next_due_at  TEXT,
  note         TEXT
);
`;

type Row = Record<string, unknown>;

export class ControlStore {
  private readonly path: string;
  private db: DatabaseSync | null = null;

  constructor(path: string) {
    this.path = path;
  }

  private handle(): DatabaseSync {
    if (!this.db) refuse("VALIDATION_FAILED", "ControlStore is not open; call open() first.", {});
    return this.db;
  }

  open(): void {
    if (this.db) return;
    // Same first-run guard as the cluster adapter: the control directory may not exist yet.
    if (this.path !== ":memory:" && !this.path.startsWith("file:")) {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  registerProject(project: RegisteredProject): void {
    this.handle()
      .prepare(
        `INSERT INTO projects (project_id, workspace, database_path, schema_version, registered_at, last_seen_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET workspace=excluded.workspace,
           database_path=excluded.database_path, schema_version=excluded.schema_version,
           last_seen_at=excluded.last_seen_at`,
      )
      .run(
        project.projectId, project.workspace, project.databasePath,
        project.schemaVersion, project.registeredAt, project.lastSeenAt,
      );
  }

  listProjects(): RegisteredProject[] {
    return (this.handle().prepare("SELECT * FROM projects ORDER BY project_id").all() as Row[]).map((row) => ({
      projectId: String(row.project_id),
      workspace: String(row.workspace),
      databasePath: String(row.database_path),
      schemaVersion: Number(row.schema_version),
      registeredAt: String(row.registered_at),
      lastSeenAt: String(row.last_seen_at),
    }));
  }

  /**
   * Stores an already-promoted generalized lesson. Every gate lives in
   * promoteToControlTier; this method persists, it does not decide.
   */
  putGeneralizedLesson(lesson: GeneralizedLesson): void {
    this.handle()
      .prepare(
        `INSERT INTO generalized_lessons (id, trigger_text, recommendation, scope, domain,
           source_projects, pointers, approved_by, approved_at, decision, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        lesson.id, lesson.trigger, lesson.recommendation, JSON.stringify(lesson.scope), lesson.domain,
        JSON.stringify(lesson.sourceProjects), JSON.stringify(lesson.pointers),
        lesson.approvedBy, lesson.approvedAt, JSON.stringify(lesson.decision), lesson.createdAt,
      );
  }

  listGeneralizedLessons(): GeneralizedLesson[] {
    return (this.handle().prepare("SELECT * FROM generalized_lessons ORDER BY created_at DESC").all() as Row[]).map(
      (row) => ({
        id: String(row.id),
        trigger: String(row.trigger_text),
        recommendation: String(row.recommendation),
        scope: JSON.parse(String(row.scope)) as string[],
        domain: String(row.domain) as GeneralizedLesson["domain"],
        sourceProjects: JSON.parse(String(row.source_projects)) as string[],
        pointers: JSON.parse(String(row.pointers)) as GeneralizedLesson["pointers"],
        approvedBy: String(row.approved_by),
        approvedAt: String(row.approved_at),
        decision: JSON.parse(String(row.decision)) as GeneralizedLesson["decision"],
        createdAt: String(row.created_at),
      }),
    );
  }

  /**
   * Federation admissions live in the control tier because they are cross-project
   * policy: a cluster must not be able to widen its own scope by writing to its
   * own database.
   */
  putAdmission(workspace: string, admission: FederationAdmission): void {
    this.handle()
      .prepare(
        `INSERT INTO admissions (workspace, approved_by, purpose, allowed_workspaces, allowed_projects, admitted_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(workspace) DO UPDATE SET approved_by=excluded.approved_by,
           purpose=excluded.purpose, allowed_workspaces=excluded.allowed_workspaces,
           allowed_projects=excluded.allowed_projects, admitted_at=excluded.admitted_at`,
      )
      .run(
        workspace, admission.approvedBy, admission.purpose,
        JSON.stringify(admission.allowedWorkspaces),
        admission.allowedProjects ? JSON.stringify(admission.allowedProjects) : null,
        admission.admittedAt,
      );
  }

  getAdmission(workspace: string): FederationAdmission | null {
    const row = this.handle().prepare("SELECT * FROM admissions WHERE workspace = ?").get(workspace) as Row | undefined;
    if (!row) return null;
    const admission: FederationAdmission = {
      approvedBy: String(row.approved_by),
      purpose: String(row.purpose),
      allowedWorkspaces: JSON.parse(String(row.allowed_workspaces)) as string[],
      admittedAt: String(row.admitted_at),
    };
    if (row.allowed_projects) admission.allowedProjects = JSON.parse(String(row.allowed_projects)) as string[];
    return admission;
  }

  listAdmissions(): Array<{ workspace: string; admission: FederationAdmission }> {
    return (this.handle().prepare("SELECT workspace FROM admissions ORDER BY workspace").all() as Row[])
      .map((row) => String(row.workspace))
      .map((workspace) => ({ workspace, admission: this.getAdmission(workspace)! }));
  }

  setSchedule(state: ScheduleState): void {
    this.handle()
      .prepare(
        `INSERT INTO schedule (key, last_run_at, next_due_at, note) VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET last_run_at=excluded.last_run_at,
           next_due_at=excluded.next_due_at, note=excluded.note`,
      )
      .run(state.key, state.lastRunAt ?? null, state.nextDueAt ?? null, state.note ?? null);
  }

  getSchedule(key: string): ScheduleState | null {
    const row = this.handle().prepare("SELECT * FROM schedule WHERE key = ?").get(key) as Row | undefined;
    if (!row) return null;
    const state: ScheduleState = { key: String(row.key) };
    if (row.last_run_at) state.lastRunAt = String(row.last_run_at);
    if (row.next_due_at) state.nextDueAt = String(row.next_due_at);
    if (row.note) state.note = String(row.note);
    return state;
  }

  /** Tables this store defines. Asserted by the leak test. */
  tableNames(): string[] {
    return (this.handle().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Row[])
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith("sqlite_"));
  }
}
