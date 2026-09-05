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
 * tools here, it does not decide what they are. `tools/list` returns
 * `READ_ONLY_TOOLS` verbatim; `tools/call` is handed to
 * `ReadOnlyMcpServer.handleRequest`, and its answer is unwrapped or its error is
 * rethrown so the SDK's own error path takes over. Nothing about tool dispatch
 * is reimplemented, so nothing about it can drift from what the existing test
 * suite already proves.
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ReadOnlyMcpServer, READ_ONLY_TOOLS } from "../src/mcp/server.ts";
import { openMemory } from "../src/cli/multi-memory.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Walked, not a fixed `../..` — this file's distance from `package.json` differs
 * between the source tree (`bin/` is one level under the package root) and the
 * build (`tsconfig.build.json` mirrors that same tree one level deeper, under
 * `dist/`, so it's two levels from there). A fixed relative path is only ever
 * right for one of the two, and this was measured wrong the first time: it read
 * clean from `node bin/multi-memory-mcp.ts` and threw `ENOENT` from the compiled
 * `dist/bin/multi-memory-mcp.js` this package's own `bin` field actually points
 * at. Walking up is correct in both cases, and in a third this project doesn't
 * exercise yet but a real install does: running from inside someone else's
 * `node_modules/multi-graph-memory/`.
 */
const findPackageJson = (startDir: string): string => {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${startDir}`);
    dir = parent;
  }
};
const pkg = JSON.parse(readFileSync(findPackageJson(__dirname), "utf8")) as { version: string };

async function main(): Promise<void> {
  /**
   * Scope resolved the one way this codebase resolves it, not a second time.
   * `openMemory` already does `loadConfig` -> `ensureClusterDir` ->
   * `SqliteStorageAdapter` -> `GraphMemory` for the CLI; an MCP client asking
   * "which project is this" should get the identical answer a `multi-memory`
   * command run from the same directory would.
   */
  const { memory, storage, config } = openMemory();

  const inner = new ReadOnlyMcpServer({ memory });

  const server = new Server(
    { name: "multi-memory", version: pkg.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: READ_ONLY_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const response = (await inner.handleRequest({
      id: 0,
      method: "tools/call",
      params: { name: request.params.name, arguments: request.params.arguments ?? {} },
    })) as { result?: { content: Array<{ type: "text"; text: string }> }; error?: { message: string } };
    /* `handleRequest` already knows how to fail — "Unknown tool", a
       GraphMemory error's own message. Rethrowing hands that same message to
       the SDK's protocol-level error path rather than re-deciding what it
       should say. */
    if (response.error) throw new Error(response.error.message);
    /* `handleRequest` sets exactly one of `result`/`error` — the branch above
       already ruled out `error`, so `result` is guaranteed here. */
    return response.result!;
  });

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
