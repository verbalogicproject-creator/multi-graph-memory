/**
 * GraphMemory -- the library port, and the narrow model-facing port.
 *
 * Ruling 9 in structure rather than in configuration:
 *
 *   GraphMemory       full surface, including approval and revocation. Reached
 *                     by the human CLI and by the builder's own server.
 *   ModelContextPort  a single method, `readMemoryContext`. Approval,
 *                     revocation, federation admission and re-homing are not
 *                     absent-by-flag here; they are absent by construction, so
 *                     no configuration mistake can expose them to a model.
 *
 * The packet is assembled HERE, not by the caller. That is what makes the
 * creativity protections structural: a model can ask for context but cannot
 * compose its own query, so the budget, the domain weighting, the diversity
 * guard and the direction bar always apply.
 */

import { appendEvent, queryEvents, type AppendResult } from "./core/events.ts";
import { closeEpisode, getEpisode, listEpisodes, openEpisode, recordAppliedLesson, type EpisodeAttribution, type OpenEpisodeInput } from "./core/episodes.ts";
import { getEvidence, listEvidence, recordEvidence, type EvidenceInput } from "./core/evidence.ts";
import {
  approveLesson,
  getLesson,
  listLessons,
  proposeLesson,
  recordContradiction,
  recordReuse,
  revokeLesson,
} from "./core/lessons.ts";
import {
  evaluateDeviation,
  qualifyDeviationAsContradiction,
  recordDeviation,
  type QualifyDeviationInput,
  type RecordDeviationInput,
} from "./core/deviation.ts";
import { assemblePacket, lessonToCitedItem } from "./core/packet.ts";
import { DIRECTION_BARRED_DOMAINS } from "./core/types.ts";
import { exportProject, importBundle, type ImportOptions, type ImportResult } from "./core/portability.ts";
import { requireScope } from "./core/scope.ts";
import { DeterministicRelevanceAdapter } from "./relevance/deterministic.ts";
import type { RelevanceAdapter } from "./relevance/adapter.ts";
import type { StorageAdapter } from "./adapters/storage.ts";
import type {
  ContextPacket,
  Episode,
  EpisodeOutcome,
  Evidence,
  ExportBundle,
  Lesson,
  LessonDomain,
  LessonProposal,
  LessonStatus,
  MemoryEvent,
  MemoryEventInput,
  ProjectScope,
} from "./core/types.ts";

/** Statuses that may reach a model. Proposed guidance is not yet guidance. */
export const INJECTABLE_STATUSES: readonly LessonStatus[] = ["approved", "qualified"];

export interface GraphMemoryOptions {
  storage: StorageAdapter;
  scope: Partial<ProjectScope>;
  relevance?: RelevanceAdapter;
}

export interface ContextRequest {
  task: string;
  component?: string;
  domain?: LessonDomain;
  triggerTags?: string[];
  maxItems?: number;
  /** Ruling 8: set for a turn that generates the builder's three art directions. */
  directionGeneration?: boolean;
  now?: Date;
}

export class GraphMemory {
  readonly scope: ProjectScope;
  private readonly storage: StorageAdapter;
  private readonly relevance: RelevanceAdapter;

  constructor(options: GraphMemoryOptions) {
    this.scope = requireScope(options.scope);
    this.storage = options.storage;
    this.relevance =
      options.relevance ?? new DeterministicRelevanceAdapter({ lexicalIndex: options.storage });
  }

  /* -------------------------------------------------------------- writing -- */

  appendEvent(input: MemoryEventInput): AppendResult {
    return appendEvent(this.storage, input, { scope: this.scope });
  }

  queryEvents(filter: Omit<Parameters<typeof queryEvents>[1], "projectId"> = {}): MemoryEvent[] {
    return queryEvents(this.storage, { ...filter, projectId: this.scope.projectId });
  }

  openEpisode(input: Omit<OpenEpisodeInput, "projectId">): Episode {
    return openEpisode(this.storage, { ...input, projectId: this.scope.projectId });
  }

  closeEpisode(
    episodeId: string,
    outcome: EpisodeOutcome,
    closedAt?: string,
    attribution?: EpisodeAttribution,
  ): Episode {
    return closeEpisode(this.storage, episodeId, outcome, closedAt, attribution);
  }

  recordAppliedLesson(episodeId: string, lessonId: string): Episode {
    return recordAppliedLesson(this.storage, episodeId, lessonId);
  }

  listEpisodes(): Episode[] {
    return listEpisodes(this.storage, this.scope);
  }

  getEpisode(episodeId: string): Episode | null {
    return getEpisode(this.storage, episodeId, this.scope);
  }

  recordEvidence(input: Omit<EvidenceInput, "projectId">): Evidence {
    return recordEvidence(this.storage, { ...input, projectId: this.scope.projectId });
  }

  listEvidence(): Evidence[] {
    return listEvidence(this.storage, this.scope);
  }

  getEvidence(id: string): Evidence | null {
    return getEvidence(this.storage, id, this.scope);
  }

  /* -------------------------------------------------------------- lessons -- */

  proposeLesson(proposal: Omit<LessonProposal, "projectId">, now?: string): Lesson {
    return proposeLesson(this.storage, { ...proposal, projectId: this.scope.projectId }, now);
  }

  recordReuse(lessonId: string, episodeId: string, evidenceIds: readonly string[], now?: string): Lesson {
    return recordReuse(this.storage, lessonId, episodeId, evidenceIds, now);
  }

  recordContradiction(lessonId: string, evidenceId: string, now?: string): Lesson {
    return recordContradiction(this.storage, lessonId, evidenceId, now);
  }

  recordDeviation(input: RecordDeviationInput) {
    return recordDeviation(this.storage, input);
  }

  evaluateDeviation(input: QualifyDeviationInput) {
    return evaluateDeviation(this.storage, input);
  }

  qualifyDeviationAsContradiction(input: QualifyDeviationInput): Lesson {
    return qualifyDeviationAsContradiction(this.storage, input);
  }

  listLessons(filter: { statuses?: readonly LessonStatus[]; domain?: LessonDomain; component?: string } = {}): Lesson[] {
    return listLessons(this.storage, { ...filter, projectId: this.scope.projectId });
  }

  getLesson(lessonId: string): Lesson | null {
    return getLesson(this.storage, lessonId, this.scope);
  }

  /* ------------------------------------------------- human-only mutations -- */

  /**
   * Gate 4. Present on this port and on the CLI; deliberately NOT reachable from
   * ModelContextPort or the MCP server.
   */
  approveLesson(lessonId: string, approvedBy: string, now?: string): Lesson {
    return approveLesson(this.storage, lessonId, approvedBy, now);
  }

  revokeLesson(lessonId: string, reason: string, now?: string): Lesson {
    return revokeLesson(this.storage, lessonId, reason, now);
  }

  /* ---------------------------------------------------------- portability -- */

  export(exportedAt?: string): ExportBundle {
    return exportProject(this.storage, this.scope, exportedAt);
  }

  import(raw: unknown, options: ImportOptions = {}): ImportResult {
    return importBundle(this.storage, raw, { targetProjectId: this.scope.projectId, ...options });
  }

  /* ------------------------------------------------------- context packet -- */

  /**
   * The governed read. Candidates are drawn under strict scope, ranked by the
   * relevance adapter, then passed through the packet's budget, weighting,
   * diversity guard and direction bar.
   */
  async queryContext(request: ContextRequest): Promise<ContextPacket> {
    const now = request.now ?? new Date();

    const all = this.listLessons({
      statuses: INJECTABLE_STATUSES,
      ...(request.domain === undefined ? {} : { domain: request.domain }),
      ...(request.component === undefined ? {} : { component: request.component }),
    });

    /**
     * Ruling 8: the direction bar is applied to the CANDIDATE SET, before
     * ranking -- not merely to whatever the relevance layer happened to surface.
     *
     * Filtering only at the packet stage would make the exclusion depend on
     * retrieval: if relevance returned nothing, nothing would be barred, and the
     * guarantee would quietly hold by luck rather than by construction. Taste
     * lessons must be excluded from a direction turn whether or not they would
     * have ranked. The packet applies the same bar again as defence in depth.
     */
    const barred = request.directionGeneration
      ? all.filter((lesson) => DIRECTION_BARRED_DOMAINS.includes(lesson.domain))
      : [];
    const candidates = request.directionGeneration
      ? all.filter((lesson) => !DIRECTION_BARRED_DOMAINS.includes(lesson.domain))
      : all;

    const ranked = await this.relevance.rank(candidates, {
      projectId: this.scope.projectId,
      task: request.task,
      ...(request.component === undefined ? {} : { component: request.component }),
      ...(request.domain === undefined ? {} : { domain: request.domain }),
      ...(request.triggerTags === undefined ? {} : { triggerTags: request.triggerTags }),
    });

    const sourceEpisodes = new Map<string, string>();
    const items = ranked.map((scored) => {
      const cited = lessonToCitedItem(scored.lesson, now);
      sourceEpisodes.set(cited.id, scored.lesson.sourceEpisodeIds[0] ?? "");
      return { ...cited, score: cited.score * (1 + scored.score), reason: scored.reason };
    });

    const packet = assemblePacket(items, {
      scope: this.scope,
      task: request.task,
      ...(request.maxItems === undefined ? {} : { maxItems: request.maxItems }),
      ...(request.directionGeneration === undefined ? {} : { directionGeneration: request.directionGeneration }),
      sourceEpisodeOf: (item) => sourceEpisodes.get(item.id) || undefined,
      now,
    });

    if (barred.length === 0) return packet;

    // Report what the candidate-stage bar removed, so the omission notice stays truthful.
    const dropped = packet.omissions.droppedForDirectionBar + barred.length;
    return {
      ...packet,
      omissions: {
        ...packet.omissions,
        consideredCount: packet.omissions.consideredCount + barred.length,
        droppedForDirectionBar: dropped,
        note:
          `${dropped} candidate(s) barred from direction generation; ` +
          packet.omissions.note.replace(/^All candidates returned\.$/, "the rest were returned."),
      },
    };
  }
}

/**
 * The ONLY surface a model reaches. One method, by construction.
 *
 * There is no approve, revoke, admit, re-home, propose or append here, and none
 * can be added by configuration -- adding one would require editing this class.
 */
export class ModelContextPort {
  private readonly memory: GraphMemory;

  constructor(memory: GraphMemory) {
    this.memory = memory;
  }

  get scope(): ProjectScope {
    return this.memory.scope;
  }

  readMemoryContext(request: ContextRequest): Promise<ContextPacket> {
    return this.memory.queryContext(request);
  }
}
