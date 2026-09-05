#!/usr/bin/env node
/**
 * The missing entrypoint.
 *
 * `src/mcp/server.ts`'s `ReadOnlyMcpServer` has correct read tools and a genuine
 * read-only guarantee, but no bootstrap ever called `.start()` on one — `npm run
 * mcp` loaded the module and exited. It also spoke a hand-rolled line-delimited
 * JSON-RPC that never implemented `initialize`, never advertised capabilities,
 * and replied to notifications, which is a protocol violation any real MCP
 * client would trip over immediately.
 *
 * This file is a thin adapter, not a rewrite. `READ_ONLY_TOOLS`,
 * `FORBIDDEN_TOOL_PATTERNS`, `ReadOnlyMcpServer` and the source-scanning test in
 * `test/mcp.readonly.test.ts` all stay exactly as they are — the SDK transports
 * tools here, it does not decide what they are. The actual wiring
 * (`tools/list` -> `READ_ONLY_TOOLS`, `tools/call` -> `ReadOnlyMcpServer.
 * handleRequest`) lives in `src/mcp/sdkAdapter.ts`, shared with the HTTP
 * transport (`src/mcp/http.ts`, B2) so the translation exists exactly once
 * regardless of how many transports carry it.
 *
 * The low-level `Server` class is used deliberately over the newer `McpServer`,
 * despite the SDK marking it `@deprecated` in favour of `McpServer`.
 * `McpServer.registerTool` only accepts a Zod schema for `inputSchema` — but
 * `READ_ONLY_TOOLS` is already a raw JSON Schema, which is what the wire
 * protocol actually carries in `tools/list`. Converting it to Zod would be a
 * second, hand-maintained copy of every tool's shape; `Server.setRequestHandler`
 * takes the JSON Schema as-is and the SDK still does full `initialize`,
 * capability negotiation and notification handling correctly underneath it.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openMemory } from "../src/cli/multi-memory.ts";
import { attachReadOnlyTools } from "../src/mcp/sdkAdapter.ts";
import { packageVersion } from "../src/mcp/version.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const version = packageVersion(__dirname);

async function main(): Promise<void> {
  /**
   * Scope resolved the one way this codebase resolves it, not a second time.
   * `openMemory` already does `loadConfig` -> `ensureClusterDir` ->
   * `SqliteStorageAdapter` -> `GraphMemory` for the CLI; an MCP client asking
   * "which project is this" should get the identical answer a `multi-memory`
   * command run from the same directory would.
   */
  const { memory, storage, config } = openMemory();

  const server = new Server(
    { name: "multi-memory", version },
    { capabilities: { tools: {} } },
  );
  attachReadOnlyTools(server, memory);

  const shutdown = () => {
    storage.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  /* No further output: stdout is the transport now. Anything else written to
     it would be read by the client as a malformed JSON-RPC message. */
  console.error(`multi-memory MCP server started — project "${config.projectId}", workspace "${config.workspace}".`);
}

main().catch((error) => {
  console.error("multi-memory-mcp failed to start:", error);
  process.exit(1);
});
