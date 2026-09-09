/**
 * `multi-memory serve`, driven as a browser and a websocket client drive it.
 *
 * The posture rules are asserted as pure logic; the server itself is bound on
 * a real ephemeral port, because the two defects this file exists to prevent
 * were both about what happens around `listen`:
 *
 *   - the first version printed its whole success banner — url, strata counts,
 *     "Ctrl-C to stop" — and only then died on EADDRINUSE, because nothing
 *     waited for the socket. A surface built to stop silent failure must not
 *     announce a success it has not had.
 *   - the failed start then left its filesystem watchers open, so the process
 *     printed a correct error and hung forever, which looks like work.
 */
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

import { GraphMemory } from "../src/port.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { startServe } from "../src/serve/index.ts";
import { bootPosture, CONTENDED_PORTS, DEFAULT_PORT, isLoopback } from "../src/serve/posture.ts";

function memory(): GraphMemory {
  const storage = new MemoryStorageAdapter();
  storage.open();
  return new GraphMemory({ storage, scope: { workspace: "multi-app", projectId: "demo" } });
}

/** A free port, taken from the OS rather than guessed. */
async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolvePort(port));
    });
  });
}

test("the default port is not one this device fights over", () => {
  assert.ok(!CONTENDED_PORTS.has(DEFAULT_PORT));
  // 8080 is named explicitly: the MCP HTTP entrypoint defaults there because
  // Cloud Run injects PORT, and on this device a stranger holding 8080 hangs a
  // dev proxy rather than failing it.
  assert.ok(CONTENDED_PORTS.has(8080));
  assert.match(String(bootPosture("127.0.0.1", "k", 8080).fatal), /refusing to listen on 8080/);
  assert.match(String(bootPosture("127.0.0.1", "k", 8050).fatal), /multi-app/);
});

test("reachable from the network or unauthenticated, but never both", () => {
  // The invariant is multi-app's auth/config.js bootPosture, not a new one.
  const openToWorld = bootPosture("0.0.0.0", undefined, DEFAULT_PORT);
  assert.ok(openToWorld.fatal, "a non-loopback bind with no key must not listen");
  assert.match(String(openToWorld.fatal), /no --api-key/);

  const guarded = bootPosture("0.0.0.0", "a-key", DEFAULT_PORT);
  assert.equal(guarded.fatal, undefined);
  assert.equal(guarded.enforcesAuth, true);

  // Loopback and unconfigured is allowed, and says what it is.
  const local = bootPosture("127.0.0.1", undefined, DEFAULT_PORT);
  assert.equal(local.fatal, undefined);
  assert.match(String(local.warning), /every caller on this machine/);
  assert.equal(local.enforcesAuth, false);

  for (const host of ["127.0.0.1", "localhost", "::1"]) assert.ok(isLoopback(host));
  for (const host of ["0.0.0.0", "192.168.1.4", "example.com"]) assert.ok(!isLoopback(host));
});

test("nothing is announced until the socket is genuinely bound", async () => {
  const port = await freePort();
  const first = startServe({ source: memory(), port });
  await first.ready;

  // Same port, second server. `ready` must reject rather than the process
  // dying on an unhandled 'error' event after a success banner.
  const second = startServe({ source: memory(), port });
  await assert.rejects(second.ready, /already in use/);

  // And the failed one must not be holding the event loop open.
  await second.close();
  await first.close();
});

test("a failed bind releases its watchers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mgm-serve-"));
  const watched = join(dir, "store.db");
  writeFileSync(watched, "x");

  const port = await freePort();
  const holder = startServe({ source: memory(), port });
  await holder.ready;

  const failed = startServe({ source: memory(), port, watchPaths: [watched] });
  await assert.rejects(failed.ready);
  // If the watcher were still open the process would never exit. Touching the
  // file after the failure must not throw or resurrect anything.
  utimesSync(watched, new Date(), new Date());
  await failed.close();
  await holder.close();
});

test("the page, the projection and the receipts are all served", async () => {
  const port = await freePort();
  const running = startServe({ source: memory(), port, title: "demo graph" });
  await running.ready;
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /demo graph/);
    // Live mode, and still no network dependency of its own.
    assert.match(html, /new WebSocket\("ws:\/\/127\.0\.0\.1:/);
    assert.doesNotMatch(html, /<script src="http/);

    const graph = (await (await fetch(`http://127.0.0.1:${port}/graph.json`)).json()) as {
      schemaVersion: number;
    };
    assert.equal(graph.schemaVersion, 3);

    const receipts = (await (await fetch(`http://127.0.0.1:${port}/strata.json`)).json()) as {
      strata: { stratum: string }[];
    };
    assert.deepEqual(
      receipts.strata.map((s: { stratum: string }) => s.stratum),
      ["governance", "structure", "context"],
    );
  } finally {
    await running.close();
  }
});

test("a key, when set, is required — and a wrong one is refused", async () => {
  const port = await freePort();
  const running = startServe({ source: memory(), port, apiKey: "the-key" });
  await running.ready;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/graph.json`)).status, 401);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/graph.json`, { headers: { "x-api-key": "wrong" } })).status,
      401,
    );
    // A wrong key of a different length must be refused, not throw a 500:
    // timingSafeEqual throws on a length mismatch rather than returning false.
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/graph.json`, { headers: { "x-api-key": "x" } })).status,
      401,
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/graph.json`, { headers: { "x-api-key": "the-key" } })).status,
      200,
    );
  } finally {
    await running.close();
  }
});

test("a client is sent the graph on connect, and again when it changes", async () => {
  const port = await freePort();
  const running = startServe({ source: memory(), port });
  await running.ready;
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/live`);
    const messages: { generatedAt: string }[] = [];
    const got = (count: number) =>
      new Promise<void>((resolveWhen, rejectWhen) => {
        const timer = setTimeout(() => rejectWhen(new Error(`only ${messages.length} message(s)`)), 8000);
        const check = () => {
          if (messages.length >= count) {
            clearTimeout(timer);
            resolveWhen();
          }
        };
        socket.on("message", (data) => {
          messages.push(JSON.parse(String(data)));
          check();
        });
        check();
      });

    // Connecting between two changes must not leave a client on a blank page
    // waiting for a write that may never come.
    await got(1);
    assert.equal(messages[0]!.generatedAt.length > 0, true);

    running.refresh();
    await got(2);
    assert.notEqual(messages[1]!.generatedAt, messages[0]!.generatedAt, "a real new projection");

    socket.close();
  } finally {
    await running.close();
  }
});
