/**
 * Typed-graph declaration and integrity checking.
 *
 * This layer knows nothing about episodes, lessons or evidence. It is a general
 * typed-graph contract translated from `kg_toolkit` (see PROVENANCE.md), kept
 * separate from `src/core/**` because the governance core owns memory records
 * and must not grow a second graph model.
 */

export * from "./types.ts";
export * from "./integrity.ts";
