/**
 * Evidence versioning: the Phase 3b blocker.
 *
 * Evidence ids hashed {projectId, kind, ref} and excluded the digest, the
 * recorder returned the existing row on a match, and the storage seam had no
 * update path. So evidence was frozen at its first digest forever: editing a
 * document section under an unchanged heading was a silent no-op, and a
 * staleness check built on stored digests could never trip.
 *
 * Revert-proof: restore the three-field derivation in `deriveEvidenceId` and
 * `an edited section supersedes rather than returning the old record` goes red
 * by name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveEvidenceId, sha256Hex } from "../src/core/canonical.ts";
import { currentEvidenceFor, evidenceChain, recordEvidence } from "../src/core/evidence.ts";
import { GraphMemoryError } from "../src/core/errors.ts";
import { GraphMemory } from "../src/port.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { ingestAuthoredDocument } from "../src/docs/ingest.ts";
import { PROJECT } from "./helpers/factory.ts";

const DIGEST_A = sha256Hex("first");
const DIGEST_B = sha256Hex("second");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fgm-evd-"));
  const storage = new MemoryStorageAdapter();
  storage.open();
  const memory = new GraphMemory({ storage, scope: { projectId: PROJECT } });
  return { dir, storage, memory, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

/** `assert.throws` returns undefined, so capture the error to inspect its code. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

test("a digest-free evidence id is byte-identical to the pre-change derivation", () => {
  // The migration guarantee. Folding the digest into the identity must not
  // rename a single record already on disk, and none of the five that exist in
  // this estate carries a digest.
  assert.equal(
    deriveEvidenceId(PROJECT, "verification.result", "run://1"),
    deriveEvidenceId(PROJECT, "verification.result", "run://1", undefined),
  );
  assert.notEqual(
    deriveEvidenceId(PROJECT, "verification.result", "run://1"),
    deriveEvidenceId(PROJECT, "verification.result", "run://1", DIGEST_A),
  );
});

test("the same digest at the same ref is one record, recorded twice", () => {
  const { storage, cleanup } = setup();
  try {
    const first = recordEvidence(storage, { projectId: PROJECT, kind: "authored.document", ref: "doc://a#h", digest: DIGEST_A });
    const again = recordEvidence(storage, { projectId: PROJECT, kind: "authored.document", ref: "doc://a#h", digest: DIGEST_A });
    assert.equal(again.id, first.id);
    assert.equal(again.supersedesEvidenceId, undefined);
  } finally {
    cleanup();
  }
});

test("a different digest at the same ref is a NEW record, not the old one", () => {
  const { storage, cleanup } = setup();
  try {
    const first = recordEvidence(storage, { projectId: PROJECT, kind: "authored.document", ref: "doc://a#h", digest: DIGEST_A });
    const second = recordEvidence(storage, {
      projectId: PROJECT, kind: "authored.document", ref: "doc://a#h", digest: DIGEST_B,
      supersedesEvidenceId: first.id,
    });
    assert.notEqual(second.id, first.id);
    assert.equal(second.digest, DIGEST_B);
    assert.equal(second.supersedesEvidenceId, first.id);
  } finally {
    cleanup();
  }
});

test("superseding an unknown record is refused, not silently dropped", () => {
  const { storage, cleanup } = setup();
  try {
    const error = caught(() =>
      recordEvidence(storage, {
        projectId: PROJECT, kind: "authored.document", ref: "doc://a#h", digest: DIGEST_A,
        supersedesEvidenceId: "evd_deadbeef",
      }),
    );
    assert.equal(code(error), "VALIDATION_FAILED");
  } finally {
    cleanup();
  }
});

test("a correction must describe the same reference", () => {
  const { storage, cleanup } = setup();
  try {
    const other = recordEvidence(storage, { projectId: PROJECT, kind: "authored.document", ref: "doc://other#h", digest: DIGEST_A });
    const error = caught(() =>
      recordEvidence(storage, {
        projectId: PROJECT, kind: "authored.document", ref: "doc://a#h", digest: DIGEST_B,
        supersedesEvidenceId: other.id,
      }),
    );
    assert.equal(code(error), "VALIDATION_FAILED");
  } finally {
    cleanup();
  }
});

test("the head of a reference is the record nothing supersedes, and the chain walks back", () => {
  const { storage, memory, cleanup } = setup();
  try {
    const first = recordEvidence(storage, { projectId: PROJECT, kind: "authored.document", ref: "doc://a#h", digest: DIGEST_A });
    const second = recordEvidence(storage, {
      projectId: PROJECT, kind: "authored.document", ref: "doc://a#h", digest: DIGEST_B,
      supersedesEvidenceId: first.id,
    });
    const all = memory.listEvidence();
    assert.equal(currentEvidenceFor(all, "authored.document", "doc://a#h")?.id, second.id);
    assert.deepEqual(evidenceChain(all, second.id).map((r) => r.id), [second.id, first.id]);
    assert.equal(currentEvidenceFor(all, "authored.document", "doc://never#h"), null);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------- staleness, through ingest -- */

const DOC_V1 = "# Title\n\n## Section\n\noriginal body text\n";
const DOC_V2 = "# Title\n\n## Section\n\nedited body text\n";

test("an edited section supersedes rather than returning the old record", () => {
  const { dir, memory, cleanup } = setup();
  try {
    const path = join(dir, "note.md");
    writeFileSync(path, DOC_V1);
    const first = ingestAuthoredDocument(memory, path);
    assert.equal(first.created, first.evidence.length);
    assert.equal(first.superseded, 0);

    writeFileSync(path, DOC_V2);
    const second = ingestAuthoredDocument(memory, path);

    // The heading did not change, so the ref did not change. Before this fix the
    // recorder returned the first row and reported success.
    assert.ok(second.superseded > 0, "an edit under an unchanged heading must supersede");
    assert.equal(second.created, 0);

    const head = currentEvidenceFor(memory.listEvidence(), "authored.document", "doc://note.md#Title/Section");
    assert.ok(head);
    assert.notEqual(head.digest, first.evidence[0]?.digest, "the head carries the edited content's digest");
    assert.ok(head.supersedesEvidenceId, "the new head names the record it replaced");
  } finally {
    cleanup();
  }
});

test("an mtime touch does not trip staleness", () => {
  const { dir, memory, cleanup } = setup();
  try {
    const path = join(dir, "note.md");
    writeFileSync(path, DOC_V1);
    ingestAuthoredDocument(memory, path);

    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    const again = ingestAuthoredDocument(memory, path);

    assert.equal(again.superseded, 0, "the bytes did not change");
    assert.equal(again.created, 0);
    assert.equal(again.unchanged, again.evidence.length);
  } finally {
    cleanup();
  }
});

test("a byte change trips staleness", () => {
  const { dir, memory, cleanup } = setup();
  try {
    const path = join(dir, "note.md");
    writeFileSync(path, DOC_V1);
    const before = ingestAuthoredDocument(memory, path);
    const beforeHead = currentEvidenceFor(memory.listEvidence(), "authored.document", "doc://note.md#Title/Section");

    writeFileSync(path, DOC_V1.replace("original", "originai"));
    const after = ingestAuthoredDocument(memory, path);
    const afterHead = currentEvidenceFor(memory.listEvidence(), "authored.document", "doc://note.md#Title/Section");

    assert.equal(after.superseded, 1, "one section changed, one record superseded");
    assert.notEqual(afterHead?.digest, beforeHead?.digest);
    assert.equal(afterHead?.supersedesEvidenceId, beforeHead?.id);
    // Append-only: the superseded record is still readable.
    assert.ok(memory.listEvidence().some((r) => r.id === beforeHead?.id));
    assert.ok(before.evidence.length > 0);
  } finally {
    cleanup();
  }
});
