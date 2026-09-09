/**
 * Graph Memory domain model.
 *
 * Adapter-neutral and JSON-serializable throughout (Ruling 4): no SQLite types,
 * no IndexedDB types, no Date objects. Timestamps are ISO-8601 strings; vectors
 * are carried separately as raw Float32 bytes by the relevance layer.
 *
 * The `MemoryEvent` and `Lesson` shapes below are the interfaces required verbatim
 * by docs/prompts/GRAPH-MEMORY-OPUS-IMPLEMENTER.md. Additional fields are optional
 * extensions only -- per the specification's Cycle 2 compatibility clause, extra
 * event and evidence kinds are additive and are never new authority paths.
 */

/* ------------------------------------------------------------------ kinds -- */

export const MEMORY_EVENT_KINDS = [
  "planning.answer",
  "contract.delta",
  "direction.selected",
  "candidate.created",
  "verification.completed",
  "repair.attempted",
  "revision.promoted",
  "revision.rolled_back",
  "human.decision",
  /**
   * Ruling 7. A departure from a lesson is recorded as its own observation.
   * It is NOT a contradiction until it independently qualifies as one.
   */
  "deviation.observed",
] as const;

export type MemoryEventKind = (typeof MEMORY_EVENT_KINDS)[number];

/**
 * Ruling 8. `domain` is what makes the creativity balance mechanical rather than
 * aspirational: it drives relevance weighting and the direction-gate exclusion.
 */
export const LESSON_DOMAINS = [
  // high relevance weight -- correctness territory
  "build",
  "diagnostics",
  "dependency",
  "api-usage",
  "environment",
  "repair",
  // mid weight
  "bug",
  "performance",
  "architecture",
  // very low default weight -- taste territory
  "taste",
  "layout",
  "copy",
  "art-direction",
] as const;

export type LessonDomain = (typeof LESSON_DOMAINS)[number];

/** Ruling 8: high weight for builds, diagnostics, dependencies, API misuse, environment, repairs. */
export const HIGH_WEIGHT_DOMAINS: readonly LessonDomain[] = [
  "build",
  "diagnostics",
  "dependency",
  "api-usage",
  "environment",
  "repair",
];

/** Ruling 8: very low default weight for taste, layout, copy, art direction. */
export const LOW_WEIGHT_DOMAINS: readonly LessonDomain[] = [
  "taste",
  "layout",
  "copy",
  "art-direction",
];

/**
 * Ruling 8: memory is structurally barred from generating, filtering, ranking or
 * selecting the builder's three art directions -- the trio produced by
 * `suggestArtDirections` and rendered by the Theme step. `taste` is named
 * explicitly in the ruling; the remaining art-direction domains are barred on
 * the same reasoning. Past builds may inform correctness; they may not decide
 * what the next one is allowed to look like.
 */
export const DIRECTION_BARRED_DOMAINS: readonly LessonDomain[] = LOW_WEIGHT_DOMAINS;

export const LESSON_STATUSES = [
  "proposed",
  "qualified",
  "approved",
  "contradicted",
  "revoked",
] as const;

export type LessonStatus = (typeof LESSON_STATUSES)[number];

export const EPISODE_OUTCOMES = ["verified", "failed", "abandoned"] as const;
export type EpisodeOutcome = (typeof EPISODE_OUTCOMES)[number];

/* ----------------------------------------------------------------- facets -- */

/**
 * Project is an isolation boundary. Component and bug are facets *inside* it.
 * Only the control tier crosses, and only under an admission record.
 */
export interface Facets {
  /** Route / package / surface / module the record belongs to. */
  component?: string;
  domain?: LessonDomain;
  /** Error class, symptom signature, exact strings. Matched exactly, never fuzzily. */
  triggerTags?: string[];
}

/* ------------------------------------------------------------ attribution -- */

/**
 * Who produced a record.
 *
 * Schema version 2. A single-provider host could leave this implicit; a
 * multi-provider one cannot. The builder that consumes this memory now serves
 * the same step from Google, Anthropic, OpenAI or NVIDIA, and "that step failed"
 * means something different depending on which model ran it. Without attribution
 * the outcomes of four providers average into one indistinguishable blur, and no
 * per-provider claim is checkable afterwards.
 *
 * Every field is optional: attribution is evidence when present, never a
 * precondition, so a producer that does not know its own provider still records.
 */
export interface Attribution {
  /** Provider family that served the call, e.g. "google", "anthropic". */
  provider?: string;
  /** Exact model id as the provider names it, e.g. "claude-haiku-4-5". */
  model?: string;
  /** Host surface that produced the record, e.g. "builder.plan". */
  surface?: string;
}

/* ----------------------------------------------------------------- events -- */

export interface MemoryEvent extends Facets, Attribution {
  /** Deterministic: SHA-256 over the canonical form of the identity fields. */
  id: string;
  kind: MemoryEventKind;
  /** ISO-8601. */
  occurredAt: string;
  projectId: string;
  cycleId: string;
  phaseId: string;
  stepId?: string;
  contractVersion?: number;
  baseRevisionId?: string;
  candidateRevisionId?: string;
  payload: Record<string, unknown>;
  evidenceIds: string[];
  /** Extension: binds the event to its episode. Optional so the required shape still validates. */
  episodeId?: string;
  /** Extension: a correction references the claim it supersedes. Corrections are new events. */
  supersedesEventId?: string;
}

/** What `appendEvent` accepts. `id` is derived, never supplied. */
export type MemoryEventInput = Omit<MemoryEvent, "id"> & { id?: string };

/* --------------------------------------------------------------- episodes -- */

/**
 * An episode carries provider and model but not `surface`: one episode spans
 * several surfaces (plan, directions, generate), while the serving model is a
 * property of the attempt as a whole. It is set at close, not at open, because
 * fallback means the model that actually served is only known afterwards.
 */
export interface Episode extends Pick<Attribution, "provider" | "model"> {
  id: string;
  projectId: string;
  /** The single objective this bounded sequence serves. */
  objective: string;
  baseRevisionId: string;
  contractVersion?: number;
  openedAt: string;
  closedAt?: string;
  outcome?: EpisodeOutcome;
  /** Lessons whose recommendation was applied during this episode. */
  appliedLessonIds: string[];
}

/* --------------------------------------------------------------- evidence -- */

export interface Evidence {
  id: string;
  projectId: string;
  /** e.g. "verification.result", "diagnostic", "receipt.ref", "human.decision". */
  kind: string;
  /** A reference, never an inlined artifact body. */
  ref: string;
  recordedAt: string;
  /** SHA-256 of the referenced material, when the producer supplied one. */
  digest?: string;
  summary?: string;
  /**
   * Extension: a re-record of the same reference with different content points at
   * the record it replaces. Corrections are new records; nothing is edited in
   * place. Mirrors `supersedesEventId`.
   */
  supersedesEvidenceId?: string;
}

/* ---------------------------------------------------------------- lessons -- */

export interface Lesson extends Facets {
  id: string;
  status: LessonStatus;
  trigger: string;
  recommendation: string;
  scope: string[];
  sourceEpisodeIds: string[];
  reuseEpisodeId?: string;
  evidenceIds: string[];
  contradictionIds: string[];
  approvedByHumanAt?: string;

  /* extensions */
  projectId: string;
  /** Ruling 8: required in practice; drives weighting and the direction bar. */
  domain: LessonDomain;
  /** Known limits, surfaced in every packet so guidance is never read as absolute. */
  limits: string[];
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  revokedAt?: string;
  revokedReason?: string;
  /** Count of distinct episodes in which this lesson was successfully reused. */
  reuseCount: number;
  /** Deviations observed against this lesson (Ruling 7); not itself a contradiction. */
  deviationIds: string[];
}

export interface LessonProposal extends Facets {
  projectId: string;
  trigger: string;
  recommendation: string;
  scope: string[];
  domain: LessonDomain;
  sourceEpisodeIds: string[];
  evidenceIds: string[];
  limits?: string[];
}

/* --------------------------------------------------------------- scoping -- */

export interface ProjectScope {
  workspace: string;
  projectId: string;
}

/**
 * Ruling 5. A cross-project read is an explicit, recorded admission -- never a flag.
 * This is retrieval policy and provenance; it is never an authority grant.
 */
export interface FederationAdmission {
  approvedBy: string;
  purpose: string;
  allowedWorkspaces: string[];
  allowedProjects?: string[];
  admittedAt: string;
}

export const RETRIEVAL_MODES = ["strict", "federated"] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/* --------------------------------------------------------- context packet -- */

/** One cited item in a bounded packet. Citations are mandatory, never optional. */
export interface CitedItem {
  id: string;
  sourceKind: "lesson" | "event" | "episode" | "document";
  title: string;
  body: string;
  /** Where this came from, so a reader can chase it. */
  citation: string;
  scope: string[];
  limits: string[];
  /** ISO-8601 of the underlying material, for the freshness line. */
  occurredAt: string;
  ageDays: number;
  domain?: LessonDomain;
  component?: string;
  score: number;
  reason: string;
}

/**
 * The governed artifact. Bounded, cited, budgeted, and carrying its own omissions.
 * Assembled by the host builder -- never by a model choosing its own query.
 */
export interface ContextPacket {
  scope: ProjectScope;
  task: string;
  items: CitedItem[];
  /** Ruling 8: what was left out, and why. Never silently dropped. */
  omissions: {
    consideredCount: number;
    returnedCount: number;
    droppedForBudget: number;
    droppedForDiversity: number;
    droppedForDirectionBar: number;
    note: string;
  };
  /** Advisory framing is part of the artifact, not a prompt-side convention. */
  advisory: string;
  authority: "context_only";
  generatedAt: string;
}

/* ------------------------------------------------------------ portability -- */

export interface ExportBundle {
  schemaVersion: number;
  projectId: string;
  exportedAt: string;
  events: MemoryEvent[];
  episodes: Episode[];
  lessons: Lesson[];
  evidence: Evidence[];
  /** SHA-256 over the canonical form of everything above. */
  checksum: string;
}
