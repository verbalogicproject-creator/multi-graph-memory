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
