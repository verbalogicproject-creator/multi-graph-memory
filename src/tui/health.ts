/**
 * "Is this system telling the truth?", as data.
 *
 * Pure and blessed-free on purpose. The panel that renders this is a terminal
 * UI and awkward to assert against; the *decisions* -- is the heartbeat stale,
 * did a layer answer, is a zero explained -- are ordinary logic, and this repo's
 * rule is that logic which can be pure is tested by the runner rather than by a
 * screenshot.
 *
 * Every row carries a `detail` even when it is fine. A dashboard whose healthy
 * state is a bare green tick teaches you to stop reading it, and the failure
 * this whole plan exists around is a check that was present, passing, and not
 * looking at the real case.
 */

import { DatabaseSync } from "node:sqlite";

export type Verdict = "ok" | "warn" | "bad" | "unknown";

export interface HealthRow {
  readonly label: string;
  readonly verdict: Verdict;
  /** The number or state itself, short enough for a narrow pane. */
  readonly value: string;
  /** Why it reads that way. Always present, including when it is fine. */
  readonly detail: string;
}

/** The delivery heartbeat's own threshold, matching test_delivery_heartbeat. */
export const MAX_SILENCE_MS = 48 * 60 * 60 * 1000;

export function formatAge(ms: number): string {
  if (ms < 0) return "in the future";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export interface Receipt {
  readonly createdAt: string;
  readonly loaded: boolean;
  readonly reason?: string;
  readonly trigger?: string;
}

/**
 * The newest context-delivery receipt, or null when there has never been one.
 *
 * Null and "old" are different answers and must stay different: a store with no
 * receipts at all is a hook that has never run, which is not the same problem as
 * a hook that stopped.
 */
export function readNewestReceipt(portfolioDb: string): Receipt | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(`file:${portfolioDb}?mode=ro`, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT created_at,
                json_extract(metadata, '$.loaded') AS loaded,
                json_extract(metadata, '$.reason') AS reason,
                json_extract(metadata, '$.trigger') AS trigger
           FROM episodes WHERE kind = 'brain_load'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      createdAt: String(row["created_at"]),
      // SQLite has no boolean; json_extract gives 1/0 or the literal.
      loaded: row["loaded"] === 1 || row["loaded"] === true || row["loaded"] === "true",
      ...(row["reason"] ? { reason: String(row["reason"]) } : {}),
      ...(row["trigger"] ? { trigger: String(row["trigger"]) } : {}),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function heartbeatRow(receipt: Receipt | null, now: Date = new Date()): HealthRow {
  if (!receipt) {
    return {
      label: "heartbeat",
      verdict: "unknown",
      value: "no receipts",
      detail:
        "no brain_load receipt has ever been written — the SessionStart hook has not run, " +
        "or is writing somewhere else",
    };
  }
  const age = now.getTime() - new Date(receipt.createdAt).getTime();
  const trigger = receipt.trigger ? ` (${receipt.trigger})` : "";
  if (age > MAX_SILENCE_MS) {
    return {
      label: "heartbeat",
      verdict: "bad",
      value: formatAge(age),
      detail:
        `context delivery last succeeded ${formatAge(age)}${trigger}, past the 48h bar. ` +
        `This is the check that would have caught the 13-day silence on day three.`,
    };
  }
  // A recent receipt that records a MISS is not a healthy heartbeat. The hook
  // ran, which is the thing being measured, but it delivered nothing -- and
  // conflating the two is how "I found nothing" became indistinguishable from
  // "I am broken" in the first place.
  if (!receipt.loaded) {
    return {
      label: "heartbeat",
      verdict: "warn",
      value: formatAge(age),
      detail: `the hook ran ${formatAge(age)}${trigger} but delivered nothing: ${receipt.reason ?? "no reason recorded"}`,
    };
  }
  return {
    label: "heartbeat",
    verdict: "ok",
    value: formatAge(age),
    detail: `context was delivered ${formatAge(age)}${trigger}, well inside the 48h bar`,
  };
}

export interface StratumLike {
  readonly stratum: string;
  readonly available: boolean;
  readonly reason?: string;
  readonly nodes: number;
  readonly edges: number;
}

export function strataRows(strata: readonly StratumLike[]): HealthRow[] {
  return strata.map((leg) => {
    if (!leg.available) {
      return {
        label: leg.stratum,
        verdict: "unknown" as Verdict,
        value: "absent",
        detail: leg.reason ?? "not available, and no reason was recorded — that is itself the bug",
      };
    }
    if (leg.nodes === 0) {
      return {
        label: leg.stratum,
        verdict: "warn" as Verdict,
        value: "0 nodes",
        detail: leg.reason ?? "present but empty, with no reason recorded",
      };
    }
    return {
      label: leg.stratum,
      verdict: "ok" as Verdict,
      value: `${leg.nodes}n ${leg.edges}e`,
      detail: leg.reason ?? `${leg.nodes} node(s) and ${leg.edges} edge(s) reached the graph`,
    };
  });
}

export interface IntegrityLike {
  readonly ok: boolean;
  readonly issues: readonly { readonly check: string; readonly severity: string }[];
}

export function integrityRow(report: IntegrityLike | null): HealthRow {
  if (!report) {
    return {
      label: "integrity",
      verdict: "unknown",
      value: "not run",
      detail: "no structure graph to check — build one with `brain structure build`",
    };
  }
  const errors = report.issues.filter((i) => i.severity === "error");
  const warnings = report.issues.filter((i) => i.severity === "warning");
  if (errors.length > 0) {
    const names = [...new Set(errors.map((i) => i.check))].join(", ");
    return {
      label: "integrity",
      verdict: "bad",
      value: `${errors.length} error(s)`,
      detail: `the declared taxonomy rejects this graph: ${names}`,
    };
  }
  return {
    label: "integrity",
    verdict: "ok",
    value: warnings.length > 0 ? `${warnings.length} warning(s)` : "clean",
    detail:
      warnings.length > 0
        ? `no errors; ${warnings.length} warning(s), which are advisory (orphans, self-loops)`
        : "every edge resolves, every type is declared, and no acyclic edge type has a cycle",
  };
}

/** The worst verdict present, for a one-glance summary. */
export function overallVerdict(rows: readonly HealthRow[]): Verdict {
  if (rows.some((r) => r.verdict === "bad")) return "bad";
  if (rows.some((r) => r.verdict === "warn")) return "warn";
  if (rows.some((r) => r.verdict === "unknown")) return "unknown";
  return "ok";
}
