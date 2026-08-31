# fractal-graph-memory

Governed episodic and lesson memory for [Verbalogix Fractal](https://github.com/) — local-first,
with an **offline-pure governance core** and an **injected relevance layer**.

> **Standing:** this is an independent return package for Codex to inspect and test.
> It makes **no claim** of Fractal integration, compatibility, or admission. Nothing here
> has been run against the Fractal repository, and no file in it was touched.

## What problem it solves

Fractal re-solves the same build failures, dependency problems and repair patterns
because nothing carries verified experience across episodes.

The problem it must *not* create is subtler: a memory that feeds a generative model its
own past **converges**. It exploits, stops exploring, and yields an assistant that grows
more reliable and less imaginative — bounded by its earliest mistakes.

So the governing rule is:

> **Memory constrains authority, not imagination.** The ratchet is on what becomes
> policy, never on what the model may think.

Memory **informs** and **warns**. It does not **forbid** — the things that genuinely must
be forbidden are owned elsewhere in Fractal, and this package grants none of them.

## The two objects

| | Owns | Refuses |
|---|---|---|
| **Governance core** (`src/core`) | events, episodes, evidence, lesson lifecycle, bounded packets, migrations | promotion from confidence, from one episode, or without a human |
| **Relevance** (`src/relevance`) | recall and ranking | everything else — it cannot qualify, approve, satisfy reuse, or contradict |

Similarity may reorder what a query returns. It can never promote.

## Quick start

```bash
npm install          # zod; @google/genai is optional
npm run check        # boundaries + typecheck + 158 tests
npm run verify:pure  # proves the package works with NO provider and NO key
node examples/dogfood.ts
```

```ts
import { SqliteStorageAdapter, GraphMemory } from "fractal-graph-memory";

const storage = new SqliteStorageAdapter({ path: ".fractal-memory/my-project.db" });
storage.open();
const memory = new GraphMemory({ storage, scope: { workspace: "verbalogix", projectId: "my-project" } });

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
memory.approveLesson(lesson.id, "eyal");            // refused — never reused
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

A lesson never retrieved at the right moment can never be reused, so it can never
qualify, so it can never be approved. **Retrieval quality is the rate limiter on the
entire learning system** — which is the real argument for embeddings here.

## The creativity balance, in code

| Protection | Where |
|---|---|
| 3–5 injected items per turn, a hard clamp | `core/packet.ts` `MAX_INJECTED_ITEMS` |
| Cited scope, freshness, limits, omission notice | every `ContextPacket` |
| Advisory framing carried in the artifact | `ADVISORY_NOTE` |
| High weight for build/diagnostics/dependency/api-usage/environment/repair | `domainWeight` |
| Very low weight for taste/layout/copy/art-direction | `domainWeight` |
| **No taste lesson may enter a direction-generation turn** | barred at candidate selection *and* at packet assembly |
| A single component or episode cannot fill the packet | `core/diversity.ts` |
| Deviation is observed, not assumed to contradict | `core/deviation.ts` |
| Staleness lowers weight; confirmed reuse raises it | `calculateTimeDecay` |

The packet is assembled by the port, never by the caller. **If Fractal assembles it,
governance is structural. If a model composes its own query, governance is a suggestion.**

## Surfaces

| Consumer | Surface | Can approve? |
|---|---|---|
| Fractal server | `GraphMemory` library port | yes |
| A model / Aria | `ModelContextPort` — one method | **no — absent by construction** |
| Human operator | `fractal-memory` CLI | yes |
| External agents | read-only MCP | **no — no mutation tool is registered** |

```bash
fractal-memory                              # interactive
fractal-memory ask "why does the build fail" --component build-pipeline --json
fractal-memory lesson approve <id> --by eyal    # human only
fractal-memory docs generate
fractal-memory sync export bundle.json
```

Scope vocabulary: `@local` (default) · `@workspace:<name>` (needs an admission record) · `@global` (control tier).

## Storage

| Adapter | Role |
|---|---|
| `SqliteStorageAdapter` | system of record, built-in `node:sqlite`, real transactions |
| `IndexedDBProjectionAdapter` | browser projection + append outbox |
| `MemoryStorageAdapter` | tests |

The outbox drain is **peek → atomic append → acknowledge**. A crash between append and
acknowledge replays as a pure no-op, because event identity is content-derived.

## Relevance

`DeterministicRelevanceAdapter` (default) — facets + lexical/BM25 + exact trigger tags,
fused with RRF, fully offline. It reports **no cosine**, because it computes none.

`EmbeddedRelevanceAdapter` — adds genuine cosine similarity via the injected embedding
port. Vectors carry `{modelId, dimensions, promptFormatVersion}` plus a digest of the
text embedded, so both a model change and a lesson edit force a re-embed rather than a
confidently wrong similarity.

The Gemini provider lives **outside** the core and lazily imports the optional SDK.
Verified against ai.google.dev on 2026-08-31: `gemini-embedding-2` does **not** accept
`task_type`; task intent goes in the prompt.

## Documents

```
.fractal-memory/
  {project}.db                 system of record
  {project}-MEMORY.md          GENERATED   entry card
  {project}-ARCHITECTURE.md    AUTHORED    invariants — human-owned
  {project}-DECISIONS.md       GENERATED   append-only decision log
  {project}-LESSONS.md         GENERATED   grouped by status, with limits
  {project}-NOTES.md           AUTHORED    freeform — human-owned
```

Generated files carry checksummed frontmatter. A hand edit is **refused and reported**,
never silently overwritten.

## Boundaries this package does not cross

- No filesystem, dependency, donor, model, network, revision or deployment authority.
- No secrets, raw provider traces, hidden chain-of-thought, audio, or opaque executables.
- No cross-project read without a recorded admission; no re-home without human approval.
- No Fractal file touched, no Fractal integration claimed.

See `REQUIREMENT-EVIDENCE.md` for the full matrix, `PROVENANCE.md` for reuse and
licensing, and `ARCHITECTURE-DELTA.md` for where this diverges from the original spec.
