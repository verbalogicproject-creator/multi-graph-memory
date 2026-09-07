# Roadmap — beyond the multi-app port

**Not in scope for the current package.** Recorded here so the ideas are not lost and so
it is visible where the schema may need to stretch. Nothing below has been designed,
costed, or validated; both items need work before they are decisions.

## 1. Deployed multi-tenant MCP memory service

A hosted MCP server backed by many databases, one per agent or provider — Codex, Claude
Code, Antigravity, Cursor, Bolt, Lovable, Grok — each with a tailored store, behind **one
engine and one unified query surface**. Personal multi-tenant memory, context and
orchestration, reachable from any MCP-capable client.

The appeal is real: planning in one agent and executing in another, with the user's
context in one place rather than re-explained per tool.

**What this package already gives it, and what it does not.** Project isolation, the
admission model, deterministic identity and the export bundle all generalize from
per-project to per-tenant. What is entirely absent: authentication, tenant identity, rate
limiting, quota, hosting, backup, key custody, and any multi-tenant threat model. The
strict-scope-fails-closed design is a good starting posture, but "fails closed within one
user's device" and "fails closed between paying strangers" are different problems.

## 2. Grounded research question — is there a market?

The hypothesis to test, stated plainly so it can be falsified: **that a technically
competent AI peer-programming memory layer is something people would pay roughly
$10–15/month for, either BYOK or with bundled safe API access.**

This needs **grounded research, not speculation.** Specifically:

- **Demand evidence.** Are people actually asking for this? Look for it in its own words
  on HN, r/LocalLLaMA, r/ChatGPTCoding, Cursor and Claude Code forums, MCP community
  discussions — complaints about re-explaining context across tools, about losing project
  history between sessions, about orchestrating one model's plan into another's execution.
  Distinguish people describing the *pain* from people asking for *this solution*; the
  first is much more common and much weaker evidence.
- **Willingness to pay.** What comparable developer tools actually sustain at that price,
  and what their churn looks like. BYOK changes the economics but also the audience —
  BYOK buyers are typically fewer and more price-sensitive about the wrapper.
- **Competitive landscape.** Who is already shipping memory-for-agents, what they charge,
  and what they get wrong. Whether the governed/auditable angle is a differentiator or an
  irrelevance to the people paying.
- **Cost floor.** Embedding, storage and egress per active user per month, so the margin at
  $10–15 is known rather than assumed.
- **What it takes to start.** Auth, tenant isolation, key custody, uptime expectations,
  support burden, and the legal surface of holding other people's project context.

**Method note:** the honest failure mode here is confirmation bias — it is easy to find a
handful of enthusiastic forum posts and read them as a market. Any research pass should
report disconfirming evidence with equal weight, and should say plainly if the answer is
"the pain is real but people route around it for free."

## 3. `PostgresStorageAdapter` — the next storage backend for a live Cloud Run deploy

The current Cloud Run plan (see the multi-app-side deployment plan) ships read-only: the
image bakes in a bundle imported at build time via `multi-memory sync export`/`importBundle`,
so the first deploy needs no persistence layer at all. This is the design for what replaces
that once writes need to reach the remote surface.

**Interface, not implementation, decided now:** a `PostgresStorageAdapter` implementing the
exact same `StorageAdapter`/`StorageTx` contract in `src/adapters/storage.ts` that
`MemoryStorageAdapter` and `SqliteStorageAdapter` already satisfy — proven genuinely
swappable by `npm run check:adapter` (`test/adapter.conformance.test.ts`), which any new
adapter must pass before it is trusted, not just asserted compatible. Concretely: one table
per record type (`events`, `episodes`, `lessons`, `evidence`), `transact()` mapped to a real
Postgres transaction (`BEGIN`/`COMMIT`/`ROLLBACK`, not savepoints-by-default — matching
`MemoryStorageAdapter`'s simpler nested-transaction semantics is fine, since savepoint
independence was never part of the shared contract), and `listEvents`/`listLessons`'s facet
filters translated to `WHERE` clauses mirroring `src/adapters/filters.ts`'s predicates exactly
— the same discipline the SQLite adapter already follows (its own tests assert its SQL agrees
with the JS predicates, not just that it returns *something*).

**Why Cloud SQL Postgres, not GCS-FUSE.** `node:sqlite` opens its database in WAL mode; WAL
depends on `mmap` and byte-range locking semantics that a FUSE-mounted GCS bucket does not
provide correctly under concurrent access. That is a corruption risk, not a persistence
strategy — rejected for that reason, not for lack of trying.

**What stays deliberately absent until then:** per `ROADMAP.md`'s own already-listed gap list
above (§1) — authentication, tenant identity, rate limiting, quota, key custody. Writes do
not reach the remote surface at all until one of those exists to carry them; a Postgres
adapter with no auth model in front of it is a louder version of the same unresolved problem,
not a fix for it.

## 4. Smaller follow-ons

- A real schema migration once a v2 exists, exercising the ladder end to end rather than
  only its refusal paths.
- Browser verification of the IndexedDB adapter against an actual browser.
- Batch embedding for bulk re-index, at half the interactive price.
- Multimodal embedding of captured preview screenshots into the same space as lesson text,
  for visual-regression recall.
