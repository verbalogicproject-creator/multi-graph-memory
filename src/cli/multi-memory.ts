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
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
import type { LessonDomain, LessonStatus, MemoryEventKind } from "../core/types.ts";

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
  multi-memory episode list [--provider P] [--model M]
  multi-memory episode show <episodeId>
  multi-memory events [--kind K] [--episode ID] [--provider P] [--model M]
                      [--surface S] [--component C] [--since ISO] [--limit N] [--json]
  multi-memory attribution                                who produced what, by provider
  multi-memory docs generate [--dir <path>]
  multi-memory docs ingest <file>
  multi-memory graph export <file.html|file.json>       3D graph, or nodes+edges
  multi-memory sync export <file>
  multi-memory sync import <file>
  multi-memory backup <file.db>                         consistent copy, safe while running
  multi-memory builds [--older-than <days>]             clusters under MULTI_MEMORY_BUILDS
  multi-memory prune --older-than <days> [--apply]      dry run unless --apply
  multi-memory doctor

Pointing at a cluster (otherwise: the .multi-memory.json where you run):
  --build <id>              a build, resolved under MULTI_MEMORY_BUILDS
  --database <path>         an explicit .db file
  --workspace <name>        override the workspace

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

export interface OpenMemoryOptions {
  /**
   * Take the project id from the database's own contents when it holds exactly
   * one. Used when the caller named a FILE rather than a project, because the
   * filename is not evidence of what is inside it.
   */
  inferProjectId?: boolean;
}

export function openMemory(overrides: Partial<CliConfig> = {}, options: OpenMemoryOptions = {}): RunContext {
  let config = loadConfig(overrides);
  ensureClusterDir(config);
  const storage = new SqliteStorageAdapter({ path: config.databasePath });
  storage.open();

  if (options.inferProjectId) {
    const present = [...new Set(storage.distinctProjectIds())];
    // Exactly one, or leave the caller's guess alone: with several, picking one
    // would silently hide the others.
    if (present.length === 1 && present[0] !== config.projectId) {
      config = { ...config, projectId: present[0]! };
    }
  }

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
        const provider = flagString(args.flags, "provider");
        const model = flagString(args.flags, "model");
        const episodes = memory.listEpisodes().filter(
          (e) =>
            (provider === undefined || e.provider === provider) &&
            (model === undefined || e.model === model),
        );
        if (asJson) return out(episodes, true);
        if (episodes.length === 0) return "No episodes recorded.";
        return episodes
          .map((e) => {
            const by = e.provider === undefined && e.model === undefined
              ? "unattributed"
              : [e.provider, e.model].filter(Boolean).join("/");
            return `${(e.outcome ?? "open").padEnd(10)} ${e.openedAt}  ${e.id}\n           ${e.objective}\n           ${by}`;
          })
          .join("\n");
      }
      if (args.sub === "show") {
        const episode = memory.getEpisode(args.positional[1] ?? "");
        return episode ? out(episode, true) : "No such episode in this project.";
      }
      return "Usage: multi-memory episode list|show";
    }

    /**
     * The event journal, filterable by the schema-version-2 attribution.
     * Parity matters here: the same filters the host server can pass to
     * `queryEvents` are reachable by a human without writing code.
     */
    case "events": {
      const limit = Number(flagString(args.flags, "limit") ?? 40);
      const events = memory.queryEvents({
        ...(flagString(args.flags, "kind") === undefined
          ? {}
          : { kinds: [flagString(args.flags, "kind") as MemoryEventKind] }),
        ...(flagString(args.flags, "episode") === undefined ? {} : { episodeId: flagString(args.flags, "episode")! }),
        ...(flagString(args.flags, "provider") === undefined ? {} : { provider: flagString(args.flags, "provider")! }),
        ...(flagString(args.flags, "model") === undefined ? {} : { model: flagString(args.flags, "model")! }),
        ...(flagString(args.flags, "surface") === undefined ? {} : { surface: flagString(args.flags, "surface")! }),
        ...(flagString(args.flags, "component") === undefined ? {} : { component: flagString(args.flags, "component")! }),
        ...(flagString(args.flags, "since") === undefined ? {} : { since: flagString(args.flags, "since")! }),
        limit: Number.isFinite(limit) && limit > 0 ? limit : 40,
      });
      if (asJson) return out(events, true);
      if (events.length === 0) return "No events match.";
      return events
        .map((e) => {
          const by = [e.provider, e.model].filter(Boolean).join("/") || "unattributed";
          const where = e.surface ? ` ${e.surface}` : "";
          return `${e.occurredAt}  ${e.kind.padEnd(22)} ${by}${where}\n  ${e.id}`;
        })
        .join("\n");
    }

    /**
     * Who produced what.
     *
     * Event attribution and episode attribution are two INDEPENDENT axes, and the
     * report keeps them apart. An event records the model that served that one
     * call; an episode records the model that served the attempt as a whole. A
     * fallback chain can serve different steps of one episode from different
     * providers, so putting an events count and an outcome count in the same row
     * would imply a coverage relationship the data does not establish -- it would
     * read as "this producer did N things and M of them verified" when the N and
     * the M can come from entirely unrelated records.
     */
    case "attribution": {
      const nameOf = (provider?: string, model?: string) =>
        [provider, model].filter(Boolean).join("/") || "unattributed";

      const eventCounts = new Map<string, number>();
      for (const e of memory.queryEvents({})) {
        const key = nameOf(e.provider, e.model);
        eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
      }

      const outcomeCounts = new Map<string, { verified: number; failed: number; abandoned: number; open: number }>();
      for (const ep of memory.listEpisodes()) {
        const key = nameOf(ep.provider, ep.model);
        const slot = outcomeCounts.get(key) ?? { verified: 0, failed: 0, abandoned: 0, open: 0 };
        if (ep.outcome === "verified") slot.verified += 1;
        else if (ep.outcome === "failed") slot.failed += 1;
        else if (ep.outcome === "abandoned") slot.abandoned += 1;
        else slot.open += 1;
        outcomeCounts.set(key, slot);
      }

      const byEvents = [...eventCounts.entries()].sort((a, b) => b[1] - a[1]);
      const byEpisodes = [...outcomeCounts.entries()].sort(
        (a, b) => (b[1].verified + b[1].failed + b[1].abandoned + b[1].open)
          - (a[1].verified + a[1].failed + a[1].abandoned + a[1].open),
      );

      if (asJson) {
        return out(
          {
            byEventAttribution: byEvents.map(([producer, events]) => ({ producer, events })),
            byEpisodeAttribution: byEpisodes.map(([producer, counts]) => ({ producer, ...counts })),
            note: "Two independent axes. An event names the model that served one call; an episode names the model that served the attempt.",
          },
          true,
        );
      }
      if (byEvents.length === 0 && byEpisodes.length === 0) return "Nothing recorded yet.";

      const lines: string[] = [];
      lines.push("Events — the model that served each individual call");
      if (byEvents.length === 0) lines.push("  (none)");
      for (const [producer, count] of byEvents) {
        lines.push(`  ${producer.padEnd(34)} ${String(count).padStart(5)}`);
      }
      lines.push("", "Episodes — the model that served the attempt, and how it ended");
      if (byEpisodes.length === 0) lines.push("  (none)");
      else lines.push(`  ${"producer".padEnd(34)} verified  failed  abandoned  open`);
      for (const [producer, c] of byEpisodes) {
        lines.push(
          `  ${producer.padEnd(34)} ${String(c.verified).padStart(8)}  ${String(c.failed).padStart(6)}  ${String(c.abandoned).padStart(9)}  ${String(c.open).padStart(4)}`,
        );
      }
      lines.push(
        "",
        "Two independent axes: one episode can be served by several models, so the",
        "two tables do not sum to each other. Counts only — an outcome is what was",
        "observed, not a verdict on a provider.",
      );
      return lines.join("\n");
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

    /** A copy that is safe to take while the server holds the store open. */
    case "backup": {
      const file = args.positional[0];
      if (!file) return "Usage: multi-memory backup <file.db>";
      const target = resolve(file);
      context.storage.backupTo(target);
      const size = statSync(target).size;
      return [
        `wrote ${target}`,
        `  ${(size / 1024).toFixed(1)} KiB, consistent as of now`,
        "  Taken through the WAL, so unlike `cp` it is not a stale snapshot.",
      ].join("\n");
    }

    /**
     * The clusters on disk. A host that keeps one database per build accumulates
     * files nothing ever removes, and nothing else in this tool would tell you.
     */
    case "builds":
    case "prune": {
      const dir = process.env.MULTI_MEMORY_BUILDS ?? context.config.clusterDir;
      const olderThanDays = Number(flagString(args.flags, "older-than") ?? NaN);
      let entries: { name: string; path: string; sizeBytes: number; modified: string; ageDays: number }[];
      try {
        entries = readdirSync(dir)
          .filter((name) => name.endsWith(".db"))
          .map((name) => {
            const full = join(dir, name);
            const stat = statSync(full);
            return {
              name: name.replace(/\.db$/, ""),
              path: full,
              sizeBytes: stat.size,
              modified: stat.mtime.toISOString(),
              ageDays: (Date.now() - stat.mtimeMs) / 86_400_000,
            };
          })
          .sort((a, b) => a.ageDays - b.ageDays);
      } catch {
        return `No cluster directory at ${dir}. Set MULTI_MEMORY_BUILDS to where the databases live.`;
      }

      const matching = Number.isFinite(olderThanDays)
        ? entries.filter((e) => e.ageDays >= olderThanDays)
        : entries;

      if (args.command === "builds") {
        if (asJson) return out(matching, true);
        if (matching.length === 0) return `No databases in ${dir}.`;
        const total = matching.reduce((sum, e) => sum + e.sizeBytes, 0);
        return [
          dir,
          ...matching.map(
            (e) =>
              `  ${e.name.padEnd(30)} ${(e.sizeBytes / 1024).toFixed(0).padStart(7)} KiB  ${e.ageDays.toFixed(1).padStart(6)} days old`,
          ),
          `  ${String(matching.length).padStart(30)} database(s), ${(total / 1024 / 1024).toFixed(1)} MiB total`,
        ].join("\n");
      }

      // prune
      if (!Number.isFinite(olderThanDays)) {
        return "Usage: multi-memory prune --older-than <days> [--apply]\nRefusing to prune without an age: deleting memory needs an explicit boundary.";
      }
      if (matching.length === 0) return `Nothing older than ${olderThanDays} day(s) in ${dir}.`;

      const apply = args.flags["apply"] === true;
      if (!apply) {
        return [
          `Would remove ${matching.length} database(s) older than ${olderThanDays} day(s):`,
          ...matching.map((e) => `  ${e.name}  (${e.ageDays.toFixed(1)} days, ${(e.sizeBytes / 1024).toFixed(0)} KiB)`),
          "",
          "Dry run. Re-run with --apply to delete. Consider `backup` first — this is not reversible.",
        ].join("\n");
      }

      const removed: string[] = [];
      for (const entry of matching) {
        // The companions go too, or SQLite will later find a -wal with no database.
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            rmSync(`${entry.path}${suffix}`, { force: true });
          } catch { /* already gone */ }
        }
        removed.push(entry.name);
      }
      return `Removed ${removed.length} database(s): ${removed.join(", ")}`;
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
  ["5", "Who produced what", "attribution"],
  ["6", "Approve a lesson (human)", "lesson approve"],
  ["7", "Revoke a lesson (human)", "lesson revoke"],
  ["8", "Generate project documents", "docs generate"],
  ["9", "Doctor", "doctor"],
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

/**
 * Resolves `--build` / `--database` / `--workspace` into config overrides.
 *
 * Without these the only way to inspect a particular cluster was to create a
 * directory containing a `.multi-memory.json` and run from inside it -- which
 * made looking at a second build a file-editing exercise. A host that keeps one
 * database per build (multi-app does) makes that the common case, not the rare one.
 *
 * `--build <id>` resolves against `MULTI_MEMORY_BUILDS` when set, so a host can
 * name its cluster directory once and every later command is just the build id.
 */
export function overridesFromFlags(args: ParsedArgs): Partial<CliConfig> {
  const overrides: Partial<CliConfig> = {};

  const databasePath = flagString(args.flags, "database") ?? flagString(args.flags, "db");
  const build = flagString(args.flags, "build");
  const workspace = flagString(args.flags, "workspace");

  if (workspace) overrides.workspace = workspace;

  if (databasePath) {
    overrides.databasePath = resolve(databasePath);
    overrides.clusterDir = dirname(overrides.databasePath);
    if (!build) overrides.projectId = basename(overrides.databasePath).replace(/\.db$/i, "");
  }

  if (build) {
    overrides.projectId = build;
    if (!databasePath) {
      const dir = process.env.MULTI_MEMORY_BUILDS;
      if (dir) {
        overrides.clusterDir = resolve(dir);
        overrides.databasePath = join(resolve(dir), `${build}.db`);
      }
    }
  }

  return overrides;
}

/** How many sibling ids are worth printing before the list stops helping. */
const NEARBY_BUILDS = 8;

/**
 * Why a `--build` cannot be answered, or null when it can.
 *
 * Opening a SQLite database creates it, so a mistyped build id used to answer
 * "No episodes recorded" — indistinguishable from a run that genuinely recorded
 * nothing — and leave an empty file behind as a souvenir. A build id names
 * something that either exists or does not, and saying which is cheap.
 *
 * Only `--build` is guarded. `--database` names a file the caller chose, and
 * creating one is sometimes the point (importing a bundle into a new cluster).
 */
function unresolvableBuild(args: ParsedArgs, overrides: Partial<CliConfig>): string | null {
  const build = flagString(args.flags, "build");
  // Without a resolved per-build path, `--build` selects a project inside a shared
  // database, and "does this file exist" is not the question being asked.
  if (!build || !overrides.databasePath || existsSync(overrides.databasePath)) return null;

  const dir = overrides.clusterDir ?? dirname(overrides.databasePath);
  let nearby: string[] = [];
  try {
    nearby = readdirSync(dir)
      .filter((name) => name.endsWith(".db"))
      .map((name) => name.replace(/\.db$/, ""))
      .sort();
  } catch {
    return `No cluster directory at ${dir}. Set MULTI_MEMORY_BUILDS to where the databases live.`;
  }

  const lines = [`No database for build "${build}" in ${dir}.`];
  if (nearby.length === 0) {
    lines.push("That directory holds no databases at all.");
  } else {
    lines.push(`${nearby.length} there: ${nearby.slice(0, NEARBY_BUILDS).join(", ")}${
      nearby.length > NEARBY_BUILDS ? ", …" : ""
    }`);
    lines.push("`multi-memory builds` lists them with sizes and ages.");
  }
  return lines.join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const namedAFile = Boolean(flagString(args.flags, "database") ?? flagString(args.flags, "db"));
  const namedAProject = Boolean(flagString(args.flags, "build"));

  const overrides = overridesFromFlags(args);
  // Before opening anything: opening is what would create it.
  const unresolvable = unresolvableBuild(args, overrides);
  if (unresolvable) {
    console.error(unresolvable);
    return 1;
  }

  const context = openMemory(overrides, { inferProjectId: namedAFile && !namedAProject });

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
