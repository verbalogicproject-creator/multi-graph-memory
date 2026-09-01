/**
 * Generated document projections (Ruling 11).
 *
 *   {project}-MEMORY.md     entry card: scope, counts, health, index
 *   {project}-DECISIONS.md  append-only, from human.decision + contract.delta
 *   {project}-LESSONS.md    grouped by status, with citations and limits
 *
 * These are projections; the database is authoritative. `{project}-ARCHITECTURE.md`
 * and `{project}-NOTES.md` are AUTHORED and are never written here.
 *
 * Each lesson is rendered under its own heading, which is why ingestion uses a
 * dedicated parser rather than the parent engine's markdown chunker -- that one
 * only flushes a heading after 15 accumulated lines, so short lessons would be
 * merged together and could not be retrieved individually.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../core/migrate.ts";
import { assertSafeToOverwrite, serializeDocument } from "./frontmatter.ts";
import type { GraphMemory } from "../port.ts";
import type { Lesson, LessonStatus, MemoryEvent } from "../core/types.ts";

export const GENERATOR = "multi-graph-memory@0.2.0";

export const AUTHORED_DOCUMENTS = ["ARCHITECTURE", "NOTES"] as const;
export const GENERATED_DOCUMENTS = ["MEMORY", "DECISIONS", "LESSONS"] as const;

const STATUS_ORDER: readonly LessonStatus[] = ["approved", "qualified", "proposed", "contradicted", "revoked"];

export function documentPath(directory: string, projectId: string, name: string): string {
  return join(directory, `${projectId}-${name}.md`);
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function renderLesson(lesson: Lesson): string {
  const lines = [
    `### ${lesson.trigger}`,
    "",
    `- **id:** \`${lesson.id}\``,
    `- **domain:** ${lesson.domain}`,
    `- **scope:** ${lesson.scope.join(", ")}`,
  ];
  if (lesson.component) lines.push(`- **component:** \`${lesson.component}\``);
  if (lesson.triggerTags?.length) lines.push(`- **trigger tags:** ${lesson.triggerTags.map((t) => `\`${t}\``).join(", ")}`);
  lines.push(`- **reuse count:** ${lesson.reuseCount}`);
  if (lesson.approvedBy) lines.push(`- **approved by:** ${lesson.approvedBy} at ${lesson.approvedByHumanAt}`);
  if (lesson.revokedAt) lines.push(`- **revoked:** ${lesson.revokedAt} — ${lesson.revokedReason}`);
  if (lesson.contradictionIds.length) lines.push(`- **contradictions:** ${lesson.contradictionIds.length}`);
  if (lesson.deviationIds.length) lines.push(`- **deviations observed:** ${lesson.deviationIds.length}`);
  lines.push(`- **evidence:** ${lesson.evidenceIds.map((e) => `\`${e}\``).join(", ") || "none"}`);
  lines.push("", `**Recommendation.** ${lesson.recommendation}`);
  if (lesson.limits.length) {
    lines.push("", `**Known limits.** ${lesson.limits.join(" ")}`);
  }
  return lines.join("\n");
}

export function renderLessonsBody(lessons: readonly Lesson[]): string {
  if (lessons.length === 0) return "# Lessons\n\nNo lessons recorded yet.";

  const sections: string[] = ["# Lessons", ""];
  sections.push(
    "Guidance is advisory and scoped. A lesson is not policy: it informs and warns, and may be",
    "departed from with a stated reason. Only the four gates promote one.",
    "",
  );

  for (const status of STATUS_ORDER) {
    const group = lessons.filter((l) => l.status === status);
    if (group.length === 0) continue;
    sections.push(`## ${status} (${group.length})`, "");
    for (const lesson of group) {
      sections.push(renderLesson(lesson), "");
    }
  }
  return sections.join("\n").trimEnd();
}

export function renderDecisionsBody(events: readonly MemoryEvent[]): string {
  const relevant = events
    .filter((e) => e.kind === "human.decision" || e.kind === "contract.delta" || e.kind === "direction.selected")
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.id < b.id ? -1 : 1));

  if (relevant.length === 0) return "# Decisions\n\nNo decisions recorded yet.";

  const lines = ["# Decisions", "", "Append-only. Newest entries are at the bottom.", ""];
  for (const event of relevant) {
    lines.push(`## ${event.occurredAt} — ${event.kind}`);
    lines.push("");
    lines.push(`- **event:** \`${event.id}\``);
    lines.push(`- **cycle/phase:** ${event.cycleId} / ${event.phaseId}${event.stepId ? ` / ${event.stepId}` : ""}`);
    if (event.contractVersion !== undefined) lines.push(`- **contract version:** ${event.contractVersion}`);
    if (event.baseRevisionId) lines.push(`- **base revision:** \`${event.baseRevisionId}\``);
    if (event.supersedesEventId) lines.push(`- **supersedes:** \`${event.supersedesEventId}\``);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(event.payload, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderMemoryBody(
  projectId: string,
  counts: { events: number; episodes: number; lessons: number; evidence: number },
  lessons: readonly Lesson[],
): string {
  const byStatus = STATUS_ORDER.map((status) => `${status}: ${lessons.filter((l) => l.status === status).length}`);
  return [
    `# ${projectId} — memory`,
    "",
    "Entry card for this project's memory cluster. Generated from the database.",
    "",
    "## Counts",
    "",
    `- events: ${counts.events}`,
    `- episodes: ${counts.episodes}`,
    `- lessons: ${counts.lessons} (${byStatus.join(", ")})`,
    `- evidence: ${counts.evidence}`,
    "",
    "## Documents",
    "",
    `- \`${projectId}-ARCHITECTURE.md\` — authored. Invariants and boundaries. Human-owned.`,
    `- \`${projectId}-NOTES.md\` — authored. Freeform input, ingested as evidence. Human-owned.`,
    `- \`${projectId}-DECISIONS.md\` — generated. Append-only decision log.`,
    `- \`${projectId}-LESSONS.md\` — generated. Lessons grouped by status.`,
    "",
    "## Authority",
    "",
    "Memory grants no filesystem, dependency, donor, model, network, revision or",
    "deployment authority. Project revisions and the System Design Contract remain",
    "stronger truth. Nothing here is a SAG receipt or an evidence level.",
  ].join("\n");
}

export interface ProjectionResult {
  written: string[];
  refused: Array<{ path: string; reason: string }>;
}

/**
 * Regenerates the three projections. A hand-edited file is refused and reported;
 * the others still regenerate, so one edited file does not block the rest.
 */
export function projectDocuments(
  memory: GraphMemory,
  directory: string,
  now: string = new Date().toISOString(),
): ProjectionResult {
  mkdirSync(directory, { recursive: true });

  const projectId = memory.scope.projectId;
  const events = memory.queryEvents();
  const lessons = memory.listLessons();
  const counts = {
    events: events.length,
    episodes: memory.listEpisodes().length,
    lessons: lessons.length,
    evidence: memory.listEvidence().length,
  };

  const documents: Array<{ name: string; body: string }> = [
    { name: "MEMORY", body: renderMemoryBody(projectId, counts, lessons) },
    { name: "DECISIONS", body: renderDecisionsBody(events) },
    { name: "LESSONS", body: renderLessonsBody(lessons) },
  ];

  const written: string[] = [];
  const refused: Array<{ path: string; reason: string }> = [];

  for (const document of documents) {
    const path = documentPath(directory, projectId, document.name);
    try {
      assertSafeToOverwrite(readIfExists(path), projectId, path);
    } catch (error) {
      refused.push({ path, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    writeFileSync(
      path,
      serializeDocument(
        {
          projectId,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          generatedAt: now,
          sourceEventCount: counts.events,
          generator: GENERATOR,
        },
        document.body,
      ),
      "utf8",
    );
    written.push(path);
  }

  return { written, refused };
}
