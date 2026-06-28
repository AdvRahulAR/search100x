import { SearchResult } from "./types.js";

function jaccardTokens(a: string, b: string): number {
  const A = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 1));
  const B = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 1));
  const intersection = [...A].filter(t => B.has(t)).length;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Groups results into subtopic clusters using title token Jaccard similarity.
 * Two results are in the same cluster if jaccardTokens(title_A, title_B) > threshold.
 * Uses greedy single-linkage: assign each result to the first cluster it matches.
 * 
 * Returns: one representative (highest-scoring) result per cluster, 
 * followed by unrepresented results sorted by score.
 * 
 * threshold = 0.35 (tune: lower → more clusters, higher → fewer clusters)
 */
export function clusterResults(
  results: SearchResult[],
  limit: number,
  threshold = 0.35
): SearchResult[] {
  const clusters: SearchResult[][] = [];

  for (const r of results) {
    let assigned = false;
    for (const cluster of clusters) {
      // Check similarity with any member of the cluster
      const matches = cluster.some(c => jaccardTokens(r.title, c.title) > threshold);
      if (matches) {
        cluster.push(r);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push([r]);
    }
  }

  // Pick the highest-scoring result from each cluster as representative
  const representatives = clusters.map(c =>
    c.reduce((best, r) => r.score > best.score ? r : best)
  );
  const representativeSet = new Set(representatives);
  const others: SearchResult[] = [];
  for (const cluster of clusters) {
    for (const r of cluster) {
      if (!representativeSet.has(r)) others.push(r);
    }
  }

  representatives.sort((a, b) => b.score - a.score);
  others.sort((a, b) => b.score - a.score);

  const finalResults = [...representatives, ...others];
  return finalResults.slice(0, limit);
}
