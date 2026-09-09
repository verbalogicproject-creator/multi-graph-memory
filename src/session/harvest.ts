/**
 * The session ladder: learning from the work that actually happens.
 *
 * The builder ladder learns about a model generating applications. It is not
 * where most of this estate's work occurs — that happens in editing sessions
 * across a dozen repositories, and none of it reaches memory.
 *
 * The temptation is to build a new capture mechanism for those sessions. That
 * would be the wrong move, because a disciplined one already exists and is
 * better than anything a hook could produce: **the commit history.** Measured
 * across four repositories, 188 commits, every one carrying a conventional type
 * prefix, and 87 of them fixes. Which files those fixes land on is a recurrence
 * signal that needs no model, no prose parsing and no new instrumentation:
 *
 *     server.js              26 fix commits
 *     context/AppContext.tsx 24
 *     memory/bridge.js       12
 *
 * So this module harvests rather than captures.
 *
 * **No model decides anything here**, matching the rule the builder's own
 * proposal table follows. A lesson's recommendation is never synthesised from a
 * commit message; it *cites* the commits, and the guidance is "read these before
 * you change this". That is the principle `evidence.ts` already states in its own
 * docstring: Graph Memory points at proof, it does not become the proof.
 *
 * Everything here is pure. The git invocation and the writes live in the CLI, so
 * the parsing, the recurrence rule and the proposal shape are all covered by
 * `node --test` rather than by a script that spawns a process.
 */

/** One commit, as much of it as can be read deterministically. */
export interface CommitRecord {
  readonly sha: string;
  /** Conventional prefix: fix, feat, docs, ci, chore, test, perf, vendor... */
  readonly type: string;
  readonly scope: string | null;
  readonly subject: string;
  readonly authoredAt: string;
  readonly files: readonly string[];
  /** `tests 294 -> 303` in the body, when the author stated one. */
  readonly testDelta: { readonly before: number; readonly after: number } | null;
  /** The body claims a named assertion goes red when the fix is reverted. */
  readonly claimsRevertProof: boolean;
}

/**
 * The separators.
 *
 * A commit body contains blank lines, bullet lines and, in this estate, whole
 * fenced code blocks — so a newline-delimited parse would split one commit into
 * several. ASCII RECORD SEPARATOR and UNIT SEPARATOR exist for exactly this and
 * cannot occur in prose. They are passed to git as `%x1e`/`%x1f`, which git
 * expands itself: a literal control byte in an argv string is rejected by Node
 * before git ever sees it, which is how the first version of this failed.
 */
export const RECORD = "\u001e";
export const FIELD = "\u001f";

/** The `--pretty` format this parser expects. Exported so the caller cannot drift from it. */
export const GIT_FORMAT = "%x1e%H%x1f%aI%x1f%s%x1f%b%x1f";

const TYPE_RE = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.*)$/;
const TEST_DELTA_RE = /tests?\s+(\d+)\s*(?:->|→)\s*(\d+)/i;
const REVERT_PROOF_RE = /revert-proof|goes? red|go red when/i;

/**
 * Parses `git log --name-only` output in {@link GIT_FORMAT}.
 *
 * A commit whose subject carries no conventional prefix is still returned, with
 * `type: "unknown"`. Dropping it would make the harvest silently partial, and a
 * count that quietly excludes what it could not classify is the shape of every
 * defect this system exists to remove.
 */
export function parseCommits(raw: string): CommitRecord[] {
  const out: CommitRecord[] = [];
  for (const chunk of raw.split(RECORD)) {
    if (!chunk.trim()) continue;
    const [sha = "", authoredAt = "", subject = "", body = "", rest = ""] = chunk.split(FIELD);
    if (!sha.trim()) continue;

    const match = TYPE_RE.exec(subject.trim());
    const delta = TEST_DELTA_RE.exec(body);

    out.push({
      sha: sha.trim(),
      type: match?.[1] ?? "unknown",
      scope: match?.[2] ?? null,
      subject: (match?.[3] ?? subject).trim(),
      authoredAt: authoredAt.trim(),
      files: rest
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      testDelta: delta ? { before: Number(delta[1]), after: Number(delta[2]) } : null,
      claimsRevertProof: REVERT_PROOF_RE.test(body),
    });
  }
  return out;
}

/**
 * The Phase 2 join key, so a session lesson lands in the same address space as a
 * structural node and a context atom. `build:` is the builder's namespace; a
 * first-party repository file is `repo:`.
 */
export function componentFor(repo: string, path: string): string {
  return `repo:${repo}/${path}`;
}

export interface Hotspot {
  readonly component: string;
  readonly path: string;
  /** Commits of type `fix` that touched this file. */
  readonly fixes: number;
  /** Every commit that touched it, of any type. */
  readonly touches: number;
  /** Newest first. The evidence a proposal cites. */
  readonly recentFixShas: readonly string[];
}

export interface HotspotOptions {
  /** A file must have been fixed at least this many times to count. Default 3. */
  readonly minFixes?: number;
  /**
   * How many hotspots become proposals. Default 10.
   *
   * Not cosmetic. A packet holds five items, so proposing a lesson for all 64
   * files that crossed the threshold in this estate would bury the five that
   * matter under fifty-nine that do not — and every one of them would be
   * competing for the same budget. The report still lists every hotspot; the
   * cap is on what asks to become guidance.
   */
  readonly propose?: number;
  /** How many fix shas a hotspot carries. Default 3. */
  readonly cite?: number;
  /**
   * Paths to ignore. Lockfiles, generated artifacts and changelogs are touched
   * by almost every fix without being the thing that broke, so counting them
   * would rank the noise above the signal.
   */
  readonly ignore?: readonly RegExp[];
}

export const DEFAULT_IGNORE: readonly RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)CHANGELOG\.md$/,
  /(^|\/)\.gitignore$/,
  /(^|\/)dist\//,
  /(^|\/)schemas\/.*\.schema\.json$/,
];

/**
 * Files that keep needing fixes, newest evidence first.
 *
 * Deliberately counts commits rather than lines: a file changed once in a
 * thousand-line refactor is not a hotspot, and a one-line fix applied eleven
 * times is. The question this answers is "how often was this wrong", not "how
 * much of it moved".
 */
export function hotspots(
  records: readonly CommitRecord[],
  repo: string,
  options: HotspotOptions = {},
): Hotspot[] {
  const minFixes = options.minFixes ?? 3;
  const cite = options.cite ?? 3;
  const ignore = options.ignore ?? DEFAULT_IGNORE;

  const fixes = new Map<string, string[]>();
  const touches = new Map<string, number>();

  // Newest first, so the cited shas are the most recent without a second sort.
  const ordered = [...records].sort((a, b) => (a.authoredAt < b.authoredAt ? 1 : a.authoredAt > b.authoredAt ? -1 : 0));

  for (const record of ordered) {
    for (const path of record.files) {
      if (ignore.some((pattern) => pattern.test(path))) continue;
      touches.set(path, (touches.get(path) ?? 0) + 1);
      if (record.type === "fix") {
        const list = fixes.get(path) ?? [];
        list.push(record.sha);
        fixes.set(path, list);
      }
    }
  }

  const out: Hotspot[] = [];
  for (const [path, shas] of fixes) {
    if (shas.length < minFixes) continue;
    out.push({
      component: componentFor(repo, path),
      path,
      fixes: shas.length,
      touches: touches.get(path) ?? shas.length,
      recentFixShas: shas.slice(0, cite),
    });
  }
  return out.sort((a, b) => b.fixes - a.fixes || a.path.localeCompare(b.path));
}

export interface SessionProposal {
  readonly component: string;
  readonly trigger: string;
  readonly recommendation: string;
  readonly scope: readonly string[];
  readonly limits: readonly string[];
  readonly triggerTags: readonly string[];
  /** `git://<repo>@<sha>` — what the lesson points at, rather than restates. */
  readonly evidenceRefs: readonly string[];
}

/**
 * Turns a hotspot into a proposal, with no model anywhere in the decision.
 *
 * The recommendation deliberately does NOT summarise what went wrong. Extracting
 * that from prose would need a model, and the builder's own proposal table sets
 * the rule this follows: the mapping from an observation to a lesson is declared,
 * not inferred. So the lesson points at the commits and says to read them. The
 * evidence carries the content; the lesson carries the pointer.
 *
 * The limits are not decoration. A recurrence count is a fact about history, not
 * a claim that the file is badly written — it may simply be the busiest file in
 * the repository — and a lesson that does not say so would be read as a verdict.
 */
export function proposalFor(hotspot: Hotspot, repo: string): SessionProposal {
  return {
    component: hotspot.component,
    trigger: `changing ${hotspot.path} in ${repo}`,
    recommendation:
      `This file has needed ${hotspot.fixes} fix commits across ${hotspot.touches} changes. ` +
      `Read the cited fixes before changing it — each one names a defect that reached main here.`,
    scope: [repo, hotspot.path],
    limits: [
      `A recurrence count is a fact about this file's history, not a judgement on its quality: a busy file accrues fixes without being fragile.`,
      `Counted from commits reachable at harvest time; a rebase or a squash changes the count.`,
    ],
    triggerTags: ["session", "hotspot", repo],
    evidenceRefs: hotspot.recentFixShas.map((sha) => `git://${repo}@${sha}`),
  };
}

export interface HarvestSummary {
  readonly repo: string;
  readonly commits: number;
  readonly byType: Record<string, number>;
  readonly fixes: number;
  readonly withTestDelta: number;
  readonly claimingRevertProof: number;
  readonly hotspots: readonly Hotspot[];
  readonly proposals: readonly SessionProposal[];
  /** Stated when nothing qualified, because a silent empty result is the defect. */
  readonly note: string;
}

export function summarise(
  records: readonly CommitRecord[],
  repo: string,
  options: HotspotOptions = {},
): HarvestSummary {
  const byType: Record<string, number> = {};
  let withTestDelta = 0;
  let claimingRevertProof = 0;
  for (const record of records) {
    byType[record.type] = (byType[record.type] ?? 0) + 1;
    if (record.testDelta) withTestDelta += 1;
    if (record.claimsRevertProof) claimingRevertProof += 1;
  }

  const spots = hotspots(records, repo, options);
  const cap = options.propose ?? 10;
  const proposals = spots.slice(0, cap).map((spot) => proposalFor(spot, repo));
  const minFixes = options.minFixes ?? 3;

  return {
    repo,
    commits: records.length,
    byType,
    fixes: byType["fix"] ?? 0,
    withTestDelta,
    claimingRevertProof,
    hotspots: spots,
    proposals,
    note:
      spots.length > 0
        ? `${spots.length} file(s) fixed at least ${minFixes} times` +
          (spots.length > cap
            ? `; the top ${cap} would be proposed. The other ${spots.length - cap} are listed but not proposed — a packet holds five items, so proposing all of them would bury the ones that matter.`
            : ".")
        : records.length === 0
          ? "No commits in range — nothing to harvest, which is different from nothing to learn."
          : `No file reached ${minFixes} fix commits in this range; the threshold, not the history, is why this is empty.`,
  };
}
