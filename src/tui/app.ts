/**
 * The terminal surface: health, browse, ask, act.
 *
 * Two rules shape every line of this file.
 *
 * **One command path.** Every action a pane takes goes through `runCommand` --
 * the same function a headless `multi-memory ask ...` calls -- rather than
 * reaching into the engine itself. The numbered-menu session this replaces
 * already worked that way, and it is what stops the TUI and the CLI drifting
 * into two tools that disagree about what the memory says.
 *
 * **Every pane says why it is empty.** A blank list means "no lessons are
 * qualified", or "no structure graph is built", or "this asked and nothing
 * matched" -- three different facts that a blank list renders identically. That
 * conflation is the defect this whole plan exists to remove, so it is not
 * allowed to reappear in the surface built to expose it.
 *
 * Sized for a phone. The device this runs on reports 80x24 only because the
 * shell has no controlling TTY; a real Termux window in portrait is commonly 40
 * to 55 columns, so the layout stacks and never assumes side-by-side.
 *
 * blessed is an *optional* dependency, loaded dynamically, so the package still
 * installs and every other surface still works without it -- the same seam
 * `@google/genai` and `sqlite-vec` already use, and the reason `verify:pure`
 * stays meaningful.
 */

import { parseArgs } from "../cli/args.ts";
import type { RunContext } from "../cli/multi-memory.ts";
import { projectGraph, type StrataOptions } from "../visualization/exporter.ts";
import { SqliteStructureIndex } from "../structure/read.ts";
import {
  heartbeatRow,
  integrityRow,
  overallVerdict,
  readNewestReceipt,
  strataRows,
  type HealthRow,
  type Verdict,
} from "./health.ts";

export const PANES = ["health", "browse", "ask", "act"] as const;
export type Pane = (typeof PANES)[number];

const VERDICT_COLOR: Record<Verdict, string> = {
  ok: "green",
  warn: "yellow",
  bad: "red",
  unknown: "grey",
};

const VERDICT_MARK: Record<Verdict, string> = {
  ok: "✔",
  warn: "!",
  bad: "✖",
  unknown: "?",
};

export interface TuiOptions {
  readonly context: RunContext;
  readonly strata?: StrataOptions;
  /** The portfolio brain, for the delivery heartbeat. */
  readonly portfolioDb?: string;
  /** Used by the tests; the real entry point resolves this itself. */
  readonly runCommand: (line: string) => Promise<string>;
}

/** The health pane's contents, gathered without touching the terminal. */
export function gatherHealth(options: TuiOptions): HealthRow[] {
  const rows: HealthRow[] = [];

  rows.push(
    heartbeatRow(options.portfolioDb ? readNewestReceipt(options.portfolioDb) : null),
  );

  const projection = projectGraph(options.context.memory, undefined, options.strata ?? {});
  rows.push(...strataRows(projection.strata));

  let integrity = null;
  if (options.strata?.structureDb) {
    const index = SqliteStructureIndex.open(options.strata.structureDb);
    if (index) {
      try {
        integrity = index.checkIntegrity();
      } finally {
        index.close();
      }
    }
  }
  rows.push(integrityRow(integrity));

  return rows;
}

export function renderHealth(rows: readonly HealthRow[], width: number): string {
  const lines: string[] = [];
  for (const row of rows) {
    const colour = VERDICT_COLOR[row.verdict];
    lines.push(
      `{${colour}-fg}${VERDICT_MARK[row.verdict]}{/} {bold}${row.label}{/bold}  ${row.value}`,
    );
    // The reason, wrapped by hand: blessed's own wrapping does not know about
    // the tag markup above, and a phone in portrait has no room to lose.
    for (const chunk of wrap(row.detail, Math.max(20, width - 4))) {
      lines.push(`  {grey-fg}${chunk}{/}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Greedy word wrap. Long tokens are broken rather than allowed to overflow. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > width) {
      if (line) {
        out.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * What a pane shows when it has nothing.
 *
 * Never the empty string. The whole point of this surface is that "nothing
 * matched", "nothing is built" and "nothing ran" stop looking the same.
 */
export function emptyState(pane: Pane, reason: string): string {
  return `{yellow-fg}nothing to show{/}\n\n${wrap(reason, 44).join("\n")}`;
}

export interface LoadedBlessed {
  blessed: typeof import("blessed");
}

/** Load the optional terminal library, or explain precisely what to install. */
export async function loadBlessed(): Promise<LoadedBlessed> {
  try {
    const blessed = (await import("blessed")).default as typeof import("blessed");
    return { blessed };
  } catch (error) {
    throw new Error(
      "the terminal UI needs `blessed`, which is an optional dependency and is not installed. " +
        "Install it with: npm install blessed@npm:neo-blessed blessed-contrib --save-optional " +
        "(the alias matters: blessed-contrib does a bare require('blessed'), and neo-blessed is " +
        "the maintained fork). Every other surface works without it. " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
