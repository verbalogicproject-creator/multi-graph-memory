/**
 * Read-only MCP server for external agents (Ruling 9).
 *
 * Hand-rolled line-delimited JSON-RPC over stdio, matching the transport the
 * antigravity-memory-os server uses, so no SDK dependency is added.
 *
 * The critical difference from that server: it gates mutation tools at runtime
 * with a `mutationMode` flag. This one does not have mutation tools AT ALL.
 * Approval, revocation, federation admission and re-homing are not registered,
 * not dispatched, and not reachable by any configuration -- exposing one would
 * require editing this file. A flag can be set wrongly; an absent capability
 * cannot.
 *
 * Ruling 10: a model-facing transport is the surface most likely to be pointed
 * at a live host before anyone has decided what it may do there. Registering a
 * mutation tool here would make that decision by default, so the decision is
 * removed instead.
 */

import readline from "node:readline";
import type { GraphMemory } from "../port.ts";
import { isGraphMemoryError } from "../core/errors.ts";

export const JSONRPC_VERSION = "2.0";

/** Every tool this server will ever expose. All are reads. */
export const READ_ONLY_TOOLS = [
  {
    name: "fgm_read_memory_context",
    description:
      "Return a bounded, cited context packet for a task. The packet is assembled by Graph Memory: item budget, domain weighting, source diversity and the direction-generation bar always apply. Guidance is advisory, never authoritative.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the caller is trying to do." },
        component: { type: "string" },
        domain: { type: "string" },
        triggerTags: { type: "array", items: { type: "string" } },
        maxItems: { type: "number", description: "Clamped to at most 5." },
        directionGeneration: {
          type: "boolean",
          description: "Set for a design-direction turn; taste lessons are then excluded entirely.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "fgm_list_lessons",
    description: "List lessons for the active project, optionally filtered by status, domain or component.",
    inputSchema: {
      type: "object",
      properties: {
        statuses: { type: "array", items: { type: "string" } },
        domain: { type: "string" },
        component: { type: "string" },
      },
    },
  },
  {
    name: "fgm_get_lesson",
    description: "Fetch one lesson by id, including its evidence, contradictions and limits.",
    inputSchema: { type: "object", properties: { lessonId: { type: "string" } }, required: ["lessonId"] },
  },
  {
    name: "fgm_list_episodes",
    description: "List episodes for the active project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fgm_query_events",
    description: "Query the append-only event journal by facet.",
    inputSchema: {
      type: "object",
      properties: {
        episodeId: { type: "string" },
        component: { type: "string" },
        domain: { type: "string" },
        triggerTags: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "fgm_project_status",
    description: "Counts and scope for the active project, plus the authority boundary.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

/**
 * Names that must never appear in this server. Asserted by the test suite so a
 * future edit cannot quietly reintroduce one.
 */
export const FORBIDDEN_TOOL_PATTERNS = [
  "approve", "revoke", "admit", "rehome", "re_home",
  "propose", "append", "delete", "write", "import", "promote", "qualify",
  /* Setting aside a contradiction restores a lesson's eligibility, which is a
     promotion by another name. It belongs beside `approve` on this list, and its
     absence here would have been an omission rather than a decision. */
  "withdraw",
] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpServerOptions {
  memory: GraphMemory;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export class ReadOnlyMcpServer {
  private readonly memory: GraphMemory;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private rl: readline.Interface | null = null;

  constructor(options: McpServerOptions) {
    this.memory = options.memory;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
  }

  start(): void {
    this.rl = readline.createInterface({ input: this.input, output: this.output, terminal: false });
    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (error) {
      this.write({ jsonrpc: JSONRPC_VERSION, id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    this.write(await this.handleRequest(request));
  }

  private write(response: unknown): void {
    this.output.write(`${JSON.stringify(response)}\n`);
  }

  async handleRequest(request: JsonRpcRequest): Promise<unknown> {
    const id = request.id ?? null;

    if (request.method === "tools/list") {
      return { jsonrpc: JSONRPC_VERSION, id, result: { tools: READ_ONLY_TOOLS } };
    }

    if (request.method !== "tools/call") {
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: -32601, message: `Method not found: ${request.method ?? "(none)"}` },
      };
    }

    const name = String(request.params?.name ?? "");
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await this.callTool(name, args);
      return { jsonrpc: JSONRPC_VERSION, id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: -32602,
          message,
          ...(isGraphMemoryError(error) ? { data: { code: error.code, detail: error.detail } } : {}),
        },
      };
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "fgm_read_memory_context":
        return this.memory.queryContext({
          task: String(args.task ?? ""),
          ...(args.component === undefined ? {} : { component: String(args.component) }),
          ...(args.domain === undefined ? {} : { domain: args.domain as never }),
          ...(args.triggerTags === undefined ? {} : { triggerTags: args.triggerTags as string[] }),
          ...(args.maxItems === undefined ? {} : { maxItems: Number(args.maxItems) }),
          ...(args.directionGeneration === undefined ? {} : { directionGeneration: Boolean(args.directionGeneration) }),
        });

      case "fgm_list_lessons":
        return this.memory.listLessons({
          ...(args.statuses === undefined ? {} : { statuses: args.statuses as never }),
          ...(args.domain === undefined ? {} : { domain: args.domain as never }),
          ...(args.component === undefined ? {} : { component: String(args.component) }),
        });

      case "fgm_get_lesson":
        return this.memory.getLesson(String(args.lessonId ?? ""));

      case "fgm_list_episodes":
        return this.memory.listEpisodes();

      case "fgm_query_events":
        return this.memory.queryEvents({
          ...(args.episodeId === undefined ? {} : { episodeId: String(args.episodeId) }),
          ...(args.component === undefined ? {} : { component: String(args.component) }),
          ...(args.domain === undefined ? {} : { domain: args.domain as never }),
          ...(args.triggerTags === undefined ? {} : { triggerTags: args.triggerTags as string[] }),
          ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
        });

      case "fgm_project_status":
        return {
          scope: this.memory.scope,
          counts: {
            events: this.memory.queryEvents().length,
            episodes: this.memory.listEpisodes().length,
            lessons: this.memory.listLessons().length,
            evidence: this.memory.listEvidence().length,
          },
          authority: "context_only",
          note:
            "Graph Memory grants no filesystem, dependency, donor, model, network, revision or deployment authority. " +
            "Lesson approval and revocation are not available on this surface.",
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
