import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, appendEvents, queryEvents, supersessionChain } from "../src/core/events.ts";
import { GraphMemoryError } from "../src/core/errors.ts";
import { event, makeStorage, PROJECT, T0 } from "./helpers/factory.ts";

test("event identity is deterministic across independent stores", () => {
  const a = appendEvent(makeStorage(), event());
  const b = appendEvent(makeStorage(), event());
  assert.equal(a.event.id, b.event.id);
  assert.match(a.event.id, /^evt_[0-9a-f]{64}$/);
});

test("identity is content-derived, so a caller cannot assert one", () => {
  const storage = makeStorage();
  const result = appendEvent(storage, { ...event(), id: "evt_attacker_supplied" });
  assert.notEqual(result.event.id, "evt_attacker_supplied");
});

test("duplicate delivery is idempotent, not a second row", () => {
  const storage = makeStorage();
  const first = appendEvent(storage, event());
  const second = appendEvent(storage, event());

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.event.id, second.event.id);
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 1);
});

test("differing content yields a different identity", () => {
  const storage = makeStorage();
  appendEvent(storage, event());
  appendEvent(storage, event({ payload: { result: "failed" } }));
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 2);
});

test("a batch append is atomic: one bad event rolls back the whole batch", () => {
  const storage = makeStorage();
  assert.throws(
    () =>
      appendEvents(storage, [
        event({ payload: { n: 1 } }),
        event({ occurredAt: "not-a-timestamp" }),
        event({ payload: { n: 3 } }),
      ]),
    GraphMemoryError,
  );
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 0);
});

test("events are immutable: a correction supersedes rather than overwrites", () => {
  const storage = makeStorage();
  const original = appendEvent(storage, event({ payload: { result: "passed" } }));
  const correction = appendEvent(
    storage,
    event({ payload: { result: "failed" }, supersedesEventId: original.event.id }),
  );

  const chain = supersessionChain(storage, correction.event.id);
  assert.equal(chain.length, 2);
  assert.equal(chain[1]?.id, original.event.id);
  // The original is still readable exactly as written.
  assert.deepEqual(queryEvents(storage, { projectId: PROJECT }).length, 2);
});

test("superseding an unknown event is refused", () => {
  const storage = makeStorage();
  assert.throws(
    () => appendEvent(storage, event({ supersedesEventId: "evt_nope" })),
    (err: unknown) => err instanceof GraphMemoryError && err.code === "VALIDATION_FAILED",
  );
});

test("facet queries filter by component, domain and trigger tag", () => {
  const storage = makeStorage();
  appendEvent(storage, event({ component: "checkout", domain: "build", triggerTags: ["ERR_A"] }));
  appendEvent(storage, event({ component: "gallery", domain: "taste", triggerTags: ["ERR_B"], payload: { n: 2 } }));

  assert.equal(queryEvents(storage, { projectId: PROJECT, component: "checkout" }).length, 1);
  assert.equal(queryEvents(storage, { projectId: PROJECT, domain: "taste" }).length, 1);
  assert.equal(queryEvents(storage, { projectId: PROJECT, triggerTags: ["ERR_A"] }).length, 1);
  assert.equal(queryEvents(storage, { projectId: PROJECT, triggerTags: ["ERR_ZZZ"] }).length, 0);
  assert.equal(queryEvents(storage, { projectId: PROJECT, since: T0 }).length, 2);
});
