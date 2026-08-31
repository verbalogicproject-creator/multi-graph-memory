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
import { byScoreThenId } from "./embedded.ts";
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
        .sort(byScoreThenId);
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

    /**
     * The semantic slot is left EMPTY here, deliberately.
     *
     * An earlier version passed recency into it, which both double-counted
     * recency -- the fusion already applies time decay to every candidate -- and
     * made every packet cite a "cosine" score that was never computed. A
     * deterministic adapter has no semantic signal, and saying so is the honest
     * behaviour. Real cosine similarity lives in EmbeddedRelevanceAdapter.
     *
     * A consequence worth stating: a lesson with no lexical overlap and no tag
     * match does not surface at all. That is correct. Surfacing it purely for
     * being recent is noise, and noise is what erodes a bounded packet.
     */
    const fused = reciprocalRankFusion(
      [],        // no semantic signal without an embedding adapter
      lexical,
      exact,
      intent,
      60,
      this.halfLifeDays,
      referenceTime,
    );

    const exactIds = new Set(exact.map((item) => item.id));
    const usedBm25 = usable.length > 0;

    const out: ScoredLesson[] = [];
    for (const candidate of fused) {
      const lesson = byId.get(candidate.id);
      if (!lesson) continue;

      /**
       * The reason is rebuilt here rather than taken from the fusion helper.
       * That helper labels its first list "semantic (cosine ...)", but this
       * adapter passes RECENCY into that slot -- there is no vector signal at
       * all. Reporting a cosine score that was never computed would make every
       * citation in the packet untrue.
       */
      const parts: string[] = [];
      if (exactIds.has(candidate.id)) parts.push("exact trigger-tag match");
      if (candidate.lexicalScore !== undefined) {
        parts.push(`${usedBm25 ? "BM25" : "lexical"} ${candidate.lexicalScore.toFixed(3)}`);
      }
      if (candidate.decayMultiplier !== undefined) {
        parts.push(`recency ${candidate.decayMultiplier.toFixed(2)}`);
      }
      if (lesson.reuseCount > 0) parts.push(`reused ${lesson.reuseCount}x`);
      parts.push(`domain ${lesson.domain}`);

      out.push({
        lesson,
        score: candidate.finalScore,
        reason: parts.join(", "),
        signals: {
          ...(candidate.lexicalScore === undefined ? {} : { lexical: candidate.lexicalScore }),
          ...(candidate.decayMultiplier === undefined ? {} : { recency: candidate.decayMultiplier }),
        },
      });
    }

    return query.limit === undefined ? out : out.slice(0, query.limit);
  }
}
