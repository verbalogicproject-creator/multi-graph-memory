/**
 * The bounded, cited context packet -- the governed artifact.
 *
 * Ruling 8, in code rather than in prose:
 *   - three to five injected lessons maximum per turn
 *   - cited scope, freshness, limits and an omission notice on every packet
 *   - advisory framing carried in the artifact, not left to prompt convention
 *   - high weight for build/diagnostics/dependency/api-usage/environment/repair
 *   - very low default weight for taste/layout/copy/art-direction
 *   - structurally barred from direction generation; no `taste` lesson may enter
 *
 * Rendering is adapted from `memory/packaging.ts` in the /root/image-studio
 * prototype (packageContextForAgent), which already had the right shape: per-item
 * citation, match reason, per-item truncation, a total budget, and an explicit
 * "showing N of M" omission line.
 *
 * If the host assembles this, governance is structural. If a model assembles its
 * own query instead, governance is merely a suggestion -- which is why the
 * model-facing surface can only ask for a packet, never compose one.
 */

import { filterForDiversity } from "./diversity.ts";
import { refuse } from "./errors.ts";
import { requireScope } from "./scope.ts";
import {
  DIRECTION_BARRED_DOMAINS,
  HIGH_WEIGHT_DOMAINS,
  LOW_WEIGHT_DOMAINS,
} from "./types.ts";
import type { CitedItem, ContextPacket, Lesson, LessonDomain, ProjectScope } from "./types.ts";

/** Ruling 8's ceiling. Not a default to be raised by a caller -- a hard clamp. */
export const MAX_INJECTED_ITEMS = 5;
export const MIN_INJECTED_ITEMS = 3;
export const DEFAULT_MAX_CHARS = 4_000;
export const DEFAULT_ITEM_CHARS = 1_200;

export const ADVISORY_NOTE =
  "These are cited prior observations with stated limits, not instructions. " +
  "They are advisory and may be departed from; if you depart, say why. " +
  "Project revisions, current diagnostics and the System Design Contract remain stronger truth.";

/** Domain weighting. The asymmetry is the balance mechanism, expressed as numbers. */
export function domainWeight(domain: LessonDomain | undefined): number {
  if (domain === undefined) return 0.5;
  if (HIGH_WEIGHT_DOMAINS.includes(domain)) return 1;
  if (LOW_WEIGHT_DOMAINS.includes(domain)) return 0.05;
  return 0.6;
}

export function ageInDays(occurredAt: string, now: Date): number {
  const then = Date.parse(occurredAt);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (now.getTime() - then) / 86_400_000);
}

export function lessonToCitedItem(lesson: Lesson, now: Date): CitedItem {
  const age = ageInDays(lesson.updatedAt, now);
  return {
    id: lesson.id,
    sourceKind: "lesson",
    title: lesson.trigger,
    body: lesson.recommendation,
    citation: `lesson:${lesson.id} status=${lesson.status} reuse=${lesson.reuseCount}`,
    scope: lesson.scope,
    limits: lesson.limits,
    occurredAt: lesson.updatedAt,
    ageDays: Math.round(age * 10) / 10,
    ...(lesson.domain === undefined ? {} : { domain: lesson.domain }),
    ...(lesson.component === undefined ? {} : { component: lesson.component }),
    score: domainWeight(lesson.domain),
    reason: `status ${lesson.status}, domain ${lesson.domain}`,
  };
}

export interface AssembleOptions {
  scope: Partial<ProjectScope>;
  task: string;
  /** Clamped to at most MAX_INJECTED_ITEMS. */
  maxItems?: number;
  maxChars?: number;
  /**
   * Set when the turn generates the builder's three art directions
   * (`suggestArtDirections`). Ruling 8 bars memory from that gate entirely.
   */
  directionGeneration?: boolean;
  maxPerComponent?: number;
  maxPerEpisode?: number;
  /** Maps an item back to its source episode, for the diversity cap. */
  sourceEpisodeOf?: (item: CitedItem) => string | undefined;
  now?: Date;
}

export function assemblePacket(
  candidates: readonly CitedItem[],
  options: AssembleOptions,
): ContextPacket {
  const scope = requireScope(options.scope);
  const now = options.now ?? new Date();
  const requested = options.maxItems ?? MAX_INJECTED_ITEMS;
  if (requested < 1) {
    refuse("VALIDATION_FAILED", "A packet must allow at least one item.", { maxItems: requested });
  }
  const limit = Math.min(requested, MAX_INJECTED_ITEMS);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const consideredCount = candidates.length;

  // 1. Direction gate. Structural, not advisory.
  let pool = candidates;
  let droppedForDirectionBar = 0;
  if (options.directionGeneration) {
    const before = pool.length;
    pool = pool.filter((item) => item.domain === undefined || !DIRECTION_BARRED_DOMAINS.includes(item.domain));
    droppedForDirectionBar = before - pool.length;
  }

  // 2. Weight and order. Ties break on id so ordering is total and reproducible.
  const ranked = [...pool].sort((a, b) => {
    const wa = a.score * domainWeight(a.domain);
    const wb = b.score * domainWeight(b.domain);
    if (wa !== wb) return wb - wa;
    if (a.ageDays !== b.ageDays) return a.ageDays - b.ageDays;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // 3. Diversity, so the budget cannot be filled from one episode or component.
  const { kept, droppedForDiversity } = filterForDiversity(
    ranked,
    options.sourceEpisodeOf ?? (() => undefined),
    {
      limit,
      ...(options.maxPerComponent === undefined ? {} : { maxPerComponent: options.maxPerComponent }),
      ...(options.maxPerEpisode === undefined ? {} : { maxPerEpisode: options.maxPerEpisode }),
    },
  );

  // 4. Character budget, applied last so it trims a already-diverse set.
  const items: CitedItem[] = [];
  let usedChars = 0;
  let droppedForBudget = 0;
  for (const item of kept) {
    const body = item.body.length > DEFAULT_ITEM_CHARS
      ? `${item.body.slice(0, DEFAULT_ITEM_CHARS)}\n... [truncated] ...`
      : item.body;
    const cost = body.length + item.title.length + item.citation.length;
    if (items.length > 0 && usedChars + cost > maxChars) {
      droppedForBudget += 1;
      continue;
    }
    usedChars += cost;
    items.push({ ...item, body });
  }
  droppedForBudget += Math.max(0, kept.length - items.length - droppedForBudget);

  const returnedCount = items.length;
  const omitted = consideredCount - returnedCount;

  return {
    scope,
    task: options.task,
    items,
    omissions: {
      consideredCount,
      returnedCount,
      droppedForBudget,
      droppedForDiversity,
      droppedForDirectionBar,
      note:
        omitted === 0
          ? "All candidates returned."
          : `${omitted} candidate(s) omitted: ${droppedForDirectionBar} barred from direction generation, ` +
            `${droppedForDiversity} for source diversity, ${droppedForBudget} for the item and character budget.`,
    },
    advisory: ADVISORY_NOTE,
    authority: "context_only",
    generatedAt: now.toISOString(),
  };
}

/** Human- and model-readable rendering. Citations and omissions are never dropped. */
export function renderPacket(packet: ContextPacket): string {
  if (packet.items.length === 0) {
    return [
      `# Project Memory`,
      `**Task:** ${packet.task}`,
      `**Scope:** ${packet.scope.workspace}/${packet.scope.projectId}`,
      ``,
      `No applicable prior observations. ${packet.omissions.note}`,
    ].join("\n");
  }

  const sections: string[] = [
    `# Project Memory`,
    `**Task:** ${packet.task}`,
    `**Scope:** ${packet.scope.workspace}/${packet.scope.projectId}`,
    `**Showing:** ${packet.omissions.returnedCount} of ${packet.omissions.consideredCount} candidate(s)`,
    `**Authority:** ${packet.authority} — ${packet.advisory}`,
    `---`,
  ];

  packet.items.forEach((item, index) => {
    const parts = [
      `### [${index + 1}] ${item.title}`,
      `**Citation:** \`${item.citation}\``,
      `**Scope:** ${item.scope.join(", ")}`,
      `**Freshness:** ${item.ageDays} day(s) old`,
      `**Why surfaced:** ${item.reason}`,
    ];
    if (item.component) parts.push(`**Component:** \`${item.component}\``);
    if (item.limits.length > 0) parts.push(`**Known limits:** ${item.limits.join("; ")}`);
    sections.push(`${parts.join("\n")}\n\n${item.body}`);
    sections.push(`---`);
  });

  sections.push(`*${packet.omissions.note}*`);
  return sections.join("\n\n");
}
