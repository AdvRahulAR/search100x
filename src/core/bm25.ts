/**
 * BM25 query-result relevance scorer
 * ───────────────────────────────────
 * Post-RRF noise filter: blends each result's RRF score with a BM25 similarity
 * score between the user query and the result's title + snippet.
 *
 * Standard BM25 parameters: k1=1.5, b=0.75
 *
 * Corpus-size problem: with N=15 results, raw IDF is nearly useless — a term
 * appearing in 8/15 docs and one appearing in 1/15 docs differ by only 3×.
 * The fix is a stopword list: remove ubiquitous English and legal function words
 * before computing IDF, so only content-bearing query terms contribute to score.
 */

const K1 = 1.5;
const B  = 0.75;

// High-frequency English function words that carry no discriminative signal.
// Legal/academic variants (act, law, court, rule) are intentionally NOT in this
// list — they are content-bearing in our domain.
const STOPWORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","up","about","into","through","during","is","are","was","were",
  "be","been","being","have","has","had","do","does","did","will","would",
  "could","should","may","might","shall","can","this","that","these","those",
  "it","its","they","them","their","we","our","you","your","i","my","he","his",
  "she","her","not","no","nor","so","yet","either","as","if","while",
  "although","because","since","when","where","which","who","whom","whose",
  "what","how","than","then","just","also","more","most","other",
  "such","same","any","all","each","every","both","few","s",
  // common connective/presentational words with no content signal
  "including","according","based","within","without","before","after",
  "between","among","against","during","however","therefore","moreover",
  "whether","further","under","over","per","via","re","vs",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Compute BM25 scores for a query against a list of documents.
 *
 * @param query  User query string
 * @param docs   Array of strings (title + " " + snippet per result)
 * @returns      Scores in [0, ∞), same length as docs. 0 = no query term overlap.
 */
export function bm25Scores(query: string, docs: string[]): number[] {
  const qTerms = tokenize(query);
  if (qTerms.length === 0 || docs.length === 0) return docs.map(() => 0);

  const N         = docs.length;
  const tokenized = docs.map(tokenize);
  const tfs       = tokenized.map(termFreq);
  const totalLen  = tokenized.reduce((s, t) => s + t.length, 0);
  const avgDl     = totalLen / N || 1;

  // Per-term IDF across this result set
  const idf = new Map<string, number>();
  for (const term of qTerms) {
    if (idf.has(term)) continue;
    const df = tokenized.filter((tok) => tok.includes(term)).length;
    idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
  }

  return tfs.map((tf, i) => {
    const dl      = tokenized[i].length;
    const lenNorm = 1 - B + B * (dl / avgDl);
    let score = 0;
    for (const term of qTerms) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) continue;
      const tfScore = (freq * (K1 + 1)) / (freq + K1 * lenNorm);
      score += (idf.get(term) ?? 0) * tfScore;
    }
    return score;
  });
}

/**
 * Blend RRF scores with normalised BM25 scores.
 *
 * final = α × rrf + (1-α) × bm25_norm
 *
 * α=0.4: preserves cross-engine consensus signal; penalises off-topic results
 * that ranked well on only one engine.
 */
export const BM25_ALPHA = 0.4;

export function blendScores(rrfNorm: number[], bm25Raw: number[]): number[] {
  const max   = Math.max(...bm25Raw);
  const min   = Math.min(...bm25Raw);
  const range = max - min;
  const bm25Norm = range === 0
    ? bm25Raw.map(() => 0.5)
    : bm25Raw.map((s) => (s - min) / range);

  return rrfNorm.map((rrf, i) => BM25_ALPHA * rrf + (1 - BM25_ALPHA) * bm25Norm[i]);
}
