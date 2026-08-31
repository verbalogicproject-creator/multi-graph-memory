/**
 * Schema versioning and the single migration ladder (Ruling 4).
 *
 * One ladder is shared by every adapter, so a bundle exported from SQLite and
 * imported into the browser projection follows the identical route.
 *
 * The ladder currently holds one version. That is not a placeholder: the
 * mechanism it exists to enforce -- refusing a bundle whose version has no route
 * to the current one -- is fully exercised today, because versions 0 and 2 have
 * no route and are rejected. Adding a real migration later is one array entry.
 */

import { refuse } from "./errors.ts";

export const CURRENT_SCHEMA_VERSION = 1;

/** Versions this build can read at all, before any migration is attempted. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

export interface Migration {
  from: number;
  to: number;
  describe: string;
  /** Pure transform over a decoded bundle body. Must not perform I/O. */
  apply(bundle: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Ordered ascending by `from`. Each entry moves a bundle exactly one step.
 * Empty today because version 1 is the first published schema.
 */
export const MIGRATIONS: readonly Migration[] = [];

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
