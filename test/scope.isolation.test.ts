import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { appendEvent, queryEvents } from "../src/core/events.ts";
import { admits, assertRehomeApproved, requireScope, resolveRetrieval } from "../src/core/scope.ts";
import { event, makeStorage, PROJECT } from "./helpers/factory.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

test("an unscoped query fails closed rather than returning everything", () => {
  for (const bad of [undefined, null, {}, { projectId: "" }]) {
    assert.throws(
      () => requireScope(bad as never),
      (e: unknown) => code(e) === "SCOPE_REQUIRED",
    );
  }
});

test("strict mode is the default and pins to one project", () => {
  const resolved = resolveRetrieval({ workspace: "w", projectId: "p" });
  assert.equal(resolved.mode, "strict");
  assert.equal(resolved.projectId, "p");
});

test("federated mode without an admission record is refused", () => {
  assert.throws(
    () => resolveRetrieval({ workspace: "w", projectId: "p" }, "federated"),
    (e: unknown) => code(e) === "FEDERATION_NOT_ADMITTED",
  );
});

test("a partial admission record is refused", () => {
  const incomplete = [
    { purpose: "x", allowedWorkspaces: ["w"], admittedAt: "2026-08-01T00:00:00.000Z" },
    { approvedBy: "eyal", allowedWorkspaces: ["w"], admittedAt: "2026-08-01T00:00:00.000Z" },
    { approvedBy: "eyal", purpose: "x", allowedWorkspaces: [], admittedAt: "2026-08-01T00:00:00.000Z" },
  ];
  for (const admission of incomplete) {
    assert.throws(
      () => resolveRetrieval({ workspace: "w", projectId: "p" }, "federated", admission),
      (e: unknown) => code(e) === "FEDERATION_NOT_ADMITTED",
    );
  }
});

test("a complete admission record permits only the workspaces it names", () => {
  const admission = {
    approvedBy: "eyal",
    purpose: "compare build failures across two products",
    allowedWorkspaces: ["studio"],
    admittedAt: "2026-08-01T00:00:00.000Z",
  };

  const resolved = resolveRetrieval({ workspace: "studio", projectId: "p" }, "federated", admission);
  assert.equal(resolved.mode, "federated");

  assert.throws(
    () => resolveRetrieval({ workspace: "backend", projectId: "p" }, "federated", admission),
    (e: unknown) => code(e) === "FEDERATION_NOT_ADMITTED",
  );

  assert.equal(admits(resolved.admission!, "studio", "anything"), true);
  assert.equal(admits(resolved.admission!, "backend", "anything"), false);
});

test("allowedProjects narrows further when present", () => {
  const admission = {
    approvedBy: "eyal",
    purpose: "narrow",
    allowedWorkspaces: ["studio"],
    allowedProjects: ["alpha"],
    admittedAt: "2026-08-01T00:00:00.000Z",
  };
  assert.equal(admits(admission, "studio", "alpha"), true);
  assert.equal(admits(admission, "studio", "beta"), false);
});

test("writing an event outside the active scope is refused", () => {
  const storage = makeStorage();
  assert.throws(
    () => appendEvent(storage, event({ projectId: "other" }), { scope: { projectId: PROJECT } }),
    (e: unknown) => code(e) === "PROJECT_MISMATCH",
  );
});

test("queries never leak across projects", () => {
  const storage = makeStorage();
  appendEvent(storage, event({ projectId: "alpha" }));
  appendEvent(storage, event({ projectId: "beta" }));

  assert.equal(queryEvents(storage, { projectId: "alpha" }).length, 1);
  assert.equal(queryEvents(storage, { projectId: "beta" }).length, 1);
  assert.equal(queryEvents(storage, { projectId: "gamma" }).length, 0);
});

test("a cross-project re-home requires a recorded human approval", () => {
  assert.doesNotThrow(() => assertRehomeApproved("a", "a"));
  assert.throws(
    () => assertRehomeApproved("a", "b"),
    (e: unknown) => code(e) === "REHOME_NOT_APPROVED",
  );
  assert.doesNotThrow(() =>
    assertRehomeApproved("a", "b", {
      approvedBy: "eyal",
      reason: "project renamed",
      fromProjectId: "a",
      toProjectId: "b",
      approvedAt: "2026-08-01T00:00:00.000Z",
    }),
  );
});
