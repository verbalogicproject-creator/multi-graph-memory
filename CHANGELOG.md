# Changelog

## [Unreleased]

### Fixed — two refusals that read as empty results

Both were found by the first host to depend on this package rather than read it,
and both cost the same thing: a caller was told nothing happened, when something
had in fact been rejected.

- **A schema refusal now names the field and the value it rejected**, in
  `error.message` rather than only in `error.detail.issues`. Logging `message` and
  dropping the rest is the normal thing to do at a process boundary, and the host
  that did lost every event carrying an undeclared `domain` — reported to it as a
  count, with the field never named. The message now reads `Event failed schema
  validation — domain: Invalid option: expected one of "build"|…|"art-direction"`,
  so a caller learns both what was wrong and what would have been accepted. New
  `refuseSchema()` in `core/errors.ts`; the five `prepare*` and import sites share
  it, each naming its own subject, and every issue is still in `detail`.
- **`--build <id>` no longer creates the cluster it cannot find.** Opening a
  SQLite database creates it, so a mistyped build id answered "No episodes
  recorded" — indistinguishable from a build that genuinely recorded nothing — and
  left an empty file behind. It now refuses by name, lists the ids that do exist,
  and exits 1 having created nothing. Two exemptions, both deliberate:
  `--database` names a file the caller chose, and `sync import` is how a bundle is
  restored *into* a cluster that does not exist yet — guarding that would have
  traded one silent failure for a loud broken workflow.

Covered by `test/refusals.test.ts`, including that the guard runs *before*
anything is opened, and that the working case still works. 219 tests.

### Added — a build, so a plain-JavaScript host can consume the package

The package runs its own TypeScript directly on Node's type stripping, which is
why it has never needed a build. A consumer cannot do that: Node strips types in
a project's own files and **never inside `node_modules`**. So the multi-app
server — plain ESM `.js`, no build step — could not have imported this at all.

- `tsconfig.build.json` + `npm run build`. Close to mechanical, because the source
  already satisfies `erasableSyntaxOnly`: strip types, rewrite `./x.ts` specifiers
  to `./x.js` via `rewriteRelativeImportExtensions`. No bundler, no downlevel.
- `exports` and `bin` now point at `dist/`; `npm run memory` and `npm run mcp` still
  run the source directly, so development is unchanged.
- `tooling/check-dist.mjs`, wired into `npm run check`. Deliberately `.mjs` and
  importing only through the package's own exports map, so it fails the way a real
  consumer would. A green test suite proves nothing here — the suite runs the source
  on type stripping, which is exactly the thing a consumer cannot do. It drives the
  real loop (open, append attributed event, close, query) and asserts that
  `ModelContextPort` is still approval-free in the built artifact.
- **Confirmed, not assumed:** installed into a scratch project as a `file:`
  dependency and imported from plain JS. npm's script policy skipped `prepare`, so a
  consumer does not get an automatic build — which is why the host must build
  explicitly and degrade gracefully when `dist/` is absent, rather than assume it.

### Added — schema version 2: provider and model attribution

The host became multi-provider (Google, Anthropic, OpenAI, NVIDIA behind one
adapter interface), so "that step failed" stopped being a complete record. Without
naming the producer, four providers' outcomes average into one blur and no
per-provider claim is checkable afterwards.

- `Attribution` on `MemoryEvent` (`provider`, `model`, `surface`) and on `Episode`
  (`provider`, `model` — an episode spans surfaces, so it has no single one).
  Every field optional: attribution is evidence when present, never a precondition.
- Set on an episode at **close**, not at open: under a fallback chain the model that
  actually served is only known afterwards. A value recorded at open is never
  overwritten by a later one; absent fields are filled per field.
- `EventQuery` gains `provider` / `model` / `surface`, matched exactly, in the SQL
  narrowing and in the shared JS predicate both — so the projection and the system
  of record cannot disagree.
- Empty strings are refused rather than stored: `""` and absent would otherwise be
  two spellings of the same unknown, and would derive two different event ids.
- Attribution does not change episode identity (the same attempt is the same episode
  either way) but **does** participate in event identity, so the same call served by
  two providers is honestly two records.

### Added — CLI parity for attribution
- `multi-memory events [--kind|--episode|--provider|--model|--surface|--component|--since|--limit]`
  — the event journal was previously reachable only from code.
- `multi-memory episode list [--provider P] [--model M]`, and the list now prints the
  producer (or `unattributed`).
- `multi-memory attribution` — events and episode outcomes counted per producer.
  It reports observations and says so; it does not rank providers.

### Migration
- `CURRENT_SCHEMA_VERSION` 1 → 2; `SUPPORTED_SCHEMA_VERSIONS` `[1, 2]`.
- Bundle ladder: a real 1 → 2 step whose transform is identity, because version 2 only
  adds optional fields. Nothing is back-filled — inventing an attribution for a record
  written before attribution existed would manufacture evidence.
- On-disk ladder in `SqliteStorageAdapter.open()`: additive `ALTER TABLE`, guarded by a
  `PRAGMA table_info` presence check rather than a try/catch, so "already applied" and
  "failed" stay distinguishable and a genuine failure still throws.
- **Fixed while testing the ladder:** the version-2 index was declared in `SCHEMA`, which
  runs before the ladder adds its column — opening any existing version-1 database failed
  outright with `no such column: provider`. Indexes over new columns are now created after
  the version is resolved. Found by the hand-built v1 fixture, not by review.

### Added — concurrency
- `PRAGMA busy_timeout` (default 2000 ms, `SqliteOptions.busyTimeoutMs`). This store has two
  legitimate writers — a host server holding a long-lived connection and the human CLI
  approving a lesson — and without a timeout the second fails instantly on any overlap.

### Tests
- `test/attribution.test.ts` (11) — validation, identity stability for pre-v2 events,
  filtering, and the fill-never-overwrite rule at close.
- `test/adapter.sqlite.migration.test.ts` (5) — a hand-built **real v1 database** upgraded on
  open, legacy ids and field absence preserved, attributed writes afterwards surviving a
  reopen, and an interrupted migration (columns present, version lagging) re-running cleanly.
- `test/cli.surface.test.ts` (+5) — CLI filters, `unattributed` rendering, and a check that
  `HELP` advertises every attribution surface actually implemented.
- Suite: 193 tests, 188 passing, 5 skipped (live-API), 0 failing. `verify:pure` still green.

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
