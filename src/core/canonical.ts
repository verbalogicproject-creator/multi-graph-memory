/**
 * Deterministic serialization and content identity.
 *
 * Everything downstream leans on this: idempotent append (Ruling 4), export
 * checksums, migration validation, and the outbox drain's guarantee that
 * replaying a partially drained batch cannot duplicate events.
 *
 * Determinism rules, chosen so Node and a browser produce byte-identical output:
 *   - object keys sorted by UTF-16 code unit
 *   - array order preserved (order is semantic)
 *   - `undefined` members omitted, so absent and explicitly-undefined agree
 *   - `null` preserved
 *   - non-finite numbers refused rather than coerced
 *   - functions, symbols and BigInt refused
 *   - cycles refused
 *
 * Number formatting relies on ECMAScript's Number::toString, which is
 * specified exactly and therefore identical across conforming engines.
 */

import { createHash } from "node:crypto";
import { refuse } from "./errors.ts";

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function encode(value: unknown, seen: Set<object>, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      refuse("VALIDATION_FAILED", `Non-finite number at ${path} cannot be canonicalized.`, {
        path,
        value: String(value),
      });
    }
    // -0 and 0 must not produce different identities.
    const n = value as number;
    return JSON.stringify(Object.is(n, -0) ? 0 : n);
  }

  if (t === "string") return JSON.stringify(value);

  if (t === "bigint" || t === "function" || t === "symbol") {
    refuse("VALIDATION_FAILED", `Value of type ${t} at ${path} cannot be canonicalized.`, { path });
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      refuse("VALIDATION_FAILED", `Circular reference at ${path}.`, { path });
    }
    seen.add(value);
    const parts = value.map((item, i) => encode(item, seen, `${path}[${i}]`) ?? "null");
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) {
      refuse("VALIDATION_FAILED", `Circular reference at ${path}.`, { path });
    }
    seen.add(obj);
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const encoded = encode(obj[key], seen, `${path}.${key}`);
      if (encoded === undefined) continue; // omit undefined members
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    seen.delete(obj);
    return `{${parts.join(",")}}`;
  }

  refuse("VALIDATION_FAILED", `Unsupported value at ${path}.`, { path });
}

/** Stable, byte-reproducible string form of any JSON-compatible value. */
export function canonicalize(value: unknown): string {
  const out = encode(value, new Set<object>(), "$");
  return out ?? "null";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 over the canonical form. The one hashing entry point used everywhere. */
export function contentDigest(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/**
 * Deterministic event identity.
 *
 * Derived from the full semantic content, so the same logical event delivered
 * twice yields the same id and the second append is a no-op. Any supplied `id`
 * is ignored on purpose -- identity is computed, never asserted by a caller.
 */
export function deriveEventId(event: Record<string, unknown>): string {
  const { id: _ignored, ...rest } = event;
  return `evt_${contentDigest(rest)}`;
}

export function deriveEpisodeId(projectId: string, objective: string, baseRevisionId: string, openedAt: string): string {
  return `epi_${contentDigest({ projectId, objective, baseRevisionId, openedAt })}`;
}

export function deriveLessonId(projectId: string, trigger: string, recommendation: string, domain: string): string {
  return `les_${contentDigest({ projectId, trigger, recommendation, domain })}`;
}

export function deriveEvidenceId(projectId: string, kind: string, ref: string): string {
  return `evd_${contentDigest({ projectId, kind, ref })}`;
}
