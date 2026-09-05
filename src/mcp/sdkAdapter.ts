/**
 * The one piece every SDK-based transport (stdio, HTTP) shares: wiring an SDK
 * `Server`'s `tools/list` and `tools/call` handlers to `ReadOnlyMcpServer`'s
 * own, transport-agnostic dispatch.
 *
 * Deliberately not inside `server.ts` — that file's whole point is staying
 * SDK-free, so a future transport, or a test, can drive `ReadOnlyMcpServer`
 * without ever importing the SDK. This file is the one place that dependency
 * is allowed to exist, and every transport bootstrap goes through it rather
 * than reimplementing the `tools/call` -> `handleRequest` translation a
 * second time — which is exactly the kind of drift `READ_ONLY_TOOLS` staying
 * a single source of truth is supposed to prevent.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ReadOnlyMcpServer, READ_ONLY_TOOLS } from "./server.ts";
import type { GraphMemory } from "../port.ts";

export function attachReadOnlyTools(server: Server, memory: GraphMemory): void {
  const inner = new ReadOnlyMcpServer({ memory });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: READ_ONLY_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const response = (await inner.handleRequest({
      id: 0,
      method: "tools/call",
      params: { name: request.params.name, arguments: request.params.arguments ?? {} },
    })) as { result?: { content: Array<{ type: "text"; text: string }> }; error?: { message: string } };
    /* `handleRequest` sets exactly one of `result`/`error` — rethrowing hands
       the same message to the SDK's own protocol-level error path rather than
       re-deciding what it should say. */
    if (response.error) throw new Error(response.error.message);
    return response.result!;
  });
}
