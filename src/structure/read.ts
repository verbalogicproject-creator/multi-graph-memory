/**
 * Read-only access to a project's derived structure graph.
 *
 * `structure.db` is written by `project-memory brain structure build` and is
 * rebuilt by publishing a whole new file. **The engine reads derived data and
 * never writes it**, so this opens `mode=ro` and offers no write path at all --
 * a rule that has to hold in the connection flags rather than in a convention,
 * because the one thing a rebuild must never be able to touch is the earned
 * store sitting beside it.
 *
 * Absent or unreadable is a normal answer, not an error: a project that has
 * never had a structure build should behave exactly as it does today.
 */

import { DatabaseSync } from "node:sqlite";
import { checkIntegrity } from "../kg/integrity.ts";
import { makeNodeId } from "../kg/types.ts";
import type { IntegrityReport } from "../kg/integrity.ts";
import type { GraphEdge, GraphNode, TypedGraph } from "../kg/types.ts";
import { STRUCTURE_SCHEMA } from "./schema.ts";

export interface StructureNode {
  readonly id: string;
  readonly level: string;
  readonly name: string;
  readonly qualname: string;
  readonly filePath: string;
  /** The cross-stratum join key, or null for anything not a file in this repo. */
  readonly component: string | null;
  readonly summary: string | null;
}

export interface StructureEdge {
  readonly edgeType: string;
  readonly sourceId: string;
  readonly targetId: string;
}

/** Whether a value can answer structural questions — the `hasLexicalIndex` shape. */
export function hasStructureIndex(value: unknown): value is StructureIndex {
  return typeof (value as StructureIndex | null)?.neighbours === "function";
}

export interface StructureIndex {
  /** Node ids one hop from `component`, over the given edge types. */
  neighbours(component: string, edgeTypes: readonly string[], limit: number): StructureNode[];
}

export class SqliteStructureIndex implements StructureIndex {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Open a structure graph read-only, or return null when there is not one. */
  static open(path: string): SqliteStructureIndex | null {
    try {
      const db = new DatabaseSync(`file:${path}?mode=ro`, { readOnly: true });
      db.prepare("SELECT 1 FROM nodes LIMIT 1").get();
      return new SqliteStructureIndex(db);
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }

  meta(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.db.prepare("SELECT key, value FROM build_meta").all()) {
      out[String((row as { key: unknown }).key)] = String((row as { value: unknown }).value);
    }
    return out;
  }

  /**
   * One hop out of every node carrying `component`, over the named edge types.
   *
   * Bounded by `limit` at the SQL level rather than in the caller: an unbounded
   * expansion over `imports` in a large repository is how a packet stops being a
   * packet.
   */
  neighbours(component: string, edgeTypes: readonly string[], limit: number): StructureNode[] {
    if (!component || edgeTypes.length === 0 || limit <= 0) return [];
    const placeholders = edgeTypes.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.id, t.level, t.name, t.qualname, t.file_path, t.component, t.summary
           FROM nodes s
           JOIN edges e ON e.source_id = s.id
           JOIN nodes t ON t.id = e.target_id
          WHERE s.component = ? AND e.edge_type IN (${placeholders})
          ORDER BY t.file_path, t.level, t.name
          LIMIT ?`,
      )
      .all(component, ...edgeTypes, limit);
    return rows.map(toStructureNode);
  }

  /** The whole graph, as plain data `checkIntegrity` can read. */
  typedGraph(): TypedGraph {
    const nodes: GraphNode[] = this.db
      .prepare("SELECT id, level, name, qualname FROM nodes ORDER BY id")
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: makeNodeId(String(r["level"]), String(r["id"])),
          type: String(r["level"]),
          name: String(r["name"] ?? ""),
          qualname: String(r["qualname"] ?? ""),
        };
      });
    const byRowId = new Map(
      (this.db.prepare("SELECT id, level FROM nodes").all() as Record<string, unknown>[]).map(
        (r) => [String(r["id"]), makeNodeId(String(r["level"]), String(r["id"]))],
      ),
    );
    const edges: GraphEdge[] = (
      this.db
        .prepare("SELECT edge_type, source_id, target_id FROM edges ORDER BY id")
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      type: String(r["edge_type"]),
      sourceId: byRowId.get(String(r["source_id"])) ?? String(r["source_id"]),
      targetId: byRowId.get(String(r["target_id"])) ?? String(r["target_id"]),
    }));
    return { nodes, edges };
  }

  /**
   * Every node, with the fields a picture needs -- `component` included.
   *
   * `typedGraph()` deliberately projects down to what `checkIntegrity` reads:
   * id, type, name, qualname. That is the right shape for the checker and the
   * wrong one for the renderer, which needs the file path to label a node and
   * the join key to link it to the other strata. Two readers, two shapes, one
   * table.
   */
  allNodes(): StructureNode[] {
    return this.db
      .prepare(
        `SELECT id, level, name, qualname, file_path, component, summary
           FROM nodes ORDER BY file_path, level, name`,
      )
      .all()
      .map(toStructureNode);
  }

  /** Every edge, source and target as raw row ids matching `allNodes()`. */
  allEdges(): StructureEdge[] {
    return (
      this.db
        .prepare("SELECT edge_type, source_id, target_id FROM edges ORDER BY id")
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      edgeType: String(r["edge_type"]),
      sourceId: String(r["source_id"]),
      targetId: String(r["target_id"]),
    }));
  }

  /** Run the declared taxonomy over this graph. */
  checkIntegrity(): IntegrityReport {
    return checkIntegrity(this.typedGraph(), STRUCTURE_SCHEMA);
  }
}

function toStructureNode(row: unknown): StructureNode {
  const r = row as Record<string, unknown>;
  return {
    id: String(r["id"]),
    level: String(r["level"]),
    name: String(r["name"] ?? ""),
    qualname: String(r["qualname"] ?? ""),
    filePath: String(r["file_path"] ?? ""),
    component: r["component"] === null || r["component"] === undefined ? null : String(r["component"]),
    summary: r["summary"] === null || r["summary"] === undefined ? null : String(r["summary"]),
  };
}
