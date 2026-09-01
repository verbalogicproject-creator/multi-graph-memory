/**
 * TRANSLATED — see PROVENANCE.md
 * Origin : /root/projects/kg_toolkit/kg_toolkit/schema.py (Eyal Nof, Apache-2.0)
 *
 * A declared graph schema: which node and edge types exist, and what may sit at
 * each end of an edge.
 *
 * The package this descends from does not own your taxonomy, and neither does
 * this. A graph is typed nodes and typed edges; *which* types exist is the
 * caller's decision, so the caller declares them. That declaration is what makes
 * `checkIntegrity` able to say a graph is malformed rather than merely unusual.
 *
 * Changes from the Python: endpoint predicates are free functions over an
 * `EdgeType` rather than methods, because `erasableSyntaxOnly` rules out classes
 * carrying behaviour here; constraint tuples are `readonly string[]`; and node
 * ids are built and split with the same `::` convention so ids stay portable
 * between the two implementations. The rules themselves are unchanged.
 */

/** The separator between a node's type and its qualified name. */
export const ID_SEP = "::";

/** A declared kind of node. */
export interface NodeType {
  readonly name: string;
  readonly description?: string;
}

/**
 * A declared kind of edge, carrying the constraints integrity enforces.
 *
 * An empty `sourceTypes`/`targetTypes` means "any declared type" — the absence
 * of a constraint, not a constraint that nothing satisfies.
 */
export interface EdgeType {
  readonly name: string;
  readonly description?: string;
  /** Relative importance for ranking. Must be >= 0. */
  readonly weight?: number;
  /** Node types allowed at the source end. Empty → any. */
  readonly sourceTypes?: readonly string[];
  /** Node types allowed at the target end. Empty → any. */
  readonly targetTypes?: readonly string[];
  /** Undirected edges are treated symmetrically by traversal. */
  readonly directed?: boolean;
  /** A cycle formed only by edges of this type is an integrity error. */
  readonly acyclic?: boolean;
}

export interface GraphNode {
  readonly id: string;
  readonly type: string;
  readonly name?: string;
  readonly qualname?: string;
}

export interface GraphEdge {
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
}

/** A graph to check. Deliberately plain data: no storage, no adapter, no I/O. */
export interface TypedGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface KGSchema {
  readonly name: string;
  readonly nodeTypes: readonly NodeType[];
  readonly edgeTypes: readonly EdgeType[];
}

/** `type::qualname` — the id convention shared with the Python implementation. */
export function makeNodeId(nodeType: string, qualname: string): string {
  return `${nodeType}${ID_SEP}${qualname}`;
}

/** Split a node id back into its parts. A bare id yields a null type. */
export function splitNodeId(nodeId: string): { type: string | null; qualname: string } {
  const at = nodeId.indexOf(ID_SEP);
  if (at < 0) return { type: null, qualname: nodeId };
  return { type: nodeId.slice(0, at), qualname: nodeId.slice(at + ID_SEP.length) };
}

/**
 * Validate a schema declaration itself.
 *
 * A schema that names a node type twice, or constrains an edge to a node type it
 * never declared, is broken before any data arrives — and catching it here means
 * the resulting integrity report is about the graph rather than about the schema.
 */
export function validateSchema(schema: KGSchema): string[] {
  const problems: string[] = [];
  const seenNode = new Set<string>();
  for (const nt of schema.nodeTypes) {
    if (!nt.name) problems.push("a node type has an empty name");
    else if (seenNode.has(nt.name)) problems.push(`duplicate node type ${JSON.stringify(nt.name)}`);
    seenNode.add(nt.name);
  }
  const seenEdge = new Set<string>();
  for (const et of schema.edgeTypes) {
    if (!et.name) {
      problems.push("an edge type has an empty name");
      continue;
    }
    if (seenEdge.has(et.name)) problems.push(`duplicate edge type ${JSON.stringify(et.name)}`);
    seenEdge.add(et.name);
    if (et.weight !== undefined && et.weight < 0) {
      problems.push(`edge type ${JSON.stringify(et.name)} has negative weight ${et.weight}`);
    }
    for (const [end, list] of [["source", et.sourceTypes], ["target", et.targetTypes]] as const) {
      for (const t of list ?? []) {
        if (!seenNode.has(t)) {
          problems.push(
            `edge type ${JSON.stringify(et.name)} constrains its ${end} to undeclared ` +
              `node type ${JSON.stringify(t)}`,
          );
        }
      }
    }
  }
  return problems;
}

export function nodeTypeNames(schema: KGSchema): Set<string> {
  return new Set(schema.nodeTypes.map((t) => t.name));
}

export function edgeTypeNames(schema: KGSchema): Set<string> {
  return new Set(schema.edgeTypes.map((t) => t.name));
}

export function findEdgeType(schema: KGSchema, name: string): EdgeType | undefined {
  return schema.edgeTypes.find((t) => t.name === name);
}

/** True if `nodeType` may sit at the source end. An empty constraint allows any. */
export function allowsSource(edgeType: EdgeType, nodeType: string | undefined): boolean {
  const allowed = edgeType.sourceTypes ?? [];
  if (allowed.length === 0) return true;
  return nodeType !== undefined && allowed.includes(nodeType);
}

/** True if `nodeType` may sit at the target end. An empty constraint allows any. */
export function allowsTarget(edgeType: EdgeType, nodeType: string | undefined): boolean {
  const allowed = edgeType.targetTypes ?? [];
  if (allowed.length === 0) return true;
  return nodeType !== undefined && allowed.includes(nodeType);
}
