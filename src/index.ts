/**
 * multi-graph-memory — public surface.
 *
 * Governed episodic and lesson memory for the multi-app builder. Local-first,
 * with an offline-pure governance core and an injected relevance layer.
 *
 * One cluster per build, not per workspace: what accumulates is what went wrong
 * generating, running and repairing a given application, and a lesson only
 * crosses builds through the control tier's human-approved promotion.
 *
 * Import the core alone (`multi-graph-memory/core`) to get the governance
 * model with no storage, provider or network code attached.
 */

export * from "./core/index.ts";
export * from "./adapters/index.ts";
export * from "./relevance/index.ts";
export * from "./port.ts";
export * from "./visualization/index.ts";
export * from "./docs/frontmatter.ts";
export * from "./docs/projector.ts";
export * from "./docs/ingest.ts";
// `kg` and `docs/frontmatter` both call their result an `IntegrityReport`, and
// they mean different things: one is a typed graph's structural soundness, the
// other is whether a projected document is safe to overwrite. The graph one is
// aliased at this boundary rather than renamed at its source, so the parity
// fixture against the Python original keeps naming it what the Python does.
export * from "./kg/types.ts";
export { CHECKS, ERROR_CHECKS, byCheck, checkIntegrity, errorsOf, findCycle, warningsOf } from "./kg/integrity.ts";
export type { CheckName, Severity, Issue as GraphIssue, IntegrityReport as GraphIntegrityReport } from "./kg/integrity.ts";
export * from "./structure/index.ts";
export * from "./control/index.ts";
export * from "./mcp/server.ts";

/** The provider is NOT re-exported: importing it would pull the optional SDK. */
