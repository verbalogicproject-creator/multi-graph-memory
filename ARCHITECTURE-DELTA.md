# Architecture delta

Where this implementation differs from `docs/specs/GRAPH-MEMORY-INTEGRATION.md` and the
Opus implementer prompt, and why. **No item below weakens an invariant**; several
strengthen one. Codex should rule on each.

## D1 — Embeddings reconciled by injection

*Spec:* "Avoid network calls. Avoid a dependency on Gemini." *Owner:* embeddings are mandatory.

Resolved by injection rather than by relaxing the invariant. The governance core carries
no provider code, no network code and no key; relevance is an adapter, and the Gemini
implementation lives outside both. `npm run verify:pure` removes `@google/genai` from
`node_modules`, clears the key, and runs the whole suite — **161 tests pass**.

A second constraint forces the same shape independently: multi-app's browser never holds
`GEMINI_API_KEY` -- `server.js` is an Express proxy precisely so it does not -- and a
browser-resident component therefore could not call `embedContent` anyway.

## D2 — SQLite added as the system of record

*Spec:* storage adapter contract + IndexedDB + in-memory.

Adds `node:sqlite` as the system of record; IndexedDB becomes a projection plus an append
outbox. Forced by the owner's requirements: a CLI cannot reach browser IndexedDB, ingest
cannot read the filesystem from a browser, and the key never enters browser code.

**Consequence:** real transactions had to be written from scratch. `antigravity-memory-os`
has no `BEGIN`/`COMMIT` anywhere in `src/`.

## D3 — Redaction is a transmission boundary, not only a storage rule

*Spec:* "stores no secrets, raw provider traces, audio, hidden chain-of-thought…"

Embedding makes this a *transmission* rule: anything embedded leaves the device. The gate
runs before persistence, embedding, provider transmission, export and cross-project
promotion — and a spy-adapter test proves refused material never reaches `embed()`.

**Recommendation:** write this into the specification.

## D4 — Relevance specified

*Spec:* `queryContext` returns "a bounded cited packet" — relevance is unspecified.

Filled in: facets (`projectId` · `component` · `kind` · `domain` · `triggerTags`), FTS5/BM25
lexical retrieval, exact trigger-tag agreement, recency decay, RRF fusion, and an optional
genuine-cosine signal.

## D5 — Isolation strengthened to fail closed

*Spec:* events carry `projectId`; isolation is not stated as an invariant.

`requireScope` refuses an unscoped query rather than widening it. Federated reads need a
complete admission record. Export defaults to one project; cross-project import refuses
without a recorded, human-approved re-home. Ported from the origin engine's model, which
was already stronger than the spec asked for.

## D6 — Control tier added as a second, optional module

Per Ruling 6. Holds registry metadata, schedule state, de-identified generalized lessons
and pointers — and defines no table that could hold a project record, asserted by test.

**Deliberate divergence:** the `image-studio` hive-mind design specifies an *automated*
"Global Distillation Engine". Ruling 6 forbids that; promotion here requires a recorded
human decision, and the mechanical leak scan is explicitly a backstop, not the authority.

## D7 — `deviation.observed` added; deviation ≠ contradiction

Per Ruling 7, and this is the change that most affects the system's character. A departure
that verifies is recorded as its own event and becomes contradiction evidence **only**
after four independent checks: exact trigger/scope match, verified candidate, recorded
comparison, domain validation. Similarity or model judgement alone can never contradict.

This is the mechanism that keeps the ratchet from ossifying — it is how an approved lesson
can be overturned by evidence rather than standing forever.

## D8 — Typed `domain` on every lesson

Per Ruling 8. Makes the creativity balance mechanical: it drives relevance weighting and
the direction-gate exclusion. Without it, "memory should not constrain taste" is a hope.

## D9 — Document surface added

Per Ruling 11. Generated projections vs authored evidence, with checksummed frontmatter
and hand-edit refusal. Ingestion uses a dedicated parser rather than the origin chunker,
which merges short sections under the wrong heading.

## D10 — Operator surfaces added

Per Ruling 9. Library port, one-method model port, human CLI, read-only MCP. The MCP
server **registers no mutation tools at all**, rather than gating them behind a runtime
flag as the origin server does. A flag can be set wrongly; an absent capability cannot.

## D11 — Cycle sequencing unchanged

Per Ruling 10. The MCP surface is implemented and tested but **not connected** to any
host, and no host server endpoint was added — the embedding service sits at the external
CLI/server boundary. The sequencing constraint that produced this delta was specific to
the original target; the shape it produced is kept because it is correct on its own terms.
A transport that registers no mutation tool cannot be pointed at a live host by accident.

## D12 — The direction bar moved earlier

Discovered during dogfooding. Filtering only at packet assembly made the exclusion depend
on retrieval: if relevance surfaced nothing, nothing was barred, and the guarantee held by
luck. The bar now applies at **candidate selection**, before ranking, with packet-level
filtering retained as defence in depth.

## D13 — No fabricated semantic signal

Also discovered during dogfooding. An earlier deterministic adapter passed recency into
the fusion's semantic slot, so every packet cited a `cosine` score that had never been
computed — and double-counted recency, which the fusion already applies as decay.

The deterministic adapter now reports only the signals it actually ran. A lesson with no
lexical overlap and no tag match does not surface at all; surfacing it for being merely
recent is noise, and noise is what erodes a bounded packet.

## Open questions

1. **D1** — does adapter injection satisfy "no Gemini dependency", given the core carries no provider code, no network code and no key, and `verify:pure` proves it?
2. **D3** — should the transmission-boundary rule be written into the specification?
3. **D6** — is the control tier in scope for this component, or should cross-build promotion live host-side?
4. **D7** — is `deviation.observed` the right event name and shape, or would you prefer a different typed evidence kind?
5. **D11** — is a read-only MCP surface acceptable to build now, given Graph Memory is specified as Cycle 2?
6. **D12/D13** — both were found by dogfooding rather than by the acceptance list. Worth adding acceptance items for "the exclusion is structural" and "citations name only signals that ran"?
