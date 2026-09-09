/**
 * The other two strata, read for the picture.
 *
 * Phase 2 built three layers of one graph joined across files on `component`:
 *
 *     structure.db   derived   rebuilt by publishing a whole new file
 *          | component
 *     builder.db     earned    never rebuilt
 *          | component
 *     portfolio.db   context   Claude Code's own
 *
 * and then nothing could look at any of it. `multi-memory graph export` drew
 * the earned stratum alone: for multi-app that is nineteen nodes, while two
 * hundred and nineteen sat in the file beside it. This module reads the other
 * two so the exporter can draw all three.
 *
 * Two rules it inherits from the rest of the plan:
 *
 *   1. **The engine reads derived and context data and never writes it.** Both
 *      opens are `mode=ro`; there is no write path here.
 *   2. **A missing stratum is an answer, and it says why.** Every leg reports
 *      `available` with a reason when it is not, because an unexplained zero is
 *      the founding defect this whole plan exists to remove. A file that has
 *      never been built is normal; being unable to tell that from a bug is not.
 */

import { DatabaseSync } from "node:sqlite";
import { SqliteStructureIndex } from "../structure/read.ts";
import type { VisEdge, VisNode } from "./threejs_renderer.ts";

/** The three layers, named once so nothing spells one differently. */
export const STRATA = ["governance", "structure", "context"] as const;
export type Stratum = (typeof STRATA)[number];

/** What one leg contributed, or why it contributed nothing. */
export interface StratumReport {
  readonly stratum: Stratum;
  readonly available: boolean;
  /** Present whenever `available` is false, or whenever a leg is empty. */
  readonly reason?: string;
  readonly nodes: number;
  readonly edges: number;
  /** Where it was read from, so a surprising count has somewhere to go. */
  readonly source?: string;
}

export interface StrataResult {
  readonly nodes: VisNode[];
  readonly edges: VisEdge[];
  readonly reports: StratumReport[];
}

/** Structure edge types, mirrored from the declared taxonomy in schema.ts. */
export const STRUCTURE_EDGE_KINDS = ["imports", "contains", "renders", "uses_hook"] as const;

/** The cross-stratum edge. Not in either file: it *is* the join, drawn. */
export const JOIN_EDGE_KIND = "describes";

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * The derived stratum: files, the components inside them, and what they reach.
 *
 * Node ids are prefixed. A structure row id is a bare hex digest and a lesson
 * id is `lsn_<digest>`; without a prefix the two namespaces share one id space
 * in the projection and a collision would silently merge two unrelated nodes.
 */
export function readStructure(path: string): {
  nodes: VisNode[];
  edges: VisEdge[];
  report: StratumReport;
  componentIndex: Map<string, string>;
} {
  const empty = {
    nodes: [] as VisNode[],
    edges: [] as VisEdge[],
    componentIndex: new Map<string, string>(),
  };
  const index = SqliteStructureIndex.open(path);
  if (!index) {
    return {
      ...empty,
      report: {
        stratum: "structure",
        available: false,
        nodes: 0,
        edges: 0,
        source: path,
        reason:
          `no readable structure graph at ${path} — build one with ` +
          `\`project-memory brain structure build <repo>\``,
      },
    };
  }

  try {
    const rows = index.allNodes();
    const nodes: VisNode[] = [];
    const componentIndex = new Map<string, string>();
    const idFor = new Map<string, string>();

    for (const row of rows) {
      const id = `structure:${row.id}`;
      idFor.set(row.id, id);
      // Only a FILE may claim a component here.
      //
      // 203 nodes carry the key, not 143: a component node deliberately carries
      // its file's, so `repo:multi-app/App.tsx` is held by one file and its two
      // components. Indexing all of them would make the winner depend on row
      // order -- and this exact shape was already a bug once, in Phase 2's
      // endpoint index, where a component won a path because "component" sorts
      // before "file". A context record is about the file; say so in the code
      // rather than arriving there by accident.
      if (row.component && row.level === "file") componentIndex.set(row.component, id);
      nodes.push({
        id,
        name: truncate(row.level === "file" ? row.filePath || row.name : row.name, 60),
        type: `structure:${row.level}`,
        stratum: "structure",
        description: [
          `kind: ${row.level}`,
          row.filePath ? `path: ${row.filePath}` : null,
          row.component ? `component: ${row.component}` : null,
          row.summary ? `\n${row.summary}` : null,
        ]
          .filter((line) => line !== null)
          .join("\n"),
      });
    }

    const edges: VisEdge[] = [];
    for (const edge of index.allEdges()) {
      const source = idFor.get(edge.sourceId);
      const target = idFor.get(edge.targetId);
      // Same rule the governance projection already follows: never invent a
      // node for a reference that does not resolve. structure.db reports its
      // own unresolved count in build_meta; a dangling edge here would be a
      // second, quieter place for the same number to hide.
      if (!source || !target) continue;
      edges.push({ source, target, type: edge.edgeType });
    }

    const meta = index.meta();
    return {
      nodes,
      edges,
      componentIndex,
      report: {
        stratum: "structure",
        available: true,
        nodes: nodes.length,
        edges: edges.length,
        source: path,
        ...(nodes.length === 0
          ? { reason: "the structure graph is present but holds no nodes" }
          : {}),
        ...(meta["unresolved_edges"] && meta["unresolved_edges"] !== "0"
          ? { reason: `${meta["unresolved_edges"]} edge(s) were unresolved at build time` }
          : {}),
      },
    };
  } finally {
    index.close();
  }
}

/**
 * The context stratum: what Claude Code recorded about this repository.
 *
 * Only episodes carrying a `component` are drawn. That is deliberate rather
 * than a shortcut: portfolio.db is estate-wide and holds well over a thousand
 * rows, most of them about other repositories, and an unjoinable node in a
 * picture of *this* project's graph is noise wearing the same colour as signal.
 * The report says how many were skipped, so the number is visible rather than
 * quietly dropped.
 */
export function readContext(
  path: string,
  componentIndex: ReadonlyMap<string, string>,
): { nodes: VisNode[]; edges: VisEdge[]; report: StratumReport } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(`file:${path}?mode=ro`, { readOnly: true });
    db.prepare("SELECT 1 FROM episodes LIMIT 1").get();
  } catch {
    return {
      nodes: [],
      edges: [],
      report: {
        stratum: "context",
        available: false,
        nodes: 0,
        edges: 0,
        source: path,
        reason:
          `no readable portfolio brain at ${path} — point --context-db at one, ` +
          `or set PMEM_BRAIN_DB`,
      },
    };
  }

  try {
    const total = Number(
      (db.prepare("SELECT count(*) AS c FROM episodes").get() as { c: number }).c,
    );
    const rows = db
      .prepare(
        `SELECT id, kind, content, created_at,
                json_extract(metadata, '$.component') AS component
           FROM episodes
          WHERE json_extract(metadata, '$.component') IS NOT NULL
          ORDER BY created_at, id`,
      )
      .all() as Record<string, unknown>[];

    const nodes: VisNode[] = [];
    const edges: VisEdge[] = [];
    let joined = 0;

    for (const row of rows) {
      const component = String(row["component"]);
      const id = `context:${String(row["id"])}`;
      const kind = String(row["kind"] ?? "episode");
      nodes.push({
        id,
        name: truncate(component, 60),
        type: `context:${kind}`,
        stratum: "context",
        description: [
          `kind: ${kind}`,
          `component: ${component}`,
          `recorded: ${String(row["created_at"] ?? "?")}`,
          "",
          truncate(String(row["content"] ?? ""), 600),
        ].join("\n"),
      });
      const structureId = componentIndex.get(component);
      if (structureId) {
        edges.push({ source: id, target: structureId, type: JOIN_EDGE_KIND });
        joined += 1;
      }
    }

    const skipped = total - rows.length;
    const reasons: string[] = [];
    if (skipped > 0) {
      reasons.push(`${skipped} of ${total} episode(s) carry no component and are not drawn`);
    }
    if (joined > 0 && joined < rows.length) {
      reasons.push(`${joined} joined to a file in the structure graph, ${rows.length - joined} did not match`);
    }
    // `brain structure join` reports a higher number for the same data -- it
    // counts node pairs, and a file's components share its key, so one record
    // matching a file with two components is three rows there and one edge
    // here. Both are right; say which this is so the two can be reconciled.
    if (rows.length > 0 && joined === 0) {
      reasons.push(
        "no context episode matched a structure node — the two stores describe different repositories, " +
          "or the structure graph has not been rebuilt since the components were written",
      );
    }

    return {
      nodes,
      edges,
      report: {
        stratum: "context",
        available: true,
        nodes: nodes.length,
        edges: edges.length,
        source: path,
        ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
      },
    };
  } finally {
    db.close();
  }
}
