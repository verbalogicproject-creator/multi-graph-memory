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

import { canonicalize, sha256Hex } from "./canonical.ts";
import { refuse } from "./errors.ts";
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
    refuse("VALIDATION_FAILED", "Bundle failed schema validation.", {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
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
  const retarget = <T extends { projectId: string }>(record: T): T =>
    rehomed ? { ...record, projectId: targetProjectId } : record;

  return storage.transact((tx) => {
    const imported = { events: 0, episodes: 0, lessons: 0, evidence: 0 };
    let skippedDuplicates = 0;

    for (const evidence of migrated.evidence) {
      if (tx.putEvidenceIfAbsent(retarget(evidence))) imported.evidence += 1;
      else skippedDuplicates += 1;
    }
    for (const episode of migrated.episodes) {
      if (tx.getEpisode(episode.id)) skippedDuplicates += 1;
      else {
        tx.putEpisode(retarget(episode));
        imported.episodes += 1;
      }
    }
    for (const lesson of migrated.lessons) {
      if (tx.getLesson(lesson.id)) skippedDuplicates += 1;
      else {
        tx.putLesson(retarget(lesson));
        imported.lessons += 1;
      }
    }
    for (const event of migrated.events) {
      if (tx.putEventIfAbsent(retarget(event))) imported.events += 1;
      else skippedDuplicates += 1;
    }

    return { projectId: targetProjectId, imported, skippedDuplicates, migratedFrom: bundle.schemaVersion };
  });
}
