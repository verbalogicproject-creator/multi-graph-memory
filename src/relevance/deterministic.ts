/**
 * The default relevance adapter: facets + lexical + recency, fused with RRF.
 *
 * Fully offline. No network, no key, no provider — this is what keeps the
 * package useful when embeddings are unavailable, and what the core test suite
 * runs against so `verify:pure` can pass with @google/genai not even installed.
 *
 * A real BM25 index is used when the storage adapter offers one (SQLite/FTS5);
 * otherwise it falls back to the deterministic scorer.
 */

import { reciprocalRankFusion, type RankedInput } from "./vendored/rank_fusion.ts";
import { inferQueryIntent } from "./vendored/intent.ts";
import { scoreLexical } from "./lexical.ts";
import type { RelevanceAdapter, RelevanceQuery, ScoredLesson } from "./adapter.ts";
import type { Lesson } from "../core/types.ts";
import { hasLexicalIndex, type LexicalIndex } from "../adapters/storage.ts";

export interface DeterministicOptions {
  /** A SQLite adapter, or anything else implementing LexicalIndex. */
  lexicalIndex?: LexicalIndex | unknown;
  halfLifeDays?: number;
  now?: () => number;
}

export class DeterministicRelevanceAdapter implements RelevanceAdapter {
  readonly name = "deterministic";
  private readonly lexicalIndex: LexicalIndex | null;
  private readonly halfLifeDays: number;
  private readonly now: () => number;

  constructor(options: DeterministicOptions = {}) {
    this.lexicalIndex = hasLexicalIndex(options.lexicalIndex) ? options.lexicalIndex : null;
    this.halfLifeDays = options.halfLifeDays ?? 14;
    this.now = options.now ?? (() => Date.now());
  }

  async rank(candidates: readonly Lesson[], query: RelevanceQuery): Promise<ScoredLesson[]> {
    if (candidates.length === 0) return [];

    const byId = new Map(candidates.map((lesson) => [lesson.id, lesson]));
    const referenceTime = this.now();
    const intent = inferQueryIntent(query.task);

    const timing = (lesson: Lesson): Pick<RankedInput, "timestamp" | "accessCount"> => ({
      timestamp: Date.parse(lesson.updatedAt),
      accessCount: lesson.reuseCount,
    });

    /* lexical: BM25 when an index exists, deterministic scoring otherwise */
    let lexical: RankedInput[];
    const indexed = this.lexicalIndex?.searchLessons(query.projectId, query.task, candidates.length * 2) ?? [];
    const usable = indexed.filter((hit) => byId.has(hit.lessonId));

    if (usable.length > 0) {
      lexical = usable.map((hit) => {
        const lesson = byId.get(hit.lessonId)!;
        return { id: hit.lessonId, score: hit.score, ...timing(lesson) };
      });
    } else {
      lexical = candidates
        .map((lesson) => {
          const scored = scoreLexical(query.task, lesson);
          return scored ? { id: lesson.id, score: scored.score, ...timing(lesson) } : null;
        })
        .filter((item): item is RankedInput => item !== null)
        .sort((a, b) => b.score - a.score);
    }

    /**
     * Exact trigger-tag matches form their own signal. A bug signature matching
     * exactly is categorically stronger than prose overlap, and giving it a
     * separate list means RRF rewards agreement between the two.
     */
    const wanted = new Set((query.triggerTags ?? []).map((t) => t.toLowerCase()));
    const exact: RankedInput[] = wanted.size === 0
      ? []
      : candidates
          .filter((lesson) => (lesson.triggerTags ?? []).some((tag) => wanted.has(tag.toLowerCase())))
          .map((lesson) => ({ id: lesson.id, score: 1, sourceType: "architecture", ...timing(lesson) }));

    /* recency alone, so a fresh lesson with weak text still surfaces */
    const recency: RankedInput[] = [...candidates]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((lesson) => ({ id: lesson.id, score: 1, ...timing(lesson) }));

    const fused = reciprocalRankFusion(
      recency,   // semantic slot: recency stands in when no vectors are present
      lexical,
      exact,
      intent,
      60,
      this.halfLifeDays,
      referenceTime,
    );

    const out: ScoredLesson[] = [];
    for (const candidate of fused) {
      const lesson = byId.get(candidate.id);
      if (!lesson) continue;
      out.push({
        lesson,
        score: candidate.finalScore,
        reason: candidate.reason,
        signals: {
          ...(candidate.lexicalScore === undefined ? {} : { lexical: candidate.lexicalScore }),
          ...(candidate.decayMultiplier === undefined ? {} : { recency: candidate.decayMultiplier }),
        },
      });
    }

    return query.limit === undefined ? out : out.slice(0, query.limit);
  }
}
