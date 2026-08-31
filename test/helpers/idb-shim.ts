/**
 * Minimal in-process IndexedDB, for testing the projection adapter on a device
 * with no browser (Decision 4 -- no new devDependency).
 *
 * Honest about its limits: it implements exactly the subset the projection uses
 * (open/upgrade, object stores with a keyPath, put/get/getAll/delete/count/clear,
 * and request objects with onsuccess/onerror), with transactions resolving on a
 * microtask. It does NOT implement cursors, indexes, versionchange blocking, or
 * real durability. It proves the drain state machine, not IndexedDB itself --
 * real-browser behaviour stays on the deferred list.
 */

interface StoreDef {
  keyPath: string;
}

class FakeRequest<T> {
  onsuccess: ((event: { target: { result: T } }) => void) | null = null;
  onerror: ((event: { target: { error: unknown } }) => void) | null = null;
  result!: T;
  error: unknown = null;

  settle(value: T): void {
    queueMicrotask(() => {
      this.result = value;
      this.onsuccess?.({ target: { result: value } });
    });
  }

  fail(error: unknown): void {
    queueMicrotask(() => {
      this.error = error;
      this.onerror?.({ target: { error } });
    });
  }
}

class FakeObjectStore {
  private readonly data: Map<string, unknown>;
  private readonly def: StoreDef;

  constructor(data: Map<string, unknown>, def: StoreDef) {
    this.data = data;
    this.def = def;
  }

  put(value: Record<string, unknown>): FakeRequest<string> {
    const key = String(value[this.def.keyPath]);
    const request = new FakeRequest<string>();
    this.data.set(key, structuredClone(value));
    request.settle(key);
    return request;
  }

  get(key: string): FakeRequest<unknown> {
    const request = new FakeRequest<unknown>();
    request.settle(this.data.has(key) ? structuredClone(this.data.get(key)) : undefined);
    return request;
  }

  getAll(): FakeRequest<unknown[]> {
    const request = new FakeRequest<unknown[]>();
    request.settle([...this.data.values()].map((v) => structuredClone(v)));
    return request;
  }

  delete(key: string): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.data.delete(key);
    request.settle(undefined);
    return request;
  }

  count(): FakeRequest<number> {
    const request = new FakeRequest<number>();
    request.settle(this.data.size);
    return request;
  }

  clear(): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.data.clear();
    request.settle(undefined);
    return request;
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: ((event: { target: { error: unknown } }) => void) | null = null;
  private readonly db: FakeDatabase;

  constructor(db: FakeDatabase) {
    this.db = db;
    queueMicrotask(() => queueMicrotask(() => this.oncomplete?.()));
  }

  objectStore(name: string): FakeObjectStore {
    return this.db.store(name);
  }
}

export class FakeDatabase {
  readonly name: string;
  private readonly stores = new Map<string, Map<string, unknown>>();
  private readonly defs = new Map<string, StoreDef>();

  constructor(name: string) {
    this.name = name;
  }

  objectStoreNames = {
    contains: (name: string): boolean => this.defs.has(name),
  };

  createObjectStore(name: string, options: StoreDef): FakeObjectStore {
    this.defs.set(name, options);
    this.stores.set(name, new Map());
    return new FakeObjectStore(this.stores.get(name)!, options);
  }

  store(name: string): FakeObjectStore {
    const data = this.stores.get(name);
    const def = this.defs.get(name);
    if (!data || !def) throw new Error(`Unknown object store "${name}"`);
    return new FakeObjectStore(data, def);
  }

  transaction(_names: string | string[], _mode?: string): FakeTransaction {
    return new FakeTransaction(this);
  }

  close(): void {}

  /** Test hook: simulate a process death that loses in-flight state. */
  snapshot(): Map<string, Map<string, unknown>> {
    return new Map([...this.stores].map(([k, v]) => [k, new Map(v)]));
  }
}

export interface FakeOpenRequest {
  onupgradeneeded: ((event: { target: { result: FakeDatabase } }) => void) | null;
  onsuccess: ((event: { target: { result: FakeDatabase } }) => void) | null;
  onerror: ((event: { target: { error: unknown } }) => void) | null;
  result: FakeDatabase;
}

/** Databases persist for the lifetime of the factory, mimicking browser storage. */
export function createFakeIndexedDB() {
  const databases = new Map<string, FakeDatabase>();

  return {
    databases,
    open(name: string, _version?: number): FakeOpenRequest {
      const isNew = !databases.has(name);
      const db = databases.get(name) ?? new FakeDatabase(name);
      databases.set(name, db);

      const request: FakeOpenRequest = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        result: db,
      };

      queueMicrotask(() => {
        if (isNew) request.onupgradeneeded?.({ target: { result: db } });
        queueMicrotask(() => request.onsuccess?.({ target: { result: db } }));
      });

      return request;
    },
  };
}

export type FakeIndexedDBFactory = ReturnType<typeof createFakeIndexedDB>;
