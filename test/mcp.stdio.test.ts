/**
 * The one thing `mcp.readonly.test.ts` cannot prove: that a real client, over a
 * real stdio transport, gets a protocol-correct handshake.
 *
 * Every existing MCP test calls `ReadOnlyMcpServer.handleRequest` directly —
 * proof that the tool dispatch is right, never proof that anything could
 * actually talk to it. Before `bin/multi-memory-mcp.ts` existed, the answer was
 * "no": `npm run mcp` loaded `src/mcp/server.ts` and exited, and the hand-rolled
 * transport it replaced never implemented `initialize`, never advertised
 * capabilities, and answered notifications — a protocol violation that would
 * hang or confuse any spec-following client on first contact.
 *
 * This spawns the real binary as a real child process and drives it exactly as
 * a client would: `initialize`, the `initialized` notification, `tools/list`,
 * `tools/call`, and every forbidden verb by name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_TOOL_PATTERNS, READ_ONLY_TOOLS } from "../src/mcp/server.ts";

const BIN = fileURLToPath(new URL("../bin/multi-memory-mcp.ts", import.meta.url));

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Runs the real server as a child process, isolated in its own temp project so
 * this test never touches this repo's own `.multi-memory/`.
 */
async function withServer(fn: (send: (msg: unknown) => void, responses: () => JsonRpcResponse[]) => Promise<void>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "fgm-mcp-stdio-"));
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [BIN], { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });

  const responses: JsonRpcResponse[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newlineAt: number;
    while ((newlineAt = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      if (line.trim()) responses.push(JSON.parse(line) as JsonRpcResponse);
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const send = (msg: unknown) => { child.stdin.write(`${JSON.stringify(msg)}\n`); };

  try {
    await fn(send, () => responses);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
  return stderr;
}

// 20s, not 5s. The bar is "the handshake completes", never "it completes within
// five seconds": spawning the server type-strips the whole module graph, and on a
// cold cache under full-suite load that measured 5081ms here -- a flake that fails
// the run for a reason the test does not claim to be testing. Still bounded, so a
// server that genuinely never answers still fails rather than hanging.
const waitForCount = async (get: () => unknown[], count: number, timeoutMs = 20000): Promise<void> => {
  const start = Date.now();
  while (get().length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} response(s), got ${get().length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("a real client handshake completes: initialize -> tools/list -> tools/call", async () => {
  await withServer(async (send, responses) => {
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test", version: "0.0.0" } },
    });
    await waitForCount(responses, 1);
    const init = responses()[0]!;
    assert.equal(init.id, 1);
    assert.ok(init.result?.protocolVersion, "initialize must answer with a protocol version");
    assert.ok(init.result?.capabilities, "initialize must advertise capabilities");
    assert.ok((init.result?.serverInfo as { name?: string } | undefined)?.name, "initialize must name the server");

    /* A notification carries no id and MUST draw no response at all — the
       violation the hand-rolled transport had before this file existed. */
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitForCount(responses, 2);
    const list = responses()[1]!;
    const names = (list.result?.tools as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(names, READ_ONLY_TOOLS.map((t) => t.name));

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fgm_project_status", arguments: {} } });
    await waitForCount(responses, 3);
    const call = responses()[2]!;
    const content = call.result?.content as Array<{ text: string }>;
    const status = JSON.parse(content[0]!.text) as { authority: string };
    assert.equal(status.authority, "context_only");

    /* The notification never drew a response — still true after three real
       replies, not merely "no response yet". */
    assert.equal(responses().length, 3, "a notification must never produce a response");

    let nextId = 10;
    const forbiddenIds: number[] = [];
    for (const forbidden of FORBIDDEN_TOOL_PATTERNS) {
      const id = nextId++;
      forbiddenIds.push(id);
      send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: `fgm_${forbidden}_lesson`, arguments: {} } });
    }
    await waitForCount(responses, 3 + forbiddenIds.length);
    for (const id of forbiddenIds) {
      const response = responses().find((r) => r.id === id);
      assert.ok(response, `no response for forbidden call id ${id}`);
      assert.match(response!.error?.message ?? "", /Unknown tool/, `"${id}" should fail as unknown, not as forbidden`);
    }
  });
});

test("an unconfigured project still starts and says so on stderr, not stdout", async () => {
  const stderr = await withServer(async (send, responses) => {
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test", version: "0.0.0" } },
    });
    await waitForCount(responses, 1);
  });
  assert.match(stderr, /multi-memory MCP server started/);
});
