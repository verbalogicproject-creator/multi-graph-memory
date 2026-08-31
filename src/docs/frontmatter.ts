/**
 * Frontmatter for generated document projections (Ruling 11).
 *
 * Generated files are projections of the database, so the database is
 * authoritative for them. A hand edit must therefore be REFUSED AND REPORTED,
 * never silently overwritten -- otherwise a human's work vanishes on the next
 * regeneration with no trace, which is the worst possible outcome.
 *
 * Detection is a checksum over the body, using the same canonical hashing as
 * export bundles: the same discipline applied to the project's own documents.
 */

import { sha256Hex } from "../core/canonical.ts";
import { refuse } from "../core/errors.ts";

export interface DocFrontmatter {
  projectId: string;
  schemaVersion: number;
  generatedAt: string;
  sourceEventCount: number;
  /** SHA-256 of the body below the frontmatter block. */
  checksum: string;
  generator: string;
}

const FENCE = "---";

export function bodyChecksum(body: string): string {
  return sha256Hex(body);
}

export function serializeDocument(frontmatter: Omit<DocFrontmatter, "checksum">, body: string): string {
  const complete: DocFrontmatter = { ...frontmatter, checksum: bodyChecksum(body) };
  const lines = [
    FENCE,
    `projectId: ${complete.projectId}`,
    `schemaVersion: ${complete.schemaVersion}`,
    `generatedAt: ${complete.generatedAt}`,
    `sourceEventCount: ${complete.sourceEventCount}`,
    `generator: ${complete.generator}`,
    `checksum: ${complete.checksum}`,
    FENCE,
    "",
    "<!-- GENERATED FILE. The database is authoritative for this document.",
    "     Edit the memory store, not this file: a hand edit is detected by the",
    "     checksum above and will be refused rather than overwritten. -->",
    "",
    body,
  ];
  return lines.join("\n");
}

export interface ParsedDocument {
  frontmatter: DocFrontmatter | null;
  body: string;
}

export function parseDocument(text: string): ParsedDocument {
  if (!text.startsWith(`${FENCE}\n`)) return { frontmatter: null, body: text };

  const end = text.indexOf(`\n${FENCE}\n`, FENCE.length);
  if (end === -1) return { frontmatter: null, body: text };

  const header = text.slice(FENCE.length + 1, end);
  const rest = text.slice(end + FENCE.length + 2);

  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const required = ["projectId", "schemaVersion", "generatedAt", "sourceEventCount", "checksum", "generator"];
  if (!required.every((key) => fields.has(key))) return { frontmatter: null, body: text };

  return {
    frontmatter: {
      projectId: fields.get("projectId")!,
      schemaVersion: Number(fields.get("schemaVersion")),
      generatedAt: fields.get("generatedAt")!,
      sourceEventCount: Number(fields.get("sourceEventCount")),
      checksum: fields.get("checksum")!,
      generator: fields.get("generator")!,
    },
    // Strip the generated-file banner so the checksum covers the body only.
    body: rest.replace(/^\n*<!-- GENERATED FILE[\s\S]*?-->\n*/, ""),
  };
}

export interface IntegrityReport {
  status: "absent" | "pristine" | "hand-edited" | "foreign";
  detail: string;
}

/** Classifies an existing file before anything is written over it. */
export function inspectDocument(existing: string | null, projectId: string): IntegrityReport {
  if (existing === null) return { status: "absent", detail: "no existing file" };

  const parsed = parseDocument(existing);
  if (!parsed.frontmatter) {
    return { status: "foreign", detail: "file has no generated-document frontmatter" };
  }
  if (parsed.frontmatter.projectId !== projectId) {
    return {
      status: "foreign",
      detail: `file belongs to project "${parsed.frontmatter.projectId}", not "${projectId}"`,
    };
  }
  const actual = bodyChecksum(parsed.body);
  if (actual !== parsed.frontmatter.checksum) {
    return {
      status: "hand-edited",
      detail: `body checksum ${actual.slice(0, 12)} does not match the recorded ${parsed.frontmatter.checksum.slice(0, 12)}`,
    };
  }
  return { status: "pristine", detail: "matches its recorded checksum" };
}

/** Throws unless it is safe to regenerate over `existing`. */
export function assertSafeToOverwrite(existing: string | null, projectId: string, path: string): void {
  const report = inspectDocument(existing, projectId);
  if (report.status === "absent" || report.status === "pristine") return;

  refuse(
    "DOCUMENT_HAND_EDITED",
    `Refusing to overwrite ${path}: ${report.detail}. Regeneration would discard those changes; move them into the memory store, or delete the file to regenerate.`,
    { path, status: report.status, detail: report.detail },
  );
}
