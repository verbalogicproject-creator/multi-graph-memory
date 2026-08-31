/**
 * VENDORED — see PROVENANCE.md
 * Origin : /root/antigravity-memory-os/src/retrieval/rank_fusion.ts
 * Author : Eyal Nof · License: MIT
 * Changes: RankedCandidate trimmed to the fields this package populates;
 *          RetrievalIntent imported from the vendored intent module; the three
 *          near-identical per-list loops collapsed into one fuseList helper.
 *          Formula, weights, k=60, half-life and decay floor are UNCHANGED.
 *
 * RRF sums weight/(k + rank + 1) across signals, then applies time decay once
 * post-fusion. Intent-conditioned weights are the original's, preserved exactly
 * so behaviour matches the engine this descends from.
 */

import type { RetrievalIntent } from "./intent.ts";

export interface RankedInput {
  id: string;
  score: number;
  sourceType?: string;
  timestamp?: number;
  lastAccessedAt?: number;
  accessCount?: number;
}

export interface RankedCandidate {
  id: string;
  semanticRank?: number;
  semanticScore?: number;
  lexicalRank?: number;
  lexicalScore?: number;
  graphScore?: number;
  sourceType?: string;
  timestamp?: number;
  lastAccessedAt?: number;
  accessCount?: number;
  decayMultiplier?: number;
  finalScore: number;
  reason: string;
}

export const DEFAULT_RRF_K = 60;
export const DEFAULT_HALF_LIFE_DAYS = 14;
export const DEFAULT_DECAY_FLOOR = 0.1;

export function calculateRRFScore(rank: number, weight = 1, k = DEFAULT_RRF_K): number {
  return weight / (k + rank);
}

/**
 * Exponential half-life decay with a frequency boost, floored so an old-but-real
 * lesson never decays to nothing. This is the anti-ossification lever: weight
 * falls with staleness and rises with confirmed reuse.
 */
export function calculateTimeDecay(
  timestamp?: number,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  minDecayFloor = DEFAULT_DECAY_FLOOR,
  referenceTime = Date.now(),
  lastAccessedAt?: number,
  accessCount?: number,
): number {
  const effective = Math.max(timestamp ?? 0, lastAccessedAt ?? 0);
  if (!effective || effective <= 0) return 1;

  const ageDays = Math.max(0, referenceTime - effective) / 86_400_000;
  let decay = Math.pow(2, -ageDays / halfLifeDays);

  if (accessCount && accessCount > 0) {
    decay *= 1 + Math.min(0.2, Math.log10(accessCount + 1) * 0.1);
  }

  return Math.max(minDecayFloor, Math.min(1, decay));
}

function semanticWeight(intent: RetrievalIntent, sourceType?: string): number {
  if (intent === "exact_symbol") return 0.6;
  if (intent === "architecture" && sourceType === "architecture") return 1.5;
  return 1;
}

function lexicalWeight(intent: RetrievalIntent): number {
  if (intent === "exact_symbol") return 2.5;
  if (intent === "implementation") return 1.3;
  return 1;
}

function graphWeight(intent: RetrievalIntent): number {
  return intent === "architecture" ? 2.2 : 1.2;
}

export function reciprocalRankFusion(
  semanticRankings: readonly RankedInput[],
  lexicalRankings: readonly RankedInput[],
  graphRankings: readonly RankedInput[] = [],
  intent: RetrievalIntent = "general",
  k = DEFAULT_RRF_K,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  referenceTime = Date.now(),
): RankedCandidate[] {
  const candidates = new Map<string, RankedCandidate>();

  const fuseList = (
    list: readonly RankedInput[],
    weightOf: (item: RankedInput) => number,
    describe: (item: RankedInput, rank: number) => string,
    assign: (candidate: RankedCandidate, item: RankedInput, rank: number) => void,
  ): void => {
    list.forEach((item, rank) => {
      const rrf = weightOf(item) / (k + rank + 1);
      const existing = candidates.get(item.id);
      if (existing) {
        existing.finalScore += rrf;
        existing.reason += ` + ${describe(item, rank)}`;
        assign(existing, item, rank);
        return;
      }
      const candidate: RankedCandidate = {
        id: item.id,
        ...(item.sourceType === undefined ? {} : { sourceType: item.sourceType }),
        ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
        ...(item.lastAccessedAt === undefined ? {} : { lastAccessedAt: item.lastAccessedAt }),
        ...(item.accessCount === undefined ? {} : { accessCount: item.accessCount }),
        finalScore: rrf,
        reason: describe(item, rank),
      };
      assign(candidate, item, rank);
      candidates.set(item.id, candidate);
    });
  };

  fuseList(
    semanticRankings,
    (item) => semanticWeight(intent, item.sourceType),
    (item, rank) => `semantic (cosine ${item.score.toFixed(3)}, #${rank + 1})`,
    (candidate, item, rank) => {
      candidate.semanticRank = rank + 1;
      candidate.semanticScore = item.score;
    },
  );

  fuseList(
    lexicalRankings,
    () => lexicalWeight(intent),
    (item, rank) => `lexical (${item.score.toFixed(3)}, #${rank + 1})`,
    (candidate, item, rank) => {
      candidate.lexicalRank = rank + 1;
      candidate.lexicalScore = item.score;
    },
  );

  fuseList(
    graphRankings,
    () => graphWeight(intent),
    (item) => `graph (${item.score.toFixed(3)})`,
    (candidate, item) => {
      candidate.graphScore = item.score;
    },
  );

  const fused = [...candidates.values()];
  for (const candidate of fused) {
    const decay = calculateTimeDecay(
      candidate.timestamp,
      halfLifeDays,
      DEFAULT_DECAY_FLOOR,
      referenceTime,
      candidate.lastAccessedAt,
      candidate.accessCount,
    );
    candidate.decayMultiplier = decay;
    candidate.finalScore *= decay;
  }

  fused.sort((a, b) => (b.finalScore === a.finalScore ? (a.id < b.id ? -1 : 1) : b.finalScore - a.finalScore));
  return fused;
}
