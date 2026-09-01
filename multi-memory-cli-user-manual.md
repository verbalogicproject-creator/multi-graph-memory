# multi-memory — User Manual

**Version:** schema 2 · engine `multi-graph-memory` 0.2.0 · written 2026-09-01
**Status:** the engine and the server side work. The multi-app user interface is not wired yet — see [What does not work yet](#8-what-does-not-work-yet).

---

## 1. What this is, in plain words

A memory for your app builder.

Every time the builder plans, styles or generates an app, that attempt is recorded: what was asked, which model answered, what the validator said afterwards, and whether you kept the result. Over time the system notices patterns — "generated files keep importing components that were never written" — and turns them into **lessons**.

A lesson is a short note: *when X happens, do Y*. Lessons are fed back into later builds so the same mistake is less likely twice.

### The one rule that shapes everything

**Memory advises. It never decides.**

A lesson can appear in a prompt as advice. It can never block a build, force a choice, or overrule you. Text in the prompt literally says so. This is on purpose: a builder whose output should look different every time must not be slowly pulled toward its own past.

### The second rule: a lesson has to earn its place

A note does not become trusted guidance because a model wrote it. It has to climb a ladder:

```
proposed  ──►  qualified  ──►  approved
   │              │               │
   │              │               └─ a human said yes. Only you can do this.
   │              └─ it was applied in a DIFFERENT later build, and that build passed.
   └─ something went wrong once, and a note was written about it.
```

You cannot skip a step. Approving a `proposed` lesson is refused, with a reason. This is what stops one lucky success from becoming permanent doctrine.

---

## 2. The five things memory stores

| Thing | Plain meaning | Example |
|---|---|---|
| **Episode** | One attempt at one goal | "Generate the plant tracker app, attempt 2" |
| **Event** | One thing that happened during an attempt | "The plan was written", "the validator found 2 errors" |
| **Evidence** | A pointer to proof | `validator://demo-1/2` — "the run that says it was clean" |
| **Lesson** | A note: when X, do Y | "Re-read every import before finishing" |
| **Attribution** | Who produced it | `anthropic/claude-haiku-4-5` |

**Attribution is new in schema 2** and matters because your builder now uses four providers. "That build failed" means something different depending on whether Gemini, Claude, GPT or an NVIDIA model produced it.

---

## 3. Where things live

```
/root/multi-graph-memory/          the engine + the multi-memory CLI
/root/multi-app/.multi-memory/     one database per build:  <buildId>.db
~/.multi-memory/control.db         the control tier (cross-project, later cycle)
```

**One database per build.** Builds do not share memory. A lesson only crosses from one build to another through a recorded human approval — that is a later cycle, not built yet.

---

## 4. Setting up the CLI

The CLI runs from the engine folder:

```bash
node /root/multi-graph-memory/bin/multi-memory.ts <command>
```

Make it shorter for a session:

```bash
alias mm='node /root/multi-graph-memory/bin/multi-memory.ts'
```

### Pointing it at the build you want to look at

Tell it where your build databases live, once per session:

```bash
export MULTI_MEMORY_BUILDS=/root/multi-app/.multi-memory
```

Then name a build from anywhere:

```bash
mm --build demo-1 project status
mm --build demo-1 lesson list
mm builds                          # which builds exist, how big, how old
```

A build id that has no database is an error, not an empty list:

```
$ mm --build demo-2 episode list
No database for build "demo-2" in /root/multi-app/.multi-memory.
3 there: build-mtis8q1a-4f2p, build-mtitlp71-9kd3, demo-1
`multi-memory builds` lists them with sizes and ages.
```

Opening a SQLite database creates it, so a typo used to answer "No episodes
recorded" — which reads exactly like a build that ran and recorded nothing — and
leave an empty file behind. Now it says which id it could not find and what is
actually there.

Or point at a file directly — a backup, or a database someone sent you:

```bash
mm --database /tmp/demo-1-backup.db lesson list
```

Two things are deliberately *not* guarded this way: `--database`, which names a
file you chose, and `sync import`, which is how a bundle is restored **into** a
cluster that does not exist yet.

With `--database`, the project id is read from **inside** the file rather than from
its name. A backup called `demo-1-backup.db` still holds records scoped to
`demo-1`, and guessing from the filename would silently show you an empty database.

Without either flag the CLI falls back to a `.multi-memory.json` in the folder you
run from, which is handy if you want a fixed working directory per build.

---

## 5. Commands

Every example below is real output from a real database.

### `mm project status` — where am I?

```
project    multi-app/demo-1
database   /root/multi-app/.multi-memory/demo-1.db
events     3
episodes   3
lessons    2
evidence   3
authority  context_only — memory grants no filesystem, dependency, model,
           network, revision or deployment authority.
```

That last line is not decoration. It states what memory is allowed to do: nothing but advise.

---

### `mm doctor` — is anything waiting for me?

```
database        /root/multi-app/.multi-memory/demo-1.db
schema version  2
lessons         1
awaiting human  1 qualified lesson(s) need approval
contradicted    0

Approve with: multi-memory lesson approve <id> --by <name>
```

**Run this first.** It tells you if a lesson has climbed to `qualified` and is waiting on you.

---

### `mm lesson list` — what has been learned?

```
qualified    build        reuse=1 les_b2c8698692...
             generated components import files that were never emitted
```

Reading it: status · topic · how many times it helped · id · the trigger.

Filters:

```bash
mm lesson list --status proposed     # not yet trusted
mm lesson list --status qualified    # waiting for you
mm lesson list --status approved     # trusted
mm lesson list --domain build
mm lesson list --json                # machine-readable
```

---

### `mm lesson show <id>` — the full note

Shows everything: the recommendation, its stated limits, which episodes produced it, the evidence it cites, who approved it and when.

---

### `mm lesson approve <id> --by <name>` — say yes  👤 humans only

```bash
mm lesson approve les_b2c8698692... --by Eyal
```

Approving something not yet qualified is refused, and says why:

```
Refused [LESSON_TRANSITION_INVALID]: Lesson "les_bad274d1..." has not qualified:
approval requires successful reuse in a distinct episode first.
```

> **This command exists only here and in the app's Memory panel.** It is not in the MCP server and not reachable by any model — not because a switch is off, but because the code path does not exist on those surfaces. A model cannot approve its own advice.

---

### `mm lesson revoke <id> --reason "<why>"` — take it back  👤 humans only

```bash
mm lesson revoke les_b2c8698692... --reason "Only ever true for Vite 5"
```

The lesson stops being injected. Its history is kept — nothing is deleted.

---

### `mm episode list` — what attempts have there been?

```
failed     2026-09-01T08:28:27.879Z  epi_9db741f869...
           probe the bridge end to end
           anthropic/claude-haiku-4-5

open       2026-09-01T08:29:52.821Z  epi_b18e3a9918...
           plan a plant tracker
           unattributed
```

Three lines each: outcome · when · id, then the goal, then who produced it.

- `verified` — it worked
- `failed` — it did not
- `abandoned` — you walked away (reload, restart)
- `open` — still running, or never closed

Filters:

```bash
mm episode list --provider anthropic
mm episode list --model gemini-3.7-flash
mm episode list --json
```

---

### `mm events` — the raw diary

```
2026-09-01T08:29:55.294Z  planning.answer        google/gemini-3.5-flash-lite builder.plan
  evt_939916fa10...
```

Filters — this is where attribution earns its keep:

```bash
mm events --provider anthropic          # only Claude's work
mm events --model claude-haiku-4-5      # one exact model
mm events --surface builder.generate    # only code generation
mm events --kind verification.completed # only validator verdicts
mm events --episode epi_...             # one attempt
mm events --since 2026-09-01            # from a date
mm events --limit 100                   # default is 40
mm events --json
```

The event kinds you will see:

| Kind | Means |
|---|---|
| `planning.answer` | a plan or art directions were produced |
| `contract.delta` | you asked for the plan to be changed |
| `direction.selected` | you picked a look |
| `candidate.created` | code was generated |
| `verification.completed` | the validator gave its verdict |
| `revision.promoted` | a build was accepted |
| `human.decision` | you kept or discarded something |
| `repair.attempted` | a retry after a failure |
| `deviation.observed` | a lesson was not followed |

---

### `mm attribution` — who produced what

```
producer                           events  verified  failed  open
google/gemini-3.5-flash-lite            1         0       0     0
anthropic/claude-haiku-4-5              1         0       1     0
unattributed                            0         0       0     1

Counts only. An outcome is what was observed, not a verdict on a provider.
```

This is the seed of the **provider reliability ledger** planned for the next cycle. Right now it counts; it does not judge. Read it as "what happened", never as "which model is best" — the numbers are far too small for that, and nothing controls for task difficulty.

---

### `mm ask "<question>"` — what would memory tell the model?

This shows you **exactly** what would be injected into a prompt.

```bash
mm ask "imports are failing in the generated app"
```

```
# Project Memory

**Task:** imports are failing in the generated app
**Scope:** multi-app/demo-1
**Showing:** 1 of 1 candidate(s)

**Authority:** context_only — These are cited prior observations with stated
limits, not instructions. They are advisory and may be departed from; if you
depart, say why. Project revisions, current diagnostics and the System Design
Contract remain stronger truth.

---

### [1] generated components import files that were never emitted
**Citation:** `lesson:les_b2c8698692... status=qualified reuse=1`
**Scope:** build, imports
**Freshness:** 0 day(s) old
**Why surfaced:** BM25 1.000, recency 1.00, reused 1x, domain build
**Component:** `codegen`
**Known limits:** Observed on one failed run only.

Before finishing, re-read every relative import and confirm the target file is
in the same response.
```

Note **Why surfaced** and **Known limits** — a lesson never arrives as a bare command. It arrives with its evidence and its limits attached.

Options:

```bash
mm ask "..." --domain build      # narrow the topic
mm ask "..." --component codegen
mm ask "..." --bug import-unresolved
mm ask "..." --direction         # simulate an art-direction turn (see below)
mm ask "..." --json
```

**`--direction` is worth trying.** It simulates the moment the builder proposes three visual looks. In that mode, all taste / layout / copy / art-direction lessons are removed **before** ranking. Past builds may inform correctness; they may not decide what the next app is allowed to look like. Run `mm ask "a calm dashboard" --direction` and watch taste lessons vanish from the result.

---

### `mm graph export <file>` — see it

```bash
mm graph export /tmp/memory.html   # 3D graph, one self-contained file
mm graph export /tmp/memory.json   # nodes and edges as data
```

Open the `.html` in a browser. Nodes are episodes, lessons and evidence; node size is how connected it is.

The picture is diagnostic, not decorative: **a lesson stuck at `proposed` is one with no `reused-in` edge.** The missing line is the reason it has not been promoted.

---

### `mm docs generate [--dir <path>]` — memory as readable documents

```bash
mm docs generate --dir /tmp/mydocs
```

```
wrote    /tmp/mydocs/demo-1-MEMORY.md
wrote    /tmp/mydocs/demo-1-DECISIONS.md
wrote    /tmp/mydocs/demo-1-LESSONS.md
```

If you hand-edit one of these, the next run **refuses** to overwrite it and tells you. Your edits are never silently destroyed.

---

### `mm docs ingest <file>` — teach it from a document

```bash
mm docs ingest ./NOTES.md
```

Reads a markdown file and records its sections as evidence.

---

### `mm sync export <file>` / `mm sync import <file>` — backup and move

```bash
mm sync export /tmp/backup.json
```

```
Exported project "demo-1" to /tmp/backup.json
  checksum 30df7407d879...
```

The checksum covers everything. If a single character is edited, import refuses it. Import also refuses a bundle from a newer version of the software rather than silently dropping fields it does not understand.

---

### `mm backup <file.db>` — a safe copy while everything is running

```bash
mm --build demo-1 backup /tmp/demo-1-backup.db
```

```
wrote /tmp/demo-1-backup.db
  104.0 KiB, consistent as of now
  Taken through the WAL, so unlike `cp` it is not a stale snapshot.
```

**Use this instead of `cp`.** Copying a `.db` while it is open gives you a stale
file — recent changes are still in the `-wal` companion. This reads through the
WAL and writes one complete file.

---

### `mm builds` — which builds have memory

```
/root/multi-app/.multi-memory
  demo-1                             104 KiB     0.0 days old
  fixcheck-1                         104 KiB     0.0 days old
                               2 database(s), 0.2 MiB total
```

---

### `mm prune --older-than <days>` — clean up old builds

```bash
mm prune --older-than 30            # shows what WOULD go
mm prune --older-than 30 --apply    # actually deletes
```

Three safety rails, because deleting memory cannot be undone: it refuses without
an explicit age, it shows rather than deletes unless you add `--apply`, and it
removes the `-wal`/`-shm` companions with each database so SQLite never later
finds a WAL with no database.

---

### `mm` with no arguments — interactive menu

```
1. Project status
2. Ask memory a question
3. List lessons
4. List episodes
5. Who produced what
6. Approve a lesson (human)
7. Revoke a lesson (human)
8. Generate project documents
9. Doctor
q. Quit
```

Every change asks for confirmation first.

---

## 6. The HTTP API (what the app uses)

The multi-app server exposes these. You can call them by hand while testing.

### Is memory alive?

```bash
curl -s localhost:8080/api/memory/state | python3 -m json.tool
```

```json
{ "health": { "available": true, "probed": true, "reason": null,
              "databaseDir": "/root/multi-app/.multi-memory",
              "openBuilds": [], "failures": {}, "lastInjection": null } }
```

If `available` is `false`, `reason` tells you exactly what to do.

### One build's memory

```bash
curl -s "localhost:8080/api/memory/state?buildId=demo-1" | python3 -m json.tool
```

### The rest

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/memory/episodes/open` | start an attempt → returns `episodeId` |
| `POST` | `/api/memory/episodes/close` | finish it with an outcome + attribution |
| `POST` | `/api/memory/events` | report events and evidence (batched; evidence is addressed by `key`) |
| `GET` | `/api/memory/state?buildId=` | health + one build's contents |
| `POST` | `/api/memory/lessons/:id/approve` | human approval (`approvedBy` required) |

Example — open an attempt, then report a verdict with its proof:

```bash
curl -s -X POST localhost:8080/api/memory/episodes/open \
  -H 'Content-Type: application/json' \
  -d '{"buildId":"demo-1","objective":"generate the app","baseRevisionId":"rev-1"}'

curl -s -X POST localhost:8080/api/memory/events \
  -H 'Content-Type: application/json' \
  -d '{"buildId":"demo-1","episodeId":"epi_...",
       "evidence":[{"key":"verdict","kind":"verification.result","ref":"validator://1"}],
       "events":[{"kind":"verification.completed","evidenceKeys":["verdict"],
                  "payload":{"ok":false},"domain":"build"}]}'
```

**Evidence is addressed, never shared.** Each evidence item carries a `key`, and an
event cites it by listing keys in `evidenceKeys`. An event that names none cites
none. The response tells you exactly what landed and what did not:

```json
{ "accepted": 1,
  "accepted_ids": [{"index": 0, "id": "evt_..."}],
  "rejected": [{"index": 1, "kind": "made.up", "reason": "unknown event kind"}],
  "evidenceIds": ["evd_..."] }
```

Opening the same attempt twice returns the **same** episode: a request matching an
already-open episode's objective and base revision is treated as the same attempt,
not a new one.

**These routes always answer `200` with a shaped body, even when memory is broken.** A degraded memory is a fact the interface shows, never an error the builder has to survive.

---

## 7. What works right now

Verified live, not assumed:

- ✅ The engine records episodes, events, evidence and lessons, per build.
- ✅ Attribution: which provider and which exact model produced each record.
- ✅ The full ladder: `proposed → qualified → approved`, with the skip refused.
- ✅ Approval works from the CLI **and** the server route, on one shared code path.
- ✅ The CLI reads the same database while the server holds it open.
- ✅ The server records real builder calls (a live Gemini plan call was recorded as `planning.answer` attributed to `google/gemini-3.5-flash-lite`).
- ✅ Recall assembles a cited, limited, budgeted packet.
- ✅ **With the engine deleted entirely, a real build still succeeded.** Memory cannot take the builder down.
- ✅ An old version-1 database upgrades on open without losing anything.

---

## 8. What does not work yet

These are the remaining steps of this cycle, not defects:

| Not yet | Meaning for you today |
|---|---|
| **The app does not call memory yet** | Using the builder normally records **nothing**. Only manual `curl` calls or scripts write records. This is step 4. |
| **No lessons are created automatically** | Nothing turns a validator failure into a lesson yet. You can create one by hand (see below). This is step 5. |
| **No Memory panel in the app** | Approval is CLI-only for now. This is step 6. |
| **Episodes are never closed by the app** | An episode opened by hand stays `open` and `unattributed` until something closes it. |

### Want to see the full loop today?

Create a lesson by hand, then watch it climb:

```bash
cd /root/multi-app
node - <<'EOF'
import { GraphMemory, SqliteStorageAdapter } from 'multi-graph-memory';
const storage = new SqliteStorageAdapter({ path: '.multi-memory/demo-1.db' });
storage.open();
const m = new GraphMemory({ storage, scope: { workspace: 'multi-app', projectId: 'demo-1' } });

const first = m.openEpisode({ objective: 'first attempt', baseRevisionId: 'rev-1' });
const proof = m.recordEvidence({ kind: 'verification.result', ref: 'validator://1', summary: '2 bad imports' });
m.closeEpisode(first.id, 'failed', undefined, { provider: 'anthropic', model: 'claude-haiku-4-5' });

const lesson = m.proposeLesson({
  trigger: 'components import files that were never emitted',
  recommendation: 'Re-read every relative import before finishing.',
  scope: ['build'], domain: 'build',
  sourceEpisodeIds: [first.id], evidenceIds: [proof.id],
  triggerTags: ['import-unresolved'],
});

const second = m.openEpisode({ objective: 'second attempt', baseRevisionId: 'rev-2' });
m.recordAppliedLesson(second.id, lesson.id);
const proof2 = m.recordEvidence({ kind: 'verification.result', ref: 'validator://2', summary: 'clean' });
m.closeEpisode(second.id, 'verified', undefined, { provider: 'google', model: 'gemini-3.7-flash' });
console.log('now:', m.recordReuse(lesson.id, second.id, [proof2.id]).status);
storage.close();
EOF
```

Then: `mm doctor` → `mm lesson list` → `mm ask "imports failing"` → `mm lesson approve <id> --by YourName`.

---

## 9. Known gaps and bugs

Honest list, worst first.

### 1. "A lesson was injected" is recorded as "a lesson was applied"
When a lesson is put into a prompt, memory records it as *applied* to that episode.
But the model may have read it and ignored it — there is no way to know from
outside whether the advice was actually followed. This matters because "applied"
is the precondition for counting a reuse. Step 5 of the current cycle tightens it:
reuse is only counted when the build afterwards actually **passed**. Until then,
read `reuse=1` as "was present, and the build passed", not "this is why it passed".

### 2. Databases are never cleaned up automatically
`mm prune` exists now, but nothing runs it for you. Every build makes a `.db` that
lives until you remove it. Check with `mm builds`.

### 3. Records written after the response can be lost
Some events are written *after* the answer reaches the browser, deliberately, so
memory is never in the way of your result. If the server is killed in that
instant, that record is lost. Rare and harmless, but real.

### 4. Rebuilding the engine briefly interrupts a running server
`npm run check` in the engine folder deletes and rebuilds `dist/`. A running app
server reports memory unavailable for a few seconds, then recovers on its own
(it retries every 30 seconds — no restart needed).

### 5. Many builds open at once can thrash the cache
The bridge keeps at most 8 build databases open and closes the least recently
used, though never the one a request is currently using. A view listing dozens of
builds would open and close files repeatedly. Cheap, but not free.

### 6. `npx multi-memory` needs a build first
The published entry point is `dist/bin/multi-memory.js`. If `dist/` is missing, run
`npm run build` in `/root/multi-graph-memory`. Running the source directly
(`node bin/multi-memory.ts`) always works and needs no build.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `available: false` in health | engine not built | `cd /root/multi-graph-memory && npm run build` |
| `No episodes recorded` but you know there are | CLI is pointed at the wrong database | check `mm project status` — the `database` line is the truth |
| `Refused ... has not qualified` | lesson has not been reused in a later build yet | this is correct; it is the ladder working |
| `approvedBy is required` | approval with a blank name | supply a real name; an approval with no approver is not an approval |
| `mm` finds a database you did not expect | it walked up to the nearest `package.json` or `.git` | create a `.multi-memory.json` where you want it |
| Nothing is recorded when you use the app | the interface is not wired yet | expected — step 4 of this cycle |
| A copied database is missing recent changes | you used `cp` on a live database | use `mm backup <file>` instead — it reads through the WAL |
| `mm` shows an empty database that should have data | pointed at the wrong file | run `mm project status`; the `database` line is the truth |

---

## 11. Cheat sheet

```bash
alias mm='node /root/multi-graph-memory/bin/multi-memory.ts'
export MULTI_MEMORY_BUILDS=/root/multi-app/.multi-memory

mm builds                                  # which builds have memory
mm --build demo-1 doctor                   # anything waiting on me, for one build
mm doctor                                  # anything waiting for me?
mm project status                          # where am I, how much is here
mm lesson list --status qualified          # what needs my approval
mm lesson approve <id> --by Eyal           # say yes
mm lesson revoke <id> --reason "..."       # take it back
mm episode list --provider anthropic       # attempts by one provider
mm events --surface builder.generate       # only code generation
mm attribution                             # who produced what
mm ask "what breaks the build"             # what a model would be told
mm ask "a calm dashboard" --direction      # ...with taste lessons barred
mm graph export /tmp/m.html                # look at it
mm backup /tmp/demo-1.db                   # safe copy while running
mm prune --older-than 30                   # show old builds (add --apply to delete)
mm sync export /tmp/backup.json            # portable, checksummed bundle

ls /root/multi-app/.multi-memory/          # which builds have memory
curl -s localhost:8080/api/memory/state    # is memory alive
```

---

## 12. The short version

- Memory **advises, never decides**. It cannot block or overrule you.
- A lesson must be **reused successfully in a later build**, and then **approved by you**, before it counts.
- **You are the only one who can approve.** No model can, on any surface, by construction.
- Every record says **which provider and model** produced it.
- **One database per build.** Nothing crosses without a recorded human decision.
- If memory breaks, **the builder keeps working**.
