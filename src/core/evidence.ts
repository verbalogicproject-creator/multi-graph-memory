/**
 * Evidence records.
 *
 * Append-only, and deliberately thin: evidence holds a *reference* and an optional
 * digest, never an inlined artifact body. Graph Memory points at proof; it does not
 * become the proof, and it never promotes a local record to a SAG evidence level.
 */

import { deriveEvidenceId } from "./canonical.ts";
import { refuseSchema } from "./errors.ts";
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
}

export function recordEvidenceTx(tx: StorageTx, input: EvidenceInput): Evidence {
  const evidence: Evidence = {
    id: deriveEvidenceId(input.projectId, input.kind, input.ref),
    projectId: input.projectId,
    kind: input.kind,
    ref: input.ref,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  };

  const parsed = evidenceSchema.safeParse(evidence);
  if (!parsed.success) {
    refuseSchema("Evidence", parsed.error.issues);
  }

  assertRedactionBoundary(evidence, "persistence");

  const existing = tx.getEvidence(evidence.id);
  if (existing) return existing;
  tx.putEvidenceIfAbsent(evidence);
  return evidence;
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
