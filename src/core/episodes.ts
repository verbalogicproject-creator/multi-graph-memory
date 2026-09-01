/**
 * Episode lifecycle.
 *
 * An episode is a bounded sequence for ONE objective against ONE base revision.
 * It matters because it is the unit the reuse gate counts: a lesson qualifies only
 * when it is reused in a *distinct* episode, so episode identity is what stops a
 * lesson from promoting itself off a single success.
 */

import { deriveEpisodeId } from "./canonical.ts";
import { refuse } from "./errors.ts";
import { episodeSchema } from "./schema.ts";
import { assertProjectMatch, requireScope } from "./scope.ts";
import type { Attribution, Episode, EpisodeOutcome, ProjectScope } from "./types.ts";
import type { StorageAdapter, StorageTx } from "../adapters/storage.ts";

/** provider/model only; an episode has no single surface. */
export type EpisodeAttribution = Pick<Attribution, "provider" | "model">;

export interface OpenEpisodeInput {
  projectId: string;
  objective: string;
  baseRevisionId: string;
  contractVersion?: number;
  openedAt?: string;
  /**
   * Usually absent here and supplied at close instead: under a fallback chain
   * the model that actually served is not known when the episode opens.
   */
  attribution?: EpisodeAttribution;
}

/**
 * Spreads only the fields that are actually present.
 *
 * Absence and `undefined` must not become two different stored shapes: the
 * SQLite adapter decodes a NULL column back to an ABSENT key, so writing an
 * explicit `undefined` here would make a round-trip change the record.
 */
export function spreadAttribution(attribution: EpisodeAttribution | undefined): EpisodeAttribution {
  if (!attribution) return {};
  return {
    ...(attribution.provider === undefined ? {} : { provider: attribution.provider }),
    ...(attribution.model === undefined ? {} : { model: attribution.model }),
  };
}

export function openEpisodeTx(tx: StorageTx, input: OpenEpisodeInput): Episode {
  const openedAt = input.openedAt ?? new Date().toISOString();
  const episode: Episode = {
    id: deriveEpisodeId(input.projectId, input.objective, input.baseRevisionId, openedAt),
    projectId: input.projectId,
    objective: input.objective,
    baseRevisionId: input.baseRevisionId,
    ...(input.contractVersion === undefined ? {} : { contractVersion: input.contractVersion }),
    // Deliberately not part of `deriveEpisodeId`: the same attempt is the same
    // episode whether or not the caller could name the model that served it.
    ...spreadAttribution(input.attribution),
    openedAt,
    appliedLessonIds: [],
  };

  const parsed = episodeSchema.safeParse(episode);
  if (!parsed.success) {
    refuse("VALIDATION_FAILED", "Episode failed schema validation.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const existing = tx.getEpisode(episode.id);
  if (existing) return existing;

  tx.putEpisode(episode);
  return episode;
}

export function openEpisode(storage: StorageAdapter, input: OpenEpisodeInput): Episode {
  return storage.transact((tx) => openEpisodeTx(tx, input));
}

export function requireEpisode(tx: StorageTx, episodeId: string): Episode {
  const episode = tx.getEpisode(episodeId);
  if (!episode) {
    refuse("VALIDATION_FAILED", `Unknown episode "${episodeId}".`, { episodeId });
  }
  return episode;
}

/**
 * `attribution` is accepted here because a fallback chain only resolves during
 * the attempt: the model named at close is the one that actually served, which
 * is the only one worth recording. Supplied values never overwrite an
 * attribution already carried by the episode.
 */
export function closeEpisode(
  storage: StorageAdapter,
  episodeId: string,
  outcome: EpisodeOutcome,
  closedAt?: string,
  attribution?: EpisodeAttribution,
): Episode {
  return storage.transact((tx) => {
    const episode = requireEpisode(tx, episodeId);
    if (episode.closedAt !== undefined) {
      refuse("VALIDATION_FAILED", `Episode "${episodeId}" is already closed.`, {
        episodeId,
        closedAt: episode.closedAt,
        outcome: episode.outcome,
      });
    }
    // Fill per field, never overwrite: an attribution recorded at open was
    // observed earlier and is not improved by a later guess.
    const supplied = spreadAttribution(attribution);
    const closed: Episode = {
      ...episode,
      ...(episode.provider === undefined && supplied.provider !== undefined
        ? { provider: supplied.provider }
        : {}),
      ...(episode.model === undefined && supplied.model !== undefined
        ? { model: supplied.model }
        : {}),
      closedAt: closedAt ?? new Date().toISOString(),
      outcome,
    };
    tx.putEpisode(closed);
    return closed;
  });
}

/**
 * Records that a lesson's recommendation was actually applied during this episode.
 * The reuse gate reads this: a lesson cannot be "reused" in an episode that never
 * applied it.
 */
export function recordAppliedLesson(storage: StorageAdapter, episodeId: string, lessonId: string): Episode {
  return storage.transact((tx) => {
    const episode = requireEpisode(tx, episodeId);
    if (episode.appliedLessonIds.includes(lessonId)) return episode;
    const updated: Episode = { ...episode, appliedLessonIds: [...episode.appliedLessonIds, lessonId] };
    tx.putEpisode(updated);
    return updated;
  });
}

export function listEpisodes(storage: StorageAdapter, scope: Partial<ProjectScope>): Episode[] {
  const resolved = requireScope(scope);
  return storage.transact((tx) => tx.listEpisodes(resolved.projectId));
}

export function getEpisode(storage: StorageAdapter, episodeId: string, scope?: Partial<ProjectScope>): Episode | null {
  return storage.transact((tx) => {
    const episode = tx.getEpisode(episodeId);
    if (episode && scope) assertProjectMatch(episode.projectId, requireScope(scope), "episode");
    return episode;
  });
}
