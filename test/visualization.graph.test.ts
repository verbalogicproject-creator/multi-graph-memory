import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GraphMemory } from "../src/port.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import {
  EDGE_KINDS,
  exportGraphHtml,
  exportGraphJson,
  projectGraph,
  serializeGraph,
} from "../src/visualization/index.ts";

function seeded() {
  const storage = new MemoryStorageAdapter();
  const memory = new GraphMemory({ storage, scope: { workspace: "multi-app", projectId: "build-demo" } });

  const first = memory.openEpisode({ objective: "repair the build", baseRevisionId: "rev-1" });
  const evidence = memory.recordEvidence({ kind: "verification.result", ref: "run://build/1" });
  memory.closeEpisode(first.id, "verified");

  const lesson = memory.proposeLesson({
    trigger: "vite build fails with ERR_REQUIRE_ESM",
    recommendation: "Pin the plugin to its ESM build.",
    scope: ["build"],
    domain: "build",
    sourceEpisodeIds: [first.id],
    evidenceIds: [evidence.id],
    limits: ["Observed on Node 24."],
  });

  return { memory, first, evidence, lesson };
}

test("the projection carries the lineage as named edges, not inferred ones", () => {
  const { memory, first, evidence, lesson } = seeded();
  const projection = projectGraph(memory);

  const ids = new Set(projection.graphData.nodes.map((n) => n.id));
  assert.ok(ids.has(first.id), "episode is a node");
  assert.ok(ids.has(lesson.id), "lesson is a node");
  assert.ok(ids.has(evidence.id), "evidence is a node");

  const produced = projection.graphData.edges.find((e) => e.type === "produced");
  assert.deepEqual(
    { source: produced?.source, target: produced?.target },
    { source: first.id, target: lesson.id },
    "the episode that produced the lesson is edged to it",
  );

  const cites = projection.graphData.edges.find((e) => e.type === "cites");
  assert.deepEqual(
    { source: cites?.source, target: cites?.target },
    { source: lesson.id, target: evidence.id },
    "the lesson cites its evidence",
  );

  for (const edge of projection.graphData.edges) {
    assert.ok(
      (EDGE_KINDS as readonly string[]).includes(edge.type),
      `edge type ${edge.type} is outside the declared vocabulary`,
    );
  }
});

test("the missing reuse edge is what shows a lesson is unpromoted", () => {
  const { memory, lesson } = seeded();

  const before = projectGraph(memory);
  assert.equal(
    before.graphData.edges.filter((e) => e.type === "reused-in").length,
    0,
    "a proposed lesson has no reuse edge",
  );
  const node = before.graphData.nodes.find((n) => n.id === lesson.id);
  assert.equal(node?.type, "lesson:proposed");
  assert.match(String(node?.description), /not promoted: no reuse in a distinct episode/);

  // Reuse it in a genuinely distinct, verified episode. The lesson must have
  // been recorded as applied there first -- reuse that was never attempted is
  // refused, which is the ratchet doing its job.
  const second = memory.openEpisode({ objective: "repair the build again", baseRevisionId: "rev-2" });
  const secondEvidence = memory.recordEvidence({ kind: "verification.result", ref: "run://build/2" });
  memory.recordAppliedLesson(second.id, lesson.id);
  memory.closeEpisode(second.id, "verified");
  memory.recordReuse(lesson.id, second.id, [secondEvidence.id]);

  const after = projectGraph(memory);
  const reuse = after.graphData.edges.find((e) => e.type === "reused-in");
  assert.deepEqual(
    { source: reuse?.source, target: reuse?.target },
    { source: second.id, target: lesson.id },
    "the second episode now carries the ratchet edge",
  );
  assert.equal(
    after.graphData.nodes.find((n) => n.id === lesson.id)?.type,
    "lesson:qualified",
  );
});

test("node size reflects degree, and reaches the rendered payload", () => {
  const { memory, lesson, evidence } = seeded();
  const projection = projectGraph(memory);

  const lessonVal = projection.graphData.nodes.find((n) => n.id === lesson.id)?.val ?? 0;
  const evidenceVal = projection.graphData.nodes.find((n) => n.id === evidence.id)?.val ?? 0;
  assert.ok(lessonVal > evidenceVal, "the lesson has more edges than the evidence it cites");

  const dir = mkdtempSync(join(tmpdir(), "mgm-graph-"));
  const out = join(dir, "graph.html");
  exportGraphHtml(memory, out);
  const html = readFileSync(out, "utf8");
  // The donor dropped `val` when mapping to gData, so sizing never rendered.
  assert.match(html, /val: n\.val/, "val is carried into the render payload");
  assert.match(html, /\.nodeVal\(/, "and is bound to node size");
});

test("the html export is self-contained and pins its one external script", () => {
  const { memory } = seeded();
  const dir = mkdtempSync(join(tmpdir(), "mgm-graph-"));
  const out = join(dir, "nested", "graph.html");
  exportGraphHtml(memory, out, "demo title");
  const html = readFileSync(out, "utf8");

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /demo title/);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["https://unpkg.com/3d-force-graph@1"], "exactly one, pinned");
});

test("graph content is html-escaped rather than interpolated raw", () => {
  const storage = new MemoryStorageAdapter();
  const memory = new GraphMemory({ storage, scope: { workspace: "multi-app", projectId: "build-demo" } });
  const episode = memory.openEpisode({
    objective: "</script><img src=x onerror=alert(1)>",
    baseRevisionId: "rev-1",
  });
  memory.closeEpisode(episode.id, "verified");

  const dir = mkdtempSync(join(tmpdir(), "mgm-graph-"));
  const out = join(dir, "graph.html");
  exportGraphHtml(memory, out);
  const html = readFileSync(out, "utf8");

  assert.ok(!html.includes("<img src=x onerror="), "the raw tag never lands in the document");
  assert.match(html, /\\u003c\\\/script\\u003e|\\u003cimg/, "it is escaped inside the JSON payload");
});

test("export runs the redaction gate, so a graph is not a way around it", () => {
  // A credential cannot be reached through the store at all: the persistence
  // gate refuses the lesson before it is written. So this asserts the SECOND
  // line -- that the projection itself gates, and a picture is not a hole even
  // if poisoned data arrived by some other route.
  const poisoned = {
    scope: { workspace: "multi-app", projectId: "build-demo" },
    listEpisodes: () => [
      {
        id: "epi_x",
        projectId: "build-demo",
        objective: "wire the provider",
        baseRevisionId: "rev-1",
        openedAt: "2026-09-01T00:00:00.000Z",
        closedAt: "2026-09-01T00:01:00.000Z",
        outcome: "verified" as const,
        appliedLessonIds: [],
      },
    ],
    listLessons: () => [
      {
        id: "les_x",
        projectId: "build-demo",
        status: "proposed" as const,
        trigger: "auth fails",
        recommendation: "set api_key=AIzaSyD8SEvTMUiBDlzn1e2AWZ5Zy9nPUfGH-5oX",
        scope: ["api-usage"],
        domain: "api-usage" as const,
        sourceEpisodeIds: ["epi_x"],
        evidenceIds: [],
        contradictionIds: [],
        limits: [],
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    listEvidence: () => [],
  };

  assert.throws(
    () => projectGraph(poisoned as never),
    (error: unknown) => {
      assert.match(String(error), /Refused at the export gate/i);
      return true;
    },
    "the export gate refuses a projection carrying a credential",
  );
});

test("the persistence gate stops a credential before export is even reachable", () => {
  const storage = new MemoryStorageAdapter();
  const memory = new GraphMemory({ storage, scope: { workspace: "multi-app", projectId: "build-demo" } });
  const episode = memory.openEpisode({ objective: "wire the provider", baseRevisionId: "rev-1" });
  const evidence = memory.recordEvidence({ kind: "verification.result", ref: "run://build/1" });
  memory.closeEpisode(episode.id, "verified");

  assert.throws(
    () =>
      memory.proposeLesson({
        trigger: "auth fails",
        recommendation: "set api_key=AIzaSyD8SEvTMUiBDlzn1e2AWZ5Zy9nPUfGH-5oX",
        scope: ["api-usage"],
        domain: "api-usage",
        sourceEpisodeIds: [episode.id],
        evidenceIds: [evidence.id],
        limits: [],
      }),
    (error: unknown) => {
      assert.match(String(error), /Refused at the persistence gate/i);
      return true;
    },
  );
});

test("the json export names its edge vocabulary and round-trips", () => {
  const { memory } = seeded();
  const dir = mkdtempSync(join(tmpdir(), "mgm-graph-"));
  const out = join(dir, "graph.json");
  const projection = exportGraphJson(memory, out);

  const parsed = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.scope, { workspace: "multi-app", projectId: "build-demo" });
  assert.deepEqual(parsed.edgeKinds, [...EDGE_KINDS]);
  assert.equal(parsed.nodes.length, projection.graphData.nodes.length);
  assert.equal(parsed.edges.length, projection.graphData.edges.length);
  assert.equal(parsed.counts.edges, projection.graphData.edges.length);
  assert.equal(serializeGraph(projection), readFileSync(out, "utf8"));
});

test("an empty cluster renders rather than crashing", () => {
  const storage = new MemoryStorageAdapter();
  const memory = new GraphMemory({ storage, scope: { workspace: "multi-app", projectId: "empty" } });
  const projection = projectGraph(memory);
  assert.deepEqual(projection.counts, { episodes: 0, lessons: 0, evidence: 0, edges: 0 });

  const dir = mkdtempSync(join(tmpdir(), "mgm-graph-"));
  const out = join(dir, "graph.html");
  exportGraphHtml(memory, out);
  assert.match(readFileSync(out, "utf8"), /N: 0 \| E: 0/);
});
