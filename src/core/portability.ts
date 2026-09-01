/**
 * Export and import.
 *
 * The bundle is also the sync wire format between the SQLite system of record and
 * the browser projection, which is why its determinism matters as much as its
 * validation: schema version, canonical serialization and a SHA-256 checksum, with
 * the migration route resolved before a single write.
 *
 * Import order is deliberate -- shape, then integrity, then route, then isolation:
 *   1. schema validation        -- a malformed bundle never reaches the checksum
 *   2. checksum verification    -- over the canonical body, excluding the checksum
 *   3. schema version + route   -- refuse unknown versions and missing routes
 *   4. re-home approval         -- Ruling 5, cross-project import needs a human
 *   5. redaction (import side)  -- never trust a bundle's own hygiene
 */

import {
  canonicalize,
  deriveEpisodeId,
  deriveEventId,
  deriveEvidenceId,
  deriveLessonId,
  sha256Hex,
} from "./canonical.ts";
import { refuse, refuseSchema } from "./errors.ts";
import { applyMigrations, CURRENT_SCHEMA_VERSION, planMigration, SUPPORTED_SCHEMA_VERSIONS } from "./migrate.ts";
import { assertRedactionBoundary } from "./redaction.ts";
import { exportBundleSchema } from "./schema.ts";
import { assertRehomeApproved, requireScope, type RehomeApproval } from "./scope.ts";
import type { ExportBundle, ProjectScope } from "./types.ts";
import type { StorageAdapter } from "../adapters/storage.ts";

/** The checksum covers everything except the checksum field itself. */
function bundleBody(bundle: Omit<ExportBundle, "checksum">): Omit<ExportBundle, "checksum"> {
  return {
    schemaVersion: bundle.schemaVersion,
    projectId: bundle.projectId,
    exportedAt: bundle.exportedAt,
    events: bundle.events,
    episodes: bundle.episodes,
    lessons: bundle.lessons,
    evidence: bundle.evidence,
  };
}

export function computeBundleChecksum(bundle: Omit<ExportBundle, "checksum">): string {
  return sha256Hex(canonicalize(bundleBody(bundle)));
}

/**
 * Ruling 5: export is single-project by default. There is no "export everything".
 */
export function exportProject(
  storage: StorageAdapter,
  scope: Partial<ProjectScope>,
  exportedAt?: string,
): ExportBundle {
  const resolved = requireScope(scope);

  const body = storage.transact((tx) => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectId: resolved.projectId,
    exportedAt: exportedAt ?? new Date().toISOString(),
    events: tx.listEvents({ projectId: resolved.projectId }),
    episodes: tx.listEpisodes(resolved.projectId),
    lessons: tx.listLessons({ projectId: resolved.projectId }),
    evidence: tx.listEvidence(resolved.projectId),
  }));

  // Ruling 3: export is one of the five gates.
  assertRedactionBoundary(body, "export", { maxBytes: Number.MAX_SAFE_INTEGER });

  return { ...body, checksum: computeBundleChecksum(body) };
}

export function serializeBundle(bundle: ExportBundle): string {
  return canonicalize(bundle);
}

export interface ImportOptions {
  /** Target project. Defaults to the bundle's own project. */
  targetProjectId?: string;
  rehome?: RehomeApproval;
  /** Cap on bundle size, in bytes, before anything is parsed. */
  maxBytes?: number;
}

export interface ImportResult {
  projectId: string;
  imported: { events: number; episodes: number; lessons: number; evidence: number };
  skippedDuplicates: number;
  migratedFrom: number;
}

export function validateBundle(raw: unknown): ExportBundle {
  const parsed = exportBundleSchema.safeParse(raw);
  if (!parsed.success) {
    refuseSchema("Bundle", parsed.error.issues.slice(0, 20));
  }
  const bundle = parsed.data as ExportBundle;

  const expected = computeBundleChecksum(bundle);
  if (expected !== bundle.checksum) {
    refuse("CHECKSUM_MISMATCH", "Bundle checksum does not match its contents; refusing to import.", {
      expected,
      declared: bundle.checksum,
    });
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(bundle.schemaVersion)) {
    refuse("SCHEMA_VERSION_UNSUPPORTED", `Schema version ${bundle.schemaVersion} is not supported by this build.`, {
      declared: bundle.schemaVersion,
      supported: SUPPORTED_SCHEMA_VERSIONS,
    });
  }

  return bundle;
}

/**
 * Moves a bundle to a new project, re-deriving every identity.
 *
 * `projectId` is part of what an id is a hash of. Rewriting the field while
 * keeping the old id would leave a record whose id no longer authenticates its
 * own content -- the exact property the rest of the system leans on: idempotent
 * re-import, outbox dedupe, and export checksums all assume "same content, same
 * id". A second import of the same bundle would then compute a different id than
 * the one stored and duplicate the record instead of skipping it.
 *
 * So ids are recomputed, and every reference between records is remapped with
 * them. Order matters, because identity is derived from content and content
 * includes references: evidence and episodes first (they reference nothing),
 * then lessons, then events -- and events last of all, in supersession order,
 * because an event that supersedes another hashes that other event's id.
 */
export function rehomeRecords(
  bundle: ExportBundle,
  targetProjectId: string,
): Pick<ExportBundle, "events" | "episodes" | "lessons" | "evidence"> {
  const evidenceIds = new Map<string, string>();
  const episodeIds = new Map<string, string>();
  const eventIds = new Map<string, string>();

  const evidence = bundle.evidence.map((record) => {
    const moved = { ...record, projectId: targetProjectId };
    moved.id = deriveEvidenceId(moved.projectId, moved.kind, moved.ref);
    evidenceIds.set(record.id, moved.id);
    return moved;
  });

  const episodes = bundle.episodes.map((record) => {
    const moved = { ...record, projectId: targetProjectId };
    moved.id = deriveEpisodeId(moved.projectId, moved.objective, moved.baseRevisionId, moved.openedAt);
    episodeIds.set(record.id, moved.id);
    return moved;
  });

  // A reference that cannot be remapped is dropped rather than left dangling:
  // pointing at an id that exists in no project is worse than pointing at nothing.
  const remap = (map: Map<string, string>, ids: readonly string[]): string[] =>
    ids.map((id) => map.get(id)).filter((id): id is string => id !== undefined);

  const lessons = bundle.lessons.map((record) => {
    const moved = {
      ...record,
      projectId: targetProjectId,
      sourceEpisodeIds: remap(episodeIds, record.sourceEpisodeIds),
      evidenceIds: remap(evidenceIds, record.evidenceIds),
      contradictionIds: remap(evidenceIds, record.contradictionIds),
      deviationIds: remap(evidenceIds, record.deviationIds),
    };
    if (record.reuseEpisodeId !== undefined) {
      const reuse = episodeIds.get(record.reuseEpisodeId);
      if (reuse === undefined) delete moved.reuseEpisodeId;
      else moved.reuseEpisodeId = reuse;
    }
    moved.id = deriveLessonId(moved.projectId, moved.trigger, moved.recommendation, moved.domain);
    return moved;
  });

  const lessonIds = new Map(bundle.lessons.map((record, index) => [record.id, lessons[index]!.id]));
  for (const episode of episodes) {
    episode.appliedLessonIds = remap(lessonIds, episode.appliedLessonIds);
  }

  // Supersession is a chain, so an event can only be re-derived once the event it
  // supersedes has been. Resolve in waves rather than assuming bundle order.
  const pending = [...bundle.events];
  const events: ExportBundle["events"] = [];
  while (pending.length > 0) {
    const ready = pending.filter(
      (record) => record.supersedesEventId === undefined || eventIds.has(record.supersedesEventId),
    );
    if (ready.length === 0) {
      // A cycle, or a chain reaching outside the bundle. Neither can be re-derived
      // honestly, so refuse rather than write records with invented lineage.
      refuse("VALIDATION_FAILED", "Cannot re-home events whose supersession chain is unresolvable.", {
        unresolved: pending.map((record) => record.id).slice(0, 10),
      });
    }
    for (const record of ready) {
      const moved = {
        ...record,
        projectId: targetProjectId,
        evidenceIds: remap(evidenceIds, record.evidenceIds),
      };
      if (record.episodeId !== undefined) {
        const episodeId = episodeIds.get(record.episodeId);
        if (episodeId === undefined) delete moved.episodeId;
        else moved.episodeId = episodeId;
      }
      if (record.supersedesEventId !== undefined) {
        moved.supersedesEventId = eventIds.get(record.supersedesEventId)!;
      }
      const { id: _old, ...body } = moved;
      moved.id = deriveEventId(body as Record<string, unknown>);
      eventIds.set(record.id, moved.id);
      events.push(moved);
    }
    const done = new Set(ready);
    pending.splice(0, pending.length, ...pending.filter((record) => !done.has(record)));
  }

  return { evidence, episodes, lessons, events };
}

export function importBundle(
  storage: StorageAdapter,
  raw: unknown,
  options: ImportOptions = {},
): ImportResult {
  if (options.maxBytes !== undefined) {
    const size = Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw) ?? "", "utf8");
    if (size > options.maxBytes) {
      refuse("PAYLOAD_TOO_LARGE", `Bundle of ${size} bytes exceeds the ${options.maxBytes} byte import limit.`, {
        size,
        maxBytes: options.maxBytes,
      });
    }
  }

  const decoded = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  const bundle = validateBundle(decoded);

  const plan = planMigration(bundle.schemaVersion, CURRENT_SCHEMA_VERSION);
  const migrated = applyMigrations(bundle as unknown as Record<string, unknown>, plan) as unknown as ExportBundle;

  const targetProjectId = options.targetProjectId ?? migrated.projectId;
  assertRehomeApproved(migrated.projectId, targetProjectId, options.rehome);

  // Never trust a bundle's own hygiene, whoever produced it.
  assertRedactionBoundary(migrated, "persistence", { maxBytes: Number.MAX_SAFE_INTEGER });

  const rehomed = migrated.projectId !== targetProjectId;
  const { evidence, episodes, lessons, events } = rehomed
    ? rehomeRecords(migrated, targetProjectId)
    : migrated;

  return storage.transact((tx) => {
    const imported = { events: 0, episodes: 0, lessons: 0, evidence: 0 };
    let skippedDuplicates = 0;

    for (const record of evidence) {
      if (tx.putEvidenceIfAbsent(record)) imported.evidence += 1;
      else skippedDuplicates += 1;
    }
    for (const episode of episodes) {
      if (tx.getEpisode(episode.id)) skippedDuplicates += 1;
      else {
        tx.putEpisode(episode);
        imported.episodes += 1;
      }
    }
    for (const lesson of lessons) {
      if (tx.getLesson(lesson.id)) skippedDuplicates += 1;
      else {
        tx.putLesson(lesson);
        imported.lessons += 1;
      }
    }
    for (const event of events) {
      if (tx.putEventIfAbsent(event)) imported.events += 1;
      else skippedDuplicates += 1;
    }

    return { projectId: targetProjectId, imported, skippedDuplicates, migratedFrom: bundle.schemaVersion };
  });
}
