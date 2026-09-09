import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP, openMemory, runCommand, formatError } from "../src/cli/multi-memory.ts";
import { parseArgs } from "../src/cli/args.ts";
import { GraphMemoryError } from "../src/core/errors.ts";
import { READ_ONLY_TOOLS } from "../src/mcp/server.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fgm-cli-"));
  const context = openMemory({ projectRoot: dir, projectId: "cli-demo", clusterDir: join(dir, ".multi-memory"), databasePath: join(dir, "memory.db") });
  return { dir, context, cleanup: () => { context.storage.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function run(line: string, context: ReturnType<typeof setup>["context"]): Promise<string> {
  return runCommand(parseArgs(line.split(" ").filter(Boolean)), context);
}

function seed(context: ReturnType<typeof setup>["context"]) {
  const m = context.memory;
  const source = m.openEpisode({ objective: "first build", baseRevisionId: "rev-1" });
  m.closeEpisode(source.id, "verified");
  const evidence = m.recordEvidence({ kind: "verification.result", ref: "run://1" });
  const lesson = m.proposeLesson({
    trigger: "vite build fails with ERR_REQUIRE_ESM",
    recommendation: "Pin the plugin to its ESM build.",
    scope: ["build"], domain: "build",
    sourceEpisodeIds: [source.id], evidenceIds: [evidence.id],
    triggerTags: ["ERR_REQUIRE_ESM"], component: "build-pipeline",
  });
  const second = m.openEpisode({ objective: "second build", baseRevisionId: "rev-2" });
  m.recordAppliedLesson(second.id, lesson.id);
  m.closeEpisode(second.id, "verified");
  m.recordReuse(lesson.id, second.id, [evidence.id]);
  return { lessonId: lesson.id, evidenceId: evidence.id };
}

test("Ruling 9: approval and revocation exist on the CLI and nowhere else", async () => {
  const { context, cleanup } = setup();
  try {
    const { lessonId } = seed(context);

    const approved = await run(`lesson approve ${lessonId} --by eyal`, context);
    assert.match(approved, /^Approved/);
    assert.equal(context.memory.getLesson(lessonId)?.status, "approved");

    // The same verbs are absent from the MCP surface entirely.
    const mcpNames = READ_ONLY_TOOLS.map((t) => t.name).join(" ");
    assert.ok(!/approve|revoke/.test(mcpNames));
  } finally {
    cleanup();
  }
});

test("approval without a named approver is refused", async () => {
  const { context, cleanup } = setup();
  try {
    const { lessonId } = seed(context);
    assert.match(await run(`lesson approve ${lessonId}`, context), /requires a named human approver/);
    assert.equal(context.memory.getLesson(lessonId)?.status, "qualified");
  } finally {
    cleanup();
  }
});

test("revocation without a reason is refused, and with one retains history", async () => {
  const { context, cleanup } = setup();
  try {
    const { lessonId } = seed(context);
    assert.match(await run(`lesson revoke ${lessonId}`, context), /requires a reason/);

    const revoked = await run(`lesson revoke ${lessonId} --reason=superseded`, context);
    assert.match(revoked, /History retained: reuse=1/);
  } finally {
    cleanup();
  }
});

test("ask returns a rendered packet, and --json returns the structure", async () => {
  const { context, cleanup } = setup();
  try {
    const { lessonId } = seed(context);
    await run(`lesson approve ${lessonId} --by eyal`, context);

    const rendered = await run("ask why does the build fail", context);
    assert.match(rendered, /# Project Memory/);
    assert.match(rendered, /context_only/);

    const json = JSON.parse(await run("ask why does the build fail --json", context));
    assert.equal(json.authority, "context_only");
    assert.ok(json.omissions);
  } finally {
    cleanup();
  }
});

test("the direction flag excludes taste lessons from the packet", async () => {
  const { context, cleanup } = setup();
  try {
    const m = context.memory;
    const ep = m.openEpisode({ objective: "styling", baseRevisionId: "rev-1" });
    m.closeEpisode(ep.id, "verified");
    const ev = m.recordEvidence({ kind: "verification.result", ref: "run://taste" });
    const taste = m.proposeLesson({
      trigger: "hero felt cramped", recommendation: "increase letter-spacing",
      scope: ["visual"], domain: "taste", sourceEpisodeIds: [ep.id], evidenceIds: [ev.id],
    });
    const ep2 = m.openEpisode({ objective: "styling again", baseRevisionId: "rev-2" });
    m.recordAppliedLesson(ep2.id, taste.id);
    m.closeEpisode(ep2.id, "verified");
    m.recordReuse(taste.id, ep2.id, [ev.id]);
    await run(`lesson approve ${taste.id} --by eyal`, context);

    const normal = JSON.parse(await run("ask how should the hero look --json", context));
    assert.equal(normal.items.length, 1);

    const direction = JSON.parse(await run("ask produce three directions --direction --json", context));
    assert.equal(direction.items.length, 0);
    assert.equal(direction.omissions.droppedForDirectionBar, 1);
  } finally {
    cleanup();
  }
});

test("Ruling 8: the direction bar is structural, not dependent on retrieval", async () => {
  const { context, cleanup } = setup();
  try {
    const m = context.memory;
    // A taste lesson sharing NO vocabulary with the query, so relevance would
    // never surface it. The bar must still account for it, or the guarantee
    // would hold only by luck.
    const ep = m.openEpisode({ objective: "palette", baseRevisionId: "rev-1" });
    m.closeEpisode(ep.id, "verified");
    const ev = m.recordEvidence({ kind: "human.decision", ref: "decision://palette" });
    const taste = m.proposeLesson({
      trigger: "zzzz unrelated vocabulary", recommendation: "qqqq nothing in common",
      scope: ["visual"], domain: "taste", sourceEpisodeIds: [ep.id], evidenceIds: [ev.id],
    });
    const ep2 = m.openEpisode({ objective: "palette again", baseRevisionId: "rev-2" });
    m.recordAppliedLesson(ep2.id, taste.id);
    m.closeEpisode(ep2.id, "verified");
    m.recordReuse(taste.id, ep2.id, [ev.id]);
    await run(`lesson approve ${taste.id} --by eyal`, context);

    const packet = await m.queryContext({ task: "produce three design directions", directionGeneration: true });

    assert.equal(packet.items.length, 0);
    assert.equal(packet.omissions.droppedForDirectionBar, 1, "the bar must count it even though it would not have ranked");
    assert.match(packet.omissions.note, /barred from direction generation/);
  } finally {
    cleanup();
  }
});

test("scope vocabulary is recognised", () => {
  assert.deepEqual(parseArgs(["ask", "x", "@local"]).scope, { kind: "local" });
  assert.deepEqual(parseArgs(["ask", "x", "@global"]).scope, { kind: "global" });
  assert.deepEqual(parseArgs(["ask", "x", "@workspace:studio"]).scope, { kind: "workspace", name: "studio" });
  assert.deepEqual(parseArgs(["ask", "x"]).scope, { kind: "local" }, "local is the default");
});

test("a cross-workspace read is refused without an admission record", async () => {
  const { context, cleanup } = setup();
  try {
    // A typed refusal, not a polite string: the CLI surfaces it through
    // formatError so the operator sees the code.
    await assert.rejects(
      () => run("ask anything @workspace:other", context),
      (e: unknown) => e instanceof GraphMemoryError && e.code === "FEDERATION_NOT_ADMITTED",
    );

    let rendered = "";
    try {
      await run("ask anything @workspace:other", context);
    } catch (error) {
      rendered = formatError(error);
    }
    assert.match(rendered, /^Refused \[FEDERATION_NOT_ADMITTED\]/);
    assert.match(rendered, /multi-memory admit/);
  } finally {
    cleanup();
  }
});

test("export and import round-trip through the CLI", async () => {
  const { dir, context, cleanup } = setup();
  try {
    seed(context);
    const file = join(dir, "bundle.json");
    const exported = await run(`sync export ${file}`, context);
    assert.match(exported, /checksum [0-9a-f]{64}/);

    const fresh = setup();
    try {
      const imported = await run(`sync import ${file}`, fresh.context);
      assert.match(imported, /Imported into/);
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
  }
});

test("doctor reports lessons awaiting human approval", async () => {
  const { context, cleanup } = setup();
  try {
    seed(context);
    const report = await run("doctor", context);
    assert.match(report, /awaiting human {2}1 qualified lesson\(s\) need approval/);
  } finally {
    cleanup();
  }
});

test("help names the human-only boundary", () => {
  assert.match(HELP, /Approval and revocation exist only here/);
});

test("refusals are reported with their code, not as raw stack traces", () => {
  const formatted = formatError(new GraphMemoryError("SCOPE_REQUIRED", "no scope"));
  assert.equal(formatted, "Refused [SCOPE_REQUIRED]: no scope");
});

/* ------------------------------------------- schema version 2: attribution -- */

/**
 * CLI/library parity for attribution. The engine gained provider/model/surface;
 * if a human cannot filter on them without writing code, the capability exists
 * only for the machine -- which is the failure mode this repo's doctrine names.
 */

function seedAttributed(context: ReturnType<typeof setup>["context"]) {
  const m = context.memory;
  const google = m.openEpisode({ objective: "google build", baseRevisionId: "rev-1" });
  m.appendEvent({
    kind: "planning.answer",
    occurredAt: new Date().toISOString(),
    projectId: m.scope.projectId,
    cycleId: "c1", phaseId: "plan",
    provider: "google", model: "gemini-3.7-flash", surface: "builder.plan",
    payload: { pages: 5 }, evidenceIds: [], episodeId: google.id,
  });
  m.closeEpisode(google.id, "verified", undefined, { provider: "google", model: "gemini-3.7-flash" });

  const anthropic = m.openEpisode({ objective: "anthropic build", baseRevisionId: "rev-2" });
  m.appendEvent({
    kind: "candidate.created",
    occurredAt: new Date().toISOString(),
    projectId: m.scope.projectId,
    cycleId: "c2", phaseId: "generate",
    provider: "anthropic", model: "claude-haiku-4-5", surface: "builder.generate",
    payload: { files: 24 }, evidenceIds: [], episodeId: anthropic.id,
  });
  m.closeEpisode(anthropic.id, "failed", undefined, { provider: "anthropic", model: "claude-haiku-4-5" });
}

test("events are filterable by provider, model and surface from the CLI", async () => {
  const { context, cleanup } = setup();
  try {
    seedAttributed(context);

    const all = await run("events --json", context);
    assert.equal(JSON.parse(all).length, 2);

    const anthropic = JSON.parse(await run("events --provider anthropic --json", context));
    assert.equal(anthropic.length, 1);
    assert.equal(anthropic[0].model, "claude-haiku-4-5");

    const byModel = JSON.parse(await run("events --model gemini-3.7-flash --json", context));
    assert.equal(byModel.length, 1);
    assert.equal(byModel[0].surface, "builder.plan");

    const bySurface = JSON.parse(await run("events --surface builder.generate --json", context));
    assert.equal(bySurface.length, 1);

    assert.equal(JSON.parse(await run("events --provider nvidia --json", context)).length, 0);
    assert.match(await run("events --provider nvidia", context), /No events match/);
  } finally {
    cleanup();
  }
});

test("episode list shows and filters on attribution", async () => {
  const { context, cleanup } = setup();
  try {
    seedAttributed(context);

    const listed = await run("episode list", context);
    assert.match(listed, /google\/gemini-3\.7-flash/);
    assert.match(listed, /anthropic\/claude-haiku-4-5/);

    const filtered = JSON.parse(await run("episode list --provider google --json", context));
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].objective, "google build");
  } finally {
    cleanup();
  }
});

test("an unattributed record reads as unattributed rather than as a provider", async () => {
  const { context, cleanup } = setup();
  try {
    const m = context.memory;
    const ep = m.openEpisode({ objective: "no attribution", baseRevisionId: "rev-1" });
    m.closeEpisode(ep.id, "verified");

    assert.match(await run("episode list", context), /unattributed/);
    assert.equal(JSON.parse(await run("episode list --provider google --json", context)).length, 0);
  } finally {
    cleanup();
  }
});

test("attribution keeps event and episode attribution as separate axes", async () => {
  const { context, cleanup } = setup();
  try {
    seedAttributed(context);

    const report = JSON.parse(await run("attribution --json", context));

    // An event names the model that served ONE call; an episode names the model
    // that served the attempt. A fallback chain can serve different steps of one
    // episode from different providers, so a single row carrying both an events
    // count and an outcome count would assert a coverage relationship the data
    // does not establish.
    const events = report.byEventAttribution;
    const episodes = report.byEpisodeAttribution;

    assert.equal(events.find((r: { producer: string }) => r.producer === "google/gemini-3.7-flash").events, 1);
    assert.equal(events.find((r: { producer: string }) => r.producer === "anthropic/claude-haiku-4-5").events, 1);
    assert.equal(episodes.find((r: { producer: string }) => r.producer === "google/gemini-3.7-flash").verified, 1);
    assert.equal(episodes.find((r: { producer: string }) => r.producer === "anthropic/claude-haiku-4-5").failed, 1);

    // No row may carry both axes at once.
    for (const row of events) assert.equal(row.verified, undefined, "an event row has no outcome column");
    for (const row of episodes) assert.equal(row.events, undefined, "an episode row has no events column");

    // It reports observations, and says so rather than ranking providers.
    const text = await run("attribution", context);
    assert.match(text, /Counts only/);
    assert.match(text, /two tables do not sum/);
    assert.doesNotMatch(text, /best|worst|recommend/i);
  } finally {
    cleanup();
  }
});

test("the help text advertises every attribution surface it implements", () => {
  for (const fragment of ["events", "--provider", "--model", "--surface", "attribution"]) {
    assert.ok(HELP.includes(fragment), `HELP must mention ${fragment}`);
  }
});

/* ------------------------------------------------ pointing at a cluster -- */

test("a database can be named directly, and its project read from its contents", async () => {
  const { context, dir, cleanup } = setup();
  try {
    seedAttributed(context);
    const backup = join(dir, "renamed-copy.db");
    context.storage.backupTo(backup);

    // Named by FILE, with a filename that matches no project inside it. Guessing
    // the project from the filename would silently show an empty database.
    const viewer = openMemory({ databasePath: backup }, { inferProjectId: true });
    try {
      assert.equal(viewer.memory.scope.projectId, "cli-demo", "the id comes from the contents");
      assert.equal(viewer.memory.listEpisodes().length, 2, "and the records are visible");
    } finally {
      viewer.storage.close();
    }
  } finally {
    cleanup();
  }
});

test("a backup taken while the store is open is complete, not a stale snapshot", async () => {
  const { context, dir, cleanup } = setup();
  try {
    const { lessonId } = seed(context);
    // Written after the file exists, so it is exactly the kind of recent commit
    // that lives in the -wal and that a plain `cp` of the .db would miss.
    await run(`lesson approve ${lessonId} --by eyal`, context);

    const backup = join(dir, "backup.db");
    context.storage.backupTo(backup);

    const restored = openMemory({ databasePath: backup }, { inferProjectId: true });
    try {
      assert.equal(restored.memory.getLesson(lessonId)?.status, "approved", "the approval is in the backup");
    } finally {
      restored.storage.close();
    }
  } finally {
    cleanup();
  }
});

test("a database newer than the clock is still older than zero days", async () => {
  // `--older-than 0` means everything, so a file whose mtime sits a fraction
  // AHEAD of Date.now() must still match. Unclamped, its age went negative and
  // it vanished from the listing. Forced here rather than raced: a future mtime
  // makes the condition deterministic instead of one-run-in-three.
  const { context, cleanup } = setup();
  try {
    const cluster = context.config.clusterDir;
    mkdirSync(cluster, { recursive: true });
    const future = join(cluster, "just-written.db");
    writeFileSync(future, "");
    const ahead = new Date(Date.now() + 60_000);
    utimesSync(future, ahead, ahead);

    const dry = await run("prune --older-than 0", context);
    assert.match(dry, /Dry run/);
    assert.match(dry, /just-written/);
  } finally {
    cleanup();
  }
});

test("prune refuses without an age, and dry-runs by default", async () => {
  const { context, cleanup } = setup();
  try {
    // Deleting memory is not reversible, so it takes an explicit boundary...
    assert.match(await run("prune", context), /Refusing to prune without an age/);

    // ...and even then, saying nothing extra means "show me", not "do it".
    const cluster = context.config.clusterDir;
    mkdirSync(cluster, { recursive: true });
    const doomed = join(cluster, "old-build.db");
    writeFileSync(doomed, "");

    const dry = await run("prune --older-than 0", context);
    assert.match(dry, /Dry run/);
    assert.match(dry, /old-build/);
    assert.equal(existsSync(doomed), true, "a dry run deletes nothing");

    const applied = await run("prune --older-than 0 --apply", context);
    assert.match(applied, /^Removed 1 database/);
    assert.equal(existsSync(doomed), false, "--apply is what deletes");
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------------ ladder -- */

test("every ladder row states why a lesson has not climbed", async () => {
  // The founding defect, in the new surface. A row reading "proposed, 0 reuses"
  // is a zero that does not say why, which is exactly the thing this whole
  // system exists to remove. Every row must name the rung it is stuck on.
  const { context, cleanup } = setup();
  try {
    const m = context.memory;
    const source = m.openEpisode({ objective: "a build", baseRevisionId: "rev-1" });
    m.closeEpisode(source.id, "verified");
    const evidence = m.recordEvidence({ kind: "verification.result", ref: "run://ladder" });

    // Never surfaced: proposed, and no telemetry naming it.
    m.proposeLesson({
      trigger: "a proposal nothing has ever surfaced",
      recommendation: "do the thing",
      scope: ["build"], domain: "build",
      sourceEpisodeIds: [source.id], evidenceIds: [evidence.id],
    });
    // Qualified but unapproved: stuck on the one rung a model may not climb.
    const { lessonId } = seed(context);

    const text = await run("ladder", context);

    const lines = text.split("\n");
    let rows = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^(proposed|qualified|approved|contradicted|revoked)\s/.test(lines[i] ?? "")) continue;
      rows += 1;
      assert.match(lines[i + 1] ?? "", /↳ \S/, `a status row must be followed by a reason: ${lines[i]}`);
    }
    assert.equal(rows, 2, "both lessons must appear as rows");

    assert.match(text, /never surfaced/, "an unsurfaced proposal must say so");
    assert.match(text, /awaiting human approval/, "a qualified lesson must name the approval gate");

    const json = JSON.parse(await run("ladder --json", context)) as {
      lessons: { id: string; reason: string; blocked: boolean }[];
    };
    assert.equal(json.lessons.length, 2);
    for (const row of json.lessons) {
      assert.ok(row.reason && row.reason.length > 0, `lesson ${row.id} has no reason`);
    }
    assert.ok(json.lessons.some((l) => l.id === lessonId));
  } finally {
    cleanup();
  }
});

test("the ladder says 'unknown', not 'zero', when no recall has been recorded", async () => {
  // A surfaced-count of 0 with no telemetry means nobody looked, not that the
  // lesson was passed over. Reporting the second would be a confident wrong
  // answer, and it is the exact shape of the false green this estate keeps
  // finding: a number that reads as a measurement and is really an absence.
  const { context, cleanup } = setup();
  try {
    seed(context);
    const text = await run("ladder", context);
    assert.match(text, /No recall telemetry recorded yet/);
    assert.match(text, /unknown rather than zero/);
  } finally {
    cleanup();
  }
});

test("the ladder counts a lesson as surfaced only when telemetry names it", async () => {
  const { context, cleanup } = setup();
  try {
    const { lessonId } = seed(context);
    const episode = context.memory.listEpisodes()[0]!;

    context.memory.appendEvent({
      projectId: "cli-demo",
      kind: "recall.completed",
      occurredAt: new Date().toISOString(),
      cycleId: "c1", phaseId: "builder", episodeId: episode.id,
      payload: { outcome: "delivered", lessonIds: [lessonId], omissions: { droppedForBudget: 2, droppedForDiversity: 1, droppedForDirectionBar: 0 } },
      evidenceIds: [],
    });

    const json = JSON.parse(await run("ladder --json", context)) as {
      summary: { recallsRecorded: number; dropped: Record<string, number> };
      lessons: { id: string; surfaced: number }[];
    };
    assert.equal(json.summary.recallsRecorded, 1);
    assert.equal(json.summary.dropped["droppedForBudget"], 2);
    assert.equal(json.lessons.find((l) => l.id === lessonId)?.surfaced, 1);
  } finally {
    cleanup();
  }
});
