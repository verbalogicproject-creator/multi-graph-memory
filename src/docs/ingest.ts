/**
 * Ingestion for AUTHORED documents ({project}-ARCHITECTURE.md, {project}-NOTES.md).
 *
 * These are human-owned evidence: the human is authoritative, and the database
 * indexes them. Generated projections are never ingested -- the database already
 * holds those records, so re-reading them would be a round trip through a lossy
 * format.
 *
 * A dedicated parser, not the parent engine's markdown chunker. That one only
 * flushes at a heading once 15 lines have accumulated, and re-uses the same
 * heading after a 70-line hard split, so a file of short entries collapses into
 * merged chunks with the wrong titles. Lessons and architecture notes are short
 * by nature, so per-section fidelity matters more than chunk size.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { sha256Hex } from "../core/canonical.ts";
import { currentEvidenceFor } from "../core/evidence.ts";
import { assertRedactionBoundary } from "../core/redaction.ts";
import { parseDocument } from "./frontmatter.ts";
import type { GraphMemory } from "../port.ts";
import type { Evidence } from "../core/types.ts";

export interface Section {
  level: number;
  title: string;
  /** Full heading path, e.g. ["Boundaries", "Dependency policy"]. */
  breadcrumb: string[];
  body: string;
  startLine: number;
  endLine: number;
}

/**
 * Splits on EVERY heading, preserving hierarchy. No minimum section length: a
 * one-line entry under its own heading stays its own section.
 */
export function parseSections(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];

  let current: Section | null = null;

  const flush = (endLine: number): void => {
    if (!current) return;
    current.body = current.body.replace(/\n+$/, "");
    current.endLine = endLine;
    if (current.body.trim().length > 0 || current.title !== "Preamble") sections.push(current);
    current = null;
  };

  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush(index);
      const level = heading[1]!.length;
      const title = heading[2]!.trim();

      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title });

      current = {
        level,
        title,
        breadcrumb: stack.map((entry) => entry.title),
        body: "",
        startLine: index + 1,
        endLine: index + 1,
      };
      return;
    }

    if (!current) {
      current = { level: 0, title: "Preamble", breadcrumb: [], body: "", startLine: index + 1, endLine: index + 1 };
    }
    current.body += `${line}\n`;
  });

  flush(lines.length);
  return sections;
}

export interface IngestResult {
  path: string;
  sections: number;
  evidence: Evidence[];
  skipped: string[];
  /**
   * What the ingest actually changed, per section. `unchanged` is the honest
   * answer for a re-run over an untouched file; `superseded` is the answer this
   * whole record type exists to be able to give, and until evidence carried a
   * digest in its identity it was unreachable -- an edit under an unchanged
   * heading returned the first-recorded row and reported success.
   */
  created: number;
  unchanged: number;
  superseded: number;
}

/**
 * Ingests one authored document as evidence, one record per section.
 *
 * Ruling 3: every section passes the persistence gate first, so an authored file
 * that happens to contain a credential is refused rather than indexed.
 */
export function ingestAuthoredDocument(memory: GraphMemory, path: string): IngestResult {
  const raw = readFileSync(path, "utf8");
  const parsed = parseDocument(raw);

  if (parsed.frontmatter) {
    return {
      path,
      sections: 0,
      evidence: [],
      skipped: ["this is a generated projection; the database already holds its records"],
      created: 0,
      unchanged: 0,
      superseded: 0,
    };
  }

  const file = basename(path);
  const sections = parseSections(raw);
  const evidence: Evidence[] = [];
  const skipped: string[] = [];
  let created = 0;
  let unchanged = 0;
  let superseded = 0;

  // One read of the project's evidence, resolved per section against that
  // snapshot. Reading per section would be O(sections x records) for a result
  // that cannot change mid-ingest.
  const known = memory.listEvidence();

  for (const section of sections) {
    if (section.body.trim().length === 0) continue;

    const content = `${section.breadcrumb.join(" > ")}\n\n${section.body}`;
    try {
      assertRedactionBoundary({ content }, "persistence", { maxBytes: 256 * 1024 });
    } catch (error) {
      skipped.push(`${file}#${section.title}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const kind = "authored.document";
    // A stable ref: the same file and heading path always names the same claim.
    // The *identity* of the record additionally folds in the digest, so an edit
    // under an unchanged heading is a new record that supersedes the old one
    // rather than a lookup that silently returns it.
    const ref = `doc://${file}#${section.breadcrumb.join("/") || section.title}`;
    const digest = sha256Hex(content);
    const previous = currentEvidenceFor(known, kind, ref);
    const isRevision = previous !== null && previous.digest !== digest;

    const record = memory.recordEvidence({
      kind,
      ref,
      digest,
      summary: `${section.breadcrumb.join(" > ")} (lines ${section.startLine}-${section.endLine})`,
      ...(isRevision ? { supersedesEvidenceId: previous.id } : {}),
    });

    if (isRevision) superseded += 1;
    else if (previous !== null) unchanged += 1;
    else created += 1;

    known.push(record);
    evidence.push(record);
  }

  return { path, sections: sections.length, evidence, skipped, created, unchanged, superseded };
}
