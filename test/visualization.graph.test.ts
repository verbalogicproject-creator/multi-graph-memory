import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import {
  deterministicColor,
  EXTERNAL_SCRIPTS,
  readVendoredLibrary,
  ThreeJSGraphRenderer,
  VENDORED_LIBRARY,
  VENDORED_VERSION,
  vendoredLibraryPath,
} from "../src/visualization/threejs_renderer.ts";

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
  // Assert the property rather than one spelling of the mapping: the value must
  // survive into the payload AND be bound to node size.
  assert.match(html, /"val":\s*\d/, "val is carried into the render payload");
  assert.match(html, /\.nodeVal\(/, "and is bound to node size");
});

test("every colour is legible against the page background", () => {
  // The donor's palette named ITS node types and none of this package's, so
  // every memory node fell through to a hash of its type string -- which has no
  // contrast guarantee. `evidence` resolved to #1f2024 and `lesson:proposed` to
  // #162d2f on a #0a0e27 page: invisible. This asserts the class of bug is gone,
  // for known types and for a type nobody has defined yet.
  const renderer = new ThreeJSGraphRenderer();
  const bg = { r: 0x0a, g: 0x0e, b: 0x27 };
  const distanceFromBackground = (hex: string): number => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return Math.sqrt((r - bg.r) ** 2 + (g - bg.g) ** 2 + (b - bg.b) ** 2);
  };

  const known = [
    "episode:verified", "episode:failed", "episode:abandoned", "episode:open",
    "lesson:proposed", "lesson:qualified", "lesson:approved",
    "lesson:contradicted", "lesson:revoked", "evidence",
  ];
  const palette = renderer.generateColorPalette(new Set(known));
  for (const type of known) {
    const color = palette[type]!;
    assert.match(color, /^#[0-9a-f]{6}$/i, `${type} has a colour`);
    assert.ok(distanceFromBackground(color) > 90, `${type} (${color}) must not vanish into the background`);
  }

  // Distinctness: two types must not be given the same colour.
  assert.equal(new Set(Object.values(palette)).size, known.length, "every type is distinguishable");

  // And the fallback for unknown types varies hue only, so it is always legible.
  for (const invented of ["architecture:module", "doc:section", "zzz", "a", "artifact:file"]) {
    const color = deterministicColor(invented);
    assert.ok(
      distanceFromBackground(color) > 90,
      `an unforeseen type (${invented} -> ${color}) must still be visible`,
    );
  }
});

test("the html export loads nothing over the network", () => {
  const { memory } = seeded();
  const dir = mkdtempSync(join(tmpdir(), "mgm-graph-"));
  const out = join(dir, "nested", "graph.html");
  exportGraphHtml(memory, out, "demo title");
  const html = readFileSync(out, "utf8");

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /demo title/);

  // This test used to be called "self-contained and pins every external
  // script", and asserted neither: it checked that the script list matched a
  // declared list (which is not the same as being empty) and that each src
  // matched /@\d+(\.\d+)*$/ -- a regex `@1` satisfies. `@1` is a range, so the
  // page rendered differently as upstream published. Both halves now hold.
  assert.deepEqual(EXTERNAL_SCRIPTS, [], "the declared external list is empty");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [], "the page references no script by URL");
  assert.doesNotMatch(html, /src\s*=\s*["']https?:/i, "no absolute http(s) resource at all");
});

test("the library is inlined at an exact version, and the file proves its own version", () => {
  const { memory } = seeded();
  const dir = mkdtempSync(join(tmpdir(), "mgm-graph-"));
  const out = join(dir, "graph.html");
  exportGraphHtml(memory, out, "demo title");
  const html = readFileSync(out, "utf8");

  // A range would let two renders of the same data differ. The version is in
  // the filename AND in the file's own first line; `readVendoredLibrary`
  // refuses when they disagree, so a swapped file cannot masquerade.
  assert.match(VENDORED_VERSION, /^\d+\.\d+\.\d+$/, "an exact version, never a range");
  assert.ok(VENDORED_LIBRARY.includes(VENDORED_VERSION), "the filename carries the version");
  assert.ok(html.includes(`// Version ${VENDORED_VERSION} 3d-force-graph`),
    "the library's own banner is present in the page, so the bytes really are inlined");
  assert.ok(html.includes("ForceGraph3D"), "and it is the library, not a stub");

  // The renderer's own script must come after the library it calls.
  assert.ok(html.indexOf("// Version") < html.indexOf("ForceGraph3D()("),
    "the library is defined before the page uses it");
});

test("a library that cannot be inlined safely is refused, not escaped", () => {
  // `</script` inside the bytes would close the tag early and produce a page
  // that loads clean and draws nothing. Today's pinned file has none; this
  // asserts the guard exists for the version bump that introduces one.
  const source = readFileSync(vendoredLibraryPath(), "utf8");
  assert.ok(!source.toLowerCase().includes("</script"), "the pinned library is inlinable");
  assert.throws(
    () => {
      const bad = `// Version ${VENDORED_VERSION} 3d-force-graph\nvar x = "</script>";`;
      const dir = mkdtempSync(join(tmpdir(), "mgm-vendor-"));
      mkdirSync(join(dir, "vendor"), { recursive: true });
      writeFileSync(join(dir, "vendor", VENDORED_LIBRARY), bad, "utf8");
      readVendoredLibrary(dir);
    },
    /cannot be inlined into a <script> tag safely/,
  );
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
  assert.equal(parsed.schemaVersion, 3, "3 since nodes carry `stratum` and the envelope carries `strata`");
  // Three entries, always -- including the layers that contributed nothing.
  // A consumer must be able to tell "not asked for" from "asked for and empty".
  assert.deepEqual(
    parsed.strata.map((s: { stratum: string }) => s.stratum),
    ["governance", "structure", "context"],
  );
  for (const leg of parsed.strata as { available: boolean; reason?: string }[]) {
    if (!leg.available) assert.ok(leg.reason, "an absent layer must say why");
  }
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
  assert.match(readFileSync(out, "utf8"), /0 nodes .{1,8} 0 edges/);
});

test("clusters group one causal story, and are numbered deterministically", () => {
  const storage = new MemoryStorageAdapter();
  const memory = new GraphMemory({ storage, scope: { workspace: "multi-app", projectId: "clusters" } });

  // Story one: an episode that produced a lesson citing evidence.
  const first = memory.openEpisode({ objective: "first story", baseRevisionId: "rev-1" });
  const evidence = memory.recordEvidence({ kind: "verification.result", ref: "run://1" });
  memory.closeEpisode(first.id, "failed");
  memory.proposeLesson({
    trigger: "story one trigger",
    recommendation: "story one recommendation",
    scope: ["build"], domain: "build",
    sourceEpisodeIds: [first.id], evidenceIds: [evidence.id],
  });

  // Story two: an unrelated episode that touches none of the above.
  const lonely = memory.openEpisode({ objective: "unrelated attempt", baseRevisionId: "rev-9" });
  memory.closeEpisode(lonely.id, "abandoned");

  const { graphData } = projectGraph(memory);
  const clusterOf = (id: string) => graphData.nodes.find((n) => n.id === id)?.cluster;

  assert.equal(clusterOf(first.id), clusterOf(evidence.id), "one story is one cluster");
  assert.notEqual(clusterOf(first.id), clusterOf(lonely.id), "unconnected work is a separate cluster");

  // The largest component is always 0, so the numbering does not shuffle between
  // runs -- the HTML export is asserted byte-for-byte elsewhere.
  assert.equal(clusterOf(first.id), 0, "the largest component is cluster 0");
  assert.equal(clusterOf(lonely.id), 1);

  const again = projectGraph(memory);
  assert.deepEqual(
    again.graphData.nodes.map((n) => n.cluster),
    graphData.nodes.map((n) => n.cluster),
    "cluster ids are stable across runs",
  );
});
