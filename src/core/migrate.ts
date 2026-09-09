/**
 * Schema versioning and the single migration ladder (Ruling 4).
 *
 * One ladder is shared by every adapter, so a bundle exported from SQLite and
 * imported into the browser projection follows the identical route.
 *
 * The ladder holds two steps today (1 -> 2 attribution, 2 -> 3 evidence
 * supersession) and still exercises its refusal paths: version 0 is not a valid
 * version, and a bundle newer than this build is refused as a downgrade rather
 * than silently stripped.
 */

import { refuse } from "./errors.ts";

/** 4: a lesson records contradictions a human has withdrawn, and why. */
export const CURRENT_SCHEMA_VERSION = 4;

/** Versions this build can read at all, before any migration is attempted. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4];

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
  {
    from: 2,
    to: 3,
    describe: "adds an optional supersedes pointer to evidence",
    /**
     * Identity, for the same reason as 1 -> 2: version 3 only ADDS an optional
     * field, so every version-2 evidence record is already a valid version-3
     * record. Ids are deliberately NOT recomputed. `deriveEvidenceId` folds in a
     * digest only when one is present, so a record written without a digest
     * derives the identical id under either version; a record written WITH one
     * keeps the id it was stored and exported under, and its next revision
     * supersedes it rather than colliding with it. Recomputing here would break
     * every checksum in a bundle to no purpose.
     */
    apply: (bundle) => bundle,
  },
  {
    from: 3,
    to: 4,
    describe: "adds withdrawn-contradiction history to lessons",
    /**
     * Identity, for the same reason as the two steps before it: version 4 only
     * ADDS an optional field. A lesson with no withdrawals is already a valid
     * version-4 lesson, and back-filling one would invent a human decision that
     * nobody made.
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
