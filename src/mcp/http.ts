/**
 * The Streamable HTTP transport — the surface a deployed (Cloud Run) MCP
 * server is actually hit on. Same tool dispatch as the stdio transport
 * (`bin/multi-memory-mcp.ts`, via `sdkAdapter.ts`); this file only decides how
 * a request reaches it over HTTP, and who is allowed to send one.
 *
 * Four things this file exists to get right, each a documented scar from
 * running an MCP server on Cloud Run specifically — get any one wrong and the
 * symptom is "it works from curl on a laptop and breaks in exactly the place
 * it was built for":
 *
 * 1. **`X-Api-Key`, not `Authorization: Bearer`.** A Cloud Run service
 *    deployed `--allow-unauthenticated` still has its own front door inspect
 *    a Bearer token and try to validate it as a Google identity token before
 *    the request reaches this process at all. A client's real API key,
 *    presented as a Bearer token, is rejected by infrastructure that has no
 *    idea what this server's tokens mean.
 * 2. **Stateless.** `sessionIdGenerator: undefined` below — Cloud Run kills
 *    idle container instances after roughly fifteen minutes and can route the
 *    next request to a fresh instance with no memory of a session id the
 *    first one minted.
 * 3. **DNS-rebinding protection off for a public bind.** `createMcpExpressApp`'s
 *    built-in protection only recognises loopback hostnames (127.0.0.1,
 *    localhost, ::1); a service meant to be reached at a Cloud-Run-assigned
 *    hostname would answer every real request with 421. Safe specifically
 *    because Cloud Run's own front proxy already validates the Host header
 *    before anything reaches this process — turning this off behind anything
 *    that does not do that would be a real hole, not a convenience.
 * 4. **`/.well-known/*` -> 404.** Without it, a spec-following client starts
 *    an OAuth discovery handshake this server has no way to finish, and hangs
 *    rather than falling back to the `X-Api-Key` it was actually configured
 *    with.
 *
 * The API key check fails **closed**: no key configured means every request
 * is refused, never served open. The one thing in the curriculum this was
 * built from that is not worth copying is its sample logging a warning and
 * serving open when unconfigured.
 */

import { timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { attachReadOnlyTools } from "./sdkAdapter.ts";
import type { GraphMemory } from "../port.ts";

export interface CreateHttpAppOptions {
  memory: GraphMemory;
  /** The key a caller must present in `X-Api-Key`. `undefined` means every
   *  request is refused — fail closed, never fail open. */
  apiKey: string | undefined;
  serverVersion: string;
  /** Cloud Run binds `0.0.0.0`; local verification usually wants the default
   *  `127.0.0.1`, where `createMcpExpressApp`'s own DNS-rebinding protection
   *  is exactly what should apply. */
  host?: string;
}

/**
 * Constant-time, and safe against a length mismatch — `timingSafeEqual`
 * throws rather than returning `false` when its two buffers differ in
 * length, which a naive `a.length === b.length && timingSafeEqual(a, b)`
 * gets right but is easy to get wrong under refactoring pressure later.
 */
const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } });
};

export function createHttpApp(options: CreateHttpAppOptions): Express {
  const app = createMcpExpressApp({ host: options.host ?? "0.0.0.0" });

  /* Before auth, on purpose — a client probing for OAuth metadata should get
     a clean "there is none here" regardless of whether it also sent a key. */
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/.well-known/")) { res.status(404).end(); return; }
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!options.apiKey) {
      res.status(401).json({ error: "This server has no MCP_API_KEY configured; every request is refused." });
      return;
    }
    const presented = req.header("X-Api-Key");
    if (!presented || !safeEqual(presented, options.apiKey)) {
      res.status(401).json({ error: "Missing or invalid X-Api-Key." });
      return;
    }
    next();
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    /* A fresh `Server` per request, matching the SDK's own stateless example:
       stateless mode means nothing is meant to survive between requests, so
       nothing should be shared between them either. */
    const server = new Server(
      { name: "multi-memory", version: options.serverVersion },
      { capabilities: { tools: {} } },
    );
    attachReadOnlyTools(server, options.memory);

    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal server error" } });
      }
    }
  });

  /* Streamable HTTP is POST-only in stateless mode — no server-initiated
     stream to resume (GET) and no session to end (DELETE). */
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
