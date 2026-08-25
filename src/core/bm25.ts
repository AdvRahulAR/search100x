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
 *
 * Legal-aware tokenization: preserves compound legal citations (Section 498A,
 * Article 21, AIR 2020 SC 123) as single tokens, and filters Indian legal
 * boilerplate that appears in every legal passage but carries no signal.
 */

const K1 = 1.5;
const B  = 0.75;

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
  "including","according","based","within","without","before","after",
  "between","among","against","during","however","therefore","moreover",
  "whether","further","under","over","per","via","re","vs",
  // Indian legal boilerplate
  "thereof","herein","hereinafter","thereinafter","whereof","aforesaid",
  "notwithstanding","thereto","hereunder","thereunder","hereby","hereinabove",
  "hereinafter","therein","hereof","therewith","herewith","thereon","hereon",
  "hitherto","thenceforth","wherein","whereon","whereby","whereafter",
  "infra","supra","vide","pursuant","subject","respect","relation",
  "deemed","appropriate","necessary","expedient","consequent",
]);

const COMPOUND_PATTERNS: RegExp[] = [
  /\bsection\s+\d+[a-z]*\b/gi,
  /\barticle\s+\d+[a-z]*\b/gi,
  /\bclause\s+[ivx]+\b/gi,
  /\bair\s+\d{4}\s+sc\s+\d+/gi,
  /\bscc\s+\d+/gi,
  /\bw\.?\s*p\.?\s*no\.?\s*\d+/gi,
  /\bcrl\.?\s*a\.?\s*no\.?\s*\d+/gi,
  /\bcr\.?\s*no\.?\s*\d+/gi,
  /\bcvi\s*no\.?\s*\d+/gi,
  /\bipc\b/gi,
  /\bcrpc\b/gi,
  /\bbns\b/gi,
  /\bbnss\b/gi,
  /\bbsa\b/gi,
];

const LEGAL_PHRASES: RegExp[] = [
  /\bwrit petition\b/gi,
  /\bbail application\b/gi,
  /\bsuo motu\b/gi,
  /\blocus standi\b/gi,
  /\bres judicata\b/gi,
  /\bstare decisis\b/gi,
  /\bprima facie\b/gi,
  /\bamicus curiae\b/gi,
  /\bsub judice\b/gi,
  /\bcaveat petition\b/gi,
  /\bpublic interest litigation\b/gi,
  /\bcharge sheet\b/gi,
  /\bfirst information report\b/gi,
  /\bindian penal code\b/gi,
  /\bcode of criminal procedure\b/gi,
  /\bbharatiya nyaya sanhita\b/gi,
  /\bbharatiya nagarik suraksha sanhita\b/gi,
  /\bconstitution of india\b/gi,
];

export function tokenize(text: string): string[] {
  let working = text.toLowerCase();
  const compounds: string[] = [];

  for (const pattern of COMPOUND_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = globalPattern.exec(working)) !== null) {
      compounds.push(match[0].toLowerCase().replace(/\s+/g, "_"));
    }
    working = working.replace(globalPattern, " ");
  }

  for (const pattern of LEGAL_PHRASES) {
    const globalPattern = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = globalPattern.exec(working)) !== null) {
      compounds.push(match[0].toLowerCase().replace(/\s+/g, "_"));
    }
    working = working.replace(globalPattern, " ");
  }

  const genericTokens = working
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  return [...compounds, ...genericTokens];
}

export function snippetRelevanceScore(snippet: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0.5;
  const snippetTokens = snippet.toLowerCase().split(/\s+/);
  const tf = new Map<string, number>();
  for (const t of snippetTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  const N = snippetTokens.length;
  const avgLen = 40;

  for (const qt of queryTokens) {
    const f = tf.get(qt) ?? 0;
    if (f === 0) continue;
    const k1 = 1.2, b = 0.3, δ = 0.5;
    const K = k1 * (1 - b + b * N / avgLen);
    score += (f * (k1 + 1)) / (f + K) + δ;
  }

  return Math.min(1, score / queryTokens.length);
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

export function bm25Scores(query: string, docs: string[]): number[] {
  const qTerms = tokenize(query);
  if (qTerms.length === 0 || docs.length === 0) return docs.map(() => 0);

  const N         = docs.length;
  const tokenized = docs.map(tokenize);
  const tfs       = tokenized.map(termFreq);
  const totalLen  = tokenized.reduce((s, t) => s + t.length, 0);
  const avgDl     = totalLen / N || 1;

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

export function normaliseScores(raw: number[]): number[] {
  const max   = Math.max(...raw);
  const min   = Math.min(...raw);
  const range = max - min;
  if (range === 0) return raw.map(() => 0.5);
  return raw.map((s) => (s - min) / range);
}

// ── Legal citation extraction ─────────────────────────────────────────────────

const CITATION_REGEXES: RegExp[] = [
  /\bsection\s+\d+[a-z]*\b/gi,
  /\barticle\s+\d+[a-z]*\b/gi,
  /\bair\s+\d{4}\s+sc\s+\d+/gi,
  /\b(19|20)\d{2}\s+\d+\s+scc\s+\d+/gi,
  /\bw\.?\s*p\.?\s*no\.?\s*\d+/gi,
  /\bcrl\.?\s*a\.?\s*no\.?\s*\d+/gi,
];

export function legalCitations(text: string): string[] {
  const citations: string[] = [];
  for (const regex of CITATION_REGEXES) {
    const globalRegex = new RegExp(regex.source, regex.flags);
    let match;
    while ((match = globalRegex.exec(text)) !== null) {
      const citation = match[0].trim();
      if (!citations.includes(citation)) {
        citations.push(citation);
      }
    }
  }
  return citations;
}
