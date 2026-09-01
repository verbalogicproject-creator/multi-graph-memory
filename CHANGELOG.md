# Changelog

## [0.2.0] — 2026-09-01

Retargeted from Verbalogix Fractal to the multi-app builder, in place. The governance
core, storage, relevance and surfaces are unchanged; what moved is who the host is.

### Added — visual graph renderer and exporter
- `src/visualization/`, ported from `/root/hybrid-graph-memory` (see PROVENANCE.md).
- `multi-memory graph export <file.html|file.json>`: a self-contained 3D page, or nodes and
  edges for any other viewer.
- The edge vocabulary is declared, not inferred: `produced`, `reused-in`, `cites`,
  `contradicts`, `applied`. The `reused-in` edge is the ratchet, which makes the picture
  diagnostic — a lesson stuck at `proposed` is one whose reuse edge is missing.
- Export passes the Ruling 3 redaction gate. A graph is not a route around the boundary.
- Fixed in the port: the donor's CDN reference was unpinned, and its computed node sizing
  was dropped before reaching the renderer. Both repaired and covered by tests.
- 9 tests added; suite is 167 passing.

### Renamed
- Package `fractal-graph-memory` → `multi-graph-memory`; CLI `fractal-memory` → `multi-memory`.
- Cluster directory `.fractal-memory/` → `.multi-memory/`; config `.fractal-memory.json` → `.multi-memory.json`.
- Environment `FRACTAL_MEMORY_HOME` → `MULTI_MEMORY_HOME`, `FRACTAL_WORKSPACE` → `MULTI_WORKSPACE`.
- IndexedDB database `fractal-graph-memory-v1` → `multi-graph-memory-v1`; document generator id updated.

### Retargeted
- **Scope is the build, not the workspace.** One cluster per `SavedBuild`; the control tier
  is what spans builds, and only with a recorded human approval.
- **The direction bar binds to `suggestArtDirections`.** It was written against Fractal's
  three design directions; multi-app's Theme step produces three art directions through the
  same mechanism, so the bar transfers without weakening. Past builds may inform whether
  something works; they may not decide what the next one looks like.
- Event-kind mapping onto builder stages documented in the README. Seven of ten map onto
  surfaces that already exist. The two that do not — `verification.completed` and
  `repair.attempted` — are exactly the two that require observing a running application.
- Provider-boundary note now cites multi-app's Express proxy, which is why its browser
  never holds `GEMINI_API_KEY`.

### Removed
- `CODEX-COMPLETION-PROMPT.md`. It was a Fractal admission document — twelve rulings, a
  compatibility request, an admission decision — and none of it survives the change of
  host. Retained in git history at `3b3957e`.

### Unchanged and re-verified
- 158 tests pass, `check:boundaries` and `typecheck` green, `verify:pure` green.
- No file in `/root/multi-app` was modified. The integration is specified, not wired.

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
