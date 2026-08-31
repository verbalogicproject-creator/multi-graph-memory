# Handoff to Codex — Fractal Graph Memory

**Date:** 2026-08-31 · **From:** Opus implementer session · **Package:** `~/openai/fractal-graph-memory`

Sits as a **sibling of `Verbalogix-Fractal`** in `~/openai/`, so it is reachable from the
same working root you use. It is a separate git repository with its own history; nothing
here is inside the Fractal tree.

**Supersedes** `/root/antigravity-memory-os/memory-replay-to-codex.md`. That document was a
*planning* replay written before implementation; its open questions are answered below or
were settled by the owner's ruling document. Read this instead.

## Standing

Implementation of `docs/specs/GRAPH-MEMORY-INTEGRATION.md` and
`docs/prompts/GRAPH-MEMORY-OPUS-IMPLEMENTER.md`, delivered as an independent package.

- **No Fractal file was touched.** Every command run in `~/openai/Verbalogix-Fractal` was read-only.
- **No Fractal integration, compatibility or admission is claimed.** Per the implementer prompt, no such claim is permissible before compatibility tests run in the Fractal repository.
- Nothing pushed, no remote configured, no dependency installed beyond what the owner approved.

**Spec alignment verified at handoff:** `GRAPH-MEMORY-INTEGRATION.md` (mtime 10:07) and
`GRAPH-MEMORY-OPUS-IMPLEMENTER.md` (10:08) were both unmodified since before this session
read them at ~11:16, so the package is built against exactly what you currently have.

## Verify it in four commands

```bash
cd ~/openai/fractal-graph-memory
npm install         # zod only; @google/genai is optional
npm run check       # boundaries + typecheck + 158 tests
npm run verify:pure # the load-bearing one — see below
node examples/dogfood.ts
```

`verify:pure` physically removes `@google/genai` from `node_modules`, clears
`GEMINI_API_KEY`, and runs the entire suite. It is the evidence for the reconciliation
between "embeddings are mandatory" and "avoid a dependency on Gemini": the governance core
and its full test suite pass with no provider package, no key and no network.

Live provider tests skip automatically without a key. With one set, they make ~8 calls.

## What is here

| Area | Files | Notes |
|---|---|---|
| Governance core | `src/core/**` | Pure. No network, no provider, no storage imports — enforced by `tooling/check-boundaries.mjs`, which fails the build |
| Storage | `src/adapters/**` | `node:sqlite` system of record with real transactions; IndexedDB projection + outbox; in-memory |
| Relevance | `src/relevance/**` | Deterministic (offline) and embedded (genuine cosine), behind one injected seam |
| Provider | `src/providers/gemini.ts` | Outside the core, lazy import of the optional SDK |
| Surfaces | `src/port.ts`, `src/cli/**`, `src/mcp/**` | Library port, one-method model port, human CLI, read-only MCP |
| Documents | `src/docs/**` | Generated projections with checksummed frontmatter; authored-document ingest |
| Control tier | `src/control/**` | Registry, admissions, generalized lessons, federated reads |

Requirement-by-requirement mapping, including which test proves each one, is in
**`REQUIREMENT-EVIDENCE.md`**. Reuse and licensing is in **`PROVENANCE.md`**.

## What needs your ruling

Full reasoning for each is in **`ARCHITECTURE-DELTA.md`** (13 deltas). None weakens an
invariant; several strengthen one. Six need a decision:

1. **D1 — embeddings.** The prompt says "avoid a dependency on Gemini"; the owner requires embeddings. Reconciled by injection: the core carries no provider code, no network code and no key. Does `verify:pure` satisfy the invariant as written?
2. **D3 — redaction.** Embedding makes redaction a *transmission* rule, not only a storage rule: anything embedded leaves the device. Implemented across five gates, with a spy-adapter test proving refused material never reaches `embed()`. Should this be written into the specification?
3. **D6 — control tier.** In scope for the returned component, or should it stay Fractal-side with the component single-cluster?
4. **D7 — deviation.** Ruling 7 required that a verified departure from a lesson is *not* automatically a contradiction. Implemented as a distinct `deviation.observed` event kind that qualifies only after four independent checks. Is that the right event name and shape, or would you prefer separate typed evidence?
5. **D11 — sequencing.** The read-only MCP is implemented and tested but deliberately **not connected** to Fractal, and no Fractal server endpoint was added. Acceptable given Graph Memory is specified as Cycle 2?
6. **D12/D13.** Both were found by dogfooding rather than by the acceptance list — the direction bar was not structural, and the deterministic adapter reported a cosine it never computed. Worth adding acceptance items for "the exclusion is structural" and "citations name only signals that ran"?

## Honest limits

1. **IndexedDB is verified against a hand-written shim, not a browser.** No browser exists on this device. The shim proves the outbox state machine — enqueue, peek, interrupted drain, replay, acknowledge — not IndexedDB itself. Cursors, indexes and `versionchange` are not implemented by it.
2. **The migration ladder holds one version.** `MIGRATIONS` is empty because v1 is the first published schema. Every *refusal* path is tested (unsupported version, absent route, downgrade); no actual version-to-version transform exists to test.
3. **Live provider coverage is deliberately minimal.** Three behaviours confirmed: 768 dimensions without `task_type`, auto-normalization of truncated dimensions, and correct asymmetric ranking. Rate limits, quota, batch embedding and multimodal input are untested.
4. **Control-tier promotion is library-only.** Deliberate: promotion requires a written no-proprietary-content rationale, and a flag-driven CLI command is the wrong shape for a judgement that must be argued rather than asserted.
5. **No Fractal compatibility claim.** Nothing here has been run against the Fractal repository.

## Related: an upstream defect, fixed

`antigravity-memory-os/src/vector/providers/gemini.ts` sent `taskType` to
`gemini-embedding-2` at all three call sites, and `embedImage` sent `title` with no gate.
The current documentation is explicit that `task_type` is not supported on that model, so
`RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY` and `CODE_RETRIEVAL_QUERY` were silently
equivalent — retrieval quality degraded with no error to notice.

Fixed on branch **`fix/gemini-embedding-2-task-type`** (one file, 52 insertions), verified
against the real API. `master` is untouched; nothing was pushed. If you also work in that
repository, merge or discard as you see fit.

## Note on parallel work

This session observed the Fractal repository being edited concurrently
(`SYSTEM-DESIGN-CONTRACT.md`, 12:04). Its content was unchanged where this package depends
on it — the direction-gate section is verbatim what was built against. Flagged only so you
know two agents were active in the tree today.

## Next

`ROADMAP.md` carries two owner-raised directions explicitly out of scope here: a deployed
multi-tenant MCP memory service, and a grounded market-research question about it. Both
need work before they are decisions; the research one is framed to be falsifiable, with a
warning about the confirmation bias it invites.
