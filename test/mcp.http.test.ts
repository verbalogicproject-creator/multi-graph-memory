/**
 * The Streamable HTTP transport, driven exactly as Cloud Run's own front door
 * and a real MCP client would: real HTTP requests against a real listening
 * server, not `createHttpApp`'s return value inspected in the abstract.
 *
 * Four assertions matter more than the rest, because each one is a documented
 * Cloud Run scar from `src/mcp/http.ts`'s own header comment, not a generic
 * HTTP nicety:
 *
 *   - unauthenticated (or wrongly authenticated) -> 401, never a quiet pass
 *   - no key configured at all -> 401 on every request, fail closed
 *   - `/.well-known/*` -> 404, so a client does not hang starting OAuth
 *   - a correct request answers `initialize` with no session id at all —
 *     stateless, the one mode Cloud Run's ephemeral containers can actually
 *     support
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { GraphMemory } from "../src/port.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { createHttpApp } from "../src/mcp/http.ts";
import { PROJECT } from "./helpers/factory.ts";

const API_KEY = "test-key-do-not-use-in-production";

function memory(): GraphMemory {
  const storage = new MemoryStorageAdapter();
  storage.open();
  return new GraphMemory({ storage, scope: { projectId: PROJECT } });
}

async function withApp(
  apiKey: string | undefined,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  /* host: 127.0.0.1 here on purpose — this test hits a real loopback address,
     where createMcpExpressApp's own DNS-rebinding protection is correct and
     transparent to a normal fetch(). The 0.0.0.0-without-protection path
     these tests are otherwise verifying (fail-closed auth, /.well-known,
     stateless mode) does not depend on which host triggered it. */
  const app = createHttpApp({ memory: memory(), apiKey, serverVersion: "0.0.0-test", host: "127.0.0.1" });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
};

test("an unauthenticated request is refused, never answered", async () => {
  await withApp(API_KEY, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initializeBody),
    });
    assert.equal(response.status, 401);
  });
});

test("a wrong key is refused exactly like no key", async () => {
  await withApp(API_KEY, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "not-the-real-key" },
      body: JSON.stringify(initializeBody),
    });
    assert.equal(response.status, 401);
  });
});

test("no key configured on the server refuses every request — fail closed, not open", async () => {
  await withApp(undefined, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": "anything-at-all" },
      body: JSON.stringify(initializeBody),
    });
    assert.equal(response.status, 401);
  });
});

test("a correct X-Api-Key reaches initialize, statelessly", async () => {
  await withApp(API_KEY, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Api-Key": API_KEY },
      body: JSON.stringify(initializeBody),
    });
    assert.equal(response.status, 200);
    /* Stateless mode: no session id in any response header, per the SDK's own
       documented contract for `sessionIdGenerator: undefined`. A session id
       here would mean a later request could depend on this exact container
       instance still being alive — which Cloud Run does not promise. */
    assert.equal(response.headers.get("mcp-session-id"), null);

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const body = contentType.includes("text/event-stream")
      ? JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice("data: ".length))
      : JSON.parse(text);
    assert.ok(body.result?.protocolVersion, "initialize must answer with a protocol version");
    assert.ok(body.result?.serverInfo?.name, "initialize must name the server");
  });
});

test("Authorization: Bearer is not honoured as a substitute for X-Api-Key", async () => {
  /* The whole reason this transport does not use Bearer: Cloud Run's own
     front door intercepts it before this process ever sees the request. This
     asserts the server side of that contract — presenting the key as a
     Bearer token, not as X-Api-Key, must not authenticate. */
  await withApp(API_KEY, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(initializeBody),
    });
    assert.equal(response.status, 401);
  });
});

test("/.well-known/* is 404, not 401 — no OAuth handshake to hang on", async () => {
  await withApp(API_KEY, async (baseUrl) => {
    const withoutKey = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    assert.equal(withoutKey.status, 404);

    /* Even carrying a valid key, since the point is "there is no OAuth here
       at all", not "you're not allowed to see it". */
    const withKey = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
      headers: { "X-Api-Key": API_KEY },
    });
    assert.equal(withKey.status, 404);
  });
});

test("GET and DELETE /mcp are refused — stateless mode has no stream to resume or session to end", async () => {
  await withApp(API_KEY, async (baseUrl) => {
    const get = await fetch(`${baseUrl}/mcp`, { headers: { "X-Api-Key": API_KEY } });
    assert.equal(get.status, 405);
    const del = await fetch(`${baseUrl}/mcp`, { method: "DELETE", headers: { "X-Api-Key": API_KEY } });
    assert.equal(del.status, 405);
  });
});

test("tools/call still runs through the same read-only dispatch as stdio", async () => {
  await withApp(API_KEY, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Api-Key": API_KEY },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "fgm_project_status", arguments: {} },
      }),
    });
    assert.equal(response.status, 200);
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const body = contentType.includes("text/event-stream")
      ? JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice("data: ".length))
      : JSON.parse(text);
    const status = JSON.parse(body.result.content[0].text) as { authority: string };
    assert.equal(status.authority, "context_only");
  });
});
