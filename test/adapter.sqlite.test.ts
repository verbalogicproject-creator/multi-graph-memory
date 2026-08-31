import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageAdapter, toFtsQuery } from "../src/adapters/sqlite.ts";
import { appendEvent, appendEvents, queryEvents } from "../src/core/events.ts";
import { closeEpisode, openEpisode, recordAppliedLesson } from "../src/core/episodes.ts";
import { recordEvidence } from "../src/core/evidence.ts";
import { approveLesson, getLesson, proposeLesson, recordReuse } from "../src/core/lessons.ts";
import { exportProject, serializeBundle } from "../src/core/portability.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/core/migrate.ts";
import { event, PROJECT, T0, T1, T2 } from "./helpers/factory.ts";

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fgm-"));
  return { path: join(dir, "memory.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seed(storage: SqliteStorageAdapter) {
  const source = openEpisode(storage, {
    projectId: PROJECT, objective: "build the candidate", baseRevisionId: "rev-1", openedAt: T0,
  });
  closeEpisode(storage, source.id, "verified", T1);
  const evidence = recordEvidence(storage, {
    projectId: PROJECT, kind: "verification.result", ref: "run://build/1", recordedAt: T1,
  });
  const lesson = proposeLesson(storage, {
    projectId: PROJECT,
    trigger: "vite build fails with ERR_REQUIRE_ESM",
    recommendation: "Pin the plugin to its ESM build.",
    scope: ["build", "vite"],
    domain: "build",
    sourceEpisodeIds: [source.id],
    evidenceIds: [evidence.id],
    limits: ["Node 24 under Termux only."],
    component: "build-pipeline",
    triggerTags: ["ERR_REQUIRE_ESM"],
  }, T1);

  const second = openEpisode(storage, {
    projectId: PROJECT, objective: "second repair", baseRevisionId: "rev-2", openedAt: T2,
  });
  recordAppliedLesson(storage, second.id, lesson.id);
  closeEpisode(storage, second.id, "verified", T2);
  recordReuse(storage, lesson.id, second.id, [evidence.id], T2);
  approveLesson(storage, lesson.id, "eyal", T2);
  appendEvent(storage, event({ payload: { note: "a build ran" } }));
  return { lessonId: lesson.id, evidenceId: evidence.id };
}

test("state survives close and reopen", () => {
  const { path, cleanup } = tempDb();
  try {
    const first = new SqliteStorageAdapter({ path });
    first.open();
    const { lessonId } = seed(first);
    assert.equal(first.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    first.close();

    const second = new SqliteStorageAdapter({ path });
    second.open();
    const lesson = getLesson(second, lessonId);
    assert.equal(lesson?.status, "approved");
    assert.equal(lesson?.approvedBy, "eyal");
    assert.equal(lesson?.reuseCount, 1);
    assert.deepEqual(lesson?.triggerTags, ["ERR_REQUIRE_ESM"]);
    assert.deepEqual(lesson?.limits, ["Node 24 under Termux only."]);
    assert.equal(second.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    second.close();
  } finally {
    cleanup();
  }
});

test("round-trip fidelity: the export checksum is identical after a reopen", () => {
  const { path, cleanup } = tempDb();
  try {
    const first = new SqliteStorageAdapter({ path });
    first.open();
    seed(first);
    const before = serializeBundle(exportProject(first, { projectId: PROJECT }, T2));
    first.close();

    const second = new SqliteStorageAdapter({ path });
    second.open();
    const after = serializeBundle(exportProject(second, { projectId: PROJECT }, T2));
    second.close();

    // Field presence must survive NULL columns exactly, or identities would drift.
    assert.equal(before, after);
  } finally {
    cleanup();
  }
});

test("a throw inside transact rolls back every statement in the unit", () => {
  const { path, cleanup } = tempDb();
  try {
    const storage = new SqliteStorageAdapter({ path });
    storage.open();
    appendEvent(storage, event({ payload: { n: 0 } }));

    assert.throws(() =>
      storage.transact((tx) => {
        tx.putEventIfAbsent({ ...event({ payload: { n: 1 } }), id: "evt_a" } as never);
        tx.putEventIfAbsent({ ...event({ payload: { n: 2 } }), id: "evt_b" } as never);
        throw new Error("boom");
      }),
    );

    assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1);
    storage.close();
  } finally {
    cleanup();
  }
});

test("nested transactions use savepoints and roll back independently", () => {
  const { path, cleanup } = tempDb();
  try {
    const storage = new SqliteStorageAdapter({ path });
    storage.open();

    storage.transact((tx) => {
      tx.putEventIfAbsent({ ...event({ payload: { n: 1 } }), id: "evt_outer" } as never);
      try {
        storage.transact((inner) => {
          inner.putEventIfAbsent({ ...event({ payload: { n: 2 } }), id: "evt_inner" } as never);
          throw new Error("inner fails");
        });
      } catch {
        // swallowed: the outer unit continues
      }
    });

    const ids = queryEvents(storage, { projectId: PROJECT }).map((e) => e.id);
    assert.deepEqual(ids, ["evt_outer"], "the inner savepoint rolled back, the outer committed");
    storage.close();
  } finally {
    cleanup();
  }
});

test("idempotent append holds across a reopen", () => {
  const { path, cleanup } = tempDb();
  try {
    const first = new SqliteStorageAdapter({ path });
    first.open();
    const a = appendEvent(first, event());
    first.close();

    const second = new SqliteStorageAdapter({ path });
    second.open();
    const b = appendEvent(second, event());
    assert.equal(b.created, false, "a redelivery after reopen must not duplicate");
    assert.equal(a.event.id, b.event.id);
    assert.equal(queryEvents(second, { projectId: PROJECT }).length, 1);
    second.close();
  } finally {
    cleanup();
  }
});

test("facet queries agree with the in-memory adapter's predicate", () => {
  const { path, cleanup } = tempDb();
  try {
    const storage = new SqliteStorageAdapter({ path });
    storage.open();
    appendEvents(storage, [
      event({ component: "checkout", domain: "build", triggerTags: ["ERR_A"] }),
      event({ component: "gallery", domain: "taste", triggerTags: ["ERR_B"], payload: { n: 2 } }),
    ]);

    assert.equal(queryEvents(storage, { projectId: PROJECT, component: "checkout" }).length, 1);
    assert.equal(queryEvents(storage, { projectId: PROJECT, domain: "taste" }).length, 1);
    assert.equal(queryEvents(storage, { projectId: PROJECT, triggerTags: ["ERR_A"] }).length, 1);
    assert.equal(queryEvents(storage, { projectId: PROJECT, triggerTags: ["NOPE"] }).length, 0);
    assert.equal(queryEvents(storage, { projectId: "other" }).length, 0);
    storage.close();
  } finally {
    cleanup();
  }
});

test("FTS5 lexical search actually returns the seeded lesson", () => {
  const { path, cleanup } = tempDb();
  try {
    const storage = new SqliteStorageAdapter({ path });
    storage.open();
    const { lessonId } = seed(storage);

    const hits = storage.searchLessons(PROJECT, "ERR_REQUIRE_ESM vite build", 10);
    assert.equal(hits.length, 1, "the FTS index must actually be queryable");
    assert.equal(hits[0]?.lessonId, lessonId);
    assert.ok(hits[0]!.score > 0 && hits[0]!.score <= 1);

    assert.deepEqual(storage.searchLessons(PROJECT, "completely unrelated terminology", 10), []);
    assert.deepEqual(storage.searchLessons("other-project", "vite build", 10), [],
      "lexical search must respect project isolation");
    storage.close();
  } finally {
    cleanup();
  }
});

test("FTS query construction neutralises operator syntax", () => {
  assert.equal(toFtsQuery('vite AND build'), '"vite" OR "and" OR "build"');
  assert.equal(toFtsQuery('a "quoted" NEAR/2 thing'), '"quoted" OR "near" OR "thing"');
  assert.equal(toFtsQuery("*"), "");
});

test("a malformed lexical query cannot crash the adapter", () => {
  const { path, cleanup } = tempDb();
  try {
    const storage = new SqliteStorageAdapter({ path });
    storage.open();
    seed(storage);
    for (const nasty of ['" OR 1=1 --', "NEAR/", "((((", '""""', "*"]) {
      assert.doesNotThrow(() => storage.searchLessons(PROJECT, nasty, 5), `crashed on: ${nasty}`);
    }
    storage.close();
  } finally {
    cleanup();
  }
});
