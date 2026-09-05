#!/usr/bin/env node
/**
 * The Cloud-Run-shaped entrypoint. A container has no persistent stdin/stdout
 * pipe to a client, so B1's stdio transport cannot be what a deployed server
 * speaks — see `src/mcp/http.ts` for what actually answers a request here.
 * This file only reads the environment, resolves scope, and starts listening.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openMemory } from "../src/cli/multi-memory.ts";
import { createHttpApp } from "../src/mcp/http.ts";
import { packageVersion } from "../src/mcp/version.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const version = packageVersion(__dirname);

/* Cloud Run injects PORT; 8080 matches what the eventual Dockerfile EXPOSEs. */
const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.MCP_API_KEY;

if (!API_KEY) {
  console.error(
    "MCP_API_KEY is not set. Every request will be refused with 401 — fail closed, not open. " +
      "Set it before pointing anything real at this server.",
  );
}

const { memory, storage, config } = openMemory();
const app = createHttpApp({ memory, apiKey: API_KEY, serverVersion: version, host: "0.0.0.0" });

const httpServer = app.listen(PORT, () => {
  console.log(
    `multi-memory MCP HTTP server listening on :${PORT} — project "${config.projectId}", workspace "${config.workspace}".`,
  );
});

const shutdown = () => {
  httpServer.close(() => {
    storage.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
