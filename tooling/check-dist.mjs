#!/usr/bin/env node
/**
 * Proves the built package is importable from plain JavaScript.
 *
 * This is not a duplicate of the test suite. The suite runs TypeScript source on
 * Node's type stripping, which is exactly the thing a consumer CANNOT do: Node
 * strips types in a project's own files and never inside node_modules. So a
 * green suite says nothing about whether `server.js` can import this package.
 *
 * This file is deliberately .mjs and imports only through the package's own
 * exports map, so it fails the same way a real consumer would.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const entry = new URL(`../${pkg.exports["."].default.replace(/^\.\//, "")}`, import.meta.url);

const { GraphMemory, ModelContextPort, MemoryStorageAdapter, CURRENT_SCHEMA_VERSION } = await import(entry.href);

assert.equal(typeof GraphMemory, "function", "GraphMemory must be reachable from the built entry point");
assert.equal(typeof ModelContextPort, "function");
assert.equal(CURRENT_SCHEMA_VERSION, 2);

const storage = new MemoryStorageAdapter();
storage.open();

const memory = new GraphMemory({ storage, scope: { workspace: "check", projectId: "dist-smoke" } });

// The whole loop a host actually drives, through the built artifact only.
const episode = memory.openEpisode({ objective: "prove the build is consumable", baseRevisionId: "rev-1" });
memory.appendEvent({
  kind: "verification.completed",
  occurredAt: new Date().toISOString(),
  projectId: memory.scope.projectId,
  cycleId: "c1",
  phaseId: "verify",
  provider: "anthropic",
  model: "claude-haiku-4-5",
  surface: "builder.generate",
  payload: { ok: true },
  evidenceIds: [],
  episodeId: episode.id,
});
const closed = memory.closeEpisode(episode.id, "verified", undefined, {
  provider: "anthropic",
  model: "claude-haiku-4-5",
});

assert.equal(closed.provider, "anthropic", "attribution must survive through the built code");
assert.equal(memory.queryEvents({ provider: "anthropic" }).length, 1);
assert.equal(memory.queryEvents({ provider: "google" }).length, 0);

// The narrow model-facing port must work too: it is what the host injects from.
const port = new ModelContextPort(memory);
const packet = await port.readMemoryContext({ task: "does the built package assemble a packet" });
assert.equal(packet.authority, "context_only");
assert.ok(Array.isArray(packet.items));
assert.equal(typeof packet.advisory, "string");

// And approval must NOT be reachable from that port, in the built artifact too.
assert.equal(typeof port.approveLesson, "undefined", "ModelContextPort must stay approval-free when built");

storage.close();

console.log(`✔ check:dist — ${pkg.exports["."].default} imports and runs from plain JavaScript`);

/**
 * The `bin` entry, run as the real artifact a global install would place on
 * `PATH` — not the source `.ts` file `test/mcp.stdio.test.ts` spawns.
 *
 * This is the check that catches a class of bug the test suite structurally
 * cannot: a path computed relative to the *source* file's location, correct
 * there, wrong once the same relative depth is measured from inside `dist/`
 * (`tsconfig.build.json` mirrors the source tree one level deeper). Found this
 * way once already — `bin/multi-memory-mcp.ts` read its own `package.json` via
 * a fixed `../package.json` that resolved to a real file from `bin/` and to
 * `dist/package.json` (nonexistent) from `dist/bin/`.
 */
const mcpBin = join(new URL("..", import.meta.url).pathname, pkg.bin["multi-memory-mcp"]);
const scratch = mkdtempSync(join(tmpdir(), "fgm-dist-mcp-"));
const child = spawn(process.execPath, [mcpBin], { cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-dist", version: "0.0.0" } },
  })}\n`,
);

const distMcpOk = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 5000);
  const poll = setInterval(() => {
    const line = stdout.split("\n").find((l) => l.trim());
    if (!line) return;
    clearInterval(poll);
    clearTimeout(timer);
    try {
      const response = JSON.parse(line);
      resolve(Boolean(response.result?.protocolVersion));
    } catch {
      resolve(false);
    }
  }, 20);
});

child.kill();
rmSync(scratch, { recursive: true, force: true });

assert.ok(distMcpOk, `dist/bin/multi-memory-mcp.js did not answer initialize correctly.\nstderr: ${stderr}\nstdout: ${stdout}`);
assert.equal(stderr.includes("ENOENT"), false, `the built MCP server threw a file-not-found error:\n${stderr}`);

console.log(`✔ check:dist — ${pkg.bin["multi-memory-mcp"]} starts and answers initialize`);

/**
 * The HTTP transport's compiled entrypoint (B2). No `bin` field for this one —
 * it is a service entrypoint a Dockerfile CMD points at directly, not a
 * global-install command — so the path is named here rather than read from
 * `pkg.bin`. Same class of risk as the stdio check above: this file shares
 * `packageVersion`'s walk-up logic, already proven, but compiling an
 * Express-based file is new ground the stdio check does not cover.
 */
const httpBin = join(new URL("..", import.meta.url).pathname, "dist/bin/multi-memory-mcp-http.js");
const httpScratch = mkdtempSync(join(tmpdir(), "fgm-dist-mcp-http-"));
const httpPort = 8791;
const httpChild = spawn(process.execPath, [httpBin], {
  cwd: httpScratch,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(httpPort), MCP_API_KEY: "check-dist-key" },
});

let httpStdout = "";
let httpStderr = "";
httpChild.stdout.on("data", (chunk) => { httpStdout += chunk.toString(); });
httpChild.stderr.on("data", (chunk) => { httpStderr += chunk.toString(); });

const httpUp = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 5000);
  const poll = setInterval(() => {
    if (!httpStdout.includes("listening")) return;
    clearInterval(poll);
    clearTimeout(timer);
    resolve(true);
  }, 20);
});
assert.ok(httpUp, `dist/bin/multi-memory-mcp-http.js never reported listening.\nstderr: ${httpStderr}\nstdout: ${httpStdout}`);

const unauthed = await fetch(`http://127.0.0.1:${httpPort}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
assert.equal(unauthed.status, 401, "an unauthenticated request to the built HTTP server must be refused");

const authed = await fetch(`http://127.0.0.1:${httpPort}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Api-Key": "check-dist-key" },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-dist", version: "0.0.0" } },
  }),
});
assert.equal(authed.status, 200, "a correctly authenticated initialize must succeed against the built HTTP server");

httpChild.kill();
rmSync(httpScratch, { recursive: true, force: true });
assert.equal(httpStderr.includes("ENOENT"), false, `the built HTTP MCP server threw a file-not-found error:\n${httpStderr}`);

console.log("✔ check:dist — dist/bin/multi-memory-mcp-http.js starts, fails closed, and authenticates correctly");
