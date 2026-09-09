/**
 * Evidence records.
 *
 * Append-only, and deliberately thin: evidence holds a *reference* and an optional
 * digest, never an inlined artifact body. Graph Memory points at proof; it does not
 * become the proof, and it never promotes a local record to a SAG evidence level.
 */

import { deriveEvidenceId } from "./canonical.ts";
import { refuse, refuseSchema } from "./errors.ts";
import { assertRedactionBoundary } from "./redaction.ts";
import { evidenceSchema } from "./schema.ts";
import { assertProjectMatch, requireScope } from "./scope.ts";
import type { Evidence, ProjectScope } from "./types.ts";
import type { StorageAdapter, StorageTx } from "../adapters/storage.ts";

export interface EvidenceInput {
  projectId: string;
  kind: string;
  ref: string;
  digest?: string;
  summary?: string;
  recordedAt?: string;
  /**
   * The record this one replaces. Must already exist and describe the same
   * project, kind and ref -- superseding is a correction to one reference, never
   * a link between two unrelated claims.
   */
  supersedesEvidenceId?: string;
}

export function recordEvidenceTx(tx: StorageTx, input: EvidenceInput): Evidence {
  const evidence: Evidence = {
    id: deriveEvidenceId(input.projectId, input.kind, input.ref, input.digest),
    projectId: input.projectId,
    kind: input.kind,
    ref: input.ref,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.supersedesEvidenceId === undefined ? {} : { supersedesEvidenceId: input.supersedesEvidenceId }),
  };

  const parsed = evidenceSchema.safeParse(evidence);
  if (!parsed.success) {
    refuseSchema("Evidence", parsed.error.issues);
  }

  assertRedactionBoundary(evidence, "persistence");

  // Idempotence first. Identical content at the same reference is the same
  // record, and this check runs BEFORE the supersedes validation so replaying an
  // ingest cannot lengthen a correction chain by one link per run.
  const existing = tx.getEvidence(evidence.id);
  if (existing) return existing;

  if (evidence.supersedesEvidenceId !== undefined) {
    const superseded = tx.getEvidence(evidence.supersedesEvidenceId);
    if (!superseded) {
      refuse("VALIDATION_FAILED", `Cannot supersede unknown evidence "${evidence.supersedesEvidenceId}".`, {
        supersedesEvidenceId: evidence.supersedesEvidenceId,
      });
    }
    if (superseded.projectId !== evidence.projectId) {
      refuse("VALIDATION_FAILED", `Evidence "${superseded.id}" belongs to another project and cannot be superseded here.`, {
        supersedesEvidenceId: superseded.id,
        expectedProjectId: evidence.projectId,
        actualProjectId: superseded.projectId,
      });
    }
    if (superseded.kind !== evidence.kind || superseded.ref !== evidence.ref) {
      refuse(
        "VALIDATION_FAILED",
        `Evidence "${superseded.id}" describes ${superseded.kind} ${superseded.ref}; a correction must describe the same reference.`,
        { supersedesEvidenceId: superseded.id, expected: `${evidence.kind} ${evidence.ref}` },
      );
    }
  }

  tx.putEvidenceIfAbsent(evidence);
  return evidence;
}

/**
 * The current record for a reference: the one no other record supersedes.
 *
 * Resolved against a caller-supplied snapshot rather than through a new storage
 * method, so a caller ingesting many sections reads the project's evidence once
 * and resolves every head against that single list -- O(n) for the batch instead
 * of O(n) per section, and no third adapter to keep in step.
 *
 * Returns null when the reference has never been recorded, which is a different
 * answer from "recorded and unchanged" and must stay distinguishable.
 */
export function currentEvidenceFor(
  records: readonly Evidence[],
  kind: string,
  ref: string,
): Evidence | null {
  const superseded = new Set<string>();
  for (const record of records) {
    if (record.supersedesEvidenceId) superseded.add(record.supersedesEvidenceId);
  }
  const heads = records
    .filter((record) => record.kind === kind && record.ref === ref && !superseded.has(record.id))
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : a.id < b.id ? 1 : -1));
  return heads[0] ?? null;
}

/**
 * The correction chain behind a record, newest first, starting with the record
 * itself. Mirrors the event chain walk.
 */
export function evidenceChain(records: readonly Evidence[], id: string): Evidence[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const chain: Evidence[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(id) ?? null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.supersedesEvidenceId ? byId.get(cursor.supersedesEvidenceId) ?? null : null;
  }
  return chain;
}

export function recordEvidence(storage: StorageAdapter, input: EvidenceInput): Evidence {
  return storage.transact((tx) => recordEvidenceTx(tx, input));
}

export function listEvidence(storage: StorageAdapter, scope: Partial<ProjectScope>): Evidence[] {
  const resolved = requireScope(scope);
  return storage.transact((tx) => tx.listEvidence(resolved.projectId));
}

export function getEvidence(storage: StorageAdapter, id: string, scope?: Partial<ProjectScope>): Evidence | null {
  return storage.transact((tx) => {
    const evidence = tx.getEvidence(id);
    if (evidence && scope) assertProjectMatch(evidence.projectId, requireScope(scope), "evidence");
    return evidence;
  });
}
