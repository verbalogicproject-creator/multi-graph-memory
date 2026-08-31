/**
 * Deterministic lexical scorer — the offline fallback.
 *
 * Adapted from /root/antigravity-memory-os/src/retrieval/lexical.ts (Eyal Nof,
 * MIT). Retargeted from ChunkRecord fields to lesson fields, with exact
 * trigger-tag matching added as its own weighted signal.
 *
 * Deliberately NOT BM25: when a real FTS5 index is available the SQLite adapter
 * supplies BM25 instead. This exists so the browser projection and the
 * in-memory adapter stay useful with no index and no vectors, which Ruling 4
 * requires.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for",
  "with", "is", "are", "was", "were", "be", "been", "it", "that", "this",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

export interface LexicalTarget {
  id: string;
  trigger: string;
  recommendation: string;
  scope: readonly string[];
  triggerTags?: readonly string[];
}

export interface LexicalScore {
  id: string;
  score: number;
  matched: string[];
}

/**
 * Weighted containment. An exact trigger-tag hit is the strongest signal here,
 * because a bug signature matching exactly is qualitatively different from prose
 * overlapping.
 */
export function scoreLexical(query: string, target: LexicalTarget): LexicalScore | null {
  const tokens = tokenize(query);
  if (tokens.length === 0) return null;

  const trigger = target.trigger.toLowerCase();
  const recommendation = target.recommendation.toLowerCase();
  const scope = target.scope.join(" ").toLowerCase();
  const tags = (target.triggerTags ?? []).map((t) => t.toLowerCase());

  let raw = 0;
  const matched: string[] = [];

  for (const token of tokens) {
    let hit = 0;
    if (tags.includes(token)) hit += 6;          // exact signature match
    if (trigger.includes(token)) hit += 3;
    if (scope.includes(token)) hit += 2;
    if (recommendation.includes(token)) hit += 1;
    if (hit > 0) {
      raw += hit;
      matched.push(token);
    }
  }

  if (raw === 0) return null;
  // Normalised against the best achievable score for this query length.
  return { id: target.id, score: Math.min(1, raw / (tokens.length * 6)), matched };
}
