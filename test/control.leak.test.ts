import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphMemoryError } from "../src/core/errors.ts";
import { ControlStore } from "../src/control/registry.ts";
import { promoteToControlTier, scanForProjectContent } from "../src/control/generalize.ts";
import type { Lesson } from "../src/core/types.ts";
import type { NoProprietaryContentDecision } from "../src/control/types.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

const T = "2026-08-31T00:00:00.000Z";

const DECISION: NoProprietaryContentDecision = {
  decidedBy: "eyal",
  decidedAt: T,
  rationale: "Reviewed both sources; the generalized text names no product, path or client.",
  evidenceRefs: ["review://control-tier/1"],
};

function lesson(id: string, projectId: string, over: Partial<Lesson> = {}): Lesson {
  return {
    id, status: "approved", trigger: "t", recommendation: "r", scope: ["build"],
    sourceEpisodeIds: ["e1"], evidenceIds: ["ev1"], contradictionIds: [],
    projectId, domain: "build", limits: [], createdAt: T, updatedAt: T,
    reuseCount: 1, deviationIds: [], ...over,
  };
}

function baseInput() {
  return {
    trigger: "A bundler fails when a plugin ships only CommonJS",
    recommendation: "Prefer a plugin build that publishes an ESM entrypoint.",
    scope: ["build", "bundler"],
    sources: [
      { projectId: "alpha", lesson: lesson("les_a", "alpha") },
      { projectId: "beta", lesson: lesson("les_b", "beta") },
    ],
    approvedBy: "eyal",
    decision: DECISION,
    now: T,
  };
}

test("gate 2: one project is not enough, however many episodes it had", () => {
  const input = baseInput();
  input.sources = [
    { projectId: "alpha", lesson: lesson("les_a", "alpha") },
    { projectId: "alpha", lesson: lesson("les_a2", "alpha") },
  ];
  assert.throws(
    () => promoteToControlTier(input),
    (e: unknown) => code(e) === "LESSON_TRANSITION_INVALID",
  );
});

test("gate 1: an unqualified or contradicted source blocks promotion", () => {
  const proposed = baseInput();
  proposed.sources[0]!.lesson = lesson("les_a", "alpha", { status: "proposed" });
  assert.throws(
    () => promoteToControlTier(proposed),
    (e: unknown) => code(e) === "LESSON_TRANSITION_INVALID",
  );

  const contradicted = baseInput();
  contradicted.sources[0]!.lesson = lesson("les_a", "alpha", { contradictionIds: ["evd_x"] });
  assert.throws(
    () => promoteToControlTier(contradicted),
    (e: unknown) => code(e) === "CONTRADICTION_BLOCKS_PROMOTION",
  );
});

test("gate 3: promotion requires a named human approver", () => {
  const input = { ...baseInput(), approvedBy: "  " };
  assert.throws(
    () => promoteToControlTier(input),
    (e: unknown) => code(e) === "HUMAN_APPROVAL_REQUIRED",
  );
});

test("gate 4: automated de-identification is not proof — the decision must be recorded", () => {
  for (const decision of [
    undefined,
    { decidedBy: "", decidedAt: T, rationale: "x", evidenceRefs: [] },
    { decidedBy: "eyal", decidedAt: T, rationale: "   ", evidenceRefs: [] },
  ]) {
    assert.throws(
      () => promoteToControlTier({ ...baseInput(), decision: decision as never }),
      (e: unknown) => code(e) === "CONTROL_TIER_CONTENT_REFUSED",
    );
  }
});

test("project content in the generalized text is refused", () => {
  const withProjectId = { ...baseInput(), trigger: "In alpha, the bundler fails" };
  assert.throws(
    () => promoteToControlTier(withProjectId),
    (e: unknown) => code(e) === "CONTROL_TIER_CONTENT_REFUSED",
  );

  const withComponent = baseInput();
  withComponent.sources[0]!.lesson = lesson("les_a", "alpha", { component: "checkout-flow" });
  withComponent.recommendation = "Rework the checkout-flow plugin entrypoint.";
  assert.throws(
    () => promoteToControlTier(withComponent),
    (e: unknown) => code(e) === "CONTROL_TIER_CONTENT_REFUSED",
  );

  const withPath = { ...baseInput(), recommendation: "Edit ./src/internal/secret-pricing.ts to fix it." };
  assert.throws(
    () => promoteToControlTier(withPath),
    (e: unknown) => code(e) === "CONTROL_TIER_CONTENT_REFUSED",
  );

  const withFlagged = { ...baseInput(), proprietaryTokens: ["Bundler"] };
  assert.throws(
    () => promoteToControlTier(withFlagged),
    (e: unknown) => code(e) === "CONTROL_TIER_CONTENT_REFUSED",
  );
});

test("a genuinely generalized lesson promotes, storing pointers not content", () => {
  const promoted = promoteToControlTier(baseInput());

  assert.deepEqual(promoted.sourceProjects, ["alpha", "beta"]);
  assert.deepEqual(promoted.pointers, [
    { projectId: "alpha", lessonId: "les_a" },
    { projectId: "beta", lessonId: "les_b" },
  ]);
  assert.equal(promoted.approvedBy, "eyal");
  assert.equal(promoted.decision.decidedBy, "eyal");

  const serialized = JSON.stringify(promoted);
  assert.ok(!serialized.includes("sourceEpisodeIds"), "no cluster record bodies may be copied");
  assert.ok(!serialized.includes('"evidenceIds"'), "no evidence bodies may be copied");
});

test("the scanner catches identifiers, components, paths and flagged tokens", () => {
  assert.deepEqual(scanForProjectContent("clean generalized text", ["alpha"], [], []), []);
  assert.equal(scanForProjectContent("about alpha here", ["alpha"]).length, 1);
  assert.equal(scanForProjectContent("the checkout-flow broke", [], [], ["checkout-flow"]).length, 1);
  assert.equal(scanForProjectContent("see ./src/internal/thing.ts", []).length, 1);
  assert.equal(scanForProjectContent("uses Acme SDK", [], ["acme"]).length, 1);
});

test("the control store defines no table that could hold project records", () => {
  const dir = mkdtempSync(join(tmpdir(), "fgm-control-"));
  try {
    const store = new ControlStore(join(dir, "control.db"));
    store.open();

    const tables = store.tableNames();
    // Policy and pointers only. `admissions` is cross-project retrieval policy,
    // deliberately held here rather than in a cluster so a cluster cannot widen
    // its own scope by writing to its own database.
    assert.deepEqual(tables.sort(), ["admissions", "generalized_lessons", "projects", "schedule"]);
    for (const forbidden of ["events", "episodes", "evidence", "lessons"]) {
      assert.ok(!tables.includes(forbidden), `control tier must not define an "${forbidden}" table`);
    }

    store.registerProject({
      projectId: "alpha", workspace: "w", databasePath: "/tmp/alpha.db",
      schemaVersion: 1, registeredAt: T, lastSeenAt: T,
    });
    assert.equal(store.listProjects().length, 1);
    assert.equal(store.listProjects()[0]?.databasePath, "/tmp/alpha.db", "a pointer, not a copy");

    store.putGeneralizedLesson(promoteToControlTier(baseInput()));
    const stored = store.listGeneralizedLessons();
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0]?.sourceProjects, ["alpha", "beta"]);

    store.setSchedule({ key: "lesson-extraction", lastRunAt: T, note: "batch" });
    assert.equal(store.getSchedule("lesson-extraction")?.note, "batch");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
