# Requirement-to-evidence matrix

Every requirement from `GRAPH-MEMORY-INTEGRATION.md`, the Opus implementer prompt,
and the twelve owner rulings, mapped to the code that implements it and the test
that proves it. Run `npm run check` to reproduce (158 tests).

**Status legend:** ✅ implemented and tested · ⚠️ implemented, verification limited · ⛔ deferred

## A. Specification — `docs/specs/GRAPH-MEMORY-INTEGRATION.md`

| Requirement | Implementation | Evidence | Status |
|---|---|---|---|
| Deterministic event identity | `core/canonical.ts` `deriveEventId` | `events.append.test.ts` "deterministic across independent stores" | ✅ |
| Append-only; corrections are new events | `core/events.ts` `supersessionChain` | `events.append.test.ts` "correction supersedes rather than overwrites" | ✅ |
| Idempotent duplicate delivery | `core/events.ts` `appendEventTx` | `events.append.test.ts`, `events.concurrency.test.ts` | ✅ |
| Bounded payloads; malformed/oversized refusal | `core/schema.ts`, `core/redaction.ts` | `events.validation` cases in `redaction.test.ts` | ✅ |
| Episode = bounded sequence, one objective + base revision | `core/episodes.ts` | `lessons.reuse.test.ts` | ✅ |
| Lesson: trigger, recommendation, scope, sources, evidence, limits, contradictions | `core/types.ts`, `core/lessons.ts` | `lessons.*.test.ts` | ✅ |
| Promotion gate 1 — verified source evidence | `core/lessons.ts` `proposeLesson` | `lessons.reuse.test.ts` unknown/foreign episode cases | ✅ |
| Promotion gate 2 — reuse in a separate episode | `core/lessons.ts` `recordReuse` | `lessons.reuse.test.ts` (5 cases) | ✅ |
| Promotion gate 3 — no unresolved contradiction | `core/lessons.ts` `assertNoContradiction` | `lessons.contradiction.test.ts` | ✅ |
| Promotion gate 4 — explicit human approval | `core/lessons.ts` `approveLesson` | `lessons.approval.test.ts`, `cli.surface.test.ts` | ✅ |
| Contradiction retains history; visible after revocation | `core/lessons.ts` `recordContradiction` | `lessons.contradiction.test.ts` | ✅ |
| Storage adapter contract | `adapters/storage.ts` | all adapter tests | ✅ |
| IndexedDB adapter | `adapters/indexeddb.ts` | `adapter.indexeddb.test.ts` (shim) | ⚠️ no real browser — see Deferred |
| In-memory test adapter | `adapters/memory.ts` | used throughout | ✅ |
| Zod validation | `core/schema.ts` | all validation tests | ✅ |
| Deterministic serialization | `core/canonical.ts` | `portability.test.ts` "same state, identical bytes" | ✅ |
| Export carries schema version, serialization, checksum | `core/portability.ts` | `portability.test.ts` | ✅ |
| Import validates size, identity, checksum, schema, migration route | `core/portability.ts`, `core/migrate.ts` | `portability.test.ts` (5 cases) | ✅ |
| Migration fixtures | `core/migrate.ts` `planMigration` | `portability.test.ts` "no migration route" | ⚠️ one schema version exists; the refusal path is exercised, no real migration yet |
| Stores no secrets, traces, audio, chain-of-thought, opaque executables | `core/redaction.ts` | `redaction.test.ts` (12 cases) | ✅ |
| Ports: append, query, propose, reuse, contradict, approve, revoke, export/import | `port.ts` | `cli.surface.test.ts`, `mcp.readonly.test.ts` | ✅ |
| Queries return citations, scope, freshness, omissions | `core/packet.ts` | `packet.creativity.test.ts`, `packet.diversity.test.ts` | ✅ |
| Concurrency-safe duplicate handling | `adapters/*`, `core/events.ts` | `events.concurrency.test.ts` | ✅ |
| Persistence across reopen | `adapters/sqlite.ts` | `adapter.sqlite.test.ts` | ✅ |
| Cycle 2 compat: extra event/evidence kinds are additive | `core/types.ts` union + optional facets | `deviation.observed` added without a new authority path | ✅ |

## B. Implementer prompt invariants

| Invariant | Evidence | Status |
|---|---|---|
| Append-only evidence, immutable event identities | `events.append.test.ts` | ✅ |
| No secret / raw trace / hidden chain-of-thought storage | `redaction.test.ts` | ✅ |
| No promotion from confidence or a single episode | `lessons.approval.test.ts`, `lessons.reuse.test.ts` | ✅ |
| Successful reuse must occur in a distinct episode | `lessons.reuse.test.ts` | ✅ |
| Contradiction blocks promotion, visible after revocation | `lessons.contradiction.test.ts` | ✅ |
| Human approval required for persistent guidance | `lessons.approval.test.ts`, `cli.surface.test.ts` | ✅ |
| Queries return citations, scope, freshness, omission limits | `packet.*.test.ts` | ✅ |
| Memory grants no filesystem/dependency/donor/model/network/revision/deployment authority | `core/errors.ts` `refuseAuthority`; `authority: "context_only"` on every packet | `mcp.readonly.test.ts` "authority boundary" | ✅ |
| Project revisions and the System Design Contract remain stronger truth | stated in every packet's advisory line | `packet.creativity.test.ts` | ✅ |
| No framework UI, no network calls, no Gemini/SAG/React/Fractal-internal dependency in the core | `tooling/check-boundaries.mjs` | `npm run verify:pure` | ✅ |

## C. Owner rulings

| Ruling | Evidence | Status |
|---|---|---|
| 1 — governance and relevance separate; similarity only reorders | `relevance/adapter.ts` cannot express promotion; `relevance.ranking.test.ts` "never mutates a lesson" | ✅ |
| 2 — embeddings required but not a core dependency | `npm run verify:pure` — 148 tests pass with `@google/genai` removed and no key | ✅ |
| 2 — re-verify docs immediately before implementing; fix `taskType` defect | `providers/gemini.ts` header (verified 2026-08-31); `relevance.vectors.test.ts`; upstream patched | ✅ |
| 2 — store model id, dimensions, prompt-format version; force re-embed | `relevance/embedding-port.ts` | `relevance.vectors.test.ts` | ✅ |
| 3 — redaction before persistence, embedding, transmission, export, promotion | `core/redaction.ts` | `redaction.test.ts` "all five gates" | ✅ |
| 3 — prove rejected material never reaches the embedding adapter | `relevance/embedding-port.ts` `guardedEmbed` | `redaction.test.ts` spy-adapter test | ✅ |
| 4 — node:sqlite / IndexedDB / in-memory, one domain model, one ladder | `adapters/*` | `adapter.sqlite.test.ts`, `adapter.indexeddb.test.ts` | ✅ |
| 4 — transactional, resumable, idempotent drain; no duplicates on replay | `adapters/outbox.ts` | `adapter.indexeddb.test.ts` "interrupted drain" | ✅ |
| 4 — projection keeps deterministic lexical/facet/recency queries without vectors | `adapters/indexeddb.ts`, `relevance/deterministic.ts` | `adapter.indexeddb.test.ts` | ✅ |
| 5 — every query scoped; fails closed | `core/scope.ts` `requireScope` | `scope.isolation.test.ts` | ✅ |
| 5 — federated reads need a complete admission record | `core/scope.ts`, `control/federation.ts` | `scope.isolation.test.ts`, `federation.test.ts` | ✅ |
| 5 — admissions held in the control tier, not in a cluster | `control/registry.ts` `putAdmission` | `federation.test.ts` | ✅ |
| 5 — a federated read consults only admitted projects | `control/federation.ts` | `federation.test.ts` (3 cases) | ✅ |
| 5 — single-project export; re-home needs human approval | `core/portability.ts` | `portability.test.ts` | ✅ |
| 6 — control tier separate, pointers only, never project content | `control/*` | `control.leak.test.ts` (8 cases) | ✅ |
| 6 — promotion needs 2 distinct projects + human approval + recorded decision | `control/generalize.ts` | `control.leak.test.ts` | ✅ |
| 6 — automated de-identification is not proof | `control/generalize.ts` gate 4 | `control.leak.test.ts` gate-4 case | ✅ |
| 7 — deviation is a distinct event, not automatically a contradiction | `core/deviation.ts` | `lessons.deviation.test.ts` | ✅ |
| 7 — four checks; similarity alone can never contradict | `core/deviation.ts` `evaluateDeviation` | `lessons.deviation.test.ts` | ✅ |
| 8 — 3–5 injected items maximum | `core/packet.ts` `MAX_INJECTED_ITEMS` | `packet.creativity.test.ts` "hard clamp" | ✅ |
| 8 — cited scope, freshness, limits, omission notice; advisory framing | `core/packet.ts` | `packet.creativity.test.ts` | ✅ |
| 8 — high weight for build/diagnostics/dependency/api-usage/environment/repair; very low for taste/layout/copy/art-direction | `core/packet.ts` `domainWeight` | `packet.creativity.test.ts` | ✅ |
| 8 — structurally barred from direction generation; no taste lesson may enter | `core/packet.ts` `DIRECTION_BARRED_DOMAINS` | `packet.creativity.test.ts`, `cli.surface.test.ts` | ✅ |
| 9 — library port, context-read port, human CLI, read-only MCP | `port.ts`, `cli/*`, `mcp/server.ts` | `cli.surface.test.ts`, `mcp.readonly.test.ts` | ✅ |
| 9 — MCP exposes no approval/revocation/admission/re-homing | `mcp/server.ts` | `mcp.readonly.test.ts` (3 cases incl. a source scan) | ✅ |
| 9 — approval structurally unreachable from model surfaces | `port.ts` `ModelContextPort` | `mcp.readonly.test.ts` "exactly one method" | ✅ |
| 10 — Cycle 2 boundary unchanged; MCP not connected to Fractal | no Fractal file touched; no Fractal endpoint added | `git -C ~/openai/Verbalogix-Fractal status` clean of this work | ✅ |
| 11 — approved document names; authored vs generated ownership | `docs/projector.ts` | `docs.frontmatter.test.ts` | ✅ |
| 11 — checksummed frontmatter; hand edit refused and reported | `docs/frontmatter.ts` | `docs.frontmatter.test.ts` | ✅ |
| 12 — reuse is external base, not admission; inventory required | `PROVENANCE.md` | this document | ✅ |

## D. Partial, unverified or deferred

1. **IndexedDB in a real browser.** Verified against a hand-written in-process shim (Decision 4: no new devDependency). The shim proves the outbox state machine — enqueue, peek, interrupted drain, replay, acknowledge — not IndexedDB itself. Cursors, indexes and `versionchange` blocking are not implemented by the shim and not exercised.
2. **Migration ladder has one version.** `MIGRATIONS` is empty because schema v1 is the first published schema. The *refusal* paths (unsupported version, absent route, downgrade) are fully tested; an actual version-to-version transform is not, because none exists yet.
3. **Live provider coverage is minimal by design.** Three live tests, four API calls, skipped without `GEMINI_API_KEY`. They confirm dimensions, auto-normalization and asymmetric retrieval ordering. Rate limits, quota behaviour, batch embedding and multimodal input are not exercised.
4. **Control-tier promotion has no CLI verb.** `@global` reports the tier and `admit` records an admission, but `promoteToControlTier` remains library-only. Deliberate: promotion requires a written no-proprietary-content rationale, and a flag-driven command is the wrong shape for a judgement that must be argued rather than asserted.
5. **Upstream fix left uncommitted.** `/root/antigravity-memory-os/src/vector/providers/gemini.ts` is patched and verified live, but not committed — that repository's history was not this session's to write.
6. **No Fractal compatibility claim.** Nothing here has been run against the Fractal repository. Per the implementer prompt, no such claim is permissible until compatibility tests run there.
