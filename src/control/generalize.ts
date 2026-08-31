/**
 * Promotion into the control tier.
 *
 * Four gates, all required, none automatable:
 *   1. the underlying lessons qualified in the ordinary way
 *   2. reuse across at least TWO DISTINCT PROJECTS (not merely two episodes)
 *   3. explicit human approval
 *   4. a recorded no-proprietary-content decision, made by a person
 *
 * Plus a mechanical leak refusal on top. The scan is a backstop, not the
 * authority: it can only catch what it recognises, so it never substitutes for
 * gate 4. That is exactly why the ruling says automated de-identification is
 * not proof.
 */

import { contentDigest } from "../core/canonical.ts";
import { refuse } from "../core/errors.ts";
import { assertRedactionBoundary } from "../core/redaction.ts";
import type { Lesson } from "../core/types.ts";
import type { GeneralizedLesson, LessonPointer, NoProprietaryContentDecision } from "./types.ts";

export interface PromotionInput {
  trigger: string;
  recommendation: string;
  scope: string[];
  /** The originating lessons, one per project. */
  sources: Array<{ projectId: string; lesson: Lesson }>;
  approvedBy: string;
  decision: NoProprietaryContentDecision;
  /**
   * Additional tokens the human identified as proprietary -- component names,
   * internal codenames, paths. Checked verbatim against the generalized text.
   */
  proprietaryTokens?: string[];
  now?: string;
}

/**
 * Mechanical backstop. Refuses generalized text that still carries project
 * identifiers, source component names, path-like fragments, or any token the
 * human flagged.
 */
export function scanForProjectContent(
  text: string,
  sourceProjects: readonly string[],
  extraTokens: readonly string[] = [],
  sourceComponents: readonly string[] = [],
): string[] {
  const found: string[] = [];
  const haystack = text.toLowerCase();

  for (const projectId of sourceProjects) {
    if (projectId && haystack.includes(projectId.toLowerCase())) found.push(`project id "${projectId}"`);
  }
  for (const component of sourceComponents) {
    if (component && haystack.includes(component.toLowerCase())) found.push(`source component "${component}"`);
  }
  for (const token of extraTokens) {
    if (token && haystack.includes(token.toLowerCase())) found.push(`flagged token "${token}"`);
  }
  // Path-like fragments are project content by another name.
  const pathLike = /(?:^|\s)(?:\.{0,2}\/[\w.-]+){2,}/.exec(text);
  if (pathLike) found.push(`path-like fragment "${pathLike[0].trim()}"`);

  return found;
}

export function promoteToControlTier(input: PromotionInput): GeneralizedLesson {
  const now = input.now ?? new Date().toISOString();

  /* gate 2: at least two DISTINCT projects */
  const projects = [...new Set(input.sources.map((s) => s.projectId))];
  if (projects.length < 2) {
    refuse(
      "LESSON_TRANSITION_INVALID",
      `Control-tier promotion requires reuse across at least two distinct projects; got ${projects.length}.`,
      { projects },
    );
  }

  /* gate 1: each source must have qualified in the ordinary way */
  for (const source of input.sources) {
    const status = source.lesson.status;
    if (status !== "approved" && status !== "qualified") {
      refuse(
        "LESSON_TRANSITION_INVALID",
        `Source lesson "${source.lesson.id}" is "${status}"; only qualified or approved lessons may generalize.`,
        { lessonId: source.lesson.id, status },
      );
    }
    if (source.lesson.contradictionIds.length > 0) {
      refuse(
        "CONTRADICTION_BLOCKS_PROMOTION",
        `Source lesson "${source.lesson.id}" carries unresolved contradictions.`,
        { lessonId: source.lesson.id },
      );
    }
  }

  /* gate 3: explicit human approval */
  if (!input.approvedBy?.trim()) {
    refuse("HUMAN_APPROVAL_REQUIRED", "Control-tier promotion requires a named human approver.", {});
  }

  /* gate 4: a recorded human decision, not an automated verdict */
  const decision = input.decision;
  if (!decision?.decidedBy?.trim() || !decision.rationale?.trim() || !decision.decidedAt) {
    refuse(
      "CONTROL_TIER_CONTENT_REFUSED",
      "Control-tier promotion requires a recorded no-proprietary-content decision naming who decided, when, and why. Automated de-identification is not proof.",
      {},
    );
  }

  /* mechanical backstop, on top of the human decision */
  const generalized = `${input.trigger}\n${input.recommendation}\n${input.scope.join(" ")}`;
  const components = input.sources
    .map((s) => s.lesson.component)
    .filter((c): c is string => typeof c === "string");

  const leaks = scanForProjectContent(generalized, projects, input.proprietaryTokens ?? [], components);
  if (leaks.length > 0) {
    refuse(
      "CONTROL_TIER_CONTENT_REFUSED",
      `Refusing to promote: the generalized text still carries project content (${leaks.join("; ")}). The control tier stores distilled claims and pointers only.`,
      { leaks },
    );
  }

  // Ruling 3: promotion is one of the five redaction gates.
  assertRedactionBoundary({ trigger: input.trigger, recommendation: input.recommendation }, "promotion");

  const pointers: LessonPointer[] = input.sources.map((s) => ({ projectId: s.projectId, lessonId: s.lesson.id }));
  const domain = input.sources[0]!.lesson.domain;

  return {
    id: `gen_${contentDigest({ trigger: input.trigger, recommendation: input.recommendation, domain })}`,
    trigger: input.trigger,
    recommendation: input.recommendation,
    scope: input.scope,
    domain,
    sourceProjects: projects,
    pointers,
    approvedBy: input.approvedBy,
    approvedAt: now,
    decision,
    createdAt: now,
  };
}
