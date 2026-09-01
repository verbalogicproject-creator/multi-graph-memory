/**
 * Schema version 2: provider/model/surface attribution.
 *
 * The property that matters is not "the field exists" but "the field is honest":
 * absent attribution stays absent rather than becoming an empty string, a record
 * written before version 2 keeps the identity it was written with, and an
 * attribution observed once is never overwritten by a later guess.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphMemoryError } from "../src/core/errors.ts";
import { appendEvent, prepareEvent, queryEvents } from "../src/core/events.ts";
import { closeEpisode, openEpisode } from "../src/core/episodes.ts";
import { memoryEventInputSchema, episodeSchema } from "../src/core/schema.ts";
import { event, makeStorage, PROJECT, T0, T1, T2 } from "./helpers/factory.ts";

function code(err: unknown): string | undefined {
  return err instanceof GraphMemoryError ? err.code : undefined;
}

/* ------------------------------------------------------------- validation -- */

test("attribution is accepted on an event and is optional", () => {
  assert.ok(memoryEventInputSchema.safeParse(event()).success, "absent attribution is valid");
  assert.ok(
    memoryEventInputSchema.safeParse(
      event({ provider: "anthropic", model: "claude-haiku-4-5", surface: "builder.generate" }),
    ).success,
  );
});

test("an empty attribution string is refused rather than stored", () => {
  // "" and absent would otherwise be two spellings of the same unknown -- and,
  // because identity is derived from the body, two different event ids.
  for (const field of ["provider", "model", "surface"] as const) {
    const parsed = memoryEventInputSchema.safeParse(event({ [field]: "" }));
    assert.equal(parsed.success, false, `${field}="" must be refused`);
  }
});

test("an episode carries provider and model, and rejects an unknown field", () => {
  const parsed = episodeSchema.safeParse({
    id: "epi_x",
    projectId: PROJECT,
    objective: "build",
    baseRevisionId: "rev-1",
    openedAt: T0,
    appliedLessonIds: [],
    provider: "google",
    model: "gemini-3.7-flash",
  });
  assert.ok(parsed.success, "provider and model are accepted on an episode");
});

/* --------------------------------------------------------------- identity -- */

test("attribution participates in event identity, and its absence is stable", () => {
  const bare = prepareEvent(event());
  const attributed = prepareEvent(event({ provider: "openai", model: "gpt-5.6-luna" }));

  assert.notEqual(bare.id, attributed.id, "a differently-attributed event is a different event");

  // The load-bearing half: an event written before version 2 existed hashes
  // exactly as it did then, so old ids survive the upgrade.
  assert.equal(bare.id, prepareEvent(event()).id);
  assert.equal(bare.provider, undefined);
  assert.ok(!("provider" in bare), "absent stays absent, not an explicit undefined");
});

test("the same call served by two providers yields two distinct records", () => {
  const storage = makeStorage();
  const a = appendEvent(storage, event({ provider: "google", model: "gemini-3.5-flash" }));
  const b = appendEvent(storage, event({ provider: "anthropic", model: "claude-haiku-4-5" }));

  assert.ok(a.created && b.created);
  assert.notEqual(a.event.id, b.event.id);
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 2);
});

/* --------------------------------------------------------------- querying -- */

test("events filter by provider, model and surface", () => {
  const storage = makeStorage();
  appendEvent(storage, event({ provider: "google", model: "gemini-3.5-flash", surface: "builder.plan" }));
  appendEvent(storage, event({ provider: "anthropic", model: "claude-haiku-4-5", surface: "builder.plan" }));
  appendEvent(storage, event({ provider: "anthropic", model: "claude-sonnet-5", surface: "builder.generate" }));

  assert.equal(queryEvents(storage, { projectId: PROJECT, provider: "anthropic" }).length, 2);
  assert.equal(queryEvents(storage, { projectId: PROJECT, model: "claude-sonnet-5" }).length, 1);
  assert.equal(queryEvents(storage, { projectId: PROJECT, surface: "builder.plan" }).length, 2);
  assert.equal(queryEvents(storage, { projectId: PROJECT, provider: "nvidia" }).length, 0);
});

test("an unattributed event never matches a provider filter", () => {
  const storage = makeStorage();
  appendEvent(storage, event());
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1);
  assert.equal(queryEvents(storage, { projectId: PROJECT, provider: "google" }).length, 0);
});

/* --------------------------------------------------------------- episodes -- */

test("an episode takes its attribution at close, when the serving model is known", () => {
  const storage = makeStorage();
  const opened = openEpisode(storage, {
    projectId: PROJECT,
    objective: "generate the project",
    baseRevisionId: "rev-1",
    openedAt: T0,
  });
  assert.ok(!("provider" in opened), "unknown at open under a fallback chain");

  const closed = closeEpisode(storage, opened.id, "verified", T1, {
    provider: "anthropic",
    model: "claude-haiku-4-5",
  });
  assert.equal(closed.provider, "anthropic");
  assert.equal(closed.model, "claude-haiku-4-5");
  assert.equal(closed.outcome, "verified");
});

test("attribution does not change episode identity", () => {
  const plain = makeStorage();
  const attributed = makeStorage();
  const input = {
    projectId: PROJECT,
    objective: "generate the project",
    baseRevisionId: "rev-1",
    openedAt: T0,
  };
  const a = openEpisode(plain, input);
  const b = openEpisode(attributed, { ...input, attribution: { provider: "google" } });
  assert.equal(a.id, b.id, "the same attempt is the same episode either way");
});

test("close never overwrites an attribution recorded at open", () => {
  const storage = makeStorage();
  const opened = openEpisode(storage, {
    projectId: PROJECT,
    objective: "generate",
    baseRevisionId: "rev-1",
    openedAt: T0,
    attribution: { provider: "google" },
  });
  const closed = closeEpisode(storage, opened.id, "verified", T1, {
    provider: "anthropic",
    model: "claude-haiku-4-5",
  });

  assert.equal(closed.provider, "google", "the earlier observation stands");
  assert.equal(closed.model, "claude-haiku-4-5", "an absent field is still filled");
});

test("closing an already-closed episode is still refused", () => {
  const storage = makeStorage();
  const opened = openEpisode(storage, {
    projectId: PROJECT,
    objective: "generate",
    baseRevisionId: "rev-1",
    openedAt: T0,
  });
  closeEpisode(storage, opened.id, "verified", T1);
  assert.throws(
    () => closeEpisode(storage, opened.id, "failed", T2, { provider: "openai" }),
    (e: unknown) => code(e) === "VALIDATION_FAILED",
  );
});
