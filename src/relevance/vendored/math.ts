/**
 * VENDORED — see PROVENANCE.md
 * Origin : /root/antigravity-memory-os/src/vector/math.ts
 * Author : Eyal Nof · License: MIT
 * Changes: strict-mode index guards for `noUncheckedIndexedAccess`; the
 *          byte-copy loop in bufferToFloat32 replaced with a typed-array copy
 *          (same bytes, no aliasing of the source buffer). Algorithm unchanged.
 *
 * Pure JS vector math with zero native compilation, which is what lets this run
 * on Termux/ARM64 at all.
 */

export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: vector A (${a.length}) vs vector B (${b.length})`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const valA = a[i] ?? 0;
    const valB = b[i] ?? 0;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  // Guards divide-by-zero: a zero vector is defined as maximally dissimilar.
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(copy.buffer);
}
