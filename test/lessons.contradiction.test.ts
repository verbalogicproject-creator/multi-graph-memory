import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { recordEvidence } from "../src/core/evidence.ts";
import {
  approveLesson,
  getLesson,
  recordContradiction,
  recordReuse,
  revokeLesson,
  unresolvedContradictions,
  withdrawContradiction,
} from "../src/core/lessons.ts";
import { PROJECT, reuseEpisode, seedProposedLesson, T2 } from "./helpers/factory.ts";

/** `assert.throws` returns undefined, so capture the error to inspect its code. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a refusal");
}

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

function contradictingEvidence(storage: Parameters<typeof recordEvidence>[0]) {
  return recordEvidence(storage, {
    projectId: PROJECT,
    kind: "verification.result",
    ref: "run://build/contradiction",
    recordedAt: T2,
  });
}

test("gate 3: contradiction blocks approval outright", () => {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  recordContradiction(s.storage, s.lessonId, contradictingEvidence(s.storage).id, T2);

  assert.throws(
    () => approveLesson(s.storage, s.lessonId, "eyal"),
    (e: unknown) => code(e) === "CONTRADICTION_BLOCKS_PROMOTION",
  );
});

test("contradiction blocks further reuse too", () => {
  const s = seedProposedLesson();
  recordContradiction(s.storage, s.lessonId, contradictingEvidence(s.storage).id, T2);
  assert.throws(
    () => recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId]),
    (e: unknown) => code(e) === "CONTRADICTION_BLOCKS_PROMOTION",
  );
});

test("an already-approved lesson becomes contradicted by later evidence", () => {
  const s = seedProposedLesson();
  recordReuse(s.storage, s.lessonId, reuseEpisode(s), [s.evidenceId], T2);
  approveLesson(s.storage, s.lessonId, "eyal", T2);

  const contradicted = recordContradiction(s.storage, s.lessonId, contradictingEvidence(s.storage).id, T2);
  assert.equal(contradicted.status, "contradicted");
  // The approval record survives; history is never erased.
  assert.equal(contradicted.approvedBy, "eyal");
});

test("contradiction remains visible after revocation", () => {
  const s = seedProposedLesson();
  const evidence = contradictingEvidence(s.storage);
  recordContradiction(s.storage, s.lessonId, evidence.id, T2);
  const revoked = revokeLesson(s.storage, s.lessonId, "no longer applicable", T2);

  assert.equal(revoked.status, "revoked");
  assert.deepEqual(revoked.contradictionIds, [evidence.id]);

  // A contradiction recorded after revocation still attaches, and does not
  // resurrect the lesson out of 'revoked'.
  const later = recordContradiction(s.storage, s.lessonId, recordEvidence(s.storage, {
    projectId: PROJECT,
    kind: "diagnostic",
    ref: "run://build/later",
    recordedAt: T2,
  }).id, T2);
  assert.equal(later.status, "revoked");
  assert.equal(later.contradictionIds.length, 2);
});

test("contradiction is idempotent for the same evidence", () => {
  const s = seedProposedLesson();
  const evidence = contradictingEvidence(s.storage);
  recordContradiction(s.storage, s.lessonId, evidence.id, T2);
  recordContradiction(s.storage, s.lessonId, evidence.id, T2);
  assert.equal(getLesson(s.storage, s.lessonId)?.contradictionIds.length, 1);
});

test("contradiction requires real evidence", () => {
  const s = seedProposedLesson();
  assert.throws(
    () => recordContradiction(s.storage, s.lessonId, "evd_nope"),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});

/* ------------------------------------------------------- withdrawal (human) -- */

test("a withdrawn contradiction restores eligibility", () => {
  // Before this existed there was NO path back anywhere in src/. One evidence
  // record set `contradicted`, that blocked reuse and approval permanently, and
  // INJECTABLE_STATUSES removed the lesson from every packet. A single
  // mis-attributed failure therefore deleted good guidance forever, silently.
  const s = seedProposedLesson();
  const evidence = contradictingEvidence(s.storage);
  const contradicted = recordContradiction(s.storage, s.lessonId, evidence.id);
  assert.equal(contradicted.status, "contradicted");

  const restored = withdrawContradiction(s.storage, s.lessonId, evidence.id, "misattributed to the wrong build");
  assert.equal(restored.status, "proposed", "back to the rung the record proves it reached");

  // History is retained in full: the contradiction is still recorded, and so is
  // its withdrawal. Deleting the id would have been simpler and would have
  // erased exactly what this store exists to keep.
  assert.ok(restored.contradictionIds.includes(evidence.id));
  assert.equal(restored.withdrawnContradictions?.length, 1);
  assert.equal(restored.withdrawnContradictions?.[0]?.reason, "misattributed to the wrong build");
});

test("withdrawing a contradiction requires a reason", () => {
  const s = seedProposedLesson();
  const evidence = contradictingEvidence(s.storage);
  recordContradiction(s.storage, s.lessonId, evidence.id);

  const error = caught(() => withdrawContradiction(s.storage, s.lessonId, evidence.id, "   "));
  assert.equal(code(error), "VALIDATION_FAILED");
});

test("a lesson still carrying another contradiction is not restored", () => {
  // Restoring to `approved` while a second contradiction still stands would be
  // exactly the promotion this gate exists to refuse.
  const s = seedProposedLesson();
  const first = contradictingEvidence(s.storage);
  const second = recordEvidence(s.storage, {
    projectId: PROJECT,
    kind: "verification.result",
    ref: "run://second-contradiction",
  });
  recordContradiction(s.storage, s.lessonId, first.id);
  const both = recordContradiction(s.storage, s.lessonId, second.id);
  assert.equal(both.contradictionIds.length, 2);

  const partial = withdrawContradiction(s.storage, s.lessonId, first.id, "the first was wrong");
  assert.equal(partial.status, "contradicted", "one withdrawal does not clear two contradictions");
  assert.deepEqual(unresolvedContradictions(partial), [second.id]);
});

test("withdrawing an unrecorded contradiction is refused, not ignored", () => {
  const s = seedProposedLesson();
  const error = caught(() => withdrawContradiction(s.storage, s.lessonId, "evd_never", "because"));
  assert.equal(code(error), "VALIDATION_FAILED");
});

test("withdrawing twice is idempotent rather than duplicating the history", () => {
  const s = seedProposedLesson();
  const evidence = contradictingEvidence(s.storage);
  recordContradiction(s.storage, s.lessonId, evidence.id);
  withdrawContradiction(s.storage, s.lessonId, evidence.id, "once");
  const again = withdrawContradiction(s.storage, s.lessonId, evidence.id, "twice");
  assert.equal(again.withdrawnContradictions?.length, 1);
  assert.equal(again.withdrawnContradictions?.[0]?.reason, "once", "the first reason stands");
});
