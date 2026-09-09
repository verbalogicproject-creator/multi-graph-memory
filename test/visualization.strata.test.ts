/**
 * The three strata, drawn.
 *
 * Phase 2 built a derived graph of 219 nodes, installed the `component` join
 * key and proved the join returns rows -- and the only renderer in the package
 * drew nineteen governance nodes and could not see any of it. These tests are
 * about the join being visible, and about every layer that contributes nothing
 * saying why.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { GraphMemory } from "../src/port.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { projectGraph, serializeGraph } from "../src/visualization/exporter.ts";
import { JOIN_EDGE_KIND } from "../src/visualization/strata.ts";
import { ThreeJSGraphRenderer, strataNoteHtml } from "../src/visualization/threejs_renderer.ts";

function memory(): GraphMemory {
  return new GraphMemory({
    storage: new MemoryStorageAdapter(),
    scope: { workspace: "multi-app", projectId: "demo" },
  });
}

/** A structure.db with one file, one component inside it, and one external. */
function structureFixture(dir: string): string {
  const path = join(dir, "structure.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, level TEXT NOT NULL, kind TEXT NOT NULL,
      format TEXT, name TEXT NOT NULL, qualname TEXT, file_path TEXT NOT NULL,
      line_start INTEGER, component TEXT, provenance TEXT NOT NULL,
      content_digest TEXT, docstring TEXT, summary TEXT);
    CREATE TABLE edges (id TEXT PRIMARY KEY, edge_type TEXT NOT NULL,
      source_id TEXT NOT NULL, target_id TEXT NOT NULL, confidence REAL,
      extracted_by TEXT, metadata TEXT DEFAULT '{}');
    CREATE TABLE build_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO nodes VALUES
      ('f1','file','file',NULL,'App.tsx',NULL,'App.tsx',NULL,'repo:demo/App.tsx','derived',NULL,NULL,NULL),
      -- A component carries its FILE's key. Indexing it would let row order
      -- decide which node a context record attaches to.
      ('c1','component','component',NULL,'App',NULL,'App.tsx',NULL,'repo:demo/App.tsx','derived',NULL,NULL,NULL),
      ('x1','external','external',NULL,'Suspense',NULL,'',NULL,NULL,'derived',NULL,NULL,NULL);
    INSERT INTO edges VALUES
      ('e1','contains','f1','c1',NULL,NULL,'{}'),
      ('e2','renders','c1','x1',NULL,NULL,'{}');
    INSERT INTO build_meta VALUES ('unresolved_edges','0');
  `);
  db.close();
  return path;
}

/** A portfolio brain: one episode about that file, one about somewhere else. */
function contextFixture(dir: string): string {
  const path = join(dir, "portfolio.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE episodes (id TEXT PRIMARY KEY, content TEXT, kind TEXT,
      session_id TEXT, batch TEXT, tags TEXT, metadata TEXT, method TEXT,
      schema_version INTEGER, created_at TEXT);
    INSERT INTO episodes VALUES
      ('ep1','App.tsx defines AppContent()','interface',NULL,NULL,NULL,
       '{"component":"repo:demo/App.tsx"}',NULL,1,'2026-09-09T00:00:00Z'),
      ('ep2','something about another repo','interface',NULL,NULL,NULL,
       '{"component":"repo:elsewhere/x.ts"}',NULL,1,'2026-09-09T00:00:01Z'),
      ('ep3','a fact about no file at all','milestone',NULL,NULL,NULL,
       '{}',NULL,1,'2026-09-09T00:00:02Z');
  `);
  db.close();
  return path;
}

test("with no strata requested, the graph is exactly what it has always been", () => {
  const projection = projectGraph(memory(), new Date("2026-09-09T00:00:00Z"));
  assert.deepEqual(projection.graphData.nodes, [], "governance only, and this cluster is empty");
  assert.deepEqual(projection.graphData.edges, []);
  // The optional seam: absent files change nothing about what is drawn.
  assert.equal(projection.strata.length, 3);
  for (const leg of projection.strata.filter((s) => s.stratum !== "governance")) {
    assert.equal(leg.available, false);
    assert.match(String(leg.reason), /not requested/);
  }
});

test("a requested stratum whose file is missing reports the path it tried", () => {
  const projection = projectGraph(memory(), undefined, {
    structureDb: "/nowhere/structure.db",
    contextDb: "/nowhere/portfolio.db",
  });
  const structure = projection.strata.find((s) => s.stratum === "structure")!;
  assert.equal(structure.available, false);
  assert.match(String(structure.reason), /\/nowhere\/structure\.db/, "names the path it tried");
  assert.match(String(structure.reason), /brain structure build/, "and the command that fixes it");
});

test("the join is drawn, and only to the file that owns the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgm-strata-"));
  const projection = projectGraph(memory(), undefined, {
    structureDb: structureFixture(dir),
    contextDb: contextFixture(dir),
  });

  const joins = projection.graphData.edges.filter((e) => e.type === JOIN_EDGE_KIND);
  assert.equal(joins.length, 1, "one context record matched, so one edge");
  assert.equal(joins[0]!.target, "structure:f1", "attached to the FILE, never to its component");

  // The component node shares the file's key. If it were indexed too, the
  // winner would depend on row order -- the exact shape of a Phase 2 bug.
  assert.ok(
    !joins.some((e) => e.target === "structure:c1"),
    "a component must not claim its file's join key",
  );

  const context = projection.strata.find((s) => s.stratum === "context")!;
  assert.match(String(context.reason), /carry no component and are not drawn/);
  assert.match(String(context.reason), /1 did not match/);
});

test("every node says which stratum it came from", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgm-strata-"));
  const projection = projectGraph(memory(), undefined, {
    structureDb: structureFixture(dir),
    contextDb: contextFixture(dir),
  });
  const strata = new Set(projection.graphData.nodes.map((n) => n.stratum));
  assert.deepEqual([...strata].sort(), ["context", "structure"]);
  assert.equal(
    projection.graphData.nodes.filter((n) => n.type === "structure:external").length,
    1,
    "an external node is drawn, not dropped",
  );
});

test("the page opens on governance, with the other layers hidden but present", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgm-strata-"));
  const projection = projectGraph(memory(), undefined, {
    structureDb: structureFixture(dir),
    contextDb: contextFixture(dir),
  });
  const out = join(dir, "g.html");
  new ThreeJSGraphRenderer().generateHtml(projection.graphData, out, "t", projection.strata);
  const html = readFileSync(out, "utf8");

  // 219 structure nodes against 19 governance ones buries what you came for.
  assert.match(html, /const hidden = new Set\(\[/, "the hidden set is seeded, not empty");
  assert.ok(html.includes('"structure:file"'), "and it names the structural types");
  assert.ok(html.includes('data-stratum="structure"'), "a button brings the layer back");
  assert.ok(!html.includes('data-stratum="governance"'), "governance has no button; it is always on");
});

test("a layer contributing nothing says so in the page, not only in the log", () => {
  const note = strataNoteHtml([
    { stratum: "governance", available: true, nodes: 19, edges: 10 },
    { stratum: "structure", available: false, nodes: 0, edges: 0, reason: "no readable graph at /x" },
    { stratum: "context", available: true, nodes: 0, edges: 0, reason: "none carried a component" },
  ]);
  assert.match(note, /governance: 19 nodes, 10 edges/);
  assert.match(note, /structure: none — no readable graph at \/x/);
  // Present-but-empty is a different answer from absent, and both must speak.
  assert.match(note, /context: 0 nodes, 0 edges — none carried a component/);
  assert.equal((note.match(/stratum-row/g) ?? []).length, 3, "every layer is listed, always");
});

test("the json export carries the per-stratum report", () => {
  const dir = mkdtempSync(join(tmpdir(), "mgm-strata-"));
  const projection = projectGraph(memory(), new Date("2026-09-09T00:00:00Z"), {
    structureDb: structureFixture(dir),
  });
  const parsed = JSON.parse(serializeGraph(projection));
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.strata.length, 3);
  assert.ok(parsed.nodes.every((n: { stratum?: string }) => n.stratum));
});
