# Changelog

## [0.1.0] — 2026-08-31

First return package for Codex. Not released, not published, no remote configured.

### Core governance
- Deterministic canonical serialization and SHA-256 content identity.
- Append-only events; idempotent re-delivery; immutable identities; corrections supersede.
- Episode lifecycle; lesson ratchet with all four promotion gates.
- `deviation.observed` as a distinct event, qualifying as contradiction evidence only after four checks (Ruling 7).
- Redaction as a storage **and** transmission boundary across five gates (Ruling 3).
- Strict project isolation, failing closed; federation admission records; re-home approval (Ruling 5).
- Export/import with schema version, checksum and migration-route validation.

### Storage
- `node:sqlite` system of record with real `BEGIN`/`COMMIT` and `SAVEPOINT` nesting.
- Round-trip fidelity: NULL columns decode to absent keys, so identities and checksums survive a reopen.
- FTS5 lexical index with MATCH-operator neutralisation.
- IndexedDB projection and append outbox; transactional, resumable, idempotent drain.

### Relevance
- Deterministic adapter: facets + lexical/BM25 + exact trigger tags + recency decay, fused with RRF. Fully offline.
- Embedded adapter: genuine cosine similarity through the injected port, with re-embed forced on model change *or* lesson edit.
- Gemini provider outside the core, lazily importing the optional SDK. Verified live: 768 dims, no `task_type`, auto-normalized.

### Surfaces
- `GraphMemory` library port; `ModelContextPort` with exactly one method.
- Read-only MCP registering no mutation tools at all.
- Interactive and headless CLI on built-in `node:readline`.
- Generated document projections with checksummed frontmatter and hand-edit refusal.

### Control tier
- Registry, schedule state, de-identified generalized lessons and pointers only.
- Promotion requires two distinct projects, human approval, and a recorded no-proprietary-content decision.

### Fixed during development
- **Credential detector false negative.** The `AIza` pattern required exactly 35 trailing characters plus a word boundary, so a 36-character token passed the gate. Relaxed to `{35,}`.
- **Fabricated semantic signal.** Recency was passed into the fusion's semantic slot, so packets cited a `cosine` score never computed, and recency was double-counted.
- **Non-total ranking order.** Equal-scoring items kept input order, so reversing the candidate list changed the ranking. Ties now break on id.
- **Direction bar depended on retrieval.** Taste lessons were filtered only at packet assembly; the bar now applies at candidate selection.
- **Adapter did not create its cluster directory**, so a first run failed on a fresh machine.
- **`federatedQuery` threw synchronously** while declaring a `Promise`, so a caller using `.catch()` would have taken an uncaught exception instead of a rejection.
- **`ControlStore` did not create its parent directory**, the same first-run failure already fixed in the cluster and vector adapters.
- **Two weak tests** replaced: one asserted a tautology and passed without exercising its subject; one hedged across two error codes, masking which check fired.

### Upstream
- `antigravity-memory-os/src/vector/providers/gemini.ts` sent `taskType` (and `title`) to `gemini-embedding-2` at all three call sites, which the current documentation forbids. Patched and verified live. **Left uncommitted** — that repository's history was not this session's to write.
