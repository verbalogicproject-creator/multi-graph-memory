import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP, openMemory, runCommand, formatError } from "../src/cli/fractal-memory.ts";
import { parseArgs } from "../src/cli/args.ts";
import { GraphMemoryError } from "../src/core/errors.ts";
import { READ_ONLY_TOOLS } from "../src/mcp/server.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fgm-cli-"));
  const context = openMemory({ projectRoot: dir, projectId: "cli-demo", clusterDir: join(dir, ".fractal-memory"), databasePath: join(dir, "memory.db") });
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
    assert.match(rendered, /fractal-memory admit/);
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
