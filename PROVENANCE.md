# Provenance and dependency inventory

Ruling 12: reuse of existing code is an *external implementation base*, not donor
admission into the host. Nothing in this package has been copied into
`/root/multi-app`, and this package makes no claim of being integrated with it.

## Origin repositories

| Repository | Role | Author | License |
|---|---|---|---|
| `/root/antigravity-memory-os` | Primary implementation base | Eyal Nof | MIT (declared in `package.json`; **no LICENSE file present** — see Known gaps) |
| `/root/image-studio` | Earlier prototype the above was extracted from | Eyal Nof | MIT |

## Vendored modules

Each file carries a header naming its origin and its modifications.

| File | Origin | Modifications | Covered by |
|---|---|---|---|
| `src/relevance/vendored/math.ts` | `antigravity-memory-os/src/vector/math.ts` | Strict-mode index guards; `bufferToFloat32` uses a typed-array copy instead of a byte loop (same bytes, no aliasing). Algorithm unchanged. | `test/relevance.ranking.test.ts` |
| `src/relevance/vendored/rank_fusion.ts` | `antigravity-memory-os/src/retrieval/rank_fusion.ts` | `RankedCandidate` trimmed to populated fields; three near-identical loops collapsed into one helper. **Formula, intent weights, k=60, half-life and decay floor unchanged.** | `test/relevance.ranking.test.ts` |
| `src/relevance/vendored/intent.ts` | `antigravity-memory-os/src/retrieval/intent.ts` | `RetrievalIntent` narrowed to the five values the function can actually return (the original declared eight, three of which it never produced). Keyword lists unchanged. | `test/relevance.ranking.test.ts` |

## Adapted modules

Recognisably derived, but retargeted enough that vendoring a copy would leave dead code.

| File | Origin | Nature of adaptation |
|---|---|---|
| `src/core/diversity.ts` | `image-studio/memory/diversity.ts` (`filterForDiversity`) | Retargeted from `RetrievedContext` to `CitedItem`; per-episode capping added alongside the original per-file cap. This module **did not survive extraction** into antigravity-memory-os. |
| `src/core/packet.ts` (rendering) | `image-studio/memory/packaging.ts` (`packageContextForAgent`) | Same shape — per-item citation, match reason, per-item truncation, total budget, explicit "showing N of M" omission line — retargeted onto the governed packet. Also **did not survive extraction**. |
| `src/relevance/lexical.ts` | `antigravity-memory-os/src/retrieval/lexical.ts` | Retargeted from chunk fields to lesson fields; exact trigger-tag matching added as its own weighted signal. |
| `src/mcp/server.ts` (transport) | `antigravity-memory-os/src/mcp/server.ts` | Same hand-rolled line-delimited JSON-RPC over `node:readline`. **Behaviour deliberately differs**: that server gates mutation tools behind a runtime flag; this one registers none. |
| `src/cli/*` (shape) | `antigravity-memory-os/bin/agy-memory.ts` | Same dual interactive/headless shape. Uses built-in `node:readline` rather than the `prompts` dependency. |

## Deliberate divergences from the origin code

Recorded so they read as decisions, not oversights.

1. **Transactions.** `antigravity-memory-os` contains no `BEGIN`/`COMMIT` anywhere in `src/`. Ruling 4's resumable outbox drain depends on atomicity, so the SQLite adapter here implements real transactions with `SAVEPOINT` nesting.
2. **Lexical retrieval.** In the origin, FTS5 tables are populated but **never queried** — no code issues a `MATCH` — and `lexical.ts` is a substring scorer. Here FTS5 is genuinely queried, with operator neutralisation so user text cannot inject query syntax.
3. **Markdown ingestion.** The origin's chunker only flushes at a heading once 15 lines have accumulated, and reuses the heading after a 70-line split, so short entries merge under the wrong titles. This package uses a dedicated parser preserving full heading hierarchy.
4. **Gemini task conditioning.** The origin sends `taskType` (and, for images, `title`) to `gemini-embedding-2` at all three call sites, which the current documentation forbids. Corrected here, and **also fixed upstream** in `/root/antigravity-memory-os/src/vector/providers/gemini.ts` (left uncommitted there — that repo's history is not this session's to write).
5. **Control tier.** The `image-studio` hive-mind design specifies an *automated* "Global Distillation Engine". Ruling 6 forbids exactly that: automated de-identification is not proof. Promotion here requires a recorded human decision.

## Dependency and license inventory

| Package | Kind | Version | License | Why |
|---|---|---|---|---|
| `zod` | runtime | ^3.24.1 (resolved 3.25.76) | MIT | Runtime validation, and the source of the emitted JSON Schema artifacts |
| `@google/genai` | **optional** | ^2.18.0 (resolved 2.19.0) | Apache-2.0 | Gemini embedding provider only. Lazily imported; `npm install --omit=optional` leaves the package fully functional |
| `typescript` | dev | ^5.8.2 | Apache-2.0 | `tsc --noEmit` typechecking |
| `@types/node` | dev | ^22.13.4 | MIT | Node type definitions |

No test framework, no argument parser, no SQLite driver and no IndexedDB shim
package are used: `node:test`, `node:sqlite`, `node:readline` and Node's native
TypeScript type-stripping cover all four, so the runtime dependency surface is
exactly one package.

`allowScripts` keeps the posture this component was written with: install scripts are
disabled for `@google/genai` and `protobufjs`.

## Visualization

| Module | Origin | Author | License |
|---|---|---|---|
| `src/visualization/threejs_renderer.ts` | `/root/hybrid-graph-memory` `src/visualization/threejs_renderer.ts` | Eyal Nof | MIT |
| `src/visualization/exporter.ts` | same path, **rewritten** — see below | Eyal Nof | MIT |

The renderer transferred nearly intact. Two defects were fixed in the port:

1. **Unpinned CDN.** The donor loaded `unpkg.com/3d-force-graph` with no version, so a
   rendered file's behaviour changed whenever upstream published. Pinned to `@1`.
2. **Node sizing never rendered.** The donor's exporter computed degree centrality into
   `val` ("Topological Node Gravity") and the `gData` mapping dropped the field, so the
   renderer never received it. `val` is now carried and bound via `.nodeVal()`.

`generateLiveHtml` was not ported — it polls a server endpoint this package does not have.

The exporter was **rewritten rather than adapted**. The donor built its graph from a code
relation table with node types guessed from identifier spelling. This package has no such
table; it has a governance lineage, so the edge vocabulary is declared (`EDGE_KINDS`) and
every edge is a recorded fact rather than an inference. The export also passes the Ruling 3
redaction gate, which the donor had no equivalent of.

## Known gaps

- `/root/antigravity-memory-os` declares MIT in `package.json` but ships **no LICENSE file**. This package includes one.
