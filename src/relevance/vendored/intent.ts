/**
 * VENDORED — see PROVENANCE.md
 * Origin : /root/antigravity-memory-os/src/retrieval/intent.ts
 * Author : Eyal Nof · License: MIT
 * Changes: RetrievalIntent narrowed to the four values this function can
 *          actually produce (the original union declared eight, four of which
 *          `inferQueryIntent` never returns); keyword lists unchanged.
 *
 * Pure function over a string. No storage coupling.
 */

export const RETRIEVAL_INTENTS = ["architecture", "history", "implementation", "exact_symbol", "general"] as const;
export type RetrievalIntent = (typeof RETRIEVAL_INTENTS)[number];

export function inferQueryIntent(query: string): RetrievalIntent {
  const q = query.toLowerCase();

  if (["architecture", "design", "overview", "structure", "flow", "spec", "relation"].some((k) => q.includes(k))) {
    return "architecture";
  }
  if (["history", "previous", "last", "yesterday", "commit", "changelog"].some((k) => q.includes(k))) {
    return "history";
  }
  if (["how to", "implement", "function", "method", "code", "class", "api"].some((k) => q.includes(k))) {
    return "implementation";
  }

  const trimmed = query.trim();
  if (
    /^[A-Z][a-zA-Z0-9]+$/.test(trimmed) ||
    /^[a-z]+[A-Z][a-zA-Z0-9]+$/.test(trimmed) ||
    trimmed.startsWith("use") ||
    trimmed.startsWith("get") ||
    trimmed.startsWith("set")
  ) {
    return "exact_symbol";
  }

  return "general";
}
