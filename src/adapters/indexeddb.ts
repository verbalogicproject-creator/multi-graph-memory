/**
 * IndexedDB projection and append outbox (Ruling 4).
 *
 * The browser is NOT the system of record. Events originate here -- planning
 * answers, direction selections, human decisions -- and are queued for the
 * server to drain into SQLite. Reads are served from a mirrored projection.
 *
 * The projection keeps bounded, deterministic facet/recency queries and stays
 * useful with no vectors present, which Ruling 4 requires: offline usefulness
 * must not depend on an embedding provider being reachable.
 *
 * The IndexedDB factory is injected rather than read from `globalThis`, so the
 * same code runs in a browser and against a test shim.
 */

import type { MemoryEvent } from "../core/types.ts";
import type { EventQuery, OutboxEntry, ProjectionAdapter } from "./storage.ts";
import { byOccurredAtDesc, eventMatches } from "./filters.ts";

const OUTBOX_STORE = "outbox";
const EVENTS_STORE = "projected_events";

/** The slice of the IndexedDB API this adapter uses. */
export interface IDBLike {
  open(name: string, version?: number): {
    onupgradeneeded: ((event: { target: { result: any } }) => void) | null;
    onsuccess: ((event: { target: { result: any } }) => void) | null;
    onerror: ((event: { target: { error: unknown } }) => void) | null;
  };
}

function request<T>(req: any): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (event: { target: { result: T } }) => resolve(event.target.result);
    req.onerror = (event: { target: { error: unknown } }) => reject(event.target.error);
  });
}

export interface IndexedDBOptions {
  databaseName?: string;
  factory: IDBLike;
}

export class IndexedDBProjectionAdapter implements ProjectionAdapter {
  readonly name = "indexeddb";
  private readonly databaseName: string;
  private readonly factory: IDBLike;
  private db: any = null;

  constructor(options: IndexedDBOptions) {
    this.databaseName = options.databaseName ?? "multi-graph-memory-v1";
    this.factory = options.factory;
  }

  async open(): Promise<void> {
    if (this.db) return;
    const req = this.factory.open(this.databaseName, 1);
    const upgraded = new Promise<void>((resolve) => {
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) db.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
        if (!db.objectStoreNames.contains(EVENTS_STORE)) db.createObjectStore(EVENTS_STORE, { keyPath: "id" });
        resolve();
      };
      // A database that already exists never fires upgradeneeded.
      queueMicrotask(() => resolve());
    });
    this.db = await request<any>(req);
    await upgraded;
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private store(name: string, mode: "readonly" | "readwrite") {
    if (!this.db) throw new Error("IndexedDBProjectionAdapter is not open; call open() first.");
    return this.db.transaction([name], mode).objectStore(name);
  }

  /**
   * Enqueue is keyed on the deterministic event id, so enqueuing the same event
   * twice leaves one entry -- the first line of defence against duplication.
   */
  async enqueue(event: MemoryEvent): Promise<void> {
    const entry: OutboxEntry = { id: event.id, event, enqueuedAt: new Date().toISOString() };
    await request(this.store(OUTBOX_STORE, "readwrite").put(entry));
  }

  async peekOutbox(limit: number): Promise<OutboxEntry[]> {
    const all = await request<OutboxEntry[]>(this.store(OUTBOX_STORE, "readonly").getAll());
    all.sort((a, b) =>
      a.enqueuedAt === b.enqueuedAt ? (a.id < b.id ? -1 : 1) : a.enqueuedAt < b.enqueuedAt ? -1 : 1,
    );
    return all.slice(0, limit);
  }

  /** Removal happens ONLY after the system of record has committed. */
  async acknowledge(ids: readonly string[]): Promise<void> {
    const store = this.store(OUTBOX_STORE, "readwrite");
    for (const id of ids) await request(store.delete(id));
  }

  async outboxSize(): Promise<number> {
    return request<number>(this.store(OUTBOX_STORE, "readonly").count());
  }

  async putProjectedEvent(event: MemoryEvent): Promise<void> {
    await request(this.store(EVENTS_STORE, "readwrite").put(event));
  }

  /** Deterministic facet/recency filtering, using the shared predicate. */
  async listProjectedEvents(query: EventQuery): Promise<MemoryEvent[]> {
    const all = await request<MemoryEvent[]>(this.store(EVENTS_STORE, "readonly").getAll());
    const out = all.filter((event) => eventMatches(event, query));
    out.sort(byOccurredAtDesc);
    return query.limit === undefined ? out : out.slice(0, query.limit);
  }
}
