/**
 * The on-disk schema ladder, exercised against a real version-1 database.
 *
 * A migration that has only ever run against a database this build created is
 * not a migration -- it is a guess. So these tests hand-build a genuine v1 file
 * with the v1 DDL, then open it with the current adapter and check the two
 * things that could actually go wrong: the upgrade runs, and it does not
 * disturb what was already written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageAdapter } from "../src/adapters/sqlite.ts";
import { queryEvents } from "../src/core/events.ts";
import { prepareEvent } from "../src/core/events.ts";
import { appendEvent } from "../src/core/events.ts";
import { closeEpisode, openEpisode } from "../src/core/episodes.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/core/migrate.ts";
import { event, PROJECT, T0, T1 } from "./helpers/factory.ts";

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fgm-mig-"));
  return { path: join(dir, "memory.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The version-1 DDL verbatim: no provider, model or surface columns anywhere. */
const V1_SCHEMA = `
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
  payload               TEXT NOT NULL,
  evidence_ids          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS episodes (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  objective         TEXT NOT NULL,
  base_revision_id  TEXT NOT NULL,
  contract_version  INTEGER,
  opened_at         TEXT NOT NULL,
  closed_at         TEXT,
  outcome           TEXT,
  applied_lesson_ids TEXT NOT NULL
);
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
CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  digest      TEXT,
  summary     TEXT
);
`;

/** Writes a real v1 file and returns the id of the legacy event inside it. */
function seedV1Database(path: string): string {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(V1_SCHEMA);

  // The id is derived by the current code from a body with no attribution --
  // which is exactly what a v1 writer would have produced.
  const legacy = prepareEvent(event({ payload: { note: "written under v1" } }));
  db.prepare(
    `INSERT INTO events (id, kind, occurred_at, project_id, cycle_id, phase_id,
       payload, evidence_ids)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    legacy.id, legacy.kind, legacy.occurredAt, legacy.projectId, legacy.cycleId,
    legacy.phaseId, JSON.stringify(legacy.payload), "[]",
  );

  db.prepare(
    `INSERT INTO episodes (id, project_id, objective, base_revision_id, opened_at,
       closed_at, outcome, applied_lesson_ids)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("epi_legacy", PROJECT, "a build from before attribution", "rev-0", T0, T1, "verified", "[]");

  db.exec("PRAGMA user_version = 1");
  db.close();
  return legacy.id;
}

test("a version-1 database upgrades on open", () => {
  const { path, cleanup } = tempDb();
  try {
    seedV1Database(path);

    const storage = new SqliteStorageAdapter({ path });
    storage.open();
    assert.equal(storage.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    storage.close();
  } finally {
    cleanup();
  }
});

test("the upgrade preserves legacy rows, ids and field absence", () => {
  const { path, cleanup } = tempDb();
  try {
    const legacyId = seedV1Database(path);

    const storage = new SqliteStorageAdapter({ path });
    storage.open();

    const events = queryEvents(storage, { projectId: PROJECT });
    assert.equal(events.length, 1);
    const [legacy] = events;
    assert.equal(legacy?.id, legacyId, "an id written under v1 still reads back the same");
    assert.ok(!("provider" in legacy!), "a NULL column stays an ABSENT key, not null");
    assert.ok(!("model" in legacy!));
    assert.ok(!("surface" in legacy!));

    const episode = storage.transact((tx) => tx.getEpisode("epi_legacy"));
    assert.equal(episode?.outcome, "verified");
    assert.ok(episode && !("provider" in episode));

    storage.close();
  } finally {
    cleanup();
  }
});

test("an upgraded database then accepts attributed writes", () => {
  const { path, cleanup } = tempDb();
  try {
    seedV1Database(path);

    const storage = new SqliteStorageAdapter({ path });
    storage.open();

    appendEvent(storage, event({ provider: "anthropic", model: "claude-haiku-4-5", surface: "builder.generate" }));
    const opened = openEpisode(storage, {
      projectId: PROJECT,
      objective: "a build after attribution",
      baseRevisionId: "rev-1",
      openedAt: T0,
    });
    closeEpisode(storage, opened.id, "verified", T1, { provider: "openai", model: "gpt-5.6-luna" });
    storage.close();

    // Reopen: attribution must survive the round trip, not just the session.
    const reopened = new SqliteStorageAdapter({ path });
    reopened.open();
    const attributed = queryEvents(reopened, { projectId: PROJECT, provider: "anthropic" });
    assert.equal(attributed.length, 1);
    assert.equal(attributed[0]?.model, "claude-haiku-4-5");
    assert.equal(attributed[0]?.surface, "builder.generate");

    const episode = reopened.transact((tx) => tx.getEpisode(opened.id));
    assert.equal(episode?.provider, "openai", "attribution set at close is persisted by the upsert");
    assert.equal(episode?.model, "gpt-5.6-luna");

    // The legacy event is still there and still unattributed.
    assert.equal(queryEvents(reopened, { projectId: PROJECT }).length, 2);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("the upgrade is idempotent when columns exist but the version lags", () => {
  const { path, cleanup } = tempDb();
  try {
    seedV1Database(path);

    // Simulates a crash between the ALTERs and the version bump: the columns
    // are already there, so a try/catch ladder could not tell this apart from
    // a genuine failure. A presence check can.
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE events ADD COLUMN provider TEXT");
    db.exec("PRAGMA user_version = 1");
    db.close();

    const storage = new SqliteStorageAdapter({ path });
    storage.open();
    assert.equal(storage.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1);
    storage.close();
  } finally {
    cleanup();
  }
});

test("a fresh database opens at the current version without running the ladder", () => {
  const { path, cleanup } = tempDb();
  try {
    const storage = new SqliteStorageAdapter({ path });
    storage.open();
    assert.equal(storage.getSchemaVersion(), CURRENT_SCHEMA_VERSION);

    appendEvent(storage, event({ provider: "google", model: "gemini-3.7-flash" }));
    assert.equal(queryEvents(storage, { projectId: PROJECT, provider: "google" }).length, 1);
    storage.close();
  } finally {
    cleanup();
  }
});
