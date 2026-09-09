/**
 * The session ladder's two readers.
 *
 * Both are pure — they take text and return records — so the parsing, the
 * recurrence rules and the proposal shape are all covered here rather than by a
 * script that spawns git. The IO lives in the CLI.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_IGNORE,
  GIT_FORMAT,
  RECORD,
  FIELD,
  componentFor,
  hotspots,
  parseCommits,
  proposalFor,
  summarise,
} from "../src/session/harvest.ts";
import {
  frictionPoints,
  parseTranscript,
  summariseFriction,
} from "../src/session/transcript.ts";

/* --------------------------------------------------------------- commits -- */

function commit(sha: string, subject: string, body: string, files: string[], at = "2026-09-01T00:00:00Z"): string {
  return `${RECORD}${sha}${FIELD}${at}${FIELD}${subject}${FIELD}${body}${FIELD}\n${files.join("\n")}\n`;
}

test("the git format asks for exactly the separators the parser splits on", () => {
  // A parser that assumes a format the caller does not pass is a silent
  // mis-parse, not an error. The format uses git's OWN escapes rather than
  // literal control bytes: Node rejects a null or control byte in an argv string
  // before git ever sees it, which is how the first version of this failed.
  assert.equal(RECORD, "\u001e", "ASCII RECORD SEPARATOR");
  assert.equal(FIELD, "\u001f", "ASCII UNIT SEPARATOR");
  assert.ok(GIT_FORMAT.startsWith("%x1e"), "git expands %x1e to RECORD");
  assert.equal(GIT_FORMAT.split("%x1f").length, 5, "four field separators, five fields");
  // The escapes and the constants must describe the same bytes.
  assert.equal(GIT_FORMAT.replaceAll("%x1e", RECORD).replaceAll("%x1f", FIELD).startsWith(RECORD), true);
});

test("a conventional commit yields its type, scope and files", () => {
  const [record] = parseCommits(
    commit("abc123", "fix(evidence): a record frozen at its first digest", "body\n\n  tests  294 -> 303\n", [
      "src/core/evidence.ts",
      "test/evidence.supersede.test.ts",
    ]),
  );
  assert.ok(record);
  assert.equal(record.sha, "abc123");
  assert.equal(record.type, "fix");
  assert.equal(record.scope, "evidence");
  assert.equal(record.subject, "a record frozen at its first digest");
  assert.deepEqual(record.testDelta, { before: 294, after: 303 });
  assert.equal(record.files.length, 2);
});

test("a subject with no conventional prefix is kept as unknown, not dropped", () => {
  // Dropping it would make every count quietly partial, which is the exact
  // shape of the defect this whole system exists to remove.
  const [record] = parseCommits(commit("def456", "just some words", "", ["a.ts"]));
  assert.ok(record);
  assert.equal(record.type, "unknown");
  assert.equal(record.subject, "just some words");
});

test("a body spanning blank lines and code blocks stays one commit", () => {
  // The reason the format uses an explicit sentinel: this estate's commit bodies
  // contain blank lines and fenced blocks, and a newline-delimited parse would
  // split one commit into several.
  const body = "line one\n\n```\ncode with\n\nblank lines\n```\n\nRevert-proof: the named assertion goes red.\n";
  const records = parseCommits(commit("aaa", "fix(x): y", body, ["a.ts"]));
  assert.equal(records.length, 1);
  assert.equal(records[0]?.claimsRevertProof, true);
});

test("hotspots count fix commits, respect the threshold, and ignore the noise", () => {
  const raw = [
    commit("s1", "fix(a): one", "", ["server.js", "package-lock.json"], "2026-09-01T00:00:00Z"),
    commit("s2", "fix(a): two", "", ["server.js", "CHANGELOG.md"], "2026-09-02T00:00:00Z"),
    commit("s3", "fix(a): three", "", ["server.js"], "2026-09-03T00:00:00Z"),
    commit("s4", "feat(a): not a fix", "", ["server.js"], "2026-09-04T00:00:00Z"),
    commit("s5", "fix(b): elsewhere", "", ["rare.ts"], "2026-09-05T00:00:00Z"),
  ].join("");

  const spots = hotspots(parseCommits(raw), "multi-app", { minFixes: 3 });
  assert.equal(spots.length, 1, "only server.js crosses three fixes");

  const spot = spots[0]!;
  assert.equal(spot.path, "server.js");
  assert.equal(spot.fixes, 3, "the feat commit is a touch, not a fix");
  assert.equal(spot.touches, 4);
  assert.equal(spot.component, "repo:multi-app/server.js");

  // Newest first, so the cited evidence is the most recent without a second sort.
  assert.deepEqual(spot.recentFixShas, ["s3", "s2", "s1"]);

  // The lockfile and the changelog move with almost every fix without being what
  // broke; counting them would rank the noise above the signal.
  assert.ok(!spots.some((s) => DEFAULT_IGNORE.some((p) => p.test(s.path))));
});

test("a proposal cites the commits and never restates them", () => {
  const [record] = parseCommits(commit("s1", "fix(a): one", "", ["server.js"]));
  const spot = hotspots([record!, record!, record!], "multi-app", { minFixes: 1 })[0]!;
  const proposal = proposalFor(spot, "multi-app");

  assert.equal(proposal.component, "repo:multi-app/server.js");
  assert.match(proposal.trigger, /changing server\.js/);
  // The guidance points at proof rather than becoming it — the rule evidence.ts
  // states about itself, and the reason no model is needed here.
  assert.match(proposal.recommendation, /Read the cited fixes/);
  assert.ok(proposal.evidenceRefs.every((ref) => ref.startsWith("git://multi-app@")));
  // A recurrence count is a fact about history, not a verdict on the file.
  assert.ok(proposal.limits.some((limit) => /not a judgement/.test(limit)));
});

test("an empty harvest says whether the range or the threshold made it empty", () => {
  const none = summarise([], "multi-app");
  assert.match(none.note, /No commits in range/);

  const belowThreshold = summarise(parseCommits(commit("s1", "fix(a): one", "", ["a.ts"])), "multi-app", {
    minFixes: 3,
  });
  assert.match(belowThreshold.note, /threshold, not the history/);
  assert.equal(belowThreshold.fixes, 1);
});

/* ------------------------------------------------------------ transcripts -- */

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

test("a failing tool result is attributed back to the call that failed", () => {
  const raw =
    line({ sessionId: "s", cwd: "/root/multi-app", gitBranch: "main", timestamp: "2026-09-01T10:00:00Z" }) +
    line({
      type: "assistant",
      timestamp: "2026-09-01T10:00:01Z",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
    }) +
    line({
      type: "user",
      timestamp: "2026-09-01T10:00:02Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 1\ndetail" }] },
    });

  const session = parseTranscript(raw.split("\n"));
  assert.equal(session.errors.length, 1);
  assert.equal(session.errors[0]?.tool, "Bash", "attribution is by tool_use_id, not by position");
  assert.equal(session.errors[0]?.target, "npm test");
  assert.equal(session.errors[0]?.summary, "Exit code 1");
  assert.equal(session.startedAt, "2026-09-01T10:00:00Z");
  assert.equal(session.endedAt, "2026-09-01T10:00:02Z");
});

test("a truncated final line is skipped, not thrown on", () => {
  // A transcript is written by a live process, so a half-written last line is
  // normal. Refusing the file would discard a session's evidence to report a
  // defect that is not one.
  const raw = line({ sessionId: "s" }) + '{"type":"assistant","mess';
  const session = parseTranscript(raw.split("\n"));
  assert.equal(session.sessionId, "s");
});

test("only writing tools count as touching a file", () => {
  const raw =
    line({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "a", name: "Edit", input: { file_path: "/root/multi-app/server.js" } },
          { type: "tool_use", id: "b", name: "Read", input: { file_path: "/root/multi-app/server.js" } },
        ],
      },
    });
  const session = parseTranscript(raw.split("\n"));
  assert.equal(session.touched["/root/multi-app/server.js"], 1, "a Read is attention, not work");
  assert.equal(session.toolUses["Read"], 1, "but it is still counted as a tool use");
});

test("an interrupt is counted, because a human stopping the run is the strongest signal here", () => {
  const raw = line({ interruptedMessageId: "m1" }) + line({ type: "assistant", message: { content: [] } });
  assert.equal(parseTranscript(raw.split("\n")).interrupts, 1);
});

test("friction is scoped to one repository by path prefix", () => {
  const session = parseTranscript(
    line({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "a", name: "Edit", input: { file_path: "/root/multi-app/server.js" } },
          { type: "tool_use", id: "b", name: "Edit", input: { file_path: "/root/.claude/plans/scratch.md" } },
        ],
      },
    }).split("\n"),
  );

  const points = frictionPoints([session], { repoRoot: "/root/multi-app", repo: "multi-app", minEdits: 1 });
  assert.equal(points.length, 1, "a plan file in another root must not outrank the code");
  assert.equal(points[0]?.component, "repo:multi-app/server.js");
});

test("a command that failed more than once is surfaced as a retry loop", () => {
  const failTwice = ["x1", "x2"]
    .map(
      (id) =>
        line({
          type: "assistant",
          message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "flaky --thing" } }] },
        }) +
        line({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "boom" }] },
        }),
    )
    .join("");

  const summary = summariseFriction([parseTranscript(failTwice.split("\n"))], {
    repoRoot: "/root/multi-app",
    repo: "multi-app",
  });

  assert.equal(summary.errors, 2);
  assert.equal(summary.errorsByTool["Bash"], 2);
  assert.deepEqual(summary.repeatedFailures, [{ target: "flaky --thing", count: 2 }]);
  // The honesty rule: an error is not a defect, and the summary has to say so.
  assert.ok(summary.limits.some((limit) => /not a defect/.test(limit)));
});

test("no transcripts is reported as no transcripts, never as no friction", () => {
  const summary = summariseFriction([], { repoRoot: "/root/multi-app", repo: "multi-app" });
  assert.match(summary.note, /different from nothing having happened/);
});

test("the component format matches the join key installed in phase 2", () => {
  assert.equal(componentFor("multi-app", "server.js"), "repo:multi-app/server.js");
});
