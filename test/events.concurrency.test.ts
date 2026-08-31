import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, appendEvents, queryEvents } from "../src/core/events.ts";
import { event, makeStorage, PROJECT } from "./helpers/factory.ts";

test("concurrent delivery of the same event stores exactly one", async () => {
  const storage = makeStorage();
  const results = await Promise.all(
    Array.from({ length: 25 }, async () => appendEvent(storage, event())),
  );

  const created = results.filter((r) => r.created);
  assert.equal(created.length, 1, "exactly one append may report creation");
  assert.equal(new Set(results.map((r) => r.event.id)).size, 1);
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1);
});

test("duplicates within one batch collapse to a single row", () => {
  const storage = makeStorage();
  const results = appendEvents(storage, [event(), event(), event()]);

  assert.deepEqual(results.map((r) => r.created), [true, false, false]);
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1);
});

test("interleaved distinct appends all land, with stable identities", async () => {
  const storage = makeStorage();
  await Promise.all(
    Array.from({ length: 20 }, async (_, i) => appendEvent(storage, event({ payload: { n: i } }))),
  );
  const stored = queryEvents(storage, { projectId: PROJECT });
  assert.equal(stored.length, 20);
  assert.equal(new Set(stored.map((e) => e.id)).size, 20);
});

test("replaying an interrupted batch is a no-op, which is what makes outbox drain safe", () => {
  const storage = makeStorage();
  const batch = [event({ payload: { n: 1 } }), event({ payload: { n: 2 } }), event({ payload: { n: 3 } })];

  appendEvents(storage, batch.slice(0, 2)); // a drain that got halfway
  const replay = appendEvents(storage, batch); // full replay after the interruption

  assert.deepEqual(replay.map((r) => r.created), [false, false, true]);
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 3);
});
