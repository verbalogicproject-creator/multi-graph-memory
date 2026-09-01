import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECKS,
  byCheck,
  checkIntegrity,
  errorsOf,
  findCycle,
  warningsOf,
} from "../src/kg/integrity.ts";
import {
  allowsSource,
  allowsTarget,
  makeNodeId,
  splitNodeId,
  validateSchema,
} from "../src/kg/types.ts";
import type { KGSchema, TypedGraph } from "../src/kg/types.ts";

/**
 * The parity fixture.
 *
 * These are the exact nodes, edges and schema that were run through the Python
 * original (`kg_toolkit.check_integrity`) to produce EXPECTED below. The point of
 * the test is not that the checker finds problems — it is that it finds the *same*
 * problems, with the same severities, subjects and message text, as the
 * implementation it was translated from.
 */
const SCHEMA: KGSchema = {
  name: "parity",
  nodeTypes: [{ name: "file" }, { name: "klass" }],
  edgeTypes: [
    { name: "contains", sourceTypes: ["file"], targetTypes: ["klass"] },
    { name: "inherits", sourceTypes: ["klass"], targetTypes: ["klass"], acyclic: true },
    { name: "loops" },
  ],
};

const GRAPH: TypedGraph = {
  nodes: [
    { id: "file::a.py", type: "file" },
    { id: "klass::A", type: "klass" },
    { id: "klass::B", type: "klass" },
    { id: "klass::C", type: "klass" },
    { id: "klass::Lonely", type: "klass" },
  ],
  edges: [
    { type: "contains", sourceId: "file::a.py", targetId: "klass::A" },
    { type: "contains", sourceId: "file::a.py", targetId: "file::missing.py" },
    { type: "contains", sourceId: "klass::A", targetId: "klass::B" },
    { type: "inherits", sourceId: "klass::A", targetId: "klass::B" },
    { type: "inherits", sourceId: "klass::B", targetId: "klass::C" },
    { type: "inherits", sourceId: "klass::C", targetId: "klass::A" },
    { type: "loops", sourceId: "klass::B", targetId: "klass::B" },
  ],
};

/** Verbatim output of the Python implementation on the fixture above. */
const EXPECTED = {
  ok: false,
  nodes: 5,
  edges: 7,
  byCheck: {
    dangling_edges: 1,
    undeclared_types: 0,
    endpoint_types: 1,
    cycles: 1,
    orphan_nodes: 1,
    self_loops: 1,
  },
  issues: [
    {
      check: "cycles",
      severity: "error",
      subject: "klass::A",
      message:
        "edge type 'inherits' is declared acyclic but a cycle exists: " +
        "klass::A -> klass::B -> klass::C -> klass::A",
    },
    {
      check: "dangling_edges",
      severity: "error",
      subject: "contains::file::a.py->file::missing.py",
      message: "edge 'contains' has a target node 'file::missing.py' that does not exist",
    },
    {
      check: "endpoint_types",
      severity: "error",
      subject: "contains::klass::A->klass::B",
      message: "edge 'contains' has source type 'klass', but 'contains' only allows ['file']",
    },
    {
      check: "orphan_nodes",
      severity: "warning",
      subject: "klass::Lonely",
      message: "node 'klass::Lonely' has no edges (isolated)",
    },
    {
      check: "self_loops",
      severity: "warning",
      subject: "loops::klass::B->klass::B",
      message: "edge 'loops' points from 'klass::B' to itself",
    },
  ],
};

test("integrity report matches the Python original on the parity fixture", () => {
  const report = checkIntegrity(GRAPH, SCHEMA);
  assert.equal(report.ok, EXPECTED.ok);
  assert.equal(report.nodes, EXPECTED.nodes);
  assert.equal(report.edges, EXPECTED.edges);
  assert.deepEqual(byCheck(report), EXPECTED.byCheck);

  const actual = report.issues
    .map((i) => ({
      check: i.check as string,
      severity: i.severity as string,
      subject: i.subject,
      message: i.message,
    }))
    .sort((a, b) =>
      a.check !== b.check
        ? a.check.localeCompare(b.check)
        : a.subject !== b.subject
          ? a.subject.localeCompare(b.subject)
          : a.message.localeCompare(b.message),
    );
  assert.deepEqual(actual, EXPECTED.issues);
});

test("errors fail a graph and warnings do not", () => {
  const clean: TypedGraph = {
    nodes: [
      { id: "file::a.py", type: "file" },
      { id: "klass::A", type: "klass" },
    ],
    edges: [{ type: "contains", sourceId: "file::a.py", targetId: "klass::A" }],
  };
  const report = checkIntegrity(clean, SCHEMA);
  assert.equal(report.ok, true);
  assert.equal(errorsOf(report).length, 0);

  // An isolated node is a warning, so it must not flip ok to false.
  const lonely: TypedGraph = { nodes: [...clean.nodes, { id: "klass::Z", type: "klass" }], edges: clean.edges };
  const withWarning = checkIntegrity(lonely, SCHEMA);
  assert.equal(withWarning.ok, true);
  assert.equal(warningsOf(withWarning).length, 1);
});

test("an undeclared node or edge type is an error", () => {
  const graph: TypedGraph = {
    nodes: [{ id: "ghost::X", type: "ghost" }],
    edges: [{ type: "haunts", sourceId: "ghost::X", targetId: "ghost::X" }],
  };
  const report = checkIntegrity(graph, SCHEMA, { checks: ["undeclared_types"] });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.issues.map((i) => i.message).sort(),
    [
      "edge has undeclared edge type 'haunts'",
      "node 'ghost::X' has undeclared node type 'ghost'",
    ],
  );
});

test("an undeclared edge type is reported once, not also as an endpoint violation", () => {
  const graph: TypedGraph = {
    nodes: [{ id: "klass::A", type: "klass" }, { id: "klass::B", type: "klass" }],
    edges: [{ type: "unknown", sourceId: "klass::A", targetId: "klass::B" }],
  };
  const report = checkIntegrity(graph, SCHEMA);
  assert.deepEqual(byCheck(report).undeclared_types, 1);
  assert.deepEqual(byCheck(report).endpoint_types, 0);
});

test("a misspelled check throws instead of silently running nothing", () => {
  // Rule 4: a check that quietly does nothing reports success it did not earn.
  assert.throws(
    () => checkIntegrity(GRAPH, SCHEMA, { checks: ["dangling_edgs"] }),
    /unknown integrity check/,
  );
});

test("selecting checks preserves the canonical order regardless of argument order", () => {
  const report = checkIntegrity(GRAPH, SCHEMA, { checks: ["self_loops", "dangling_edges"] });
  assert.deepEqual([...report.checksRun], ["dangling_edges", "self_loops"]);
});

test("findCycle is deterministic and survives a chain deeper than the call stack", () => {
  // The Python original recurses once per node; this depth would exhaust its
  // stack. The iterative port must return the same answer without one.
  const depth = 50_000;
  const edges = Array.from({ length: depth }, (_, i) => ({
    type: "inherits",
    sourceId: `n::${String(i).padStart(6, "0")}`,
    targetId: `n::${String(i + 1).padStart(6, "0")}`,
  }));
  assert.equal(findCycle(edges, "inherits"), null);

  // Close the chain into a cycle; it must now be found.
  edges.push({ type: "inherits", sourceId: `n::${String(depth).padStart(6, "0")}`, targetId: "n::000000" });
  const cycle = findCycle(edges, "inherits");
  assert.ok(cycle);
  assert.equal(cycle[0], "n::000000");
  assert.equal(cycle[cycle.length - 1], "n::000000");
  assert.equal(cycle.length, depth + 2);

  // Deterministic: the same graph yields the same cycle every run.
  assert.deepEqual(findCycle(edges, "inherits"), cycle);
});

test("a self-loop is not counted as a cycle", () => {
  // The original excludes self-edges from the cycle adjacency; self_loops owns
  // that defect, and reporting it twice would double-count one problem.
  const edges = [{ type: "inherits", sourceId: "klass::A", targetId: "klass::A" }];
  assert.equal(findCycle(edges, "inherits"), null);
});

test("an empty endpoint constraint allows any type", () => {
  const any = { name: "loops" };
  assert.equal(allowsSource(any, "anything"), true);
  assert.equal(allowsTarget(any, "anything"), true);
  const constrained = { name: "contains", sourceTypes: ["file"] };
  assert.equal(allowsSource(constrained, "file"), true);
  assert.equal(allowsSource(constrained, "klass"), false);
  assert.equal(allowsSource(constrained, undefined), false);
});

test("node ids round-trip through the shared :: convention", () => {
  assert.equal(makeNodeId("finding", "a/b#c"), "finding::a/b#c");
  assert.deepEqual(splitNodeId("finding::a/b#c"), { type: "finding", qualname: "a/b#c" });
  // A bare id has no type half rather than a guessed one.
  assert.deepEqual(splitNodeId("bare"), { type: null, qualname: "bare" });
});

test("a schema that constrains an edge to an undeclared node type is refused", () => {
  const broken: KGSchema = {
    name: "broken",
    nodeTypes: [{ name: "file" }, { name: "file" }],
    edgeTypes: [{ name: "contains", targetTypes: ["nonexistent"], weight: -1 }],
  };
  assert.deepEqual(validateSchema(broken), [
    'duplicate node type "file"',
    'edge type "contains" has negative weight -1',
    'edge type "contains" constrains its target to undeclared node type "nonexistent"',
  ]);
  assert.deepEqual(validateSchema(SCHEMA), []);
});

test("every declared check name is reachable", () => {
  // Rule 4 applied to the check list itself: a check nobody can select is a
  // check that silently never runs.
  for (const name of CHECKS) {
    const report = checkIntegrity(GRAPH, SCHEMA, { checks: [name] });
    assert.deepEqual([...report.checksRun], [name]);
  }
});
