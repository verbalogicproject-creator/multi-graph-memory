/**
 * The injected embedding port.
 *
 * Ruling 2: embeddings are required as a production relevance capability but are
 * never a core dependency. This file declares the seam; it contains no provider
 * code, no network code and no key handling, and `src/core/**` never imports it.
 *
 * Ruling 3: `guardedEmbed` is the ONLY sanctioned way to call an adapter. The
 * redaction gate runs first, so refused material never reaches the adapter --
 * which is the difference between a storage rule and a transmission rule.
 */

import { assertRedactionBoundary } from "../core/redaction.ts";
import { refuse } from "../core/errors.ts";

/** Identity of the embedding space. Mixing spaces silently is the failure this prevents. */
export interface VectorMetadata {
  modelId: string;
  dimensions: number;
  /** Bumped whenever the prompt-prefix convention changes, since that changes the space in practice. */
  promptFormatVersion: string;
}

export interface EmbeddingRequest {
  text: string;
  /** Asymmetric retrieval: a query and a document are formatted differently. */
  role: "query" | "document";
  title?: string;
  /** Chooses the task prefix for the provider that needs one. */
  task?: "search" | "question-answering" | "fact-checking" | "code-retrieval";
}

export interface EmbeddingAdapter {
  readonly metadata: VectorMetadata;
  embed(request: EmbeddingRequest): Promise<Float32Array>;
}

export interface StoredVector {
  values: Float32Array;
  metadata: VectorMetadata;
}

export function metadataMatches(a: VectorMetadata, b: VectorMetadata): boolean {
  return (
    a.modelId === b.modelId &&
    a.dimensions === b.dimensions &&
    a.promptFormatVersion === b.promptFormatVersion
  );
}

/**
 * Refuses when a stored vector came from a different embedding space. Embedding
 * spaces are not comparable across models, so a mismatch must force a re-embed
 * rather than quietly producing meaningless similarities.
 */
export function assertSameSpace(stored: VectorMetadata, active: VectorMetadata): void {
  if (!metadataMatches(stored, active)) {
    refuse(
      "EMBEDDING_SPACE_MISMATCH",
      "Stored vectors were produced in a different embedding space; re-embed before comparing.",
      { stored, active },
    );
  }
}

/** Partitions stored vectors into those usable now and those needing a re-embed. */
export function partitionBySpace<T extends { metadata: VectorMetadata }>(
  records: readonly T[],
  active: VectorMetadata,
): { usable: T[]; needsReembed: T[] } {
  const usable: T[] = [];
  const needsReembed: T[] = [];
  for (const record of records) {
    if (metadataMatches(record.metadata, active)) usable.push(record);
    else needsReembed.push(record);
  }
  return { usable, needsReembed };
}

/**
 * The guarded call. Nothing else in this package may invoke `adapter.embed`.
 */
export async function guardedEmbed(
  adapter: EmbeddingAdapter,
  request: EmbeddingRequest,
): Promise<StoredVector> {
  // Ruling 3: the embedding gate, before the adapter is touched.
  assertRedactionBoundary({ text: request.text, title: request.title }, "embedding");

  const values = await adapter.embed(request);
  if (values.length !== adapter.metadata.dimensions) {
    refuse(
      "EMBEDDING_SPACE_MISMATCH",
      `Adapter returned ${values.length} dimensions but declares ${adapter.metadata.dimensions}.`,
      { returned: values.length, declared: adapter.metadata.dimensions },
    );
  }
  return { values, metadata: adapter.metadata };
}
