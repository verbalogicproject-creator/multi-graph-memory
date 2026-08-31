/**
 * Saturation guard for the context packet.
 *
 * Adapted from `memory/diversity.ts` in the /root/image-studio prototype
 * (filterForDiversity), which did not survive extraction into
 * antigravity-memory-os. Retargeted here from RetrievedContext to CitedItem, with
 * per-episode capping added alongside the original per-file cap.
 *
 * Why it matters: capping the packet at three-to-five lessons does nothing if all
 * five come from the same episode or the same component. A budget limits volume;
 * only diversity limits *narrowness*, and narrowness is the actual convergence
 * failure -- an assistant that keeps rediscovering its own first answer.
 */

import type { CitedItem } from "./types.ts";

export interface DiversityOptions {
  /** Maximum items drawn from any one component. */
  maxPerComponent?: number;
  /** Maximum items drawn from any one source episode. */
  maxPerEpisode?: number;
  limit?: number;
  /**
   * Items at or above this score bypass the per-source caps. The prototype used
   * the same escape hatch for exact-symbol hits: an unambiguous match should not
   * be discarded for being the second one from its file.
   */
  exactMatchFloor?: number;
}

export interface DiversityResult {
  kept: CitedItem[];
  droppedForDiversity: number;
}

export function filterForDiversity(
  candidates: readonly CitedItem[],
  sourceEpisodeOf: (item: CitedItem) => string | undefined,
  options: DiversityOptions = {},
): DiversityResult {
  const maxPerComponent = options.maxPerComponent ?? 2;
  const maxPerEpisode = options.maxPerEpisode ?? 2;
  const limit = options.limit ?? 5;
  const exactMatchFloor = options.exactMatchFloor ?? Number.POSITIVE_INFINITY;

  const componentCounts = new Map<string, number>();
  const episodeCounts = new Map<string, number>();
  const seen = new Set<string>();
  const kept: CitedItem[] = [];
  let dropped = 0;

  for (const item of candidates) {
    if (kept.length >= limit) {
      dropped += 1;
      continue;
    }

    // Near-duplicate guard: same component and same opening prose.
    const contentKey = `${item.component ?? ""}:${item.body.slice(0, 120)}`;
    if (seen.has(contentKey)) {
      dropped += 1;
      continue;
    }

    const privileged = item.score >= exactMatchFloor;

    if (!privileged && item.component) {
      const count = componentCounts.get(item.component) ?? 0;
      if (count >= maxPerComponent) {
        dropped += 1;
        continue;
      }
    }

    const episodeId = sourceEpisodeOf(item);
    if (!privileged && episodeId) {
      const count = episodeCounts.get(episodeId) ?? 0;
      if (count >= maxPerEpisode) {
        dropped += 1;
        continue;
      }
    }

    if (item.component) componentCounts.set(item.component, (componentCounts.get(item.component) ?? 0) + 1);
    if (episodeId) episodeCounts.set(episodeId, (episodeCounts.get(episodeId) ?? 0) + 1);
    seen.add(contentKey);
    kept.push(item);
  }

  return { kept, droppedForDiversity: dropped };
}
