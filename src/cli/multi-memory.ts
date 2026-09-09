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
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SqliteStorageAdapter } from "../adapters/sqlite.ts";
import { GraphMemory } from "../port.ts";
import { renderPacket } from "../core/packet.ts";
import { isGraphMemoryError } from "../core/errors.ts";
import { projectDocuments } from "../docs/projector.ts";
import { exportGraphHtml, exportGraphJson, type StrataOptions } from "../visualization/index.ts";
import { startServe, DEFAULT_HOST, DEFAULT_PORT } from "../serve/index.ts";
import { ingestAuthoredDocument } from "../docs/ingest.ts";
import { GIT_FORMAT, parseCommits, summarise as summariseCommits } from "../session/harvest.ts";
import { parseTranscript, summariseFriction } from "../session/transcript.ts";
import { ControlStore } from "../control/registry.ts";
import { federatedQuery } from "../control/federation.ts";
import { ensureClusterDir, loadConfig, type CliConfig } from "./config.ts";
import { flagList, flagString, parseArgs, type ParsedArgs } from "./args.ts";
import type { LessonDomain, LessonStatus, MemoryEventKind } from "../core/types.ts";

export const HELP = `
multi-memory — governed episodic and lesson memory

  multi-memory                              the terminal UI (menu if unavailable)
  multi-memory project status
  multi-memory project register                          add this cluster to the control tier
  multi-memory admit --workspace W --by NAME --purpose T [--projects a,b]
  multi-memory ask "<question>" [scope] [--component X] [--bug TAG] [--domain D] [--json]
  multi-memory lesson list [--status S] [--domain D]
  multi-memory lesson show <lessonId>
  multi-memory lesson approve <lessonId> --by <name>      (human only)
  multi-memory lesson revoke  <lessonId> --reason <text>  (human only)
  multi-memory lesson withdraw-contradiction <lessonId> --evidence <id> --reason <text>
                                                          (human only)
  multi-memory episode list [--provider P] [--model M]
  multi-memory episode show <episodeId>
  multi-memory events [--kind K] [--episode ID] [--provider P] [--model M]
                      [--surface S] [--component C] [--since ISO] [--limit N] [--json]
  multi-memory attribution                                who produced what, by provider
  multi-memory ladder                                     is anything climbing, and which rung is stuck
  multi-memory session <repo> [--transcripts DIR] [--since REF] [--json]
                      what the work itself says: fix hotspots from git,
                      friction from Claude Code's own transcripts
  multi-memory docs generate [--dir <path>]
  multi-memory docs ingest <file>
  multi-memory graph export <file.html|file.json>       3D graph, or nodes+edges
                      [--strata governance,structure,context]
                      [--structure-db <path>] [--context-db <path>]
  multi-memory tui [--strata structure,context]          health · browse · ask · act
  multi-memory serve [--port N] [--host H] [--api-key K]
                      [--strata structure,context]   the graph, live in a browser
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
const GRAPH_USAGE = [
  "Usage: multi-memory graph export <file.html|file.json>",
  "         [--strata governance,structure,context] [--structure-db PATH] [--context-db PATH]",
  "",
  "  governance is always drawn. structure and context are opt-in and start hidden",
  "  in the page; the strata buttons reveal them.",
].join("\n");

/**
 * Where the other two strata live.
 *
 * An explicit path always wins. Otherwise `--strata` names a layer and it is
 * resolved by the convention each one already follows: structure.db sits beside
 * builder.db in the cluster directory, and the portfolio brain is wherever
 * PMEM_BRAIN_DB points -- the same variable `session_start_hook.sh` reads, so
 * there is one answer to "which brain" on this machine rather than two.
 *
 * Naming a layer whose file cannot be found is not an error here. The path is
 * passed through and the reader reports it as unavailable *with the path it
 * tried*, which is a better answer than refusing to draw anything.
 */
function resolveStrata(args: ParsedArgs, config: CliConfig): StrataOptions {
  const requested = new Set(
    (flagString(args.flags, "strata") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  const structureDb =
    flagString(args.flags, "structure-db") ??
    (requested.has("structure") ? join(dirname(config.databasePath), "structure.db") : undefined);
  const contextDb =
    flagString(args.flags, "context-db") ??
    (requested.has("context") ? process.env["PMEM_BRAIN_DB"] : undefined);

  const options: StrataOptions = {};
  if (structureDb) options.structureDb = structureDb;
  if (contextDb) options.contextDb = contextDb;
  return options;
}

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

        /* The inverse of a contradiction, and human-only for the same reason
           approval is: it restores a lesson's eligibility, which is a promotion
           by another name. Absent from the MCP surface by construction. */
        case "withdraw-contradiction": {
          const id = args.positional[1] ?? "";
          const evidenceId = flagString(args.flags, "evidence");
          const reason = flagString(args.flags, "reason");
          if (!evidenceId || !reason) {
            return [
              "Usage: multi-memory lesson withdraw-contradiction <lessonId> --evidence <id> --reason <text>",
              "",
              "  One evidence record demotes a lesson permanently and removes it from every",
              "  packet. Setting that aside is a human judgement and needs both the record it",
              "  concerns and the reason it was wrong.",
            ].join("\n");
          }
          const lesson = memory.withdrawContradiction(id, evidenceId, reason);
          const still = lesson.contradictionIds.length - (lesson.withdrawnContradictions?.length ?? 0);
          return [
            `Withdrew contradiction ${evidenceId} from ${lesson.id} — ${reason}`,
            `  Status: ${lesson.status}${still > 0 ? ` (${still} contradiction(s) still standing)` : ""}`,
            `  History retained: the contradiction is still recorded, and now so is its withdrawal.`,
          ].join("\n");
        }

        default:
          return "Usage: multi-memory lesson list|show|approve|revoke|withdraw-contradiction";
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
    /**
     * The ladder, and why each lesson is where it is.
     *
     * Every other view of memory answers "what do we know". This one answers the
     * question the ladder exists to make answerable and could not: is anything
     * actually climbing, and if not, which rung is stuck. A lesson that has never
     * been surfaced cannot be applied, so it cannot qualify -- and before recall
     * telemetry existed that state was indistinguishable from a lesson that was
     * surfaced constantly and simply never helped.
     *
     * Every row states a reason. A row that said only "proposed, 0 reuses" would
     * be this plan's founding defect wearing a table.
     */
    case "ladder": {
      const lessons = memory.listLessons({});
      const recalls = memory.queryEvents({ kinds: ["recall.completed"] });
      const trials = memory.queryEvents({ kinds: ["trial.completed"] });
      const episodes = memory.listEpisodes();

      const idsIn = (event: { payload: Record<string, unknown> }): string[] => {
        const raw = event.payload["lessonIds"];
        return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
      };

      const surfaced = new Map<string, number>();
      for (const event of recalls) for (const id of idsIn(event)) surfaced.set(id, (surfaced.get(id) ?? 0) + 1);
      const trialled = new Map<string, number>();
      for (const event of trials) for (const id of idsIn(event)) trialled.set(id, (trialled.get(id) ?? 0) + 1);

      /* Applied is counted from episodes, not from the telemetry, because that is
         what the promotion rule actually reads (`lessons.ts` refuses reuse unless
         the episode recorded it). Counting the events instead would report a
         number the ladder does not use. */
      const applied = new Map<string, number>();
      const appliedInVerified = new Map<string, number>();
      const appliedInOpen = new Map<string, number>();
      for (const episode of episodes) {
        for (const id of episode.appliedLessonIds) {
          applied.set(id, (applied.get(id) ?? 0) + 1);
          if (episode.outcome === "verified") {
            appliedInVerified.set(id, (appliedInVerified.get(id) ?? 0) + 1);
          } else if (!episode.closedAt) {
            /* An episode that never closed is a permanent dead end for anything
               applied in it: reuse requires a VERIFIED outcome and an open
               episode has no outcome at all. Nothing else in the system reports
               this, so a lesson can sit blocked forever behind an attempt
               someone reloaded away from -- and it looks identical to a lesson
               that was tried and simply did not help. */
            appliedInOpen.set(id, (appliedInOpen.get(id) ?? 0) + 1);
          }
        }
      }

      const openEpisodes = episodes.filter((episode) => !episode.closedAt).length;

      /** The rung, and the specific thing standing between it and the next one. */
      const stateOf = (lesson: (typeof lessons)[number]) => {
        const seen = (surfaced.get(lesson.id) ?? 0) + (trialled.get(lesson.id) ?? 0);
        const applications = applied.get(lesson.id) ?? 0;
        const verifiedApplications = appliedInVerified.get(lesson.id) ?? 0;

        if (lesson.status === "approved") return { blocked: false, reason: "climbed: approved by a human" };
        if (lesson.status === "revoked") {
          return { blocked: true, reason: `revoked: ${lesson.revokedReason ?? "no reason recorded"}` };
        }
        if (lesson.status === "contradicted") {
          return {
            blocked: true,
            reason: `contradicted by ${lesson.contradictionIds.length} evidence record(s); blocked from both reuse and approval, and absent from every packet`,
          };
        }
        if (lesson.status === "qualified") {
          return { blocked: true, reason: "awaiting human approval — the only rung a model may not climb" };
        }
        if (seen === 0) {
          return {
            blocked: true,
            reason: "never surfaced: the governed packet admits only qualified and approved, and no trial has matched its trigger tags",
          };
        }
        if (applications === 0) {
          return { blocked: true, reason: `surfaced ${seen} time(s) but never recorded as applied` };
        }
        if (verifiedApplications === 0) {
          const stillOpen = appliedInOpen.get(lesson.id) ?? 0;
          /* "Still open" and "closed without verifying" are different problems
             and must not share a sentence: the first is an attempt nobody
             finished, the second is guidance that did not work. */
          return stillOpen > 0
            ? {
                blocked: true,
                reason: `applied in ${applications} episode(s); ${stillOpen} of them never closed, so reuse can never be recorded against them`,
              }
            : {
                blocked: true,
                reason: `applied in ${applications} episode(s), none of which closed verified — reuse requires a verified outcome`,
              };
        }
        return { blocked: true, reason: `applied in ${verifiedApplications} verified episode(s) but reuse was never recorded` };
      };

      const rows = lessons
        .map((lesson) => ({
          id: lesson.id,
          status: lesson.status,
          trigger: lesson.trigger,
          domain: lesson.domain,
          component: lesson.component ?? null,
          surfaced: surfaced.get(lesson.id) ?? 0,
          trialled: trialled.get(lesson.id) ?? 0,
          applied: applied.get(lesson.id) ?? 0,
          appliedInVerified: appliedInVerified.get(lesson.id) ?? 0,
          reuseCount: lesson.reuseCount,
          ...stateOf(lesson),
        }))
        .sort((a, b) => b.surfaced + b.trialled - (a.surfaced + a.trialled) || a.id.localeCompare(b.id));

      const outcomes = new Map<string, number>();
      let droppedForBudget = 0;
      let droppedForDiversity = 0;
      let droppedForDirectionBar = 0;
      for (const event of recalls) {
        const outcome = typeof event.payload["outcome"] === "string" ? (event.payload["outcome"] as string) : "unrecorded";
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
        const om = event.payload["omissions"];
        if (om && typeof om === "object") {
          const o = om as Record<string, unknown>;
          droppedForBudget += typeof o["droppedForBudget"] === "number" ? o["droppedForBudget"] : 0;
          droppedForDiversity += typeof o["droppedForDiversity"] === "number" ? o["droppedForDiversity"] : 0;
          droppedForDirectionBar += typeof o["droppedForDirectionBar"] === "number" ? o["droppedForDirectionBar"] : 0;
        }
      }

      const summary = {
        lessons: lessons.length,
        byStatus: Object.fromEntries(
          ["proposed", "qualified", "approved", "contradicted", "revoked"].map((s) => [
            s,
            lessons.filter((l) => l.status === s).length,
          ]),
        ),
        episodes: {
          total: episodes.length,
          verified: episodes.filter((e) => e.outcome === "verified").length,
          open: openEpisodes,
        },
        recallsRecorded: recalls.length,
        trialsRecorded: trials.length,
        recallOutcomes: Object.fromEntries(outcomes),
        dropped: { droppedForBudget, droppedForDiversity, droppedForDirectionBar },
      };

      if (asJson) return out({ summary, lessons: rows }, true);

      if (lessons.length === 0) return "No lessons in this project yet.";

      const lines: string[] = [];
      lines.push(
        `${summary.lessons} lesson(s): ` +
          Object.entries(summary.byStatus)
            .filter(([, n]) => n > 0)
            .map(([s, n]) => `${n} ${s}`)
            .join(", "),
      );

      if (recalls.length === 0) {
        lines.push(
          "",
          "No recall telemetry recorded yet, so 'surfaced' is unknown rather than zero.",
          "It is written by the host on every recall; if this stays empty while builds",
          "run, the host is not calling recall at all.",
        );
      } else {
        lines.push(
          "",
          `${recalls.length} recall(s), ${trials.length} trial(s) recorded. Outcomes: ` +
            [...outcomes.entries()].map(([o, n]) => `${o} ${n}`).join(", "),
          `Dropped across all recalls — budget ${droppedForBudget}, diversity ${droppedForDiversity}, direction bar ${droppedForDirectionBar}`,
        );
      }

      if (openEpisodes > 0) {
        lines.push(
          "",
          `${openEpisodes} of ${episodes.length} episode(s) never closed. Reuse requires a VERIFIED`,
          "outcome, so anything applied inside them can never climb. Nothing else in",
          "this system reports that, and it looks exactly like guidance that did not help.",
        );
      }

      lines.push("", `${"status".padEnd(13)} ${"seen".padStart(4)} ${"appl".padStart(4)} ${"reuse".padStart(5)}  trigger`);
      for (const row of rows) {
        const seen = row.surfaced + row.trialled;
        lines.push(
          `${row.status.padEnd(13)} ${String(seen).padStart(4)} ${String(row.applied).padStart(4)} ${String(row.reuseCount).padStart(5)}  ${row.trigger.slice(0, 60)}`,
        );
        lines.push(`${" ".repeat(13)} ↳ ${row.reason}`);
      }

      lines.push(
        "",
        "'seen' counts governed recalls plus unproven trials. A lesson climbs only by",
        "being applied in a LATER, DIFFERENT episode that closed verified; approval",
        "after that is a human act and is deliberately unavailable to any model.",
      );
      return lines.join("\n");
    }

    /**
     * The session ladder: learn from the work that actually happens.
     *
     * Two sources, both already on disk and both disciplined, so nothing new has
     * to be logged. Git says what was FIXED — the outcome, with a receipt.
     * Claude Code's transcripts say what was ATTEMPTED — the errors, the retries
     * and the moments a human stopped the run, none of which reach a commit.
     * Measured on this estate the second sees roughly 2.5x the activity of the
     * first.
     *
     * Both land on the Phase 2 component key, so a session finding shares an
     * address with a structural node and a context atom.
     *
     * This case is the IO. Every rule it reports lives in `src/session/`, pure
     * and covered by `node --test`.
     */
    case "session": {
      const repoPath = resolve(args.positional[0] ?? process.cwd());
      if (!existsSync(join(repoPath, ".git"))) {
        return `Not a git repository: ${repoPath}\nUsage: multi-memory session <repo> [--transcripts DIR] [--since REF] [--json]`;
      }
      const repo = basename(repoPath);
      const since = flagString(args.flags, "since");

      let commits: ReturnType<typeof parseCommits> = [];
      let gitNote = "";
      try {
        const range = since ? [`${since}..HEAD`] : [];
        const raw = execFileSync(
          "git",
          ["-C", repoPath, "log", "--all", "--name-only", `--pretty=format:${GIT_FORMAT}`, ...range],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        );
        commits = parseCommits(raw);
      } catch (error) {
        gitNote = `git log failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      }
      const fromGit = summariseCommits(commits, repo);

      /* Claude Code files a project's transcripts under the cwd with every
         separator replaced by a dash. Derived rather than guessed, and
         overridable, because a wrong directory would report "no sessions" —
         which is indistinguishable from "no work happened" unless it says so. */
      const transcriptDir =
        flagString(args.flags, "transcripts") ??
        join(process.env["HOME"] ?? "/root", ".claude", "projects", repoPath.replace(/\//g, "-"));

      const sessions = [];
      let transcriptNote = "";
      if (existsSync(transcriptDir)) {
        for (const name of readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl")).sort()) {
          try {
            sessions.push(parseTranscript(readFileSync(join(transcriptDir, name), "utf8").split("\n")));
          } catch (error) {
            transcriptNote += `\n  could not read ${name}: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      } else {
        transcriptNote = `no transcript directory at ${transcriptDir} — pass --transcripts to point at one`;
      }
      const friction = summariseFriction(sessions, { repoRoot: repoPath, repo });

      if (asJson) {
        return out({ repo, repoPath, transcriptDir, git: fromGit, friction, gitNote, transcriptNote }, true);
      }

      const lines: string[] = [`session ladder — ${repo}`, ""];
      if (gitNote) lines.push(`  ${gitNote}`, "");

      lines.push(
        `git: ${fromGit.commits} commit(s), ${fromGit.fixes} fix(es), ` +
          `${fromGit.withTestDelta} stating a test delta, ${fromGit.claimingRevertProof} claiming revert-proof`,
        `  ${fromGit.note}`,
      );
      for (const spot of fromGit.hotspots.slice(0, 10)) {
        lines.push(`  ${String(spot.fixes).padStart(3)} fixes / ${String(spot.touches).padStart(3)} touches  ${spot.path}`);
      }

      lines.push("", `transcripts: ${friction.note}`);
      if (transcriptNote) lines.push(`  ${transcriptNote.trim()}`);
      if (friction.sessions > 0) {
        lines.push(
          `  ${friction.toolUses} tool use(s); errors by tool: ` +
            Object.entries(friction.errorsByTool)
              .sort((a, b) => b[1] - a[1])
              .map(([tool, n]) => `${tool} ${n}`)
              .join(", "),
        );
        for (const point of friction.hotFiles.slice(0, 10)) {
          lines.push(`  ${String(point.edits).padStart(3)} edits across ${String(point.sessions).padStart(2)} session(s)  ${point.path}`);
        }
        if (friction.repeatedFailures.length > 0) {
          lines.push("", "  retried after failing (the clearest evidence of something genuinely hard):");
          for (const failure of friction.repeatedFailures.slice(0, 5)) {
            lines.push(`    x${failure.count}  ${failure.target.replace(/\s*\n\s*/g, " ; ").slice(0, 96)}`);
          }
        }
      }

      lines.push("", "  " + friction.limits.join("\n  "));
      lines.push(
        "",
        `${fromGit.proposals.length} lesson(s) would be proposed. Nothing was written: this command reads.`,
      );
      return lines.join("\n");
    }

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
        if (!file) return GRAPH_USAGE;
        const asJson = file.endsWith(".json");
        const strata = resolveStrata(args, context.config);
        const projection = asJson
          ? exportGraphJson(memory, file, undefined, strata)
          : exportGraphHtml(memory, file, undefined, undefined, strata);
        const { episodes, lessons, evidence, edges } = projection.counts;
        return [
          `wrote ${file}`,
          `  ${episodes} episode(s) · ${lessons} lesson(s) · ${evidence} evidence · ${edges} edge(s)`,
          // Every layer reports, including the ones that gave nothing. A zero
          // that does not say why is the defect this whole surface exists to
          // remove, and a graph is a comfortable place for one to hide.
          ...projection.strata.map((s) =>
            s.available
              ? `  ${s.stratum}: ${s.nodes} node(s), ${s.edges} edge(s)${s.reason ? ` — ${s.reason}` : ""}`
              : `  ${s.stratum}: none — ${s.reason ?? "not available"}`,
          ),
          asJson
            ? "  nodes and edges as JSON"
            : "  open it in a browser — one file, no network, renders offline",
        ].join("\n");
      }
      return GRAPH_USAGE;
    }

    case "tui": {
      // Dynamic: blessed is optional, and importing it at module load would
      // make every other command pay for a dependency they do not use -- and
      // fail outright where it is not installed.
      const { runTui } = await import("../tui/screen.ts");
      const strata = resolveStrata(args, context.config);
      await runTui({
        context,
        strata,
        ...(flagString(args.flags, "context-db") ?? process.env["PMEM_BRAIN_DB"]
          ? { portfolioDb: flagString(args.flags, "context-db") ?? process.env["PMEM_BRAIN_DB"]! }
          : {}),
        // One command path: the panes call exactly what a headless invocation
        // calls, so the two surfaces cannot drift into disagreeing.
        runCommand: (line: string) => runCommand(parseArgs(line.split(" ").filter(Boolean)), context),
      });
      return "";
    }

    case "serve": {
      const strata = resolveStrata(args, context.config);
      const host = flagString(args.flags, "host") ?? DEFAULT_HOST;
      const port = Number(flagString(args.flags, "port") ?? DEFAULT_PORT);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return `Not a port: ${flagString(args.flags, "port")}`;
      }
      const apiKey = flagString(args.flags, "api-key") ?? process.env["MULTI_MEMORY_SERVE_KEY"];

      // Watch the stores this projection actually reads. builder.db is always
      // one of them; the other two only when they were asked for.
      const watchPaths = [context.config.databasePath, strata.structureDb, strata.contextDb].filter(
        (path): path is string => typeof path === "string",
      );

      const running = startServe({
        source: memory,
        strata,
        host,
        port,
        ...(apiKey ? { apiKey } : {}),
        title: `${context.config.workspace}/${context.config.projectId} — memory graph`,
        watchPaths,
      });

      // Nothing is announced until the socket is genuinely bound.
      await running.ready;

      console.log(`multi-memory serve — ${running.url}`);
      if (running.posture.warning) console.warn(`  ${running.posture.warning}`);
      console.log(`  auth: ${running.posture.enforcesAuth ? "X-Api-Key required" : "none (loopback only)"}`);
      for (const leg of running.refresh().strata) {
        console.log(
          leg.available
            ? `  ${leg.stratum}: ${leg.nodes} node(s), ${leg.edges} edge(s)${leg.reason ? ` — ${leg.reason}` : ""}`
            : `  ${leg.stratum}: none — ${leg.reason ?? "not available"}`,
        );
      }
      console.log(`  watching ${watchPaths.length} store(s); Ctrl-C to stop`);

      // Block here. Returning would reach main()'s `finally`, which closes the
      // storage this server is still reading from.
      await new Promise<void>((resolveShutdown) => {
        const stop = () => {
          void running.close().then(() => resolveShutdown());
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return "serve stopped";
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
              // Clamped at zero, the way rank_fusion.ts already clamps its own
              // age. A file written this instant can carry an mtime a fraction
              // ahead of Date.now(), which made its age negative and hid it from
              // `--older-than 0` -- an age that means "everything". It failed
              // roughly one CI run in three and never on a slower machine.
              ageDays: Math.max(0, Date.now() - stat.mtimeMs) / 86_400_000,
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
  /* A letter, not a number: renumbering the existing entries would change what
     every muscle-memory keystroke does, to add one row. */
  ["l", "Ladder — is anything climbing", "ladder"],
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
 * `--database` is not guarded: it names a file the caller chose. Nor is
 * `sync import`, which is how a bundle is restored INTO a cluster that does not
 * exist yet — a guard that refused that would have traded one silent failure for
 * a loud broken workflow.
 */
function unresolvableBuild(args: ParsedArgs, overrides: Partial<CliConfig>): string | null {
  const build = flagString(args.flags, "build");
  // Without a resolved per-build path, `--build` selects a project inside a shared
  // database, and "does this file exist" is not the question being asked.
  if (!build || !overrides.databasePath || existsSync(overrides.databasePath)) return null;
  if (args.command === "sync" && args.sub === "import") return null;

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
      // The TUI is the interactive surface now. The numbered menu stays as the
      // fallback rather than being deleted: blessed is an optional dependency,
      // and "the interactive mode is gone because a package is missing" would
      // be a worse answer than a plainer menu that still works.
      try {
        const { runTui } = await import("../tui/screen.ts");
        await runTui({
          context,
          strata: resolveStrata(parseArgs([]), context.config),
          ...(process.env["PMEM_BRAIN_DB"] ? { portfolioDb: process.env["PMEM_BRAIN_DB"] } : {}),
          runCommand: (line: string) =>
            runCommand(parseArgs(line.split(" ").filter(Boolean)), context),
        });
      } catch (error) {
        console.warn(
          `${error instanceof Error ? error.message : String(error)}\n\nFalling back to the menu.\n`,
        );
        await interactive(context);
      }
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
