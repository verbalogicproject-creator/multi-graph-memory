/**
 * End-to-end dogfood: the real learning loop, on this repository, using three
 * defects genuinely found while building it.
 *
 * Runs the full cycle -- episode, events, evidence, proposal, distinct-episode
 * reuse, human approval, retrieval, deviation, documents, export/import -- and
 * asserts the governance holds at every step.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageAdapter } from "../src/adapters/sqlite.ts";
import { GraphMemory, ModelContextPort } from "../src/port.ts";
import { renderPacket } from "../src/core/packet.ts";
import { projectDocuments } from "../src/docs/projector.ts";
import { isGraphMemoryError } from "../src/core/errors.ts";

const DIR = process.env.DOGFOOD_DIR ?? join(tmpdir(), "multi-graph-memory-dogfood");
const DB = join(DIR, "build-demo.db");

function ok(label: string, detail = ""): void {
  console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ""}`);
}

function mustRefuse(label: string, fn: () => unknown): void {
  try {
    fn();
    throw new Error(`EXPECTED REFUSAL: ${label}`);
  } catch (error) {
    if (!isGraphMemoryError(error)) throw error;
    console.log(`  ✔ refused [${error.code}] — ${label}`);
  }
}

async function main(): Promise<void> {
  rmSync(DIR, { recursive: true, force: true });
  const storage = new SqliteStorageAdapter({ path: DB });
  storage.open();
  const memory = new GraphMemory({ storage, scope: { workspace: "multi-app", projectId: "build-demo" } });

  console.log("\n1. Episode one — the redaction defect\n");
  const ep1 = memory.openEpisode({ objective: "Build the five-gate redaction boundary", baseRevisionId: "phase-1" });
  memory.appendEvent({
    kind: "candidate.created", occurredAt: new Date().toISOString(),
    projectId: memory.scope.projectId, cycleId: "cycle-1", phaseId: "phase-1",
    episodeId: ep1.id, component: "core/redaction", domain: "diagnostics",
    payload: { note: "Wrote the credential detector with a fixed-length AIza pattern." },
    evidenceIds: [],
  });
  const failure = memory.recordEvidence({
    kind: "verification.result",
    ref: "test://redaction.test.ts#google-api-key",
    summary: "A 36-char key slipped the gate; the pattern required exactly 35 trailing chars plus a word boundary.",
  });
  memory.appendEvent({
    kind: "repair.attempted", occurredAt: new Date().toISOString(),
    projectId: memory.scope.projectId, cycleId: "cycle-1", phaseId: "phase-1",
    episodeId: ep1.id, component: "core/redaction", domain: "diagnostics",
    triggerTags: ["FALSE_NEGATIVE", "SECRET_DETECTION"],
    payload: { fix: "Relaxed the quantifier to {35,} so longer tokens still match." },
    evidenceIds: [failure.id],
  });
  memory.closeEpisode(ep1.id, "verified");
  ok("episode closed verified", `${memory.queryEvents({ episodeId: ep1.id }).length} events`);

  const lesson = memory.proposeLesson({
    trigger: "A secret detector uses a fixed-length quantifier on a distinctive prefix",
    recommendation:
      "Anchor on the prefix and use an open-ended quantifier. A security gate should over-match rather than let a slightly longer token through.",
    scope: ["security", "redaction", "regex"],
    domain: "diagnostics",
    component: "core/redaction",
    triggerTags: ["FALSE_NEGATIVE", "SECRET_DETECTION"],
    sourceEpisodeIds: [ep1.id],
    evidenceIds: [failure.id],
    limits: ["Applies to prefix-anchored credential shapes, not to free-form entropy checks."],
  });
  ok("lesson proposed", lesson.status);

  console.log("\n2. The ratchet refuses every shortcut\n");
  mustRefuse("approving a lesson that has not been reused", () => memory.approveLesson(lesson.id, "eyal"));
  mustRefuse("counting the source episode as reuse", () =>
    memory.recordReuse(lesson.id, ep1.id, [failure.id]),
  );

  const unrelated = memory.openEpisode({ objective: "Unrelated work", baseRevisionId: "phase-2" });
  memory.closeEpisode(unrelated.id, "verified");
  mustRefuse("reuse in an episode that never applied the lesson", () =>
    memory.recordReuse(lesson.id, unrelated.id, [failure.id]),
  );

  console.log("\n3. Episode two — genuine reuse, then human approval\n");
  const ep2 = memory.openEpisode({ objective: "Audit remaining credential patterns", baseRevisionId: "phase-3" });
  memory.recordAppliedLesson(ep2.id, lesson.id);
  const reuseEvidence = memory.recordEvidence({
    kind: "verification.result",
    ref: "test://redaction.test.ts#all-patterns",
    summary: "Applied the lesson to every rule; 12 redaction tests pass.",
  });
  memory.closeEpisode(ep2.id, "verified");
  const qualified = memory.recordReuse(lesson.id, ep2.id, [reuseEvidence.id]);
  ok("qualified by distinct-episode reuse", `reuseCount=${qualified.reuseCount}`);

  const approved = memory.approveLesson(lesson.id, "eyal");
  ok("approved by a human", `${approved.approvedBy} at ${approved.approvedByHumanAt}`);

  console.log("\n4. A second lesson, and the taste lesson that must never reach a direction turn\n");
  const ep3 = memory.openEpisode({ objective: "Write vacuous-test guard", baseRevisionId: "phase-4" });
  const testEvidence = memory.recordEvidence({ kind: "verification.result", ref: "test://lessons.reuse.test.ts" });
  memory.closeEpisode(ep3.id, "verified");
  const testLesson = memory.proposeLesson({
    trigger: "A test asserts a tautology and passes without exercising its subject",
    recommendation: "Assert on observable behaviour. A test that cannot fail is worse than no test, because it reads as coverage.",
    scope: ["testing"], domain: "repair", component: "test",
    sourceEpisodeIds: [ep3.id], evidenceIds: [testEvidence.id],
  });
  const ep4 = memory.openEpisode({ objective: "Re-audit the suite", baseRevisionId: "phase-5" });
  memory.recordAppliedLesson(ep4.id, testLesson.id);
  memory.closeEpisode(ep4.id, "verified");
  memory.recordReuse(testLesson.id, ep4.id, [testEvidence.id]);
  memory.approveLesson(testLesson.id, "eyal");

  const ep5 = memory.openEpisode({ objective: "Style the CLI banner", baseRevisionId: "phase-6" });
  const tasteEvidence = memory.recordEvidence({ kind: "human.decision", ref: "decision://cli-banner" });
  memory.closeEpisode(ep5.id, "verified");
  const tasteLesson = memory.proposeLesson({
    trigger: "CLI output felt dense",
    recommendation: "Prefer more vertical spacing between sections.",
    scope: ["cli", "visual"], domain: "taste",
    sourceEpisodeIds: [ep5.id], evidenceIds: [tasteEvidence.id],
  });
  const ep6 = memory.openEpisode({ objective: "Style the doctor output", baseRevisionId: "phase-7" });
  memory.recordAppliedLesson(ep6.id, tasteLesson.id);
  memory.closeEpisode(ep6.id, "verified");
  memory.recordReuse(tasteLesson.id, ep6.id, [tasteEvidence.id]);
  memory.approveLesson(tasteLesson.id, "eyal");
  ok("three approved lessons", memory.listLessons({ statuses: ["approved"] }).map((l) => l.domain).join(", "));

  console.log("\n5. Retrieval through the model-facing port\n");
  const port = new ModelContextPort(memory);
  const packet = await port.readMemoryContext({ task: "my secret detector is missing a credential" });
  ok("packet returned", `${packet.items.length} item(s), authority=${packet.authority}`);
  console.log(`\n${renderPacket(packet).split("\n").map((l) => `    ${l}`).join("\n")}\n`);

  const direction = await port.readMemoryContext({ task: "produce three design directions", directionGeneration: true });
  const leakedTaste = direction.items.filter((i) => i.domain === "taste").length;
  ok("direction turn excluded taste", `${leakedTaste} taste item(s), ${direction.omissions.droppedForDirectionBar} barred`);
  if (leakedTaste !== 0) throw new Error("DIRECTION GATE LEAKED");

  console.log("\n6. Deviation is observed, not assumed to contradict\n");
  const ep7 = memory.openEpisode({ objective: "Try entropy detection instead", baseRevisionId: "phase-8" });
  memory.recordAppliedLesson(ep7.id, lesson.id);
  const deviation = memory.recordDeviation({
    lessonId: lesson.id, episodeId: ep7.id, cycleId: "cycle-1", phaseId: "phase-9",
    comparison: {
      lessonRecommendation: "Anchor on the prefix with an open quantifier.",
      takenApproach: "Used a Shannon-entropy heuristic with no prefix anchor.",
      observedOutcome: "Caught the same tokens with fewer rules.",
    },
    context: { component: "core/redaction", triggerTags: ["FALSE_NEGATIVE"], scope: ["security", "redaction"] },
  });
  ok("deviation recorded", `lesson still ${memory.getLesson(lesson.id)?.status}`);
  if (memory.getLesson(lesson.id)?.status !== "approved") throw new Error("DEVIATION WRONGLY CONTRADICTED");

  mustRefuse("qualifying a deviation whose episode has not verified", () =>
    memory.qualifyDeviationAsContradiction({
      lessonId: lesson.id, deviationEventId: deviation.event.id,
      episodeId: ep7.id, verificationEvidenceId: testEvidence.id,
    }),
  );

  memory.closeEpisode(ep7.id, "verified");
  const contradicted = memory.qualifyDeviationAsContradiction({
    lessonId: lesson.id, deviationEventId: deviation.event.id,
    episodeId: ep7.id, verificationEvidenceId: testEvidence.id,
  });
  ok("verified deviation became contradiction evidence", `status=${contradicted.status}`);
  mustRefuse("re-approving a contradicted lesson", () => memory.approveLesson(lesson.id, "eyal"));

  console.log("\n7. Documents, export and re-import\n");
  const docs = projectDocuments(memory, DIR);
  ok("documents generated", docs.written.map((p) => p.split("/").pop()).join(", "));

  const bundle = memory.export();
  ok("exported", `checksum ${bundle.checksum.slice(0, 16)}…`);

  const fresh = new SqliteStorageAdapter({ path: join(DIR, "reimported.db") });
  fresh.open();
  const freshMemory = new GraphMemory({ storage: fresh, scope: { workspace: "multi-app", projectId: "build-demo" } });
  const imported = freshMemory.import(bundle);
  ok("re-imported into a fresh store", `${imported.imported.lessons} lessons, ${imported.imported.events} events`);

  const before = memory.export("2026-01-01T00:00:00.000Z").checksum;
  const after = freshMemory.export("2026-01-01T00:00:00.000Z").checksum;
  ok("round-trip checksum identical", before === after ? "yes" : "NO");
  if (before !== after) throw new Error("ROUND TRIP LOST FIDELITY");

  mustRefuse("importing into another project without an approved re-home", () =>
    freshMemory.import(bundle, { targetProjectId: "someone-else" }),
  );

  storage.close();
  fresh.close();
  console.log("\nDogfood complete. Every governance gate held.\n");
}

main().catch((error) => {
  console.error("\nDOGFOOD FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
