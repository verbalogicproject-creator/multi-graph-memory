# multi-graph-memory

Governed episodic and lesson memory for the **multi-app builder** — local-first, with an
**offline-pure governance core** and an **injected relevance layer**.

> **Standing:** the governance core, storage, relevance and surfaces are built and tested
> (253 tests, `verify:pure` green as of 2026-09-08). The binding to multi-app is **wired**,
> not merely specified: multi-app declares this package in its `dependencies`, imports it
> through `memory/bridge.js`, exercises it end to end in `npm run smoke:memory`, and builds
> it in CI. See [Integrating with multi-app](#integrating-with-multi-app).
>
> An earlier version of this note said the binding was "specified, not wired" and that no
> file in `/root/multi-app` had been modified. Both stopped being true and the note did not,
> which is the failure this paragraph now exists to avoid: a standing claim is a claim, and
> it goes stale silently.

## What problem it solves

multi-app takes an idea through Plan → Theme → Generate → Export and hands back a project.
When a generated app fails the same way it failed last week — a dependency that never
resolves on this platform, an API used the way the model always uses it, a build flag that is
wrong every time — nothing carries that across builds. Each build starts from zero.

The problem it must *not* create is subtler: a memory that feeds a generative model its own
past **converges**. It exploits, stops exploring, and yields a builder that grows more
reliable and less imaginative — bounded by its earliest mistakes. For a tool whose output is
supposed to look different every time, that is fatal rather than merely unfortunate.

So the governing rule is:

> **Memory constrains authority, not imagination.** The ratchet is on what becomes policy,
> never on what the model may think.

Memory **informs** and **warns**. It does not **forbid**.

## One cluster per build

Scope is the **build**, not the workspace. What accumulates in a cluster is what went wrong
generating, running and repairing one application. A lesson crosses builds only through the
control tier, and only with a human approval on the record — because "this always fails" is a
claim that needs to have been true in more than one place.

## The two objects

| | Owns | Refuses |
|---|---|---|
| **Governance core** (`src/core`) | events, episodes, evidence, lesson lifecycle, bounded packets, migrations | promotion from confidence, from one episode, or without a human |
| **Relevance** (`src/relevance`) | recall and ranking | everything else — it cannot qualify, approve, satisfy reuse, or contradict |

Similarity may reorder what a query returns. It can never promote.

## Quick start

```bash
npm install          # zod; @google/genai is optional
npm run check        # boundaries + typecheck + the suite + dist smoke
npm run verify:pure  # proves the package works with NO provider and NO key
node examples/dogfood.ts
```

```ts
import { SqliteStorageAdapter, GraphMemory } from "multi-graph-memory";

const storage = new SqliteStorageAdapter({ path: ".multi-memory/build-42.db" });
storage.open();
const memory = new GraphMemory({ storage, scope: { workspace: "multi-app", projectId: "build-42" } });

const episode = memory.openEpisode({ objective: "repair the build", baseRevisionId: "rev-1" });
const evidence = memory.recordEvidence({ kind: "verification.result", ref: "run://build/1" });
memory.closeEpisode(episode.id, "verified");

const lesson = memory.proposeLesson({
  trigger: "vite build fails with ERR_REQUIRE_ESM",
  recommendation: "Pin the plugin to its ESM build.",
  scope: ["build"], domain: "build",
  sourceEpisodeIds: [episode.id], evidenceIds: [evidence.id],
  limits: ["Observed on Node 24 under Termux."],
});

// The ratchet: none of these shortcuts are available.
memory.approveLesson(lesson.id, "eyal");                  // refused — never reused
memory.recordReuse(lesson.id, episode.id, [evidence.id]); // refused — same episode
```

## The learning loop

```
episode opens (objective + base revision)
   ↓ events append: planning.answer → contract.delta → candidate.created
   ↓                verification.completed → repair.attempted → promoted | rolled_back
episode closes with an outcome
   ↓
lesson PROPOSED
   ↓  surfaced by queryContext in a LATER, DISTINCT episode  ← relevance is the rate limiter
   ↓  applied there, and that episode verifies
recordReuse()      → QUALIFIED        one success can never promote
   ↓
approveLesson()    → APPROVED         human only; unreachable from any model surface
   ↓
contradicting outcome
   ↓
recordContradiction() → CONTRADICTED → revoke; history retained in full
```

A lesson never retrieved at the right moment can never be reused, so it can never qualify, so
it can never be approved. **Retrieval quality is the rate limiter on the entire learning
system** — which is the real argument for embeddings here.

## Integrating with multi-app

Seven of the ten event kinds map onto builder stages that already exist:

| Builder surface | Event kind |
|---|---|
| `Step_Idea` / `generateWebAppPlan` | `planning.answer` |
| `refineWebAppPlan`, acceptance criteria | `contract.delta` |
| `Step_Theme` → `applyDirection` | `direction.selected` |
| `generateWebAppCode` → `generatedFiles` | `candidate.created` |
| `saveCurrentBuild` | `revision.promoted` |
| `loadSavedBuild` of an earlier build | `revision.rolled_back` |
| approval card, art-direction choice | `human.decision` |

The two with no producer are **`verification.completed`** and **`repair.attempted`** —
exactly the two that require observing a running application. That is not a coincidence; it
is the shape of what the runtime bridge adds. Until a build is actually run and watched, this
memory can record what was *decided* but not what was *true*.

The seam already exists. `services/buildStorage.ts` declares

```ts
evidence?: { ts: number; event: string }[];
```

on `SavedBuild`, and nothing in multi-app writes or reads it. That field is the intended
producer. Note the failure mode it represents: an evidence surface with no writer is
indistinguishable from having none, and reads as proof to anyone who finds it. **Wire the
producer in the same change as the field.**

Scope maps as one cluster per `SavedBuild.id`; the control tier spans builds.

## The creativity balance, in code

| Protection | Where |
|---|---|
| 3–5 injected items per turn, a hard clamp | `core/packet.ts` `MAX_INJECTED_ITEMS` |
| Cited scope, freshness, limits, omission notice | every `ContextPacket` |
| Advisory framing carried in the artifact | `ADVISORY_NOTE` |
| High weight for build/diagnostics/dependency/api-usage/environment/repair | `domainWeight` |
| Very low weight for taste/layout/copy/art-direction | `domainWeight` |
| **No taste lesson may enter an art-direction turn** | barred at candidate selection *and* at packet assembly |
| A single component or episode cannot fill the packet | `core/diversity.ts` |
| Deviation is observed, not assumed to contradict | `core/deviation.ts` |
| Staleness lowers weight; confirmed reuse raises it | `calculateTimeDecay` |

The direction bar is the load-bearing one for this host. `suggestArtDirections` produces
three directions per build; memory is structurally forbidden from generating, filtering,
ranking or selecting among them. Past builds may inform whether something *works*. They may
not decide what the next one is allowed to *look like*.

The packet is assembled by the port, never by the caller. **If the host assembles it,
governance is structural. If a model composes its own query, governance is a suggestion.**

## Surfaces

| Consumer | Surface | Can approve? |
|---|---|---|
| multi-app server | `GraphMemory` library port | yes |
| A model | `ModelContextPort` — one method | **no — absent by construction** |
| Human operator | `multi-memory` CLI | yes |
| External agents | read-only MCP | **no — no mutation tool is registered** |

```bash
multi-memory                              # interactive
multi-memory ask "why does the build fail" --component build-pipeline --json
multi-memory lesson approve <id> --by eyal    # human only
multi-memory docs generate
multi-memory sync export bundle.json
```

Scope vocabulary: `@local` (default) · `@workspace:<name>` (needs an admission record) · `@global` (control tier).

## Visual graph

The lineage is a real graph, and the edges *are* the governance:

```
episode ──produced──> lesson ──cites──> evidence
   │                    ^
   └──reused-in─────────┘   must be a DIFFERENT episode — this edge is the ratchet

evidence ──contradicts──> lesson
episode  ──applied─────>  lesson
```

```bash
multi-memory graph export graph.html    # self-contained 3D page, opens from disk
multi-memory graph export graph.json    # nodes + edges for any other viewer
```

Node colour is type and status (`episode:verified`, `lesson:proposed`, `lesson:approved`,
`lesson:contradicted`, `evidence`); node size is degree centrality.

It is diagnostic rather than decorative. **A lesson stuck at `proposed` has one `produced`
edge and no `reused-in` edge — the absent edge is the reason it has not been promoted.** A
table of statuses tells you a lesson is unpromoted; the graph tells you why.

Export is a redaction gate (Ruling 3), so a picture is not a route around the boundary that
`sync export` respects. The renderer emits one file whose only external reference is a
version-pinned `3d-force-graph`; all graph content is HTML-escaped and JSON-hardened before
interpolation.

## Storage

| Adapter | Role |
|---|---|
| `SqliteStorageAdapter` | system of record, built-in `node:sqlite`, real transactions |
| `IndexedDBProjectionAdapter` | browser projection + append outbox |
| `MemoryStorageAdapter` | tests |

multi-app is browser-first, so the IndexedDB projection is load-bearing here rather than
hypothetical. The outbox drain is **peek → atomic append → acknowledge**. A crash between
append and acknowledge replays as a pure no-op, because event identity is content-derived.

## Relevance

`DeterministicRelevanceAdapter` (default) — facets + lexical/BM25 + exact trigger tags, fused
with RRF, fully offline. It reports **no cosine**, because it computes none.

`EmbeddedRelevanceAdapter` — adds genuine cosine similarity via the injected embedding port.
Vectors carry `{modelId, dimensions, promptFormatVersion}` plus a digest of the text
embedded, so both a model change and a lesson edit force a re-embed rather than a confidently
wrong similarity.

The Gemini provider lives **outside** the core and lazily imports the optional SDK. Verified
against ai.google.dev on 2026-08-31: `gemini-embedding-2` does **not** accept `task_type`;
task intent goes in the prompt.

## Documents

```
.multi-memory/
  {build}.db                 system of record
  {build}-MEMORY.md          GENERATED   entry card
  {build}-ARCHITECTURE.md    AUTHORED    invariants — human-owned
  {build}-DECISIONS.md       GENERATED   append-only decision log
  {build}-LESSONS.md         GENERATED   grouped by status, with limits
  {build}-NOTES.md           AUTHORED    freeform — human-owned
```

Generated files carry checksummed frontmatter. A hand edit is **refused and reported**, never
silently overwritten.

## Boundaries this package does not cross

- No filesystem, dependency, model, network, revision or deployment authority.
- No secrets, raw provider traces, hidden chain-of-thought, audio, or opaque executables.
- No cross-build read without a recorded admission; no re-home without human approval.
- No approval or revocation reachable from any model-facing surface.

See `REQUIREMENT-EVIDENCE.md` for the full matrix, `PROVENANCE.md` for reuse and licensing,
and `ARCHITECTURE-DELTA.md` for where this diverges from the original specification.
