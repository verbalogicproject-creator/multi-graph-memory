/**
 * Append-only event journal.
 *
 * Order of operations on every append, and the order matters:
 *   1. schema validation      -- malformed input never reaches the boundary
 *   2. redaction gate         -- Ruling 3, before anything is persisted
 *   3. deterministic identity -- computed, never taken from the caller
 *   4. idempotent write       -- a repeat delivery is a no-op, not a duplicate
 *
 * Events are immutable. A correction is a NEW event referencing the claim it
 * supersedes; nothing is ever edited or deleted in place.
 */

import { deriveEventId } from "./canonical.ts";
import { refuse, refuseSchema } from "./errors.ts";
import { assertRedactionBoundary, type GateOptions } from "./redaction.ts";
import { memoryEventInputSchema } from "./schema.ts";
import { assertProjectMatch, requireScope } from "./scope.ts";
import type { MemoryEvent, MemoryEventInput, ProjectScope } from "./types.ts";
import type { EventQuery, StorageAdapter, StorageTx } from "../adapters/storage.ts";

export interface AppendResult {
  event: MemoryEvent;
  /** false when an identical event was already present -- the idempotent path. */
  created: boolean;
}

export interface AppendOptions extends GateOptions {
  scope?: Partial<ProjectScope>;
}

/** Validates, redacts, derives identity. Pure: performs no I/O. */
export function prepareEvent(input: MemoryEventInput, options: GateOptions = {}): MemoryEvent {
  const parsed = memoryEventInputSchema.safeParse(input);
  if (!parsed.success) {
    refuseSchema("Event", parsed.error.issues);
  }

  const { id: _supplied, ...body } = parsed.data;

  // Ruling 3, persistence gate. Runs before any write.
  assertRedactionBoundary(body, "persistence", options);

  const id = deriveEventId(body as Record<string, unknown>);
  return { ...(body as Omit<MemoryEvent, "id">), id };
}

/** Appends one event inside an existing transaction. */
export function appendEventTx(tx: StorageTx, input: MemoryEventInput, options: AppendOptions = {}): AppendResult {
  const event = prepareEvent(input, options);

  if (options.scope) {
    assertProjectMatch(event.projectId, requireScope(options.scope), "event");
  }

  const existing = tx.getEvent(event.id);
  if (existing) return { event: existing, created: false };

  if (event.supersedesEventId !== undefined) {
    const superseded = tx.getEvent(event.supersedesEventId);
    if (!superseded) {
      refuse("VALIDATION_FAILED", `Cannot supersede unknown event "${event.supersedesEventId}".`, {
        supersedesEventId: event.supersedesEventId,
      });
    }
    assertProjectMatch(superseded.projectId, { workspace: "default", projectId: event.projectId }, "superseded event");
  }

  const created = tx.putEventIfAbsent(event);
  return { event, created };
}

export function appendEvent(
  storage: StorageAdapter,
  input: MemoryEventInput,
  options: AppendOptions = {},
): AppendResult {
  return storage.transact((tx) => appendEventTx(tx, input, options));
}

/**
 * Appends a batch atomically. Either every new event lands or none does, which
 * is what lets an interrupted outbox drain be replayed without duplication.
 */
export function appendEvents(
  storage: StorageAdapter,
  inputs: readonly MemoryEventInput[],
  options: AppendOptions = {},
): AppendResult[] {
  return storage.transact((tx) => inputs.map((input) => appendEventTx(tx, input, options)));
}

export function queryEvents(storage: StorageAdapter, query: EventQuery): MemoryEvent[] {
  requireScope({ projectId: query.projectId });
  return storage.transact((tx) => tx.listEvents(query));
}

/**
 * The events an event supersedes, most recent first. Corrections form a chain
 * rather than replacing history.
 */
export function supersessionChain(storage: StorageAdapter, eventId: string): MemoryEvent[] {
  return storage.transact((tx) => {
    const chain: MemoryEvent[] = [];
    const seen = new Set<string>();
    let cursor = tx.getEvent(eventId);
    while (cursor && !seen.has(cursor.id)) {
      chain.push(cursor);
      seen.add(cursor.id);
      cursor = cursor.supersedesEventId ? tx.getEvent(cursor.supersedesEventId) : null;
    }
    return chain;
  });
}
