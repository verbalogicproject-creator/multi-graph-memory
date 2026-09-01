import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { appendEvent, queryEvents } from "../src/core/events.ts";
import {
  computeBundleChecksum,
  exportProject,
  importBundle,
  serializeBundle,
  validateBundle,
} from "../src/core/portability.ts";
import { CURRENT_SCHEMA_VERSION, planMigration } from "../src/core/migrate.ts";
import { listLessons } from "../src/core/lessons.ts";
import { deriveEventId, deriveLessonId } from "../src/core/canonical.ts";
import { event, makeStorage, PROJECT, reuseEpisode, seedProposedLesson, T2 } from "./helpers/factory.ts";
import { recordReuse } from "../src/core/lessons.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

function seedFull() {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  appendEvent(s.storage, event({ payload: { note: "a build ran" } }));
  return s;
}

test("export is single-project and round-trips into a fresh store", () => {
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);

  assert.equal(bundle.projectId, PROJECT);
  assert.equal(bundle.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.match(bundle.checksum, /^[0-9a-f]{64}$/);

  const fresh = makeStorage();
  const result = importBundle(fresh, bundle);

  assert.equal(result.imported.lessons, 1);
  assert.equal(result.imported.episodes, 2);
  assert.ok(result.imported.events >= 1);
  assert.equal(listLessons(fresh, { projectId: PROJECT })[0]?.status, "qualified");
});

test("export is deterministic: same state, identical bytes", () => {
  const s = seedFull();
  const a = serializeBundle(exportProject(s.storage, { projectId: PROJECT }, T2));
  const b = serializeBundle(exportProject(s.storage, { projectId: PROJECT }, T2));
  assert.equal(a, b);
});

test("a tampered bundle is refused on checksum", () => {
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);
  const tampered = {
    ...bundle,
    lessons: bundle.lessons.map((l) => ({ ...l, recommendation: "do something else entirely" })),
  };
  assert.throws(
    () => validateBundle(tampered),
    (e: unknown) => code(e) === "CHECKSUM_MISMATCH",
  );
});

test("an unsupported schema version is refused, with a valid checksum", () => {
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);
  // Recompute the checksum for the bumped version so the VERSION check is what
  // fires, not the integrity check standing in for it. One past current: a
  // version this build has never heard of, rather than a literal that silently
  // becomes supported the next time the schema moves.
  const bumped = { ...bundle, schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
  const valid = { ...bumped, checksum: computeBundleChecksum(bumped) };

  assert.throws(
    () => validateBundle(valid),
    (e: unknown) => code(e) === "SCHEMA_VERSION_UNSUPPORTED",
  );
});

test("a version with no migration route is refused at planning", () => {
  assert.throws(
    () => planMigration(0),
    (e: unknown) => code(e) === "SCHEMA_VERSION_UNSUPPORTED",
  );
  // A downgrade would silently drop newer fields, so it is refused outright.
  assert.throws(
    () => planMigration(3, 1),
    (e: unknown) => code(e) === "MIGRATION_ROUTE_INVALID",
  );
  assert.deepEqual(planMigration(1, 1).steps, []);
});

test("importing into a different project without approval is refused", () => {
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);
  const fresh = makeStorage();

  assert.throws(
    () => importBundle(fresh, bundle, { targetProjectId: "someone-elses-project" }),
    (e: unknown) => code(e) === "REHOME_NOT_APPROVED",
  );
  assert.equal(queryEvents(fresh, { projectId: "someone-elses-project" }).length, 0);
});

test("an approved re-home retargets every record", () => {
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);
  const fresh = makeStorage();

  const result = importBundle(fresh, bundle, {
    targetProjectId: "renamed",
    rehome: {
      approvedBy: "eyal",
      reason: "project renamed",
      fromProjectId: PROJECT,
      toProjectId: "renamed",
      approvedAt: T2,
    },
  });

  assert.equal(result.projectId, "renamed");
  assert.equal(listLessons(fresh, { projectId: "renamed" }).length, 1);
  assert.equal(listLessons(fresh, { projectId: PROJECT }).length, 0);
});

test("re-importing the same bundle is idempotent", () => {
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);
  const fresh = makeStorage();

  importBundle(fresh, bundle);
  const before = queryEvents(fresh, { projectId: PROJECT }).length;
  const second = importBundle(fresh, bundle);

  assert.equal(queryEvents(fresh, { projectId: PROJECT }).length, before);
  assert.equal(second.imported.events, 0);
  assert.ok(second.skippedDuplicates > 0);
});

test("a malformed bundle is refused before the checksum is even considered", () => {
  assert.throws(
    () => validateBundle({ nonsense: true }),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});

/* ------------------------------------------------------------------ rehome -- */

const REHOME = {
  approvedBy: "eyal",
  reason: "moving the build under a new id",
  fromProjectId: PROJECT,
  toProjectId: "renamed",
  approvedAt: T2,
};

test("a re-homed record's id still authenticates its own content", () => {
  // projectId is part of what an id hashes. Rewriting the field while keeping the
  // old id leaves a record whose id no longer matches its content -- which breaks
  // every consumer that treats the id as a content checksum.
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);

  const fresh = makeStorage();
  importBundle(fresh, bundle, { targetProjectId: "renamed", rehome: REHOME });

  for (const event of queryEvents(fresh, { projectId: "renamed" })) {
    const { id, ...body } = event;
    assert.equal(id, deriveEventId(body as Record<string, unknown>), `event ${id} must re-derive to itself`);
    assert.equal(event.projectId, "renamed");
  }
  for (const lesson of listLessons(fresh, { projectId: "renamed" })) {
    assert.equal(
      lesson.id,
      deriveLessonId(lesson.projectId, lesson.trigger, lesson.recommendation, lesson.domain),
      "lesson id must re-derive to itself",
    );
  }
});

test("re-homing remaps references instead of leaving them dangling", () => {
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);

  const fresh = makeStorage();
  importBundle(fresh, bundle, { targetProjectId: "renamed", rehome: REHOME });

  const episodeIds = new Set(fresh.transact((tx) => tx.listEpisodes("renamed")).map((e) => e.id));
  const evidenceIds = new Set(fresh.transact((tx) => tx.listEvidence("renamed")).map((e) => e.id));

  const lessons = listLessons(fresh, { projectId: "renamed" });
  assert.ok(lessons.length > 0);
  for (const lesson of lessons) {
    for (const id of lesson.sourceEpisodeIds) {
      assert.ok(episodeIds.has(id), `source episode ${id} must exist after the re-home`);
    }
    for (const id of lesson.evidenceIds) {
      assert.ok(evidenceIds.has(id), `cited evidence ${id} must exist after the re-home`);
    }
    // The reuse edge is the ratchet; a re-home must not quietly break it.
    if (lesson.reuseEpisodeId !== undefined) {
      assert.ok(episodeIds.has(lesson.reuseEpisodeId), "the reuse episode survives the re-home");
    }
  }
  assert.equal(lessons[0]?.status, "qualified", "and the lesson keeps the status it earned");
});

test("re-homing twice is idempotent rather than duplicating", () => {
  // This is the consequence of the id bug that would have bitten silently: with
  // stale ids, the second import computes different ids from what is stored and
  // writes a second copy of everything.
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);

  const fresh = makeStorage();
  const first = importBundle(fresh, bundle, { targetProjectId: "renamed", rehome: REHOME });
  const second = importBundle(fresh, bundle, { targetProjectId: "renamed", rehome: REHOME });

  assert.ok(first.imported.lessons > 0);
  assert.equal(second.imported.lessons, 0, "nothing new on the second import");
  assert.equal(second.imported.events, 0);
  assert.equal(second.imported.episodes, 0);
  assert.equal(second.imported.evidence, 0);
  assert.ok(second.skippedDuplicates > 0, "they are recognised as duplicates");

  assert.equal(listLessons(fresh, { projectId: "renamed" }).length, first.imported.lessons);
});

test("an import that is not a re-home leaves ids untouched", () => {
  const s = seedFull();
  const bundle = exportProject(s.storage, { projectId: PROJECT }, T2);
  const fresh = makeStorage();
  importBundle(fresh, bundle);

  const ids = new Set(queryEvents(fresh, { projectId: PROJECT }).map((e) => e.id));
  for (const event of bundle.events) {
    assert.ok(ids.has(event.id), "the same project keeps the identity it exported with");
  }
});
