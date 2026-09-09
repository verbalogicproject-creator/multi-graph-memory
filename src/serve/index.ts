/**
 * `multi-memory serve` — the graph, live.
 *
 * Phase 2 joined three stores and Phase 3 drew them. This is the part that
 * makes the picture keep up: the stores are files, files change, and a graph
 * that silently stopped reflecting them is the same defect as a hook that
 * silently stopped firing.
 *
 * What it serves:
 *
 *   GET  /            the same page `graph export` writes, in live mode
 *   GET  /graph.json  the projection, for anything that is not a browser
 *   WS   /live        a push of the whole projection whenever a store changes
 *
 * Three things it deliberately does not do:
 *
 * 1. **It never writes.** Every store is opened read-only by the readers it
 *    calls; there is no mutating route. The one thing a viewer must not be
 *    able to do is edit the earned corpus by looking at it.
 * 2. **It does not choose 8080.** The MCP HTTP entrypoint defaults there
 *    because Cloud Run injects `PORT`, and 8080 is contended on this device --
 *    a stranger holding it hangs a dev proxy instead of failing it. See
 *    `CONTENDED_PORTS`, which refuses several ports by name rather than
 *    documenting the hazard and hoping.
 * 3. **It does not push a diff.** The projection is rebuilt whole and sent
 *    whole. At four hundred nodes that is cheap, and a diff protocol is a
 *    second place for the client and server to disagree about what the graph
 *    is -- which is the class of bug this phase exists to remove, not add.
 */

import { watch, type FSWatcher } from "node:fs";
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { projectGraph, type GraphProjection, type GraphSource, type StrataOptions } from "../visualization/exporter.ts";
import { serializeGraph } from "../visualization/exporter.ts";
import { ThreeJSGraphRenderer, strataNoteHtml } from "../visualization/threejs_renderer.ts";
import { bootPosture, DEFAULT_HOST, DEFAULT_PORT, type Posture } from "./posture.ts";

export { bootPosture, CONTENDED_PORTS, DEFAULT_HOST, DEFAULT_PORT, isLoopback } from "./posture.ts";

export interface ServeOptions {
  readonly source: GraphSource;
  readonly strata?: StrataOptions;
  readonly host?: string;
  readonly port?: number;
  readonly apiKey?: string;
  readonly title?: string;
  /** Store files to watch. A path that does not exist is skipped, not fatal. */
  readonly watchPaths?: readonly string[];
  /** Milliseconds to coalesce filesystem events. SQLite writes several. */
  readonly debounceMs?: number;
}

export interface RunningServer {
  readonly url: string;
  readonly posture: Posture;
  /**
   * Resolves once the socket is actually bound; rejects if it never will be.
   *
   * This exists because the first version printed its whole success banner --
   * the url, the strata counts, "Ctrl-C to stop" -- and only then died on
   * EADDRINUSE, because `listen` is asynchronous and nothing waited for it.
   * A surface built to stop things failing silently must not announce a
   * success it has not had. Await this before telling anyone anything.
   */
  readonly ready: Promise<void>;
  /** Rebuild and push now. Returns the projection that was sent. */
  refresh(): GraphProjection;
  clients(): number;
  close(): Promise<void>;
}

function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Compare lengths first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a thrown 500 is a worse answer than a 401.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startServe(options: ServeOptions): RunningServer {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const posture = bootPosture(host, options.apiKey, port);
  if (posture.fatal) throw new Error(posture.fatal);

  const renderer = new ThreeJSGraphRenderer();
  const title = options.title ?? "memory graph";
  const strata = options.strata ?? {};

  let projection = projectGraph(options.source, undefined, strata);

  const app = express();

  if (options.apiKey) {
    const expected = options.apiKey;
    app.use((req: Request, res: Response, next: NextFunction) => {
      const provided = req.header("x-api-key");
      if (!provided || !keyMatches(provided, expected)) {
        res.status(401).json({ error: "unauthorized", detail: "present a valid X-Api-Key" });
        return;
      }
      next();
    });
  }

  app.get("/", (_req: Request, res: Response) => {
    const liveUrl = `ws://${host === "0.0.0.0" ? "localhost" : host}:${port}/live`;
    res.type("html").send(renderer.renderHtml(projection.graphData, title, projection.strata, { liveUrl }));
  });

  app.get("/graph.json", (_req: Request, res: Response) => {
    res.type("json").send(serializeGraph(projection));
  });

  /** What the strata actually said, for anything that only wants the receipts. */
  app.get("/strata.json", (_req: Request, res: Response) => {
    res.json({ generatedAt: projection.generatedAt, strata: projection.strata });
  });

  let pending: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];

  const server: Server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/live" });
  const sockets = new Set<WebSocket>();

  const payload = (): string =>
    JSON.stringify({
      type: "graph",
      generatedAt: projection.generatedAt,
      graphData: projection.graphData,
      colors: renderer.generateColorPalette(
        new Set(projection.graphData.nodes.map((n) => n.type || "unknown")),
      ),
      strata: projection.strata,
      strataHtml: strataNoteHtml(projection.strata),
    });

  wss.on("connection", (socket: WebSocket) => {
    sockets.add(socket);
    // Send immediately. A client that connects between two changes should not
    // sit on a stale page waiting for the next write that may never come.
    socket.send(payload());
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  function refresh(): GraphProjection {
    projection = projectGraph(options.source, undefined, strata);
    const message = payload();
    for (const socket of sockets) {
      // readyState 1 is OPEN. A socket mid-close must not take the loop down.
      if (socket.readyState === 1) {
        try {
          socket.send(message);
        } catch {
          sockets.delete(socket);
        }
      }
    }
    return projection;
  }

  // SQLite touches a file several times per commit, so coalesce.
  const debounceMs = options.debounceMs ?? 250;
  for (const target of options.watchPaths ?? []) {
    try {
      watchers.push(
        watch(target, () => {
          if (pending) clearTimeout(pending);
          pending = setTimeout(() => {
            pending = undefined;
            try {
              refresh();
            } catch {
              // A store mid-write is a normal transient. The next event wins.
            }
          }, debounceMs);
        }),
      );
    } catch {
      // A store that does not exist is a normal answer here -- the projection
      // already reports it as an absent stratum, with the path it tried.
    }
  }

  /**
   * Everything that holds the event loop open, released.
   *
   * Called on a failed bind as well as on a clean stop. Without it, a server
   * that never managed to listen still had its filesystem watchers open, so
   * the process printed a clear error message and then hung forever -- which
   * is arguably worse than the crash it replaced, because it looks like work.
   */
  function releaseHandles(): void {
    if (pending) clearTimeout(pending);
    for (const w of watchers) w.close();
    for (const socket of sockets) socket.terminate();
  }

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    server.once("listening", () => resolveReady());
    server.once("error", (error: NodeJS.ErrnoException) => {
      releaseHandles();
      wss.close();
      server.close();
      // Name the fix, not just the errno. "address already in use" without the
      // port and without what to do next is a message you have to go and
      // decode somewhere else.
      if (error.code === "EADDRINUSE") {
        rejectReady(
          new Error(
            `port ${port} is already in use on ${host}. Something else is serving there — ` +
              `stop it, or pass --port with another.`,
          ),
        );
        return;
      }
      rejectReady(error);
    });
  });
  // The WebSocket server shares this http server, and emits the same error.
  // Without a listener it becomes an unhandled 'error' event and takes the
  // process down with a stack trace instead of a sentence.
  wss.on("error", () => {});
  server.listen(port, host);

  return {
    url: `http://${host}:${port}`,
    posture,
    ready,
    refresh,
    clients: () => sockets.size,
    close: () =>
      new Promise<void>((resolvePromise) => {
        releaseHandles();
        wss.close(() => server.close(() => resolvePromise()));
      }),
  };
}
