/**
 * The half of a session that git cannot see.
 *
 * `harvest.ts` reads commits: what was fixed, and the receipt it left. That is
 * the outcome. It is silent about the process — the attempt that errored four
 * times before it worked, the path abandoned without a commit, the moment a
 * human stopped the work because it was going wrong. None of that reaches a
 * repository, and all of it is the most direct evidence a learning loop has.
 *
 * Claude Code already records it. Measured across this project's transcripts:
 *
 *     14 sessions · 57,493 lines · 7,404 tool uses
 *     163 tool errors, every one attributable to its call (tool_use_id, 163/163)
 *     16 human interrupts
 *     server.js touched 67 times by a tool, against 26 fix commits
 *
 * So the transcripts see roughly two and a half times the activity the commit
 * history does, and they carry the failures. Nothing new needs to be logged;
 * this reads what is already on disk.
 *
 * **No model decides anything here.** An error is detected by `is_error` on a
 * tool result, an interrupt by the presence of `interruptedMessageId`, a target
 * by the tool's own declared input. All three are structural facts, and the
 * module refuses to interpret them further — see `FrictionPoint`'s limits.
 *
 * Pure by construction: it takes lines and returns records. Reading the files
 * belongs to the caller, which keeps every rule here inside `node --test`.
 */

import { componentFor } from "./harvest.ts";

export interface ToolError {
  readonly tool: string;
  /** The file path or the head of the command the failing call named. */
  readonly target: string | null;
  /** First line of the failure, bounded. Enough to group, never enough to leak a file. */
  readonly summary: string;
}

export interface TranscriptSession {
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly toolUses: Readonly<Record<string, number>>;
  readonly errors: readonly ToolError[];
  /** A human stopped the run. The strongest signal in the file, and the rarest. */
  readonly interrupts: number;
  /** Absolute paths a write-capable tool named, and how often. */
  readonly touched: Readonly<Record<string, number>>;
}

/** Tools that change a file. A Read is attention, not work. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit"]);

const MAX_SUMMARY = 160;
const MAX_TARGET = 120;

function firstLine(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value
            .map((part) =>
              part && typeof part === "object" && "text" in (part as Record<string, unknown>)
                ? String((part as Record<string, unknown>)["text"])
                : "",
            )
            .join(" ")
        : String(value ?? "");
  return text.split("\n").find((line) => line.trim().length > 0)?.trim().slice(0, MAX_SUMMARY) ?? "";
}

/**
 * Parses one transcript.
 *
 * Malformed lines are skipped rather than thrown on: a transcript is an append-
 * only log written by a live process, so a truncated final line is normal and
 * refusing the whole file over it would discard a session's evidence to report a
 * defect that is not one.
 */
export function parseTranscript(lines: Iterable<string>): TranscriptSession {
  const uses = new Map<string, { tool: string; target: string | null }>();
  const toolUses: Record<string, number> = {};
  const touched: Record<string, number> = {};
  const errors: ToolError[] = [];
  let interrupts = 0;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    sessionId ??= typeof entry["sessionId"] === "string" ? entry["sessionId"] : null;
    cwd ??= typeof entry["cwd"] === "string" ? entry["cwd"] : null;
    gitBranch ??= typeof entry["gitBranch"] === "string" ? entry["gitBranch"] : null;
    const stamp = typeof entry["timestamp"] === "string" ? entry["timestamp"] : null;
    if (stamp !== null) {
      if (startedAt === null || stamp < startedAt) startedAt = stamp;
      if (endedAt === null || stamp > endedAt) endedAt = stamp;
    }
    if (entry["interruptedMessageId"]) interrupts += 1;

    const message = entry["message"];
    if (!message || typeof message !== "object") continue;
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;

    for (const raw of content) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;

      if (block["type"] === "tool_use") {
        const tool = typeof block["name"] === "string" ? block["name"] : "(unnamed)";
        toolUses[tool] = (toolUses[tool] ?? 0) + 1;
        const input = (block["input"] ?? {}) as Record<string, unknown>;
        const path = typeof input["file_path"] === "string" ? input["file_path"] : null;
        const command = typeof input["command"] === "string" ? input["command"] : null;
        const target = path ?? (command ? command.slice(0, MAX_TARGET) : null);
        if (typeof block["id"] === "string") uses.set(block["id"], { tool, target });
        if (path && WRITING_TOOLS.has(tool)) touched[path] = (touched[path] ?? 0) + 1;
      } else if (block["type"] === "tool_result" && block["is_error"]) {
        const id = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "";
        const call = uses.get(id);
        errors.push({
          tool: call?.tool ?? "(unattributed)",
          target: call?.target ?? null,
          summary: firstLine(block["content"]),
        });
      }
    }
  }

  return { sessionId, cwd, gitBranch, startedAt, endedAt, toolUses, errors, interrupts, touched };
}

export interface FrictionPoint {
  readonly component: string;
  readonly path: string;
  /** Times a writing tool named this file. */
  readonly edits: number;
  /** Sessions in which it was touched at all. */
  readonly sessions: number;
}

export interface FrictionOptions {
  /** Absolute prefix that marks a path as belonging to this repo. */
  readonly repoRoot: string;
  readonly repo: string;
  /** Minimum edits before a file counts. Default 5. */
  readonly minEdits?: number;
}

/**
 * Files this estate actually spends its editing effort on.
 *
 * Scoped to one repository by path prefix, because a session freely edits plan
 * files, notes and sibling repositories, and counting those here would rank a
 * scratch directory above the code.
 */
export function frictionPoints(
  sessions: readonly TranscriptSession[],
  options: FrictionOptions,
): FrictionPoint[] {
  const minEdits = options.minEdits ?? 5;
  const prefix = options.repoRoot.endsWith("/") ? options.repoRoot : `${options.repoRoot}/`;

  const edits = new Map<string, number>();
  const seenIn = new Map<string, number>();
  for (const session of sessions) {
    for (const [path, count] of Object.entries(session.touched)) {
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      edits.set(relative, (edits.get(relative) ?? 0) + count);
      seenIn.set(relative, (seenIn.get(relative) ?? 0) + 1);
    }
  }

  return [...edits.entries()]
    .filter(([, count]) => count >= minEdits)
    .map(([path, count]) => ({
      component: componentFor(options.repo, path),
      path,
      edits: count,
      sessions: seenIn.get(path) ?? 1,
    }))
    .sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));
}

export interface SessionFriction {
  readonly sessions: number;
  readonly toolUses: number;
  readonly errors: number;
  readonly interrupts: number;
  /** Error counts by tool, which is how a systemic failure shows itself. */
  readonly errorsByTool: Readonly<Record<string, number>>;
  /**
   * Commands that failed more than once with the same head. A retry loop is the
   * clearest evidence a session has of something being genuinely hard, and it
   * never reaches a commit.
   */
  readonly repeatedFailures: readonly { readonly target: string; readonly count: number }[];
  readonly hotFiles: readonly FrictionPoint[];
  readonly limits: readonly string[];
  readonly note: string;
}

export function summariseFriction(
  sessions: readonly TranscriptSession[],
  options: FrictionOptions,
): SessionFriction {
  const errorsByTool: Record<string, number> = {};
  const byTarget = new Map<string, number>();
  let toolUses = 0;
  let errors = 0;
  let interrupts = 0;

  for (const session of sessions) {
    interrupts += session.interrupts;
    for (const count of Object.values(session.toolUses)) toolUses += count;
    for (const error of session.errors) {
      errors += 1;
      errorsByTool[error.tool] = (errorsByTool[error.tool] ?? 0) + 1;
      if (error.target) byTarget.set(error.target, (byTarget.get(error.target) ?? 0) + 1);
    }
  }

  const repeatedFailures = [...byTarget.entries()]
    .filter(([, count]) => count > 1)
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
    .slice(0, 20);

  const hotFiles = frictionPoints(sessions, options);

  return {
    sessions: sessions.length,
    toolUses,
    errors,
    interrupts,
    errorsByTool,
    repeatedFailures,
    hotFiles,
    limits: [
      "A tool error is not a defect. Many are deliberate probes — checking that a command fails, that a guard refuses, that a port is closed — and this module cannot tell those from real failures without a model.",
      "An interrupt means a human stopped the run. It is the strongest signal here and the least specific: it says the direction was wrong, not what was wrong with it.",
      "Edits are counted per tool call, so one file rewritten in five passes outranks one rewritten once, regardless of how much changed.",
    ],
    note:
      sessions.length === 0
        ? "No transcripts in range — nothing to read, which is different from nothing having happened."
        : `${sessions.length} session(s), ${errors} tool error(s), ${interrupts} interrupt(s).`,
  };
}
