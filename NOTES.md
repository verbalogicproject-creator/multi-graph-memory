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

## Working material that is not in git

`/root/projects/kg-rag-cookbook/ideas/` is gitignored by request. It holds
Eyal's idea documents and the session handoffs written against them, currently
the reusable RAG-backed content-catalog architecture — cartridge JSON, a
retrieval-backed renderer, a CLI, with web components as its first content kind
rather than its subject. Working material, deliberately not framework, and
deliberately not history. If a later session cannot find context that was
promised, look there before assuming it was lost.
