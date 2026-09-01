/**
 * TRANSLATED — see PROVENANCE.md
 * Origin : /root/projects/kg_toolkit/kg_toolkit/integrity.py (Eyal Nof, Apache-2.0)
 *
 * Deterministic integrity checks — the part that says a graph is *malformed*, and
 * exactly why.
 *
 * A graph built by extraction or by many hands accumulates defects that silently
 * corrupt every answer built on it: edges pointing at nodes that do not exist,
 * inheritance cycles, edges wired between the wrong kinds of thing. The engine
 * this was distilled from *dropped* bad edges without a word. Here every defect
 * is reported with a subject and a reason, so the source can be fixed.
 *
 * Why this exists in this package: `src/adapters/sqlite.ts` sets
 * `PRAGMA foreign_keys = ON` while no table declares a foreign key, so the pragma
 * enforces nothing; and `src/visualization/exporter.ts` skips a dangling
 * reference rather than reporting it. Both are correct not to invent data. Both
 * currently make a dangling reference invisible, which is the failure
 * `absence-is-not-a-result` names.
 *
 * Changes from the Python:
 *   - operates on a plain `TypedGraph` rather than a storage manager, so the
 *     checker is pure and testable without a database;
 *   - `findCycle` is iterative rather than recursive. The original recurses once
 *     per node and would exhaust the stack on a deep chain; the traversal order
 *     and the cycle it reports are unchanged;
 *   - severities, check names, check order and messages are preserved, so a
 *     report from either implementation reads the same.
 */

import type { EdgeType, GraphEdge, KGSchema, TypedGraph } from "./types.ts";
import { allowsSource, allowsTarget, edgeTypeNames, findEdgeType, nodeTypeNames } from "./types.ts";

/** Every check, in the canonical order a report runs them. */
export const CHECKS = [
  "dangling_edges",
  "undeclared_types",
  "endpoint_types",
  "cycles",
  "orphan_nodes",
  "self_loops",
] as const;

export type CheckName = (typeof CHECKS)[number];

/**
 * Which checks are contract violations rather than likely gaps.
 *
 * An orphan node or a self-loop is usually a question about the data. A dangling
 * edge is always a broken graph.
 */
export const ERROR_CHECKS: ReadonlySet<CheckName> = new Set<CheckName>([
  "dangling_edges",
  "undeclared_types",
  "endpoint_types",
  "cycles",
]);

export type Severity = "error" | "warning";

export interface Issue {
  readonly check: CheckName;
  readonly severity: Severity;
  /** Human-readable and actionable: what is wrong, and with what. */
  readonly message: string;
  /** The offending node id, or a `type::src->tgt` edge key. */
  readonly subject: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface IntegrityReport {
  /** True iff no error-severity issue was raised. Warnings do not fail a graph. */
  readonly ok: boolean;
  readonly issues: readonly Issue[];
  readonly nodes: number;
  readonly edges: number;
  readonly checksRun: readonly CheckName[];
}

export function errorsOf(report: IntegrityReport): readonly Issue[] {
  return report.issues.filter((i) => i.severity === "error");
}

export function warningsOf(report: IntegrityReport): readonly Issue[] {
  return report.issues.filter((i) => i.severity === "warning");
}

/** Issue counts per check, including the checks that found nothing. */
export function byCheck(report: IntegrityReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of report.checksRun) counts[c] = 0;
  for (const i of report.issues) counts[i.check] = (counts[i.check] ?? 0) + 1;
  return counts;
}

/**
 * Format a value the way Python's `repr` does for a plain string.
 *
 * Not decoration: it makes an issue message from this implementation
 * byte-identical to one from the Python original, so the parity test can compare
 * whole messages rather than a structural subset. Node ids in this codebase do
 * not contain quotes; if one ever does, the two implementations would diverge
 * here and the parity test is what would say so.
 */
function q(value: string): string {
  return `'${value}'`;
}

/** Python's `repr` of a list of strings: `['a', 'b']`. */
function qList(values: readonly string[]): string {
  return `[${values.map(q).join(", ")}]`;
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.type}${"::"}${edge.sourceId}->${edge.targetId}`;
}

/**
 * Run the deterministic integrity checks over a graph.
 *
 * `checks` selects a subset; the canonical order is preserved regardless of the
 * order given. An unknown check name throws rather than being ignored — a
 * misspelled check that silently runs nothing would report success it did not
 * earn.
 */
export function checkIntegrity(
  graph: TypedGraph,
  schema: KGSchema,
  options: { readonly checks?: readonly string[] } = {},
): IntegrityReport {
  let run: readonly CheckName[] = CHECKS;
  if (options.checks) {
    const requested = new Set(options.checks);
    const unknown = [...requested].filter((c) => !(CHECKS as readonly string[]).includes(c));
    if (unknown.length > 0) {
      throw new Error(
        `unknown integrity check(s): ${JSON.stringify(unknown.sort())}; ` +
          `available: ${JSON.stringify([...CHECKS])}`,
      );
    }
    run = CHECKS.filter((c) => requested.has(c));
  }
  const selected = new Set(run);
  const issues: Issue[] = [];

  const nodeType = new Map<string, string>();
  for (const n of graph.nodes) nodeType.set(n.id, n.type);

  // ── dangling_edges ──────────────────────────────────────────────────────
  if (selected.has("dangling_edges")) {
    for (const e of graph.edges) {
      const ends: Array<["source" | "target", string]> = [];
      if (!nodeType.has(e.sourceId)) ends.push(["source", e.sourceId]);
      if (!nodeType.has(e.targetId)) ends.push(["target", e.targetId]);
      for (const [end, missing] of ends) {
        issues.push({
          check: "dangling_edges",
          severity: "error",
          message: `edge ${q(e.type)} has a ${end} node ${q(missing)} that does not exist`,
          subject: edgeKey(e),
          detail: { end, missingNode: missing, edgeType: e.type },
        });
      }
    }
  }

  // ── undeclared_types ────────────────────────────────────────────────────
  const declaredNodeTypes = nodeTypeNames(schema);
  const declaredEdgeTypes = edgeTypeNames(schema);
  if (selected.has("undeclared_types")) {
    for (const n of graph.nodes) {
      if (!declaredNodeTypes.has(n.type)) {
        issues.push({
          check: "undeclared_types",
          severity: "error",
          message: `node ${q(n.id)} has undeclared node type ${q(n.type)}`,
          subject: n.id,
          detail: { nodeType: n.type, kind: "node" },
        });
      }
    }
    for (const e of graph.edges) {
      if (!declaredEdgeTypes.has(e.type)) {
        issues.push({
          check: "undeclared_types",
          severity: "error",
          message: `edge has undeclared edge type ${q(e.type)}`,
          subject: edgeKey(e),
          detail: { edgeType: e.type, kind: "edge" },
        });
      }
    }
  }

  // ── endpoint_types ──────────────────────────────────────────────────────
  if (selected.has("endpoint_types")) {
    for (const e of graph.edges) {
      const et: EdgeType | undefined = findEdgeType(schema, e.type);
      // An undeclared edge type is already reported above; flagging its endpoints
      // too would be two issues for one defect.
      if (!et) continue;
      const st = nodeType.get(e.sourceId);
      const tt = nodeType.get(e.targetId);
      if (st !== undefined && !allowsSource(et, st)) {
        issues.push({
          check: "endpoint_types",
          severity: "error",
          message:
            `edge ${q(e.type)} has source type ${q(st)}, but ` +
            `${q(e.type)} only allows ${qList([...(et.sourceTypes ?? [])])}`,
          subject: edgeKey(e),
          detail: { end: "source", actual: st, allowed: [...(et.sourceTypes ?? [])] },
        });
      }
      if (tt !== undefined && !allowsTarget(et, tt)) {
        issues.push({
          check: "endpoint_types",
          severity: "error",
          message:
            `edge ${q(e.type)} has target type ${q(tt)}, but ` +
            `${q(e.type)} only allows ${qList([...(et.targetTypes ?? [])])}`,
          subject: edgeKey(e),
          detail: { end: "target", actual: tt, allowed: [...(et.targetTypes ?? [])] },
        });
      }
    }
  }

  // ── cycles, per acyclic edge type ───────────────────────────────────────
  if (selected.has("cycles")) {
    for (const et of schema.edgeTypes) {
      if (!et.acyclic) continue;
      const cycle = findCycle(graph.edges, et.name);
      if (cycle && cycle.length > 0) {
        issues.push({
          check: "cycles",
          severity: "error",
          message:
            `edge type ${q(et.name)} is declared acyclic but a cycle exists: ` +
            cycle.join(" -> "),
          subject: cycle[0] as string,
          detail: { edgeType: et.name, cycle },
        });
      }
    }
  }

  // ── orphan_nodes ────────────────────────────────────────────────────────
  if (selected.has("orphan_nodes")) {
    const touched = new Set<string>();
    for (const e of graph.edges) {
      touched.add(e.sourceId);
      touched.add(e.targetId);
    }
    for (const n of graph.nodes) {
      if (!touched.has(n.id)) {
        issues.push({
          check: "orphan_nodes",
          severity: "warning",
          message: `node ${q(n.id)} has no edges (isolated)`,
          subject: n.id,
          detail: { nodeType: n.type },
        });
      }
    }
  }

  // ── self_loops ──────────────────────────────────────────────────────────
  if (selected.has("self_loops")) {
    for (const e of graph.edges) {
      if (e.sourceId === e.targetId) {
        issues.push({
          check: "self_loops",
          severity: "warning",
          message: `edge ${q(e.type)} points from ${q(e.sourceId)} to itself`,
          subject: edgeKey(e),
          detail: { edgeType: e.type, node: e.sourceId },
        });
      }
    }
  }

  return {
    ok: !issues.some((i) => i.severity === "error"),
    issues,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    checksRun: run,
  };
}

/**
 * One cycle formed using only `edgeType` edges, as `[a, b, …, a]`, or null.
 *
 * Deterministic: start nodes and successors are visited in sorted id order, so
 * the same cycle is reported on every run over the same graph.
 *
 * Iterative rather than recursive — the original recurses once per node, and a
 * deep chain exhausts the stack. The traversal order and the reported cycle are
 * identical; only the bookkeeping moved onto the heap.
 */
export function findCycle(edges: readonly GraphEdge[], edgeType: string): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (e.type !== edgeType || e.sourceId === e.targetId) continue;
    const seen = adjacency.get(e.sourceId);
    if (seen) seen.push(e.targetId);
    else adjacency.set(e.sourceId, [e.targetId]);
  }
  for (const [k, v] of adjacency) adjacency.set(k, [...new Set(v)].sort());

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();

  for (const start of [...adjacency.keys()].sort()) {
    if ((colour.get(start) ?? WHITE) !== WHITE) continue;

    // Explicit stack: each frame is a node plus how far through its successors
    // we are. `path` mirrors the recursive call stack.
    const frames: Array<{ node: string; index: number }> = [{ node: start, index: 0 }];
    const path: string[] = [start];
    colour.set(start, GREY);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { node: string; index: number };
      const successors = adjacency.get(frame.node) ?? [];
      if (frame.index >= successors.length) {
        colour.set(frame.node, BLACK);
        frames.pop();
        path.pop();
        continue;
      }
      const next = successors[frame.index] as string;
      frame.index += 1;
      const c = colour.get(next) ?? WHITE;
      if (c === GREY) {
        // A back edge into the current path closes a cycle.
        const at = path.indexOf(next);
        return [...path.slice(at), next];
      }
      if (c === WHITE) {
        colour.set(next, GREY);
        frames.push({ node: next, index: 0 });
        path.push(next);
      }
    }
  }
  return null;
}
