# Notes

Authored, not generated. Working context a later session would otherwise
re-derive. Ingested into this cluster's evidence with
`multi-memory docs ingest NOTES.md`.

## Cycle R and the kg-rag-cookbook graph

`/root/projects/kg-rag-cookbook` holds a knowledge graph whose domain is this
estate's own retrieval systems — 1,260 nodes, 1,298 edges, 61 findings, six
doctrine rules. It is the reason `src/kg/` exists here: the graph recorded that
this package sets `PRAGMA foreign_keys = ON` while declaring no foreign key, and
that the visualization exporter skips a dangling reference without reporting it.
Both are the same silent-degradation class, now observed in four independent
codebases.

Read `/root/projects/kg-rag-cookbook/TS-kg-rag-of-kg-rag.md` before making a
retrieval decision in this repo. Most options have already been tried here twice,
once badly and once well, and the graph records which was which — including four
mutually incompatible fusion formulas and six contradictory dimension counts, all
as `contradicts` edges with their sources.

## Two doctrine rules this package already obeyed without naming

The graph needed a rule for thirteen findings that answered to none of the four
written ones, and both turned out to be stated in this package's code:

`authority` — knowing what something is does not confer permission to act on it.
This is `ModelContextPort` being approval-free by construction, and the reason
`multi-memory lesson approve` exists only in the CLI.

`provenance` — a copy of a fact has no expiry date. This is why `PROVENANCE.md`
names an origin, a modification and a covering test for every vendored or
translated module.

## The kg layer, and why it is not in core

`src/kg/` is a general typed-graph contract translated from `kg_toolkit`
(Apache-2.0), not a memory record. `tooling/check-boundaries.mjs` lists `kg`
among the directories `src/core/**` may not reach, so the governance core cannot
acquire a second graph model. That guard was verified by making core import it
and watching the check fail.

The port found a defect in its source worth knowing about if the Python is ever
used directly: `integrity.py:_find_cycle` recurses once per node and raises
`RecursionError` past roughly 1,000 depth, so the cycle check cannot run on the
graphs most likely to contain a cycle. The TypeScript port is iterative and is
tested at 50,000.

## What the first real consumer found in this surface

multi-app is now wired end to end: server-side taps for what only the server
knows (the model that served a call after fallback), client-side taps for what
only the browser knows (that a generation started, what the validator said,
whether a human kept or discarded the result). Two things about this package's
API only became visible when something actually called it.

**An undeclared `domain` fails schema validation and the whole event is refused.**
Not the field — the event. `domain: 'design'` is not in `LESSON_DOMAINS`, and the
consumer's bridge could report the loss only as a count, with the reason buried
in a `failures` map. Every direction the user ever chose would have been dropped
silently. *Fixed here:* `refuseSchema()` puts the offending path and the
validator's own message into `error.message`, not only into `detail.issues`, so a
host that logs `message` learns which field it got wrong and what the vocabulary
actually is. The consumer separately mirrored `LESSON_DOMAINS` as a TypeScript
union, which is the better place to catch it — but a strict vocabulary should
still say what it wanted, and now it does.

**`--build <id>` created the cluster it could not find.** A mistyped build id
answered "No episodes recorded" rather than "no such build", which reads exactly
like a run that recorded nothing, and left an empty database behind.
Register-on-first-use is defensible; being indistinguishable from an empty result
is what costs the time. *Fixed here:* the guard runs before anything is opened —
because opening is what creates it — names the id it could not find, lists the
ids that do exist, and exits 1. `--database` is deliberately still unguarded: it
names a file the caller chose.

Also confirmed working as designed: open-episode reuse absorbs a double-tap
rather than forking the attempt, which puts the burden on closing rather than on
not-opening-twice — the consumer closes on every terminal path and closes
orphans at startup.

**The ladder has no entrance from inside this package.** `INJECTABLE_STATUSES` is
`["approved", "qualified"]`, so `queryContext` never surfaces a `proposed` lesson
— which means it is never applied, which means `recordReuse` can never accept it,
which means it can never become `qualified`. Read as a bug this is fatal; read as
a design it is this package declining to decide, and `recordAppliedLesson`
accepting any lesson id regardless of status is the seam left for a host that
does decide. multi-app now uses that seam: at most three proposals, only about
the issue codes that just failed, in a separately-labelled block that says in the
prompt that they are unproven, each recorded as applied so the later reuse claim
is checkable. Worth stating in this package's own docs, because a host that reads
only the status ladder will build a proposer, watch nothing ever qualify, and have
no way to tell whether it is broken or simply has nothing to learn.

## Working material that is not in git

`/root/projects/kg-rag-cookbook/ideas/` is gitignored by request. It holds
Eyal's idea documents and the session handoffs written against them, currently
the reusable RAG-backed content-catalog architecture — cartridge JSON, a
retrieval-backed renderer, a CLI, with web components as its first content kind
rather than its subject. Working material, deliberately not framework, and
deliberately not history. If a later session cannot find context that was
promised, look there before assuming it was lost.
