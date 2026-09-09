/**
 * The derived stratum: read-only access to a project's code-structure graph.
 *
 * Outside `src/core/**` deliberately -- it opens files, and the governance core
 * performs no filesystem I/O (`tooling/check-boundaries.mjs`).
 */

export * from "./schema.ts";
export * from "./read.ts";
