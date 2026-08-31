import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblePacket, domainWeight, lessonToCitedItem, MAX_INJECTED_ITEMS } from "../src/core/packet.ts";
import { HIGH_WEIGHT_DOMAINS, LOW_WEIGHT_DOMAINS } from "../src/core/types.ts";
import type { CitedItem, LessonDomain } from "../src/core/types.ts";

const NOW = new Date("2026-08-31T00:00:00.000Z");

function item(id: string, domain: LessonDomain, overrides: Partial<CitedItem> = {}): CitedItem {
  return {
    id,
    sourceKind: "lesson",
    title: `${domain} lesson ${id}`,
    body: `recommendation body for ${id}`,
    citation: `lesson:${id}`,
    scope: [domain],
    limits: [],
    occurredAt: "2026-08-30T00:00:00.000Z",
    ageDays: 1,
    domain,
    score: 1,
    reason: "test",
    ...overrides,
  };
}

test("Ruling 8: correctness domains outweigh taste domains by design", () => {
  for (const high of HIGH_WEIGHT_DOMAINS) {
    for (const low of LOW_WEIGHT_DOMAINS) {
      assert.ok(
        domainWeight(high) > domainWeight(low) * 10,
        `${high} must dominate ${low}`,
      );
    }
  }
});

test("Ruling 8: no taste lesson may enter a direction-generation packet", () => {
  const candidates = [
    item("a", "taste"),
    item("b", "layout"),
    item("c", "copy"),
    item("d", "art-direction"),
    item("e", "build"),
  ];

  const packet = assemblePacket(candidates, {
    scope: { projectId: "p" },
    task: "produce three design directions",
    directionGeneration: true,
    now: NOW,
  });

  assert.deepEqual(packet.items.map((i) => i.domain), ["build"]);
  assert.equal(packet.omissions.droppedForDirectionBar, 4);
  assert.match(packet.omissions.note, /barred from direction generation/);
});

test("outside a direction turn, taste lessons may appear but rank last", () => {
  const packet = assemblePacket([item("a", "taste"), item("b", "build")], {
    scope: { projectId: "p" },
    task: "fix the build",
    now: NOW,
  });
  assert.deepEqual(packet.items.map((i) => i.domain), ["build", "taste"]);
});

test("the injected-item budget is a hard clamp, not a suggestion", () => {
  const many = Array.from({ length: 20 }, (_, i) => item(`i${i}`, "build", { component: `c${i}` }));
  const packet = assemblePacket(many, {
    scope: { projectId: "p" },
    task: "anything",
    maxItems: 50, // caller asks for more than the ruling allows
    now: NOW,
  });
  assert.equal(packet.items.length, MAX_INJECTED_ITEMS);
  assert.equal(packet.omissions.consideredCount, 20);
});

test("every packet carries advisory framing and context_only authority", () => {
  const packet = assemblePacket([item("a", "build")], {
    scope: { projectId: "p" },
    task: "t",
    now: NOW,
  });
  assert.equal(packet.authority, "context_only");
  assert.match(packet.advisory, /advisory and may be departed from/);
  assert.match(packet.advisory, /stronger truth/);
});

test("an empty candidate set produces an honest empty packet, not a fabrication", () => {
  const packet = assemblePacket([], { scope: { projectId: "p" }, task: "t", now: NOW });
  assert.deepEqual(packet.items, []);
  assert.equal(packet.omissions.returnedCount, 0);
});

test("a lesson converts to a cited item carrying scope, limits and freshness", () => {
  const cited = lessonToCitedItem(
    {
      id: "les_1",
      status: "approved",
      trigger: "vite build fails",
      recommendation: "pin the plugin",
      scope: ["build"],
      sourceEpisodeIds: ["epi_1"],
      evidenceIds: ["evd_1"],
      contradictionIds: [],
      projectId: "p",
      domain: "build",
      limits: ["Node 24 only"],
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      reuseCount: 2,
      deviationIds: [],
    },
    NOW,
  );

  assert.deepEqual(cited.limits, ["Node 24 only"]);
  assert.deepEqual(cited.scope, ["build"]);
  assert.equal(cited.ageDays, 2);
  assert.match(cited.citation, /status=approved reuse=2/);
});
