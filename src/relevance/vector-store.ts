/**
 * Storage for lesson embeddings.
 *
 * Kept separate from the governance StorageAdapter on purpose: vectors are a
 * relevance concern, and the core must never depend on them. A cluster with no
 * vector store at all still retrieves, just deterministically.
 *
 * Every stored vector carries its embedding-space identity AND a digest of the
 * text it was produced from, so two different things force a re-embed rather
 * than a silent wrong answer: switching model/dimensions/prompt format, and
 * editing the lesson the vector was built from.
 */

import type { VectorMetadata } from "./embedding-port.ts";

export interface StoredLessonVector {
  lessonId: string;
  projectId: string;
  values: Float32Array;
  metadata: VectorMetadata;
  /** SHA-256 of the exact text embedded. */
  contentDigest: string;
  embeddedAt: string;
}

export interface VectorStore {
  get(lessonId: string): StoredLessonVector | null;
  put(vector: StoredLessonVector): void;
  list(projectId: string): StoredLessonVector[];
  remove(lessonId: string): void;
}

export class MemoryVectorStore implements VectorStore {
  private readonly vectors = new Map<string, StoredLessonVector>();

  get(lessonId: string): StoredLessonVector | null {
    return this.vectors.get(lessonId) ?? null;
  }

  put(vector: StoredLessonVector): void {
    this.vectors.set(vector.lessonId, vector);
  }

  list(projectId: string): StoredLessonVector[] {
    return [...this.vectors.values()].filter((v) => v.projectId === projectId);
  }

  remove(lessonId: string): void {
    this.vectors.delete(lessonId);
  }
}
