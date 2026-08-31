/**
 * The human surface.
 *
 * Ruling 9: this is the ONLY place lesson approval and revocation are reachable.
 * They are absent from the MCP server and from ModelContextPort by construction,
 * so the human-approval gate is enforced by topology rather than by instruction.
 *
 * One code path, two modes: no arguments opens the interactive session; with
 * arguments it runs headless and speaks `--json` for scripting.
 */

import readline from "node:readline/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { SqliteStorageAdapter } from "../adapters/sqlite.ts";
import { GraphMemory } from "../port.ts";
import { renderPacket } from "../core/packet.ts";
import { isGraphMemoryError } from "../core/errors.ts";
import { projectDocuments } from "../docs/projector.ts";
import { ingestAuthoredDocument } from "../docs/ingest.ts";
import { ensureClusterDir, loadConfig, type CliConfig } from "./config.ts";
import { flagList, flagString, parseArgs, type ParsedArgs } from "./args.ts";
import type { LessonDomain, LessonStatus } from "../core/types.ts";

export const HELP = `
fractal-memory — governed episodic and lesson memory

  fractal-memory                              interactive session
  fractal-memory project status
  fractal-memory ask "<question>" [scope] [--component X] [--bug TAG] [--domain D] [--json]
  fractal-memory lesson list [--status S] [--domain D]
  fractal-memory lesson show <lessonId>
  fractal-memory lesson approve <lessonId> --by <name>      (human only)
  fractal-memory lesson revoke  <lessonId> --reason <text>  (human only)
  fractal-memory episode list
  fractal-memory episode show <episodeId>
  fractal-memory docs generate [--dir <path>]
  fractal-memory docs ingest <file>
  fractal-memory sync export <file>
  fractal-memory sync import <file>
  fractal-memory doctor

Scope vocabulary:
  @local | @current            the active project (default)
  @workspace:<name>            another workspace; requires a federation admission record
  @global | @cross-project     the control tier

Approval and revocation exist only here. They are not exposed over MCP and not
reachable from any model-facing surface.
`.trim();

export interface RunContext {
  config: CliConfig;
  memory: GraphMemory;
  storage: SqliteStorageAdapter;
}

export function openMemory(overrides: Partial<CliConfig> = {}): RunContext {
  const config = loadConfig(overrides);
  ensureClusterDir(config);
  const storage = new SqliteStorageAdapter({ path: config.databasePath });
  storage.open();
  const memory = new GraphMemory({
    storage,
    scope: { workspace: config.workspace, projectId: config.projectId },
  });
  return { config, memory, storage };
}

function out(value: unknown, asJson: boolean): string {
  return asJson ? JSON.stringify(value, null, 2) : String(value);
}

/** Executes one command and returns what should be printed. Pure of process.exit. */
export async function runCommand(args: ParsedArgs, context: RunContext): Promise<string> {
  const { memory } = context;
  const asJson = args.flags.json === true;

  if (args.scope.kind === "workspace") {
    return "Cross-workspace reads require a federation admission record (approver, purpose, allowed workspaces). Record one with `fractal-memory admit`, which is not yet available in this build.";
  }
  if (args.scope.kind === "global") {
    return "The control tier is addressed with @global. It holds only de-identified generalized lessons and pointers; project content never moves there.";
  }

  switch (args.command) {
    case "":
    case "help":
      return HELP;

    case "project": {
      const counts = {
        events: memory.queryEvents().length,
        episodes: memory.listEpisodes().length,
        lessons: memory.listLessons().length,
        evidence: memory.listEvidence().length,
      };
      const status = { scope: memory.scope, database: context.config.databasePath, counts, authority: "context_only" };
      return asJson
        ? out(status, true)
        : [
            `project    ${memory.scope.workspace}/${memory.scope.projectId}`,
            `database   ${context.config.databasePath}`,
            `events     ${counts.events}`,
            `episodes   ${counts.episodes}`,
            `lessons    ${counts.lessons}`,
            `evidence   ${counts.evidence}`,
            `authority  context_only — memory grants no filesystem, dependency, model,`,
            `           network, revision or deployment authority.`,
          ].join("\n");
    }

    case "ask": {
      const task = args.positional.join(" ").trim();
      if (!task) return "Usage: fractal-memory ask \"<question>\"";

      const packet = await memory.queryContext({
        task,
        ...(flagString(args.flags, "component") === undefined ? {} : { component: flagString(args.flags, "component")! }),
        ...(flagString(args.flags, "domain") === undefined ? {} : { domain: flagString(args.flags, "domain") as LessonDomain }),
        ...(flagList(args.flags, "bug") === undefined ? {} : { triggerTags: flagList(args.flags, "bug")! }),
        ...(args.flags["direction"] === true ? { directionGeneration: true } : {}),
      });
      return asJson ? out(packet, true) : renderPacket(packet);
    }

    case "lesson": {
      switch (args.sub) {
        case "list": {
          const lessons = memory.listLessons({
            ...(flagString(args.flags, "status") === undefined
              ? {}
              : { statuses: [flagString(args.flags, "status") as LessonStatus] }),
            ...(flagString(args.flags, "domain") === undefined
              ? {}
              : { domain: flagString(args.flags, "domain") as LessonDomain }),
          });
          if (asJson) return out(lessons, true);
          if (lessons.length === 0) return "No lessons recorded.";
          return lessons
            .map((l) => `${l.status.padEnd(12)} ${l.domain.padEnd(12)} reuse=${l.reuseCount} ${l.id}\n             ${l.trigger}`)
            .join("\n");
        }

        case "show": {
          const lesson = memory.getLesson(args.positional[1] ?? "");
          if (!lesson) return "No such lesson in this project.";
          return out(lesson, true);
        }

        case "approve": {
          const id = args.positional[1] ?? "";
          const by = flagString(args.flags, "by");
          if (!by) return "Approval requires a named human approver: --by <name>";
          const lesson = memory.approveLesson(id, by);
          return `Approved ${lesson.id} — ${lesson.trigger}\n  by ${lesson.approvedBy} at ${lesson.approvedByHumanAt}`;
        }

        case "revoke": {
          const id = args.positional[1] ?? "";
          const reason = flagString(args.flags, "reason");
          if (!reason) return "Revocation requires a reason: --reason <text>";
          const lesson = memory.revokeLesson(id, reason);
          return `Revoked ${lesson.id} — ${lesson.revokedReason}\n  History retained: reuse=${lesson.reuseCount}, contradictions=${lesson.contradictionIds.length}`;
        }

        default:
          return "Usage: fractal-memory lesson list|show|approve|revoke";
      }
    }

    case "episode": {
      if (args.sub === "list") {
        const episodes = memory.listEpisodes();
        if (asJson) return out(episodes, true);
        if (episodes.length === 0) return "No episodes recorded.";
        return episodes
          .map((e) => `${(e.outcome ?? "open").padEnd(10)} ${e.openedAt}  ${e.id}\n           ${e.objective}`)
          .join("\n");
      }
      if (args.sub === "show") {
        const episode = memory.getEpisode(args.positional[1] ?? "");
        return episode ? out(episode, true) : "No such episode in this project.";
      }
      return "Usage: fractal-memory episode list|show";
    }

    case "docs": {
      if (args.sub === "generate") {
        const dir = flagString(args.flags, "dir") ?? context.config.clusterDir;
        const result = projectDocuments(memory, dir);
        const lines = result.written.map((p) => `wrote    ${p}`);
        for (const refusal of result.refused) lines.push(`REFUSED  ${refusal.path}\n         ${refusal.reason}`);
        return lines.join("\n") || "Nothing to write.";
      }
      if (args.sub === "ingest") {
        const file = args.positional[1];
        if (!file) return "Usage: fractal-memory docs ingest <file>";
        const result = ingestAuthoredDocument(memory, file);
        const lines = [`ingested ${result.evidence.length} section(s) from ${result.path}`];
        for (const skip of result.skipped) lines.push(`skipped  ${skip}`);
        return lines.join("\n");
      }
      return "Usage: fractal-memory docs generate|ingest";
    }

    case "sync": {
      const file = args.positional[1];
      if (args.sub === "export") {
        if (!file) return "Usage: fractal-memory sync export <file>";
        const bundle = memory.export();
        writeFileSync(file, JSON.stringify(bundle, null, 2), "utf8");
        return `Exported project "${memory.scope.projectId}" to ${file}\n  checksum ${bundle.checksum}`;
      }
      if (args.sub === "import") {
        if (!file) return "Usage: fractal-memory sync import <file>";
        const result = memory.import(readFileSync(file, "utf8"));
        return [
          `Imported into "${result.projectId}"`,
          `  events ${result.imported.events}, episodes ${result.imported.episodes},`,
          `  lessons ${result.imported.lessons}, evidence ${result.imported.evidence}`,
          `  duplicates skipped: ${result.skippedDuplicates}`,
        ].join("\n");
      }
      return "Usage: fractal-memory sync export|import <file>";
    }

    case "doctor": {
      const lessons = memory.listLessons();
      const contradicted = lessons.filter((l) => l.status === "contradicted");
      const stuck = lessons.filter((l) => l.status === "qualified" && !l.approvedByHumanAt);
      return [
        `database        ${context.config.databasePath}`,
        `schema version  ${context.storage.getSchemaVersion()}`,
        `lessons         ${lessons.length}`,
        `awaiting human  ${stuck.length} qualified lesson(s) need approval`,
        `contradicted    ${contradicted.length}`,
        stuck.length > 0 ? `\nApprove with: fractal-memory lesson approve <id> --by <name>` : "",
      ].filter(Boolean).join("\n");
    }

    default:
      return `Unknown command "${args.command}".\n\n${HELP}`;
  }
}

const MENU = [
  ["1", "Project status", "project"],
  ["2", "Ask memory a question", "ask"],
  ["3", "List lessons", "lesson list"],
  ["4", "List episodes", "episode list"],
  ["5", "Approve a lesson (human)", "lesson approve"],
  ["6", "Revoke a lesson (human)", "lesson revoke"],
  ["7", "Generate project documents", "docs generate"],
  ["8", "Doctor", "doctor"],
  ["q", "Quit", ""],
] as const;

/** Interactive session. Mutations always confirm before acting. */
export async function interactive(context: RunContext): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nfractal-memory — ${context.memory.scope.workspace}/${context.memory.scope.projectId}`);
  console.log("Approval and revocation are available here and nowhere else.\n");

  try {
    for (;;) {
      for (const [key, label] of MENU) console.log(`  ${key}. ${label}`);
      const choice = (await rl.question("\nSelect: ")).trim().toLowerCase();
      if (choice === "q" || choice === "") break;

      const entry = MENU.find(([key]) => key === choice);
      if (!entry) {
        console.log("Unrecognised choice.\n");
        continue;
      }

      try {
        let line: string = entry[2];
        if (line === "ask") {
          line = `ask ${await rl.question("Question: ")}`;
        } else if (line === "lesson approve") {
          const id = await rl.question("Lesson id: ");
          const by = await rl.question("Approver name: ");
          const confirm = await rl.question(`Approve ${id} as persistent guidance? [y/N] `);
          if (confirm.trim().toLowerCase() !== "y") {
            console.log("Cancelled.\n");
            continue;
          }
          line = `lesson approve ${id} --by ${by}`;
        } else if (line === "lesson revoke") {
          const id = await rl.question("Lesson id: ");
          const reason = await rl.question("Reason: ");
          const confirm = await rl.question(`Revoke ${id}? [y/N] `);
          if (confirm.trim().toLowerCase() !== "y") {
            console.log("Cancelled.\n");
            continue;
          }
          line = `lesson revoke ${id} --reason=${reason}`;
        }
        console.log(`\n${await runCommand(parseArgs(line.split(" ").filter(Boolean)), context)}\n`);
      } catch (error) {
        console.log(`\n${formatError(error)}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

export function formatError(error: unknown): string {
  if (isGraphMemoryError(error)) return `Refused [${error.code}]: ${error.message}`;
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const context = openMemory();

  try {
    if (argv.length === 0) {
      await interactive(context);
      return 0;
    }
    console.log(await runCommand(args, context));
    return 0;
  } catch (error) {
    console.error(formatError(error));
    return 1;
  } finally {
    context.storage.close();
  }
}
