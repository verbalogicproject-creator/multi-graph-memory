/**
 * Outbox drain: browser projection -> system of record.
 *
 * Ruling 4 requires the drain to be transactional, resumable and idempotent.
 * The ordering below is what delivers all three, and it is deliberately
 * "at-least-once, deduplicated" rather than "exactly-once":
 *
 *   1. peek a bounded batch (never remove)
 *   2. append the batch ATOMICALLY to the system of record
 *   3. only then acknowledge, removing those ids from the outbox
 *
 * A crash between 2 and 3 leaves entries in the outbox that are already durable.
 * The replay re-appends them, which is a no-op because event identity is
 * content-derived, and then acknowledges. A crash during 2 rolls the whole batch
 * back, so nothing is half-written. There is no window in which an event is
 * acknowledged but not durable.
 */

import { appendEvents } from "../core/events.ts";
import type { StorageAdapter, ProjectionAdapter } from "./storage.ts";

export interface DrainResult {
  drained: number;
  created: number;
  duplicates: number;
  remaining: number;
}

export interface DrainOptions {
  batchSize?: number;
  /** Test hook: throw between the append and the acknowledge to simulate a crash. */
  onBeforeAcknowledge?: (ids: readonly string[]) => void | Promise<void>;
}

export async function drainOutboxOnce(
  projection: ProjectionAdapter,
  storage: StorageAdapter,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const batchSize = options.batchSize ?? 50;
  const batch = await projection.peekOutbox(batchSize);

  if (batch.length === 0) {
    return { drained: 0, created: 0, duplicates: 0, remaining: await projection.outboxSize() };
  }

  // Step 2: atomic. Either every new event in this batch lands, or none does.
  const results = appendEvents(storage, batch.map((entry) => entry.event));
  const created = results.filter((r) => r.created).length;

  if (options.onBeforeAcknowledge) await options.onBeforeAcknowledge(batch.map((e) => e.id));

  // Step 3: only now is it safe to forget them.
  await projection.acknowledge(batch.map((entry) => entry.id));

  // Mirror back into the read projection so the browser sees what it queued.
  for (const entry of batch) await projection.putProjectedEvent(entry.event);

  return {
    drained: batch.length,
    created,
    duplicates: batch.length - created,
    remaining: await projection.outboxSize(),
  };
}

/** Drains until the outbox is empty. Bounded by `maxBatches` so it cannot spin. */
export async function drainOutbox(
  projection: ProjectionAdapter,
  storage: StorageAdapter,
  options: DrainOptions & { maxBatches?: number } = {},
): Promise<DrainResult> {
  const maxBatches = options.maxBatches ?? 100;
  const total: DrainResult = { drained: 0, created: 0, duplicates: 0, remaining: 0 };

  for (let i = 0; i < maxBatches; i += 1) {
    const result = await drainOutboxOnce(projection, storage, options);
    total.drained += result.drained;
    total.created += result.created;
    total.duplicates += result.duplicates;
    total.remaining = result.remaining;
    if (result.drained === 0 || result.remaining === 0) break;
  }

  return total;
}
