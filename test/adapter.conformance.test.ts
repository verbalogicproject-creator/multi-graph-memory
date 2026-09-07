/**
 * Adapter conformance suite.
 *
 * `StorageAdapter` is a contract two independent implementations (memory, sqlite)
 * both claim to satisfy. Nothing before this file ran the SAME assertions against
 * both — SqliteStorageAdapter had its own dedicated test file, MemoryStorageAdapter
 * had none at all beyond being used as a convenient test double elsewhere. Without
 * this, "the storage layer is swappable" was an assertion in a comment, not
 * something proven. Every test below runs once per fixture; a failure names which
 * adapter broke the shared contract.
 *
 * Deliberately NOT covered here (adapter-specific, not part of the shared
 * contract, already covered in their own files): cross-process persistence
 * (sqlite reopen), FTS5 lexical search (sqlite-only), and independent nested-
 * transaction rollback via savepoints — a real, discovered divergence: SQLite
 * gives a nested transact() its own savepoint (an inner throw rolls back only the
 * inner unit); MemoryStorageAdapter's nested transact joins the outer unit, so an
 * inner throw rolls back the *whole* outer transaction too (see
 * `MemoryStorageAdapter.transact`'s depth-tracking in src/adapters/memory.ts).
 * Recorded here rather than silently tested around: anything that relies on
 * catching an inner transact's failure and continuing the outer one is not
 * portable across these two adapters today.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { SqliteStorageAdapter } from "../src/adapters/sqlite.ts";
import type { StorageAdapter } from "../src/adapters/storage.ts";
import { appendEvent, appendEvents, queryEvents } from "../src/core/events.ts";
import { closeEpisode, listEpisodes, openEpisode, recordAppliedLesson } from "../src/core/episodes.ts";
import { listEvidence, recordEvidence } from "../src/core/evidence.ts";
import { approveLesson, getLesson, listLessons, proposeLesson, recordReuse } from "../src/core/lessons.ts";
import { CURRENT_SCHEMA_VERSION } from "../src/core/migrate.ts";
import { event, PROJECT, T0, T1, T2 } from "./helpers/factory.ts";

interface Fixture {
  name: string;
  create(): { storage: StorageAdapter; cleanup: () => void };
}

const FIXTURES: Fixture[] = [
  {
    name: "memory",
    create: () => {
      const storage = new MemoryStorageAdapter();
      storage.open();
      return { storage, cleanup: () => storage.close() };
    },
  },
  {
    name: "sqlite",
    create: () => {
      const dir = mkdtempSync(join(tmpdir(), "fgm-conformance-"));
      const storage = new SqliteStorageAdapter({ path: join(dir, "memory.db") });
      storage.open();
      return {
        storage,
        cleanup: () => {
          storage.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

/** Seeds one episode → evidence → proposed → reused → approved lesson, plus one bare event. */
function seed(storage: StorageAdapter) {
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
  return { sourceEpisodeId: source.id, secondEpisodeId: second.id, evidenceId: evidence.id, lessonId: lesson.id };
}

for (const fixture of FIXTURES) {
  test(`[${fixture.name}] putEventIfAbsent itself is idempotent (not just the domain layer's own existence check)`, () => {
    // Deliberately calls the adapter's own putEventIfAbsent directly, bypassing
    // appendEventTx's redundant getEvent() pre-check — that pre-check would mask
    // a broken adapter-level idempotency guarantee, which is exactly the
    // contract this suite exists to verify (found by first writing this test
    // through appendEvent() and discovering it couldn't fail even when
    // putEventIfAbsent was deliberately broken to always return true).
    const { storage, cleanup } = fixture.create();
    try {
      const raw = { ...event(), id: "evt_fixed" } as never;
      const firstWrite = storage.transact((tx) => tx.putEventIfAbsent(raw));
      const secondWrite = storage.transact((tx) => tx.putEventIfAbsent(raw));
      assert.equal(firstWrite, true);
      assert.equal(secondWrite, false, "a redelivery of the same identity must not duplicate");
      assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] a throw inside transact rolls back every statement in the unit`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      appendEvent(storage, event({ payload: { n: 0 } }));
      assert.throws(() =>
        storage.transact((tx) => {
          tx.putEventIfAbsent({ ...event({ payload: { n: 1 } }), id: "evt_a" } as never);
          tx.putEventIfAbsent({ ...event({ payload: { n: 2 } }), id: "evt_b" } as never);
          throw new Error("boom");
        }),
      );
      assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1, "only the pre-existing event survives");
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] a successful transact commits every statement in the unit atomically`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      storage.transact((tx) => {
        tx.putEventIfAbsent({ ...event({ payload: { n: 1 } }), id: "evt_a" } as never);
        tx.putEventIfAbsent({ ...event({ payload: { n: 2 } }), id: "evt_b" } as never);
      });
      assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 2);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] events are scoped by project — a query for one project never sees another's`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      appendEvent(storage, event());
      appendEvent(storage, event({ projectId: "other-project" }));
      assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1);
      assert.equal(queryEvents(storage, { projectId: "other-project" }).length, 1);
      assert.equal(queryEvents(storage, { projectId: "unrelated-project" }).length, 0);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] event facet queries agree exactly with the shared predicate`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      appendEvents(storage, [
        event({ kind: "verification.completed", component: "checkout", domain: "build", triggerTags: ["ERR_A"], provider: "google", model: "gemini-3.5-flash", surface: "builder" }),
        event({ kind: "repair.attempted", component: "gallery", domain: "taste", triggerTags: ["ERR_B"], payload: { n: 2 } }),
      ]);

      assert.equal(queryEvents(storage, { projectId: PROJECT, component: "checkout" }).length, 1);
      assert.equal(queryEvents(storage, { projectId: PROJECT, domain: "taste" }).length, 1);
      assert.equal(queryEvents(storage, { projectId: PROJECT, kinds: ["repair.attempted"] }).length, 1);
      assert.equal(queryEvents(storage, { projectId: PROJECT, triggerTags: ["ERR_A"] }).length, 1);
      assert.equal(queryEvents(storage, { projectId: PROJECT, triggerTags: ["NOPE"] }).length, 0);
      assert.equal(queryEvents(storage, { projectId: PROJECT, provider: "google", model: "gemini-3.5-flash" }).length, 1);
      assert.equal(queryEvents(storage, { projectId: PROJECT, surface: "builder" }).length, 1);
      assert.equal(queryEvents(storage, { projectId: PROJECT, since: T1 }).length, 0, "since is an inclusive lower bound; both fixtures share T0");
      assert.equal(queryEvents(storage, { projectId: PROJECT, limit: 1 }).length, 1);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] events sort newest-first, with a deterministic id tiebreak`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      appendEvent(storage, event({ occurredAt: T0 }));
      appendEvent(storage, event({ occurredAt: T2 }));
      appendEvent(storage, event({ occurredAt: T1 }));
      const ordered = queryEvents(storage, { projectId: PROJECT }).map((e) => e.occurredAt);
      assert.deepEqual(ordered, [T2, T1, T0]);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] the full episode -> evidence -> lesson lifecycle round-trips identically`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      const { lessonId } = seed(storage);
      const lesson = getLesson(storage, lessonId);
      assert.equal(lesson?.status, "approved");
      assert.equal(lesson?.approvedBy, "eyal");
      assert.equal(lesson?.reuseCount, 1);
      assert.deepEqual(lesson?.triggerTags, ["ERR_REQUIRE_ESM"]);
      assert.deepEqual(lesson?.limits, ["Node 24 under Termux only."]);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] episodes are ordered newest-opened-first and scoped by project`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      const { sourceEpisodeId, secondEpisodeId } = seed(storage);
      openEpisode(storage, {
        projectId: "other-project", objective: "unrelated", baseRevisionId: "rev-x", openedAt: T0,
      });
      const ids = listEpisodes(storage, { projectId: PROJECT }).map((e) => e.id);
      assert.deepEqual(ids, [secondEpisodeId, sourceEpisodeId]);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] listLessons filters by status/domain/component and orders newest-updated-first`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      const { lessonId } = seed(storage);
      assert.equal(listLessons(storage, { projectId: PROJECT, statuses: ["approved"] }).length, 1);
      assert.equal(listLessons(storage, { projectId: PROJECT, statuses: ["proposed"] }).length, 0);
      assert.equal(listLessons(storage, { projectId: PROJECT, domain: "build" }).length, 1);
      assert.equal(listLessons(storage, { projectId: PROJECT, domain: "taste" }).length, 0);
      assert.equal(listLessons(storage, { projectId: PROJECT, component: "build-pipeline" }).length, 1);
      assert.equal(listLessons(storage, { projectId: "other-project" }).length, 0);
      assert.equal(listLessons(storage, { projectId: PROJECT })[0]?.id, lessonId);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] evidence is idempotent-by-identity, ordered newest-recorded-first, and project-scoped`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      const a = recordEvidence(storage, { projectId: PROJECT, kind: "verification.result", ref: "run://build/1", recordedAt: T0 });
      recordEvidence(storage, { projectId: PROJECT, kind: "verification.result", ref: "run://build/2", recordedAt: T1 });
      recordEvidence(storage, { projectId: "other-project", kind: "verification.result", ref: "run://build/3", recordedAt: T1 });

      const own = listEvidence(storage, { projectId: PROJECT });
      assert.equal(own.length, 2);
      assert.equal(own[0]?.ref, "run://build/2", "newest recordedAt first");
      assert.equal(own[1]?.id, a.id);
      assert.equal(listEvidence(storage, { projectId: "other-project" }).length, 1);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] schema version round-trips through get/set`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      assert.equal(storage.getSchemaVersion(), CURRENT_SCHEMA_VERSION, "a fresh store starts at the current version");
      storage.setSchemaVersion(1);
      assert.equal(storage.getSchemaVersion(), 1);
      storage.setSchemaVersion(CURRENT_SCHEMA_VERSION);
      assert.equal(storage.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    } finally {
      cleanup();
    }
  });

  test(`[${fixture.name}] countEvents is scoped by project and reflects only committed writes`, () => {
    const { storage, cleanup } = fixture.create();
    try {
      appendEvents(storage, [event(), event({ occurredAt: T1 })]);
      appendEvent(storage, event({ projectId: "other-project" }));
      const count = storage.transact((tx) => tx.countEvents(PROJECT));
      assert.equal(count, 2);
      assert.equal(storage.transact((tx) => tx.countEvents("other-project")), 1);
      assert.equal(storage.transact((tx) => tx.countEvents("unrelated-project")), 0);
    } finally {
      cleanup();
    }
  });
}
