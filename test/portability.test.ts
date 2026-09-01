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
