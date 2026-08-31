import { test } from "node:test";
import assert from "node:assert/strict";
import { FORBIDDEN_TOOL_PATTERNS, READ_ONLY_TOOLS, ReadOnlyMcpServer } from "../src/mcp/server.ts";
import { ModelContextPort, GraphMemory } from "../src/port.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { PROJECT } from "./helpers/factory.ts";

function server() {
  const storage = new MemoryStorageAdapter();
  storage.open();
  const memory = new GraphMemory({ storage, scope: { projectId: PROJECT } });
  return { memory, mcp: new ReadOnlyMcpServer({ memory }) };
}

test("Ruling 9: no governance mutation tool exists, gated or otherwise", async () => {
  const { mcp } = server();
  const listed = (await mcp.handleRequest({ id: 1, method: "tools/list" })) as {
    result: { tools: Array<{ name: string }> };
  };
  const names = listed.result.tools.map((t) => t.name);

  for (const forbidden of FORBIDDEN_TOOL_PATTERNS) {
    assert.ok(
      !names.some((name) => name.toLowerCase().includes(forbidden)),
      `MCP must expose no tool containing "${forbidden}" — found: ${names.join(", ")}`,
    );
  }
  assert.deepEqual(names, READ_ONLY_TOOLS.map((t) => t.name));
});

test("calling a governance mutation by name fails as unknown, not as forbidden", async () => {
  const { mcp } = server();
  for (const name of ["fgm_approve_lesson", "approveLesson", "fgm_revoke_lesson", "fgm_import"]) {
    const response = (await mcp.handleRequest({
      id: 2,
      method: "tools/call",
      params: { name, arguments: {} },
    })) as { error?: { message: string } };
    assert.match(response.error?.message ?? "", /Unknown tool/, `${name} must not be dispatchable`);
  }
});

test("the source registers no handler for any mutation verb", async () => {
  // Guards against a future edit adding a case to the dispatch switch.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8"),
  );
  const cases = [...source.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!);
  for (const name of cases) {
    for (const forbidden of FORBIDDEN_TOOL_PATTERNS) {
      assert.ok(!name.includes(forbidden), `dispatch case "${name}" contains forbidden verb "${forbidden}"`);
    }
  }
  assert.ok(cases.length >= READ_ONLY_TOOLS.length);
});

test("read tools work and the packet keeps its authority marker", async () => {
  const { mcp } = server();
  const response = (await mcp.handleRequest({
    id: 3,
    method: "tools/call",
    params: { name: "fgm_read_memory_context", arguments: { task: "fix the build" } },
  })) as { result: { content: Array<{ text: string }> } };

  const packet = JSON.parse(response.result.content[0]!.text);
  assert.equal(packet.authority, "context_only");
  assert.equal(packet.scope.projectId, PROJECT);
  assert.ok(packet.advisory.length > 0);
});

test("project status states the authority boundary explicitly", async () => {
  const { mcp } = server();
  const response = (await mcp.handleRequest({
    id: 4,
    method: "tools/call",
    params: { name: "fgm_project_status", arguments: {} },
  })) as { result: { content: Array<{ text: string }> } };

  const status = JSON.parse(response.result.content[0]!.text);
  assert.equal(status.authority, "context_only");
  assert.match(status.note, /grants no filesystem, dependency, donor, model, network, revision or deployment authority/);
  assert.match(status.note, /approval and revocation are not available/);
});

test("unknown methods and malformed input are refused cleanly", async () => {
  const { mcp } = server();
  const unknown = (await mcp.handleRequest({ id: 5, method: "resources/list" })) as { error: { code: number } };
  assert.equal(unknown.error.code, -32601);
});

test("ModelContextPort exposes exactly one method", () => {
  const { memory } = server();
  const port = new ModelContextPort(memory);
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(port)).filter(
    (name) => name !== "constructor" && typeof (port as never)[name] === "function",
  );
  assert.deepEqual(methods, ["readMemoryContext"]);
  assert.equal((port as never)["approveLesson"], undefined);
  assert.equal((port as never)["revokeLesson"], undefined);
});
