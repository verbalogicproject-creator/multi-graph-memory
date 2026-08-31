/**
 * fractal-graph-memory — public surface.
 *
 * Governed episodic and lesson memory for Verbalogix Fractal. Local-first, with
 * an offline-pure governance core and an injected relevance layer.
 *
 * Import the core alone (`fractal-graph-memory/core`) to get the governance
 * model with no storage, provider or network code attached.
 */

export * from "./core/index.ts";
export * from "./adapters/index.ts";
export * from "./relevance/index.ts";
export * from "./port.ts";
export * from "./docs/frontmatter.ts";
export * from "./docs/projector.ts";
export * from "./docs/ingest.ts";
export * from "./control/index.ts";
export * from "./mcp/server.ts";

/** The provider is NOT re-exported: importing it would pull the optional SDK. */
