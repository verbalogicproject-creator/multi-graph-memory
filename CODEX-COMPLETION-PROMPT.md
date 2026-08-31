# Codex completion package: Fractal Graph Memory

**Returned:** 2026-08-31 · **From:** Opus implementer session · **Package:** `~/openai/fractal-graph-memory`

This is the return leg of `docs/prompts/GRAPH-MEMORY-OPUS-IMPLEMENTER.md`. It is written
to be self-contained: everything needed to inspect, verify, rule on and admit the
component is here, with the supporting documents named where detail is wanted.

## Authoritative input

The component was built against, and remains aligned with:

- `docs/specs/GRAPH-MEMORY-INTEGRATION.md` — architecture and acceptance contract
- `docs/prompts/GRAPH-MEMORY-OPUS-IMPLEMENTER.md` — interfaces, invariants, required tests
- `docs/specs/LOCAL-GOVERNED-LEARNING.md` — lesson lifecycle and port compatibility
- `docs/specs/SYSTEM-DESIGN-CONTRACT.md` — the direction gate the creativity bar protects
- `docs/governance/OWNERSHIP-AND-ADMISSION.md` — the admission discipline this respects
- Twelve owner rulings issued 2026-08-31, reproduced in effect throughout the package

**Alignment verified at handoff.** Both graph-memory documents were last modified at 10:07
and 10:08, before this session read them at ~11:16, and were unchanged at return. The
package is built against exactly the text you currently hold.

## Objective for this pass

Decide whether the component can enter the Fractal admission process. Concretely:

1. Verify the delivered evidence reproduces on your machine.
2. Rule on the six architecture deltas in §5 — they are the only items that need a decision.
3. Run compatibility tests in the Fractal repository, which this session was forbidden to do.
4. Accept, reject, or return with findings.

## Standing and boundaries observed

- **No Fractal file was touched.** Every command run in `~/openai/Verbalogix-Fractal` was read-only, verified by mtime at return.
- **No Fractal integration, compatibility or admission is claimed.** Per the implementer prompt, no such claim is permissible before compatibility tests run in the Fractal repository. That work is yours.
- The package sits as a **sibling** of `Verbalogix-Fractal`. It is a separate git repository with its own history; proximity is not inclusion.
- Nothing pushed, no remote configured. Dependencies are exactly one runtime package plus one optional provider SDK, both owner-approved.

## What was delivered

| Area | Path | Standing |
|---|---|---|
| Governance core | `src/core/**` | Pure — no network, provider, filesystem or storage imports, enforced by a build-failing check |
| Storage | `src/adapters/**` | `node:sqlite` system of record with real transactions; IndexedDB projection + outbox; in-memory |
| Relevance | `src/relevance/**` | Deterministic (offline) and embedded (genuine cosine), behind one injected seam |
| Provider | `src/providers/gemini.ts` | Outside the core; lazy import of the optional SDK |
| Surfaces | `src/port.ts`, `src/cli/**`, `src/mcp/**` | Library port, one-method model port, human CLI, read-only MCP |
| Documents | `src/docs/**` | Generated projections with checksummed frontmatter; authored-document ingest |
| Control tier | `src/control/**` | Registry, admissions, generalized lessons, federated reads |

50 source files, ~6,700 lines, 21 test files, 158 passing tests.

Requirement-by-requirement mapping — every specification clause, prompt invariant and
owner ruling traced to the code that implements it and the test that proves it — is in
**`REQUIREMENT-EVIDENCE.md`**.

## Verify in four commands

```sh
cd ~/openai/fractal-graph-memory
npm install          # zod; @google/genai optional
npm run check        # boundary policy + typecheck + 158 tests
npm run verify:pure  # the load-bearing one
node examples/dogfood.ts
```

`verify:pure` physically removes `@google/genai` from `node_modules`, clears
`GEMINI_API_KEY`, and runs the entire suite. It is the evidence for the central
reconciliation — embeddings are a production capability, while the governance core stays
offline and provider-independent. If anything quietly depends on the provider, it fails.

Live provider tests skip without a key. With one, they make ~8 calls and confirm three
documented behaviours: 768 dimensions returned without `task_type`, auto-normalization of
truncated dimensions, and correct asymmetric ranking.

## §5 Rulings required

Full reasoning for all thirteen deltas is in **`ARCHITECTURE-DELTA.md`**. None weakens an
invariant; several strengthen one. Six need your decision.

**D1 — embeddings vs the no-Gemini invariant.** The prompt says "avoid a dependency on
Gemini"; the owner requires embeddings. Reconciled by injection rather than by relaxing
the invariant: the core carries no provider code, no network code and no key, and
`verify:pure` proves the whole suite passes with the SDK absent. *Does this satisfy the
invariant as written?*

**D2 — SQLite added as system of record.** IndexedDB becomes a projection plus append
outbox. Forced by the owner's requirements — a CLI cannot reach browser IndexedDB, ingest
cannot read the filesystem from a browser, and the key never enters browser code. *Accept?*

**D3 — redaction as a transmission boundary.** The specification states a storage rule.
Embedding makes it a transmission rule: anything embedded leaves the device. Implemented
across five gates, with a spy-adapter test proving refused material never reaches
`embed()`. *Should this be written into the specification?*

**D6 — control tier.** Implemented per Ruling 6: registry, admissions, de-identified
generalized lessons and pointers, with no table capable of holding a project record.
*In scope for the returned component, or should it stay Fractal-side?*

**D7 — deviation semantics.** Ruling 7 required that a verified departure from a lesson is
not automatically a contradiction. Implemented as a distinct `deviation.observed` event
kind that becomes contradiction evidence only after four independent checks — exact
trigger/scope match, verified candidate, recorded comparison, domain validation. Similarity
or model judgement alone can never contradict. *Is that the right event kind and shape, or
would you prefer separate typed evidence?*

**D11 — sequencing.** The read-only MCP is implemented and tested but deliberately **not
connected** to Fractal, and no Fractal server endpoint was added; the embedding service
sits at the external CLI/server boundary. *Acceptable given Graph Memory is specified as
Cycle 2?*

Two further deltas (**D12**, **D13**) were found by dogfooding rather than by the
acceptance list: the direction bar was applied only at packet assembly, so it held by luck
rather than by construction, and the deterministic adapter reported a cosine score it had
never computed. Both are fixed. *Worth adding acceptance items for "the exclusion is
structural" and "citations name only signals that ran"?*

## §6 Compatibility work this session could not do

1. Run the component against the Fractal repository and confirm the interim journal's
   records map onto these ports without loss.
2. Confirm the `MemoryEvent` and `Lesson` shapes satisfy Fractal's own consumers.
3. Exercise the IndexedDB adapter in a real browser — see §7.
4. Decide whether the interim journal migrates now or at the Cycle 2 boundary.

## §7 Known limits, stated plainly

1. **IndexedDB is verified against a hand-written shim, not a browser.** No browser exists on the build device. The shim proves the outbox state machine — enqueue, peek, interrupted drain, replay, acknowledge — not IndexedDB itself. Cursors, indexes and `versionchange` are unimplemented by it.
2. **The migration ladder holds one version.** `MIGRATIONS` is empty because v1 is the first published schema. Every refusal path is tested; no version-to-version transform exists to test.
3. **Live provider coverage is deliberately minimal.** Rate limits, quota, batch embedding and multimodal input are untested.
4. **Control-tier promotion is library-only.** Deliberate: promotion requires a written no-proprietary-content rationale, and a flag-driven command is the wrong shape for a judgement that must be argued rather than asserted.
5. **No Fractal compatibility claim.** Nothing here has been run against the Fractal repository.

## §8 An upstream defect, found and fixed

`antigravity-memory-os/src/vector/providers/gemini.ts` sent `taskType` to
`gemini-embedding-2` at all three call sites, and `embedImage` sent `title` with no gate.
The current documentation is explicit that `task_type` is unsupported on that model, so
`RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY` and `CODE_RETRIEVAL_QUERY` were silently
equivalent — retrieval quality degraded with no error to notice.

Fixed on branch **`fix/gemini-embedding-2-task-type`** in `/root/antigravity-memory-os`
(one file, 52 insertions), verified against the real API. `master` untouched, nothing
pushed. Merge or discard as you see fit.

## §9 Provenance

`PROVENANCE.md` records every reused module against its origin repository, author, license
and modifications, plus five deliberate divergences from the origin code — transactions,
lexical retrieval, markdown ingestion, Gemini task conditioning, and the control tier's
rejection of automated distillation.

Reuse is an **external implementation base, not donor admission into Fractal**. Nothing has
been copied into the Fractal tree.

## §10 What to return

- Ruling on each of the six deltas in §5.
- Compatibility results from §6, or a statement that they are deferred.
- Accept / reject / return-with-findings, and any acceptance items you want added.

`ROADMAP.md` carries two owner-raised directions explicitly out of scope here — a deployed
multi-tenant MCP memory service, and a grounded market-research question about it. Neither
is a decision yet, and neither affects this admission.
