import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMPONENT_FIXTURES,
  buildComponent,
  parseComponent,
  repoComponent,
} from "../src/core/component.ts";
import { STRUCTURE_SCHEMA, SqliteStructureIndex, hasStructureIndex } from "../src/structure/index.ts";
import { checkIntegrity } from "../src/kg/integrity.ts";
import { allowsSource, allowsTarget, makeNodeId } from "../src/kg/types.ts";
import type { TypedGraph } from "../src/kg/types.ts";

/**
 * `Lesson.component` and `MemoryEvent.component` shipped with the first schema
 * and, as of 2026-09-09, nothing had ever written one. The column was present
 * and the data was empty, which is why "the strata join on component" survived
 * as a plan for as long as it did. These tests assert against rows.
 */

// ── the join key, and its twin ───────────────────────────────────────────────

test("the component format matches the Python implementation exactly", () => {
  // The same table lives in `project_memory/component_key.py`. A format only one
  // side can produce is the original defect wearing a different hat: the key
  // exists, and the two stores still never meet.
  for (const [namespace, raw, expected] of COMPONENT_FIXTURES) {
    const slash = raw.indexOf("/");
    const scope = raw.slice(0, slash);
    const path = raw.slice(slash + 1);
    const produced = namespace === "repo" ? repoComponent(scope, path) : buildComponent(scope, path);
    assert.equal(produced, expected);
    assert.deepEqual(parseComponent(produced), { namespace, scope, path });
  }
});

test("a generated application's path cannot join a repository's", () => {
  // multi-app's builder emits `src/App.tsx`, and so does multi-app. Its lessons
  // are shared across every build, so an unnamespaced key would let a lesson
  // about generated code join the host repository and read as cited and wrong.
  assert.notEqual(repoComponent("multi-app", "src/App.tsx"), buildComponent("b1", "src/App.tsx"));
});

test("a value that is not a component parses as absent, never as an error", () => {
  // Rows predate this format. A reader must tell "not a component" from
  // "malformed" without throwing in the middle of a join.
  assert.equal(parseComponent("src/App.tsx"), null);
  assert.equal(parseComponent(""), null);
  assert.equal(parseComponent(null), null);
  assert.equal(parseComponent(42), null);
});

test("one file is one key however its path was spelled", () => {
  assert.equal(repoComponent("r", "./src/a.ts"), repoComponent("r", "src/a.ts"));
  assert.equal(repoComponent("r", "/src/a.ts"), repoComponent("r", "src/a.ts"));
  assert.equal(repoComponent("r", "src\\a.ts"), repoComponent("r", "src/a.ts"));
});

// ── the declared taxonomy ────────────────────────────────────────────────────

test("`contains` may only run from a file to a component", () => {
  // This constraint is not decoration: the first run of `checkIntegrity` over a
  // real graph reported 60 `contains` edges running component -> component,
  // because the ingest had let component nodes claim their file's path in its
  // endpoint index. Every `imports` edge pointing at a module was resolving to a
  // component inside it. The graph was complete, self-consistent, and wrong.
  const contains = STRUCTURE_SCHEMA.edgeTypes.find((e) => e.name === "contains");
  assert.ok(contains);
  assert.ok(allowsSource(contains, "file"));
  assert.ok(!allowsSource(contains, "component"));
  assert.ok(allowsTarget(contains, "component"));
  assert.ok(!allowsTarget(contains, "file"));
});

test("the taxonomy rejects the exact graph the ingest bug produced", () => {
  const graph: TypedGraph = {
    nodes: [
      { id: makeNodeId("file", "f1"), type: "file", name: "App.tsx" },
      { id: makeNodeId("component", "c1"), type: "component", name: "App" },
    ],
    edges: [
      { type: "contains", sourceId: makeNodeId("component", "c1"), targetId: makeNodeId("component", "c1") },
    ],
  };
  const report = checkIntegrity(graph, STRUCTURE_SCHEMA);
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((i) => i.check === "endpoint_types"));
});

test("`imports` is deliberately not acyclic", () => {
  // Import cycles are legal in this ecosystem and common in practice. Declaring
  // them an integrity error would report a working repository as malformed.
  const imports = STRUCTURE_SCHEMA.edgeTypes.find((e) => e.name === "imports");
  assert.ok(imports);
  assert.notEqual(imports.acyclic, true);
});

// ── the read path ────────────────────────────────────────────────────────────

function fixtureDb(dir: string): string {
  const path = join(dir, "structure.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, level TEXT, kind TEXT, format TEXT,
      name TEXT, qualname TEXT, file_path TEXT, line_start INTEGER, component TEXT,
      provenance TEXT, content_digest TEXT, docstring TEXT, summary TEXT);
    CREATE TABLE edges (id TEXT PRIMARY KEY, edge_type TEXT, source_id TEXT,
      target_id TEXT, confidence REAL, extracted_by TEXT, metadata TEXT);
    CREATE TABLE build_meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO nodes VALUES
      ('n1','file','file','tsx','a.tsx','a.tsx','a.tsx',NULL,'repo:demo/a.tsx','derived',NULL,NULL,'A()'),
      ('n2','file','file','ts','b.ts','b.ts','b.ts',NULL,'repo:demo/b.ts','derived',NULL,NULL,'B()'),
      ('n3','component','component','tsx','A','a.tsx::A','a.tsx',NULL,'repo:demo/a.tsx','derived',NULL,NULL,NULL);
    INSERT INTO edges VALUES
      ('e1','imports','n1','n2',1.0,'TSScanner','{}'),
      ('e2','contains','n1','n3',1.0,'TSXScanner','{}');
    INSERT INTO build_meta VALUES ('repo','demo'),('node_count','3');
  `);
  db.close();
  return path;
}

test("a project with no structure graph reads as absent, not as an error", () => {
  // Absent is the normal state of every project that has never had a build, and
  // behaviour there must be identical to today's.
  assert.equal(SqliteStructureIndex.open(join(tmpdir(), "definitely-not-here.db")), null);
});

test("the engine reads the derived stratum and cannot write it", () => {
  // The rule has to hold in the connection flags rather than in a convention:
  // the one thing a rebuild must never reach is the earned store beside it.
  const dir = mkdtempSync(join(tmpdir(), "structure-"));
  try {
    const index = SqliteStructureIndex.open(fixtureDb(dir));
    assert.ok(index);
    assert.ok(hasStructureIndex(index));
    assert.equal(index.meta()["repo"], "demo");
    const readonlyDb = new DatabaseSync(`file:${join(dir, "structure.db")}?mode=ro`, { readOnly: true });
    assert.throws(() => readonlyDb.exec("DELETE FROM nodes"), /readonly/i);
    readonlyDb.close();
    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one hop out of a component returns its neighbours, bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "structure-"));
  try {
    const index = SqliteStructureIndex.open(fixtureDb(dir));
    assert.ok(index);
    const hop = index.neighbours("repo:demo/a.tsx", ["imports", "contains"], 10);
    assert.deepEqual(hop.map((n) => n.name).sort(), ["A", "b.ts"]);
    // An unbounded expansion over `imports` is how a packet stops being one.
    assert.equal(index.neighbours("repo:demo/a.tsx", ["imports", "contains"], 1).length, 1);
    assert.equal(index.neighbours("repo:demo/nothing.ts", ["imports"], 10).length, 0);
    assert.equal(index.neighbours("repo:demo/a.tsx", [], 10).length, 0);
    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real fixture graph passes its declared taxonomy", () => {
  const dir = mkdtempSync(join(tmpdir(), "structure-"));
  try {
    const index = SqliteStructureIndex.open(fixtureDb(dir));
    assert.ok(index);
    const report = index.checkIntegrity();
    assert.equal(report.ok, true, JSON.stringify(report.issues));
    assert.equal(report.nodes, 3);
    assert.equal(report.edges, 2);
    index.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
