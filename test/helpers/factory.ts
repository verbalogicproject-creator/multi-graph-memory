/** Shared fixtures. Deterministic timestamps so identities are reproducible. */

import { MemoryStorageAdapter } from "../../src/adapters/memory.ts";
import { openEpisode, closeEpisode, recordAppliedLesson } from "../../src/core/episodes.ts";
import { recordEvidence } from "../../src/core/evidence.ts";
import { proposeLesson } from "../../src/core/lessons.ts";
import type { LessonDomain, MemoryEventInput } from "../../src/core/types.ts";
import type { StorageAdapter } from "../../src/adapters/storage.ts";

export const T0 = "2026-08-01T00:00:00.000Z";
export const T1 = "2026-08-02T00:00:00.000Z";
export const T2 = "2026-08-03T00:00:00.000Z";
export const PROJECT = "builder-demo";

export function makeStorage(): StorageAdapter {
  const storage = new MemoryStorageAdapter();
  storage.open();
  return storage;
}

export function event(overrides: Partial<MemoryEventInput> = {}): MemoryEventInput {
  return {
    kind: "verification.completed",
    occurredAt: T0,
    projectId: PROJECT,
    cycleId: "cycle-1",
    phaseId: "phase-4",
    payload: { result: "passed" },
    evidenceIds: [],
    ...overrides,
  };
}

export interface Seeded {
  storage: StorageAdapter;
  sourceEpisodeId: string;
  evidenceId: string;
  lessonId: string;
}

/** A proposed lesson with one verified source episode and one evidence record. */
export function seedProposedLesson(domain: LessonDomain = "build"): Seeded {
  const storage = makeStorage();

  const source = openEpisode(storage, {
    projectId: PROJECT,
    objective: "install and build the candidate",
    baseRevisionId: "rev-1",
    openedAt: T0,
  });
  closeEpisode(storage, source.id, "verified", T1);

  const evidence = recordEvidence(storage, {
    projectId: PROJECT,
    kind: "verification.result",
    ref: "run://build/1",
    recordedAt: T1,
  });

  const lesson = proposeLesson(
    storage,
    {
      projectId: PROJECT,
      trigger: "vite build fails with ERR_REQUIRE_ESM",
      recommendation: "Pin the plugin to its ESM build and set type=module.",
      scope: ["build", "vite"],
      domain,
      sourceEpisodeIds: [source.id],
      evidenceIds: [evidence.id],
      limits: ["Observed only on Node 24 under Termux."],
      component: "build-pipeline",
      triggerTags: ["ERR_REQUIRE_ESM"],
    },
    T1,
  );

  return { storage, sourceEpisodeId: source.id, evidenceId: evidence.id, lessonId: lesson.id };
}

/** Opens a second episode, applies the lesson, and closes it verified. */
export function reuseEpisode(seeded: Seeded, objective = "second build repair"): string {
  const episode = openEpisode(seeded.storage, {
    projectId: PROJECT,
    objective,
    baseRevisionId: "rev-2",
    openedAt: T2,
  });
  recordAppliedLesson(seeded.storage, episode.id, seeded.lessonId);
  closeEpisode(seeded.storage, episode.id, "verified", T2);
  return episode.id;
}
