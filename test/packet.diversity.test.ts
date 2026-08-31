import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblePacket, renderPacket } from "../src/core/packet.ts";
import { filterForDiversity } from "../src/core/diversity.ts";
import type { CitedItem } from "../src/core/types.ts";

const NOW = new Date("2026-08-31T00:00:00.000Z");

function item(id: string, component: string, body = `body-${id}`): CitedItem {
  return {
    id,
    sourceKind: "lesson",
    title: `lesson ${id}`,
    body,
    citation: `lesson:${id}`,
    scope: ["build"],
    limits: [],
    occurredAt: "2026-08-30T00:00:00.000Z",
    ageDays: 1,
    domain: "build",
    component,
    score: 1,
    reason: "test",
  };
}

test("the packet cannot be saturated from a single component", () => {
  const candidates = Array.from({ length: 8 }, (_, i) => item(`i${i}`, "build-pipeline"));
  const packet = assemblePacket(candidates, {
    scope: { projectId: "p" },
    task: "fix the build",
    now: NOW,
  });

  assert.equal(packet.items.length, 2, "default cap is two per component");
  assert.ok(packet.omissions.droppedForDiversity > 0);
  assert.match(packet.omissions.note, /source diversity/);
});

test("the packet cannot be saturated from a single source episode", () => {
  const candidates = Array.from({ length: 6 }, (_, i) => item(`i${i}`, `component-${i}`));
  const packet = assemblePacket(candidates, {
    scope: { projectId: "p" },
    task: "fix the build",
    sourceEpisodeOf: () => "epi_same",
    now: NOW,
  });

  assert.equal(packet.items.length, 2, "default cap is two per episode");
});

test("a diverse candidate set fills the budget normally", () => {
  const candidates = Array.from({ length: 8 }, (_, i) => item(`i${i}`, `component-${i}`));
  const packet = assemblePacket(candidates, {
    scope: { projectId: "p" },
    task: "fix the build",
    sourceEpisodeOf: (i) => `epi_${i.id}`,
    now: NOW,
  });
  assert.equal(packet.items.length, 5);
});

test("near-duplicate bodies from one component are collapsed", () => {
  const dupes = [item("a", "c1", "identical body text here"), item("b", "c1", "identical body text here")];
  const { kept, droppedForDiversity } = filterForDiversity(dupes, () => undefined);
  assert.equal(kept.length, 1);
  assert.equal(droppedForDiversity, 1);
});

test("a high-confidence exact match bypasses the per-source cap", () => {
  const candidates = [
    item("a", "c1", "one"),
    item("b", "c1", "two"),
    { ...item("c", "c1", "three"), score: 99 },
  ];
  const { kept } = filterForDiversity(candidates, () => undefined, { exactMatchFloor: 50 });
  assert.equal(kept.length, 3);
});

test("the rendering always states what was omitted", () => {
  const candidates = Array.from({ length: 8 }, (_, i) => item(`i${i}`, "build-pipeline"));
  const rendered = renderPacket(
    assemblePacket(candidates, { scope: { projectId: "p" }, task: "fix the build", now: NOW }),
  );
  assert.match(rendered, /\*\*Showing:\*\* 2 of 8 candidate\(s\)/);
  assert.match(rendered, /Citation:/);
  assert.match(rendered, /Freshness:/);
  assert.match(rendered, /context_only/);
});
