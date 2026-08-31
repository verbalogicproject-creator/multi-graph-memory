import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphMemoryError } from "../src/core/errors.ts";
import { ControlStore } from "../src/control/registry.ts";
import { federatedQuery } from "../src/control/federation.ts";
import { openMemory, runCommand } from "../src/cli/fractal-memory.ts";
import { parseArgs } from "../src/cli/args.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

function makeProject(root: string, projectId: string, workspace: string, trigger: string) {
  const dir = join(root, projectId);
  const context = openMemory({
    projectRoot: dir, projectId, workspace,
    clusterDir: join(dir, ".fractal-memory"), databasePath: join(dir, "memory.db"),
    controlDatabasePath: join(root, "control.db"),
  });
  const m = context.memory;
  const ep = m.openEpisode({ objective: "work", baseRevisionId: "r1" });
  m.closeEpisode(ep.id, "verified");
  const ev = m.recordEvidence({ kind: "verification.result", ref: `run://${projectId}` });
  const lesson = m.proposeLesson({
    trigger, recommendation: `In ${projectId}: pin the dependency.`,
    scope: ["build"], domain: "build", sourceEpisodeIds: [ep.id], evidenceIds: [ev.id],
  });
  const ep2 = m.openEpisode({ objective: "again", baseRevisionId: "r2" });
  m.recordAppliedLesson(ep2.id, lesson.id);
  m.closeEpisode(ep2.id, "verified");
  m.recordReuse(lesson.id, ep2.id, [ev.id]);
  m.approveLesson(lesson.id, "eyal");
  return context;
}

async function run(line: string, context: ReturnType<typeof openMemory>): Promise<string> {
  return runCommand(parseArgs(line.split(" ").filter(Boolean)), context);
}

test("a federated read without an admission record is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "fgm-fed-"));
  try {
    const alpha = makeProject(root, "alpha", "studio", "build fails on alpha");
    await run("project register", alpha);

    const control = new ControlStore(join(root, "control.db"));
    control.open();
    await assert.rejects(
      () => federatedQuery(control, "studio", { task: "build fails" }),
      (e: unknown) => code(e) === "FEDERATION_NOT_ADMITTED",
    );
    control.close();
    alpha.storage.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an admitted federated read consults exactly the projects it names", async () => {
  const root = mkdtempSync(join(tmpdir(), "fgm-fed2-"));
  try {
    const alpha = makeProject(root, "alpha", "studio", "build fails with ERR_REQUIRE_ESM");
    const beta = makeProject(root, "beta", "studio", "build fails with ERR_REQUIRE_ESM");
    const gamma = makeProject(root, "gamma", "other-workspace", "build fails with ERR_REQUIRE_ESM");
    for (const c of [alpha, beta, gamma]) await run("project register", c);

    await run("admit --workspace studio --by eyal --purpose compare-build-failures", alpha);

    const control = alpha.openControl();
    const result = await federatedQuery(control, "studio", { task: "build fails" });

    assert.deepEqual(result.consulted.sort(), ["alpha", "beta"]);
    assert.ok(result.refused.some((r) => r.projectId === "gamma"), "another workspace must not be consulted");
    assert.equal(result.packets.length, 2);
    // Provenance stays per-project: packets are not merged into one anonymous blob.
    for (const entry of result.packets) {
      assert.equal(entry.packet.scope.projectId, entry.projectId);
    }
    for (const c of [alpha, beta, gamma]) c.storage.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allowedProjects narrows a federated read further", async () => {
  const root = mkdtempSync(join(tmpdir(), "fgm-fed3-"));
  try {
    const alpha = makeProject(root, "alpha", "studio", "build fails");
    const beta = makeProject(root, "beta", "studio", "build fails");
    for (const c of [alpha, beta]) await run("project register", c);

    await run("admit --workspace studio --by eyal --purpose narrow --projects alpha", alpha);
    const result = await federatedQuery(alpha.openControl(), "studio", { task: "build fails" });

    assert.deepEqual(result.consulted, ["alpha"]);
    assert.ok(result.refused.some((r) => r.projectId === "beta"));
    for (const c of [alpha, beta]) c.storage.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI records an admission and reports it grants no authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "fgm-fed4-"));
  try {
    const alpha = makeProject(root, "alpha", "studio", "build fails");
    const output = await run("admit --workspace studio --by eyal --purpose compare", alpha);
    assert.match(output, /Recorded a federation admission/);
    assert.match(output, /grants no authority/);

    const stored = alpha.openControl().getAdmission("studio");
    assert.equal(stored?.approvedBy, "eyal");
    alpha.storage.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI performs a real cross-workspace read once admitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "fgm-fed5-"));
  try {
    const alpha = makeProject(root, "alpha", "studio", "build fails with ERR_REQUIRE_ESM");
    const beta = makeProject(root, "beta", "studio", "build fails with ERR_REQUIRE_ESM");
    for (const c of [alpha, beta]) await run("project register", c);
    await run("admit --workspace studio --by eyal --purpose compare", alpha);

    const output = await run("ask build fails @workspace:studio", alpha);
    assert.match(output, /Federated read across workspace "studio"/);
    assert.match(output, /consulted: alpha, beta/);
    assert.match(output, /--- alpha ---/);
    for (const c of [alpha, beta]) c.storage.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("@global reports the control tier and states that project content never moves there", async () => {
  const root = mkdtempSync(join(tmpdir(), "fgm-fed6-"));
  try {
    const alpha = makeProject(root, "alpha", "studio", "build fails");
    await run("project register", alpha);

    const output = await run("ask anything @global", alpha);
    assert.match(output, /Control tier/);
    assert.match(output, /registered projects: 1/);
    assert.match(output, /Project content never moves here/);
    alpha.storage.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registering a project stores a pointer, not its contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "fgm-fed7-"));
  try {
    const alpha = makeProject(root, "alpha", "studio", "proprietary trigger text");
    await run("project register", alpha);

    const projects = alpha.openControl().listProjects();
    assert.equal(projects.length, 1);
    const serialized = JSON.stringify(projects[0]);
    assert.ok(!serialized.includes("proprietary trigger text"), "no lesson text may reach the control tier");
    assert.match(serialized, /memory\.db/, "a pointer to the cluster is what is stored");
    alpha.storage.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
