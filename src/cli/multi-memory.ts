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
import { exportGraphHtml, exportGraphJson } from "../visualization/index.ts";
import { ingestAuthoredDocument } from "../docs/ingest.ts";
import { ControlStore } from "../control/registry.ts";
import { federatedQuery } from "../control/federation.ts";
import { ensureClusterDir, loadConfig, type CliConfig } from "./config.ts";
import { flagList, flagString, parseArgs, type ParsedArgs } from "./args.ts";
import type { LessonDomain, LessonStatus } from "../core/types.ts";

export const HELP = `
multi-memory — governed episodic and lesson memory

  multi-memory                              interactive session
  multi-memory project status
  multi-memory project register                          add this cluster to the control tier
  multi-memory admit --workspace W --by NAME --purpose T [--projects a,b]
  multi-memory ask "<question>" [scope] [--component X] [--bug TAG] [--domain D] [--json]
  multi-memory lesson list [--status S] [--domain D]
  multi-memory lesson show <lessonId>
  multi-memory lesson approve <lessonId> --by <name>      (human only)
  multi-memory lesson revoke  <lessonId> --reason <text>  (human only)
  multi-memory episode list
  multi-memory episode show <episodeId>
  multi-memory docs generate [--dir <path>]
  multi-memory docs ingest <file>
  multi-memory graph export <file.html|file.json>       3D graph, or nodes+edges
  multi-memory sync export <file>
  multi-memory sync import <file>
  multi-memory doctor

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
  /** Layer 2. Opened lazily so a purely local command never creates it. */
  openControl(): ControlStore;
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

  let control: ControlStore | null = null;
  return {
    config,
    memory,
    storage,
    openControl(): ControlStore {
      if (!control) {
        control = new ControlStore(config.controlDatabasePath);
        control.open();
      }
      return control;
    },
  };
}

function out(value: unknown, asJson: boolean): string {
  return asJson ? JSON.stringify(value, null, 2) : String(value);
}

/** Executes one command and returns what should be printed. Pure of process.exit. */
export async function runCommand(args: ParsedArgs, context: RunContext): Promise<string> {
  const { memory } = context;
  const asJson = args.flags.json === true;

  if (args.scope.kind === "workspace") {
    const task = args.positional.join(" ").trim();
    if (args.command !== "ask" || !task) {
      return "Cross-workspace scope applies to `ask`. Usage: multi-memory ask \"<question>\" @workspace:<name>";
    }
    const result = await federatedQuery(context.openControl(), args.scope.name ?? "", { task });
    if (asJson) return out(result, true);

    const lines = [
      `Federated read across workspace "${args.scope.name}"`,
      `  admitted by ${result.admission.approvedBy} — ${result.admission.purpose}`,
      `  consulted: ${result.consulted.join(", ") || "none"}`,
    ];
    for (const skipped of result.refused) lines.push(`  skipped ${skipped.projectId}: ${skipped.reason}`);
    for (const entry of result.packets) {
      lines.push("", `--- ${entry.projectId} ---`, renderPacket(entry.packet));
    }
    return lines.join("\n");
  }

  if (args.scope.kind === "global") {
    const control = context.openControl();
    const generalized = control.listGeneralizedLessons();
    const projects = control.listProjects();
    if (asJson) return out({ projects, generalized, admissions: control.listAdmissions() }, true);

    const lines = [
      `Control tier — ${context.config.controlDatabasePath}`,
      `  registered projects: ${projects.length}`,
      `  generalized lessons: ${generalized.length}`,
      `  admissions:          ${control.listAdmissions().length}`,
      "",
      "The control tier holds de-identified generalized lessons and pointers only.",
      "Project content never moves here.",
    ];
    for (const lesson of generalized) {
      lines.push("", `  ${lesson.trigger}`, `    ${lesson.recommendation}`,
        `    projects: ${lesson.sourceProjects.join(", ")} · approved by ${lesson.approvedBy}`);
    }
    return lines.join("\n");
  }

  switch (args.command) {
    case "":
    case "help":
      return HELP;

    case "admit": {
      const workspace = flagString(args.flags, "workspace");
      const by = flagString(args.flags, "by");
      const purpose = flagString(args.flags, "purpose");
      if (!workspace || !by || !purpose) {
        return "Usage: multi-memory admit --workspace <name> --by <approver> --purpose <text> [--projects a,b]";
      }
      const admission = {
        approvedBy: by,
        purpose,
        allowedWorkspaces: [workspace],
        ...(flagList(args.flags, "projects") === undefined ? {} : { allowedProjects: flagList(args.flags, "projects")! }),
        admittedAt: new Date().toISOString(),
      };
      context.openControl().putAdmission(workspace, admission);
      return [
        `Recorded a federation admission for workspace "${workspace}".`,
        `  approver ${by}`,
        `  purpose  ${purpose}`,
        admission.allowedProjects ? `  projects ${admission.allowedProjects.join(", ")}` : "  projects (all in workspace)",
        "",
        "This is retrieval policy and provenance. It grants no authority.",
      ].join("\n");
    }

    case "project": {
      if (args.sub === "register") {
        context.openControl().registerProject({
          projectId: memory.scope.projectId,
          workspace: memory.scope.workspace,
          databasePath: context.config.databasePath,
          schemaVersion: context.storage.getSchemaVersion(),
          registeredAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });
        return `Registered ${memory.scope.workspace}/${memory.scope.projectId} in the control tier.\n  pointer only — no project content is copied.`;
      }
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
      if (!task) return "Usage: multi-memory ask \"<question>\"";

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
          return "Usage: multi-memory lesson list|show|approve|revoke";
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
      return "Usage: multi-memory episode list|show";
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
        if (!file) return "Usage: multi-memory docs ingest <file>";
        const result = ingestAuthoredDocument(memory, file);
        const lines = [`ingested ${result.evidence.length} section(s) from ${result.path}`];
        for (const skip of result.skipped) lines.push(`skipped  ${skip}`);
        return lines.join("\n");
      }
      return "Usage: multi-memory docs generate|ingest";
    }

    case "graph": {
      const file = args.positional[1];
      if (args.sub === "export") {
        if (!file) return "Usage: multi-memory graph export <file.html|file.json>";
        const asJson = file.endsWith(".json");
        const projection = asJson
          ? exportGraphJson(memory, file)
          : exportGraphHtml(memory, file);
        const { episodes, lessons, evidence, edges } = projection.counts;
        return [
          `wrote ${file}`,
          `  ${episodes} episode(s) · ${lessons} lesson(s) · ${evidence} evidence · ${edges} edge(s)`,
          asJson ? "  nodes and edges as JSON" : "  open it in a browser; it is one self-contained file",
        ].join("\n");
      }
      return "Usage: multi-memory graph export <file.html|file.json>";
    }

    case "sync": {
      const file = args.positional[1];
      if (args.sub === "export") {
        if (!file) return "Usage: multi-memory sync export <file>";
        const bundle = memory.export();
        writeFileSync(file, JSON.stringify(bundle, null, 2), "utf8");
        return `Exported project "${memory.scope.projectId}" to ${file}\n  checksum ${bundle.checksum}`;
      }
      if (args.sub === "import") {
        if (!file) return "Usage: multi-memory sync import <file>";
        const result = memory.import(readFileSync(file, "utf8"));
        return [
          `Imported into "${result.projectId}"`,
          `  events ${result.imported.events}, episodes ${result.imported.episodes},`,
          `  lessons ${result.imported.lessons}, evidence ${result.imported.evidence}`,
          `  duplicates skipped: ${result.skippedDuplicates}`,
        ].join("\n");
      }
      return "Usage: multi-memory sync export|import <file>";
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
        stuck.length > 0 ? `\nApprove with: multi-memory lesson approve <id> --by <name>` : "",
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
  console.log(`\nmulti-memory — ${context.memory.scope.workspace}/${context.memory.scope.projectId}`);
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
