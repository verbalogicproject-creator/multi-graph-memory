/**
 * Embedding-backed relevance: real cosine similarity in the semantic slot.
 *
 * This is where Ruling 2's "embeddings are required as a production relevance
 * capability" actually lands. It composes with the deterministic signals rather
 * than replacing them -- lexical and exact-tag matching still run, and RRF
 * rewards agreement between them and the vector signal.
 *
 * Ruling 1 still holds absolutely: this adapter reorders recall. It cannot
 * qualify a lesson, satisfy reuse, or declare a contradiction, and the interface
 * gives it no way to try.
 *
 * Ruling 3: every embed goes through `guardedEmbed`, so the redaction gate runs
 * before any text reaches the provider.
 */

import { contentDigest } from "../core/canonical.ts";
import { guardedEmbed, partitionBySpace, type EmbeddingAdapter } from "./embedding-port.ts";
import { cosineSimilarity } from "./vendored/math.ts";
import { reciprocalRankFusion, type RankedInput } from "./vendored/rank_fusion.ts";
import { inferQueryIntent } from "./vendored/intent.ts";
import { scoreLexical } from "./lexical.ts";
import { hasLexicalIndex, type LexicalIndex } from "../adapters/storage.ts";
import type { RelevanceAdapter, RelevanceQuery, ScoredLesson } from "./adapter.ts";
import type { VectorStore } from "./vector-store.ts";
import type { Lesson } from "../core/types.ts";

/**
 * Total ordering. Sorting on score alone leaves equal-scoring items in input
 * order, which makes the whole ranking depend on the order candidates happened
 * to arrive in -- so the same query could rank differently between two calls.
 * The id tiebreak makes the order total and therefore reproducible.
 */
export function byScoreThenId(a: { id: string; score: number }, b: { id: string; score: number }): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The exact text embedded for a lesson. Its digest detects edits that need a re-embed. */
export function lessonDocumentText(lesson: Lesson): string {
  return [lesson.recommendation, `scope: ${lesson.scope.join(", ")}`, ...(lesson.limits.length ? [`limits: ${lesson.limits.join(" ")}`] : [])].join("\n");
}

export interface EmbeddedOptions {
  embedder: EmbeddingAdapter;
  vectors: VectorStore;
  lexicalIndex?: LexicalIndex | unknown;
  halfLifeDays?: number;
  /** Minimum cosine for a lesson to count as a semantic hit. */
  minSimilarity?: number;
  now?: () => number;
}

export interface IndexResult {
  embedded: number;
  reused: number;
  reEmbedded: number;
}

export class EmbeddedRelevanceAdapter implements RelevanceAdapter {
  readonly name = "embedded";
  private readonly embedder: EmbeddingAdapter;
  private readonly vectors: VectorStore;
  private readonly lexicalIndex: LexicalIndex | null;
  private readonly halfLifeDays: number;
  private readonly minSimilarity: number;
  private readonly now: () => number;

  constructor(options: EmbeddedOptions) {
    this.embedder = options.embedder;
    this.vectors = options.vectors;
    this.lexicalIndex = hasLexicalIndex(options.lexicalIndex) ? options.lexicalIndex : null;
    this.halfLifeDays = options.halfLifeDays ?? 14;
    this.minSimilarity = options.minSimilarity ?? 0.25;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Ensures every lesson has a current vector. Re-embeds when the embedding
   * space changed OR when the lesson text itself changed -- either would
   * otherwise produce a confidently wrong similarity.
   */
  async indexLessons(lessons: readonly Lesson[]): Promise<IndexResult> {
    const result: IndexResult = { embedded: 0, reused: 0, reEmbedded: 0 };

    for (const lesson of lessons) {
      const text = lessonDocumentText(lesson);
      const digest = contentDigest(text);
      const existing = this.vectors.get(lesson.id);

      if (existing) {
        const sameSpace = partitionBySpace([existing], this.embedder.metadata).usable.length === 1;
        if (sameSpace && existing.contentDigest === digest) {
          result.reused += 1;
          continue;
        }
        result.reEmbedded += 1;
      } else {
        result.embedded += 1;
      }

      const stored = await guardedEmbed(this.embedder, {
        text,
        role: "document",
        title: lesson.trigger,
      });

      this.vectors.put({
        lessonId: lesson.id,
        projectId: lesson.projectId,
        values: stored.values,
        metadata: stored.metadata,
        contentDigest: digest,
        embeddedAt: new Date(this.now()).toISOString(),
      });
    }

    return result;
  }

  async rank(candidates: readonly Lesson[], query: RelevanceQuery): Promise<ScoredLesson[]> {
    if (candidates.length === 0) return [];

    const byId = new Map(candidates.map((lesson) => [lesson.id, lesson]));
    const referenceTime = this.now();
    const intent = inferQueryIntent(query.task);
    const timing = (lesson: Lesson) => ({ timestamp: Date.parse(lesson.updatedAt), accessCount: lesson.reuseCount });

    /* semantic: genuine cosine similarity against same-space vectors only */
    const queryVector = await guardedEmbed(this.embedder, {
      text: query.task,
      role: "query",
      task: intent === "exact_symbol" || intent === "implementation" ? "code-retrieval" : "search",
    });

    const stored = candidates
      .map((lesson) => this.vectors.get(lesson.id))
      .filter((v): v is NonNullable<typeof v> => v !== null);
    const { usable, needsReembed } = partitionBySpace(stored, this.embedder.metadata);

    const semantic: RankedInput[] = [];
    for (const vector of usable) {
      const lesson = byId.get(vector.lessonId);
      if (!lesson) continue;
      const score = cosineSimilarity(queryVector.values, vector.values);
      if (score >= this.minSimilarity) semantic.push({ id: lesson.id, score, ...timing(lesson) });
    }
    semantic.sort(byScoreThenId);

    /* lexical */
    const indexed = this.lexicalIndex?.searchLessons(query.projectId, query.task, candidates.length * 2) ?? [];
    const usableHits = indexed.filter((hit) => byId.has(hit.lessonId));
    let lexical: RankedInput[];
    if (usableHits.length > 0) {
      lexical = usableHits.map((hit) => ({ id: hit.lessonId, score: hit.score, ...timing(byId.get(hit.lessonId)!) }));
    } else {
      lexical = [];
      for (const lesson of candidates) {
        const scored = scoreLexical(query.task, lesson);
        if (scored) lexical.push({ id: lesson.id, score: scored.score, ...timing(lesson) });
      }
      lexical.sort(byScoreThenId);
    }

    /* exact trigger-tag agreement */
    const wanted = new Set((query.triggerTags ?? []).map((t) => t.toLowerCase()));
    const exact: RankedInput[] = wanted.size === 0
      ? []
      : candidates
          .filter((lesson) => (lesson.triggerTags ?? []).some((tag) => wanted.has(tag.toLowerCase())))
          .map((lesson) => ({ id: lesson.id, score: 1, sourceType: "architecture", ...timing(lesson) }));

    const fused = reciprocalRankFusion(semantic, lexical, exact, intent, 60, this.halfLifeDays, referenceTime);

    const semanticScores = new Map(semantic.map((item) => [item.id, item.score]));
    const exactIds = new Set(exact.map((item) => item.id));
    const usedBm25 = usableHits.length > 0;
    const staleIds = new Set(needsReembed.map((v) => v.lessonId));

    const out: ScoredLesson[] = [];
    for (const candidate of fused) {
      const lesson = byId.get(candidate.id);
      if (!lesson) continue;

      const parts: string[] = [];
      const cosine = semanticScores.get(candidate.id);
      if (cosine !== undefined) parts.push(`cosine ${cosine.toFixed(3)}`);
      if (exactIds.has(candidate.id)) parts.push("exact trigger-tag match");
      if (candidate.lexicalScore !== undefined) {
        parts.push(`${usedBm25 ? "BM25" : "lexical"} ${candidate.lexicalScore.toFixed(3)}`);
      }
      if (candidate.decayMultiplier !== undefined) parts.push(`recency ${candidate.decayMultiplier.toFixed(2)}`);
      if (lesson.reuseCount > 0) parts.push(`reused ${lesson.reuseCount}x`);
      if (staleIds.has(candidate.id)) parts.push("vector stale — re-embed pending");
      parts.push(`domain ${lesson.domain}`);

      out.push({
        lesson,
        score: candidate.finalScore,
        reason: parts.join(", "),
        signals: {
          ...(cosine === undefined ? {} : { semantic: cosine }),
          ...(candidate.lexicalScore === undefined ? {} : { lexical: candidate.lexicalScore }),
          ...(candidate.decayMultiplier === undefined ? {} : { recency: candidate.decayMultiplier }),
        },
      });
    }

    return query.limit === undefined ? out : out.slice(0, query.limit);
  }
}
