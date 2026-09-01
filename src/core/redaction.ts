/**
 * Ruling 3: redaction is a storage AND a transmission boundary.
 *
 * The gate runs before persistence, before embedding, before provider
 * transmission, before export, and before cross-project promotion. Embedding is
 * the reason this is not merely a storage rule: anything embedded leaves the
 * device, so the check must happen before the adapter is called, not after.
 *
 * The boundary REFUSES rather than silently stripping. Quietly redacting would
 * let a caller believe material was stored when it was not, which is a worse
 * failure than a loud rejection.
 */

import { refuse } from "./errors.ts";

export const REDACTION_GATES = [
  "persistence",
  "embedding",
  "transmission",
  "export",
  "promotion",
] as const;

export type RedactionGate = (typeof REDACTION_GATES)[number];

/** Default ceiling for a single event payload. Deliberately small: events are claims, not artifacts. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;

export interface SecretFinding {
  rule: string;
  path: string;
  hint: string;
}

interface SecretRule {
  name: string;
  pattern: RegExp;
}

/**
 * Credential shapes. Each is anchored on a distinctive prefix or structure so
 * ordinary prose and code do not trip it.
 */
const SECRET_RULES: SecretRule[] = [
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35,}/ },
  { name: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "private-key-block", pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/i },
  { name: "credentialed-url", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i },
  {
    name: "assigned-secret",
    pattern:
      /\b(?:api[_-]?key|secret[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|credential|private[_-]?key)\b\s*[:=]\s*["']?[^\s"',}]{8,}/i,
  },
];

/**
 * Structurally forbidden members. The specification excludes raw provider traces
 * and hidden chain-of-thought explicitly; thought signatures are opaque provider
 * state, and the host's own provider boundary already refuses to persist it.
 */
const FORBIDDEN_KEYS = new Set(
  [
    "thoughtsignature",
    "thought_signature",
    "hiddenreasoning",
    "hidden_reasoning",
    "chainofthought",
    "chain_of_thought",
    "reasoningtrace",
    "reasoning_trace",
    "rawprovidertrace",
    "raw_provider_trace",
    "providertrace",
    "apikey",
    "api_key",
    "audio",
    "audiodata",
    "audio_data",
    "inlinedata",
    "inline_data",
  ].map((k) => k.toLowerCase()),
);

/** Opaque blobs: long base64 runs and executable/media data URIs. */
const OPAQUE_RULES: SecretRule[] = [
  { name: "data-uri-executable-or-media", pattern: /\bdata:(?:audio|video|application)\/[a-z0-9.+-]+;base64,/i },
  { name: "long-base64-blob", pattern: /\b[A-Za-z0-9+/]{512,}={0,2}\b/ },
];

function walk(
  value: unknown,
  path: string,
  findings: SecretFinding[],
  depth: number,
): void {
  if (depth > 64) {
    refuse("VALIDATION_FAILED", `Payload nests deeper than 64 levels at ${path}.`, { path });
  }

  if (typeof value === "string") {
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(value)) {
        findings.push({ rule: rule.name, path, hint: "credential-shaped string" });
      }
    }
    for (const rule of OPAQUE_RULES) {
      if (rule.pattern.test(value)) {
        findings.push({ rule: rule.name, path, hint: "opaque or executable payload" });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, findings, depth + 1));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        findings.push({ rule: `forbidden-key:${key}`, path: `${path}.${key}`, hint: "excluded content class" });
      }
      walk(member, `${path}.${key}`, findings, depth + 1);
    }
  }
}

/** Non-throwing scan. Returns every finding so a report can list them all. */
export function scanForSecrets(value: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  walk(value, "$", findings, 0);
  return findings;
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
}

export interface GateOptions {
  maxBytes?: number;
}

/**
 * The gate. Call before every persistence, embedding, transmission, export and
 * promotion. Throws SECRET_DETECTED or PAYLOAD_TOO_LARGE; returns silently when clean.
 */
export function assertRedactionBoundary(
  value: unknown,
  gate: RedactionGate,
  options: GateOptions = {},
): void {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const size = byteLength(value);
  if (size > maxBytes) {
    refuse("PAYLOAD_TOO_LARGE", `Payload of ${size} bytes exceeds the ${maxBytes} byte limit at the ${gate} gate.`, {
      gate,
      size,
      maxBytes,
    });
  }

  const findings = scanForSecrets(value);
  if (findings.length > 0) {
    refuse(
      "SECRET_DETECTED",
      `Refused at the ${gate} gate: ${findings.length} excluded item(s) detected. Nothing was stored or transmitted.`,
      { gate, findings },
    );
  }
}
