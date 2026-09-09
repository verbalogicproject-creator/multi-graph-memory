/**
 * The health pane's judgements, and the wrapping that has to survive a phone.
 *
 * Asserted here rather than against a screenshot because these are ordinary
 * decisions: is a heartbeat stale, is a zero explained, is a warning different
 * from an absence. The terminal layer holds only layout and key bindings.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  MAX_SILENCE_MS,
  formatAge,
  heartbeatRow,
  integrityRow,
  overallVerdict,
  readNewestReceipt,
  strataRows,
} from "../src/tui/health.ts";
import { emptyState, wrap } from "../src/tui/app.ts";

const NOW = new Date("2026-09-09T12:00:00Z");

test("a hook that never ran is not the same answer as one that stopped", () => {
  const never = heartbeatRow(null, NOW);
  assert.equal(never.verdict, "unknown");
  assert.match(never.detail, /has ever been written/);

  const stopped = heartbeatRow(
    { createdAt: new Date(NOW.getTime() - MAX_SILENCE_MS - 1000).toISOString(), loaded: true },
    NOW,
  );
  assert.equal(stopped.verdict, "bad");
  assert.match(stopped.detail, /past the 48h bar/);
  assert.notEqual(never.verdict, stopped.verdict, "these must never render alike");
});

test("a recent hook that delivered nothing is a warning, not a pass", () => {
  // The hook ran, which is what the heartbeat measures -- but it delivered no
  // context. Scoring that green is how "I found nothing" and "I am broken"
  // became the same observable event in the first place.
  const row = heartbeatRow(
    {
      createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
      loaded: false,
      reason: "cwd is not indexed in the portfolio brain",
      trigger: "startup",
    },
    NOW,
  );
  assert.equal(row.verdict, "warn");
  assert.match(row.detail, /delivered nothing/);
  assert.match(row.detail, /not indexed/, "and it repeats the reason the receipt recorded");
});

test("a healthy heartbeat still explains itself", () => {
  const row = heartbeatRow(
    { createdAt: new Date(NOW.getTime() - 900_000).toISOString(), loaded: true, trigger: "compact" },
    NOW,
  );
  assert.equal(row.verdict, "ok");
  // A green tick with no words teaches you to stop reading the dashboard.
  assert.ok(row.detail.length > 20, "even a pass says what it checked");
  assert.match(row.detail, /compact/);
});

test("an absent layer, an empty layer and a full one are three answers", () => {
  const rows = strataRows([
    { stratum: "governance", available: true, nodes: 19, edges: 10 },
    { stratum: "structure", available: false, nodes: 0, edges: 0, reason: "no graph at /x" },
    { stratum: "context", available: true, nodes: 0, edges: 0, reason: "none carried a component" },
  ]);
  assert.deepEqual(rows.map((r) => r.verdict), ["ok", "unknown", "warn"]);
  for (const row of rows) assert.ok(row.detail.length > 0, `${row.label} must say why`);
  assert.equal(overallVerdict(rows), "warn");
});

test("a layer that is absent with no recorded reason says that is itself the bug", () => {
  const [row] = strataRows([{ stratum: "structure", available: false, nodes: 0, edges: 0 }]);
  assert.match(String(row!.detail), /no reason was recorded/);
});

test("integrity distinguishes not-run from clean from rejected", () => {
  assert.equal(integrityRow(null).verdict, "unknown");
  assert.equal(integrityRow({ ok: true, issues: [] }).verdict, "ok");
  const warned = integrityRow({ ok: true, issues: [{ check: "orphan_nodes", severity: "warning" }] });
  assert.equal(warned.verdict, "ok");
  assert.match(warned.detail, /advisory/);
  const failed = integrityRow({ ok: false, issues: [{ check: "dangling_edges", severity: "error" }] });
  assert.equal(failed.verdict, "bad");
  assert.match(failed.detail, /dangling_edges/, "names the check, not just a count");
});

test("the receipt reader tells a missing store from an empty one", () => {
  assert.equal(readNewestReceipt("/nowhere/portfolio.db"), null);

  const dir = mkdtempSync(join(tmpdir(), "mgm-tui-"));
  const path = join(dir, "portfolio.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE episodes (id TEXT PRIMARY KEY, content TEXT, kind TEXT, metadata TEXT, created_at TEXT);
    INSERT INTO episodes VALUES ('a','x','brain_load','{"loaded":false,"reason":"cwd is not indexed","trigger":"startup"}','2026-09-09T10:00:00Z');
    INSERT INTO episodes VALUES ('b','x','brain_load','{"loaded":true,"trigger":"compact"}','2026-09-09T11:00:00Z');
  `);
  db.close();

  const receipt = readNewestReceipt(path);
  assert.equal(receipt?.createdAt, "2026-09-09T11:00:00Z", "the newest, not the first");
  assert.equal(receipt?.loaded, true);
  assert.equal(receipt?.trigger, "compact");
});

test("text wraps for a phone in portrait, and a long token is broken not overflowed", () => {
  // The 80x24 this device reports is terminfo's fallback -- there is no
  // controlling TTY. A real Termux window in portrait is commonly 40-55.
  for (const line of wrap("the quick brown fox jumps over the lazy dog repeatedly", 24)) {
    assert.ok(line.length <= 24, `"${line}" is ${line.length} wide`);
  }
  const long = wrap("repo:multi-app/components/builders/SandpackAppPreview.tsx", 20);
  for (const line of long) assert.ok(line.length <= 20);
  assert.ok(long.length > 1, "an unbreakable path is split rather than allowed to overflow");
  assert.equal(wrap("", 20).length, 0);
});

test("an empty pane is never blank", () => {
  const reason = "nothing matched, and all 5 lessons are still proposed";
  const state = emptyState("ask", reason);
  assert.match(state, /nothing to show/);
  // The reason is wrapped for a narrow pane, so compare on words rather than
  // on a phrase that a line break may fall through the middle of.
  assert.equal(state.replace(/\s+/g, " ").includes(reason), true, "the reason is the whole point");
});

test("formatAge reads naturally at every scale", () => {
  assert.equal(formatAge(30_000), "just now");
  assert.equal(formatAge(16 * 60_000), "16m ago");
  assert.equal(formatAge(3 * 3_600_000), "3h ago");
  assert.equal(formatAge(13 * 24 * 3_600_000), "13d ago");
});
