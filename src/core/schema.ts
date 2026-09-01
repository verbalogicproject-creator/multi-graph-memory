/**
 * Runtime validation, and the single source for the JSON Schema artifacts.
 *
 * Decision 2 of the plan: zod is the runtime validator, and the same definitions
 * emit JSON Schema into schemas/ so Codex can validate a bundle independently of
 * this implementation rather than having to trust it.
 */

import * as z from "zod/v4";
import {
  EPISODE_OUTCOMES,
  LESSON_DOMAINS,
  LESSON_STATUSES,
  MEMORY_EVENT_KINDS,
} from "./types.ts";

/** ISO-8601 with an explicit offset or Z. Deliberately strict: timestamps are identity material. */
export const isoDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
    "must be an ISO-8601 timestamp with an explicit offset or Z",
  );

const identifier = z.string().min(1).max(512);
const shortText = z.string().min(1).max(2_000);
const longText = z.string().min(1).max(20_000);

export const facetsSchema = z.object({
  component: identifier.optional(),
  domain: z.enum(LESSON_DOMAINS).optional(),
  triggerTags: z.array(z.string().min(1).max(200)).max(64).optional(),
});

/**
 * Schema version 2. Every field optional and non-empty when present: an empty
 * string is refused rather than stored, because "" and absent would otherwise be
 * two spellings of the same unknown and would derive two different event ids.
 */
export const attributionSchema = z.object({
  provider: identifier.optional(),
  model: identifier.optional(),
  surface: identifier.optional(),
});

export const episodeAttributionSchema = attributionSchema.pick({ provider: true, model: true });

/** JSON-compatible payload. Rejects anything canonicalization could not reproduce. */
export const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().refine(Number.isFinite, "must be finite"),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const memoryEventInputSchema = facetsSchema.extend({
  ...attributionSchema.shape,
  kind: z.enum(MEMORY_EVENT_KINDS),
  occurredAt: isoDateTime,
  projectId: identifier,
  cycleId: identifier,
  phaseId: identifier,
  stepId: identifier.optional(),
  contractVersion: z.number().int().nonnegative().optional(),
  baseRevisionId: identifier.optional(),
  candidateRevisionId: identifier.optional(),
  payload: z.record(z.string(), jsonValue),
  evidenceIds: z.array(identifier).max(256),
  episodeId: identifier.optional(),
  supersedesEventId: identifier.optional(),
  id: identifier.optional(),
});

export const memoryEventSchema = memoryEventInputSchema.extend({ id: identifier });

export const episodeSchema = z.object({
  ...episodeAttributionSchema.shape,
  id: identifier,
  projectId: identifier,
  objective: shortText,
  baseRevisionId: identifier,
  contractVersion: z.number().int().nonnegative().optional(),
  openedAt: isoDateTime,
  closedAt: isoDateTime.optional(),
  outcome: z.enum(EPISODE_OUTCOMES).optional(),
  appliedLessonIds: z.array(identifier).max(256),
});

export const evidenceSchema = z.object({
  id: identifier,
  projectId: identifier,
  kind: identifier,
  ref: shortText,
  recordedAt: isoDateTime,
  digest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  summary: shortText.optional(),
});

export const lessonProposalSchema = facetsSchema.extend({
  projectId: identifier,
  trigger: shortText,
  recommendation: longText,
  scope: z.array(z.string().min(1).max(200)).min(1).max(64),
  domain: z.enum(LESSON_DOMAINS),
  sourceEpisodeIds: z.array(identifier).min(1).max(64),
  evidenceIds: z.array(identifier).min(1).max(256),
  limits: z.array(z.string().min(1).max(500)).max(32).optional(),
});

export const lessonSchema = facetsSchema.extend({
  id: identifier,
  status: z.enum(LESSON_STATUSES),
  trigger: shortText,
  recommendation: longText,
  scope: z.array(z.string()).min(1),
  sourceEpisodeIds: z.array(identifier),
  reuseEpisodeId: identifier.optional(),
  evidenceIds: z.array(identifier),
  contradictionIds: z.array(identifier),
  approvedByHumanAt: isoDateTime.optional(),
  projectId: identifier,
  domain: z.enum(LESSON_DOMAINS),
  limits: z.array(z.string()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  approvedBy: identifier.optional(),
  revokedAt: isoDateTime.optional(),
  revokedReason: shortText.optional(),
  reuseCount: z.number().int().nonnegative(),
  deviationIds: z.array(identifier),
});

export const federationAdmissionSchema = z.object({
  approvedBy: identifier,
  purpose: shortText,
  allowedWorkspaces: z.array(identifier).min(1),
  allowedProjects: z.array(identifier).optional(),
  admittedAt: isoDateTime,
});

export const exportBundleSchema = z.object({
  schemaVersion: z.number().int().positive(),
  projectId: identifier,
  exportedAt: isoDateTime,
  events: z.array(memoryEventSchema),
  episodes: z.array(episodeSchema),
  lessons: z.array(lessonSchema),
  evidence: z.array(evidenceSchema),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Every schema that gets an emitted JSON Schema artifact. */
export const EXPORTED_SCHEMAS = {
  "memory-event": memoryEventSchema,
  "memory-event-input": memoryEventInputSchema,
  episode: episodeSchema,
  evidence: evidenceSchema,
  lesson: lessonSchema,
  "lesson-proposal": lessonProposalSchema,
  "federation-admission": federationAdmissionSchema,
  "export-bundle": exportBundleSchema,
} as const;

export function toJsonSchema(name: keyof typeof EXPORTED_SCHEMAS): unknown {
  return z.toJSONSchema(EXPORTED_SCHEMAS[name], { io: "input" });
}
