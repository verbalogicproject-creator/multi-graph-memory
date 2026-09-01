/**
 * Graph projection and export.
 *
 * Adapted from `src/visualization/exporter.ts` in /root/hybrid-graph-memory
 * (Eyal Nof, MIT). The renderer transferred almost unchanged; this half did not.
 * The donor built its graph from a code-relation table (`getAllRelations`,
 * community assignments, guessed node types from identifier spelling). This
 * package has no such table. What it has is a governance lineage, and the edges
 * ARE the governance:
 *
 *     episode --produced--> lesson --cites--> evidence
 *        |                    ^
 *        +----reused-in-------+   (must be a DIFFERENT episode -- the ratchet)
 *
 *     evidence --contradicts--> lesson
 *     episode  --applied----->  lesson
 *
 * That makes the picture diagnostic rather than decorative. A lesson still
 * sitting at `proposed` has exactly one `produced` edge and no `reused-in` edge,
 * and the absent edge is the reason it has not been promoted. You can see why a
 * lesson is stuck, which a table of statuses does not tell you.
 *
 * Node size is degree centrality, carried in `val` -- the most connected pieces
 * of the lineage are the largest.
 *
 * Ruling 3: export is a redaction gate. An HTML file containing lesson text is
 * an export, so the projection passes `assertRedactionBoundary(.., "export")`
 * before anything is written. A graph is not a loophole around the boundary that
 * `sync export` respects.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertRedactionBoundary } from "../core/redaction.ts";
import type { Episode, Evidence, Lesson, ProjectScope } from "../core/types.ts";
import { ThreeJSGraphRenderer, type GraphData, type VisEdge, type VisNode } from "./threejs_renderer.ts";

export type { GraphData, VisEdge, VisNode } from "./threejs_renderer.ts";

/** Edge vocabulary. Named, not inferred -- every edge here is a governance fact. */
export const EDGE_KINDS = [
  "produced",
  "reused-in",
  "cites",
  "contradicts",
  "applied",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

/** The subset of GraphMemory this needs. Keeps the exporter testable without a store. */
export interface GraphSource {
  readonly scope: ProjectScope;
  listEpisodes(): Episode[];
  listLessons(filter?: { statuses?: readonly never[] }): Lesson[];
  listEvidence(): Evidence[];
}

export interface GraphProjection {
  scope: ProjectScope;
  generatedAt: string;
  graphData: GraphData;
  colors: Record<string, string>;
  counts: { episodes: number; lessons: number; evidence: number; edges: number };
}

function truncate(value: string, limit = 400): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function episodeType(episode: Episode): string {
  return `episode:${episode.outcome ?? "open"}`;
}

function describeEpisode(episode: Episode): string {
  const lines = [
    `objective: ${episode.objective}`,
    `base revision: ${episode.baseRevisionId}`,
    `outcome: ${episode.outcome ?? "open"}`,
    `opened: ${episode.openedAt}`,
  ];
  if (episode.closedAt) lines.push(`closed: ${episode.closedAt}`);
  return truncate(lines.join("\n"));
}

function describeLesson(lesson: Lesson): string {
  const lines = [
    `status: ${lesson.status}`,
    `domain: ${lesson.domain}`,
    "",
    `trigger: ${lesson.trigger}`,
    `recommendation: ${lesson.recommendation}`,
  ];
  if (lesson.limits.length > 0) lines.push("", `limits: ${lesson.limits.join(" · ")}`);
  if (lesson.approvedBy) lines.push("", `approved by: ${lesson.approvedBy} at ${lesson.approvedByHumanAt ?? "?"}`);
  if (lesson.revokedReason) lines.push("", `revoked: ${lesson.revokedReason}`);
  if (lesson.status === "proposed" && !lesson.reuseEpisodeId) {
    lines.push("", "not promoted: no reuse in a distinct episode yet");
  }
  return truncate(lines.join("\n"), 700);
}

function describeEvidence(evidence: Evidence): string {
  return truncate(`kind: ${evidence.kind}\nref: ${evidence.ref}`);
}

/**
 * Builds the graph. Pure -- no filesystem, no renderer instantiation beyond the
 * colour palette, so it can be asserted on directly in tests.
 */
export function projectGraph(source: GraphSource, now: Date = new Date()): GraphProjection {
  const episodes = source.listEpisodes();
  const lessons = source.listLessons();
  const evidence = source.listEvidence();

  const nodes = new Map<string, VisNode>();
  const edges: VisEdge[] = [];
  const degree = new Map<string, number>();

  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  const link = (sourceId: string, targetId: string, kind: EdgeKind) => {
    // Only draw an edge between nodes that exist. A dangling reference is a data
    // question, not something to invent a node for.
    if (!nodes.has(sourceId) || !nodes.has(targetId)) return;
    edges.push({ source: sourceId, target: targetId, type: kind });
    bump(sourceId);
    bump(targetId);
  };

  for (const episode of episodes) {
    nodes.set(episode.id, {
      id: episode.id,
      name: truncate(episode.objective, 60),
      type: episodeType(episode),
      description: describeEpisode(episode),
    });
  }
  for (const lesson of lessons) {
    nodes.set(lesson.id, {
      id: lesson.id,
      name: truncate(lesson.trigger, 60),
      type: `lesson:${lesson.status}`,
      description: describeLesson(lesson),
    });
  }
  for (const item of evidence) {
    nodes.set(item.id, {
      id: item.id,
      name: truncate(item.kind, 60),
      type: "evidence",
      description: describeEvidence(item),
    });
  }

  for (const lesson of lessons) {
    for (const episodeId of lesson.sourceEpisodeIds) link(episodeId, lesson.id, "produced");
    if (lesson.reuseEpisodeId) link(lesson.reuseEpisodeId, lesson.id, "reused-in");
    for (const evidenceId of lesson.evidenceIds) link(lesson.id, evidenceId, "cites");
    for (const contradictionId of lesson.contradictionIds) link(contradictionId, lesson.id, "contradicts");
  }
  for (const episode of episodes) {
    for (const lessonId of episode.appliedLessonIds) link(episode.id, lessonId, "applied");
  }

  // Degree centrality drives node size, matching the donor's "topological gravity".
  for (const node of nodes.values()) {
    node.val = Math.log((degree.get(node.id) ?? 0) + 2) * 5;
  }

  const graphData: GraphData = {
    nodes: Array.from(nodes.values()),
    edges,
  };

  // Ruling 3. Run the gate on the projection before it can reach a file.
  assertRedactionBoundary(graphData, "export", { maxBytes: Number.MAX_SAFE_INTEGER });

  const colors = new ThreeJSGraphRenderer().generateColorPalette(
    new Set(graphData.nodes.map((node) => node.type || "unknown")),
  );

  return {
    scope: source.scope,
    generatedAt: now.toISOString(),
    graphData,
    colors,
    counts: {
      episodes: episodes.length,
      lessons: lessons.length,
      evidence: evidence.length,
      edges: edges.length,
    },
  };
}

/** Machine-readable export: nodes and edges any viewer can consume. */
export function serializeGraph(projection: GraphProjection): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      scope: projection.scope,
      generatedAt: projection.generatedAt,
      counts: projection.counts,
      edgeKinds: EDGE_KINDS,
      nodes: projection.graphData.nodes,
      edges: projection.graphData.edges,
    },
    null,
    2,
  )}\n`;
}

export function exportGraphJson(source: GraphSource, outputPath: string, now?: Date): GraphProjection {
  const projection = projectGraph(source, now);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeGraph(projection), "utf8");
  return projection;
}

/** Self-contained 3D page. One file, openable straight from disk. */
export function exportGraphHtml(
  source: GraphSource,
  outputPath: string,
  title?: string,
  now?: Date,
): GraphProjection {
  const projection = projectGraph(source, now);
  new ThreeJSGraphRenderer().generateHtml(
    projection.graphData,
    outputPath,
    title ?? `${projection.scope.workspace}/${projection.scope.projectId} — memory graph`,
  );
  return projection;
}
