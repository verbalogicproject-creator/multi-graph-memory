import { test } from "node:test";
import assert from "node:assert/strict";
import { IndexedDBProjectionAdapter } from "../src/adapters/indexeddb.ts";
import { drainOutbox, drainOutboxOnce } from "../src/adapters/outbox.ts";
import { MemoryStorageAdapter } from "../src/adapters/memory.ts";
import { prepareEvent, queryEvents } from "../src/core/events.ts";
import { createFakeIndexedDB } from "./helpers/idb-shim.ts";
import { event, PROJECT } from "./helpers/factory.ts";
import type { MemoryEvent } from "../src/core/types.ts";

async function setup(name = "test-db") {
  const factory = createFakeIndexedDB();
  const projection = new IndexedDBProjectionAdapter({ factory, databaseName: name });
  await projection.open();
  const storage = new MemoryStorageAdapter();
  storage.open();
  return { factory, projection, storage };
}

function events(n: number): MemoryEvent[] {
  return Array.from({ length: n }, (_, i) => prepareEvent(event({ payload: { n: i } })));
}

test("queued events drain into the system of record and clear the outbox", async () => {
  const { projection, storage } = await setup();
  for (const e of events(5)) await projection.enqueue(e);
  assert.equal(await projection.outboxSize(), 5);

  const result = await drainOutbox(projection, storage);

  assert.equal(result.created, 5);
  assert.equal(result.remaining, 0);
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 5);
});

test("enqueuing the same event twice leaves one outbox entry", async () => {
  const { projection } = await setup();
  const [only] = events(1);
  await projection.enqueue(only!);
  await projection.enqueue(only!);
  assert.equal(await projection.outboxSize(), 1);
});

test("Ruling 4: an interrupted drain replays without duplicating", async () => {
  const { projection, storage } = await setup();
  for (const e of events(6)) await projection.enqueue(e);

  // Crash after the atomic append but before the acknowledge -- the worst window.
  await assert.rejects(
    () =>
      drainOutboxOnce(projection, storage, {
        batchSize: 6,
        onBeforeAcknowledge: () => {
          throw new Error("process died before acknowledge");
        },
      }),
    /process died before acknowledge/,
  );

  // The events are already durable, and the outbox still holds all six.
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 6);
  assert.equal(await projection.outboxSize(), 6);

  // The replay is a pure no-op on the system of record, then clears the outbox.
  const replay = await drainOutbox(projection, storage);
  assert.equal(replay.created, 0, "replay must create nothing");
  assert.equal(replay.duplicates, 6);
  assert.equal(await projection.outboxSize(), 0);
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 6, "no duplicates after replay");
});

test("a batch that fails to append leaves the outbox fully intact", async () => {
  const { projection, storage } = await setup();
  for (const e of events(3)) await projection.enqueue(e);
  // A corrupt entry that will fail validation inside the atomic append. It must
  // carry its own id, or the id-keyed outbox would simply overwrite a good entry.
  await projection.enqueue({
    ...prepareEvent(event({ payload: { n: 99 } })),
    id: "evt_corrupt_entry",
    occurredAt: "not-a-timestamp",
  });

  await assert.rejects(() => drainOutboxOnce(projection, storage, { batchSize: 10 }));

  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 0, "nothing may be half-written");
  assert.equal(await projection.outboxSize(), 4, "nothing may be acknowledged");
});

test("draining is bounded by batch size and resumes across calls", async () => {
  const { projection, storage } = await setup();
  for (const e of events(10)) await projection.enqueue(e);

  const first = await drainOutboxOnce(projection, storage, { batchSize: 4 });
  assert.equal(first.drained, 4);
  assert.equal(first.remaining, 6);

  const rest = await drainOutbox(projection, storage, { batchSize: 4 });
  assert.equal(rest.remaining, 0);
  assert.equal(queryEvents(storage, { projectId: PROJECT }).length, 10);
});

test("the projection serves deterministic facet queries with no vectors present", async () => {
  const { projection, storage } = await setup();
  await projection.enqueue(prepareEvent(event({ component: "checkout", domain: "build", triggerTags: ["ERR_A"] })));
  await projection.enqueue(prepareEvent(event({ component: "gallery", domain: "taste", payload: { n: 2 } })));
  await drainOutbox(projection, storage);

  assert.equal((await projection.listProjectedEvents({ projectId: PROJECT })).length, 2);
  assert.equal((await projection.listProjectedEvents({ projectId: PROJECT, component: "checkout" })).length, 1);
  assert.equal((await projection.listProjectedEvents({ projectId: PROJECT, triggerTags: ["ERR_A"] })).length, 1);
  assert.equal((await projection.listProjectedEvents({ projectId: PROJECT, limit: 1 })).length, 1);
  assert.equal((await projection.listProjectedEvents({ projectId: "other" })).length, 0);
});

test("projection state survives a close and reopen", async () => {
  const factory = createFakeIndexedDB();
  const first = new IndexedDBProjectionAdapter({ factory, databaseName: "persist" });
  await first.open();
  await first.enqueue(prepareEvent(event()));
  await first.close();

  const second = new IndexedDBProjectionAdapter({ factory, databaseName: "persist" });
  await second.open();
  assert.equal(await second.outboxSize(), 1);
});
