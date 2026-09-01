/**
 * Schema versioning and the single migration ladder (Ruling 4).
 *
 * One ladder is shared by every adapter, so a bundle exported from SQLite and
 * imported into the browser projection follows the identical route.
 *
 * The ladder holds one real step today (1 -> 2, attribution) and still exercises
 * its refusal paths: version 0 is not a valid version, and a version-3 bundle is
 * refused as a downgrade rather than silently stripped.
 */

import { refuse } from "./errors.ts";

/** 2: provider/model/surface attribution on events, provider/model on episodes. */
export const CURRENT_SCHEMA_VERSION = 2;

/** Versions this build can read at all, before any migration is attempted. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export interface Migration {
  from: number;
  to: number;
  describe: string;
  /** Pure transform over a decoded bundle body. Must not perform I/O. */
  apply(bundle: Record<string, unknown>): Record<string, unknown>;
}

/** Ordered ascending by `from`. Each entry moves a bundle exactly one step. */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    describe: "adds optional provider/model/surface attribution to events and episodes",
    /**
     * Identity by design, and that is the whole claim: version 2 only ADDS
     * optional fields, so a version-1 record is already a valid version-2
     * record. Nothing is back-filled -- inventing an attribution for a record
     * written before attribution existed would manufacture evidence. Those
     * records stay honestly unattributed.
     */
    apply: (bundle) => bundle,
  },
];

export interface MigrationPlan {
  from: number;
  to: number;
  steps: readonly Migration[];
}

/**
 * Resolves the route from `from` to the current version, or refuses.
 * Downgrades are refused outright: a newer bundle may carry fields this build
 * would silently drop, and silent loss is worse than a refusal.
 */
export function planMigration(from: number, to: number = CURRENT_SCHEMA_VERSION): MigrationPlan {
  if (!Number.isInteger(from) || from < 1) {
    refuse("SCHEMA_VERSION_UNSUPPORTED", `Schema version ${from} is not a valid version.`, { from });
  }
  if (from === to) return { from, to, steps: [] };
  if (from > to) {
    refuse(
      "MIGRATION_ROUTE_INVALID",
      `Refusing to downgrade a version ${from} bundle to version ${to}; newer fields would be lost.`,
      { from, to },
    );
  }

  const steps: Migration[] = [];
  let cursor = from;
  while (cursor < to) {
    const step = MIGRATIONS.find((m) => m.from === cursor);
    if (!step) {
      refuse(
        "MIGRATION_ROUTE_INVALID",
        `No migration route from schema version ${cursor} toward ${to}.`,
        { from, to, stalledAt: cursor },
      );
    }
    steps.push(step);
    cursor = step.to;
  }
  return { from, to, steps };
}

export function applyMigrations(
  bundle: Record<string, unknown>,
  plan: MigrationPlan,
): Record<string, unknown> {
  let current = bundle;
  for (const step of plan.steps) current = step.apply(current);
  return current;
}
