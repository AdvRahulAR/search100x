import { TimeRange } from "./types.js";

/**
 * Domain presets — named shorthands for common authoritative-source queries.
 * Pass a preset's value as `scopedDomains` in SearchOptions, or build your own.
 */
export const DOMAIN_PRESETS: Record<string, string[]> = {
  "india-legal": [
    "indiacode.nic.in",
    "india.gov.in",
    "mca.gov.in",
    "sebi.gov.in",
    "rbi.org.in",
    "irdai.gov.in",
    "trai.gov.in",
    "meity.gov.in",
    "supremecourt.gov.in",
    "legislative.gov.in",
  ],
  "us-legal": [
    "law.cornell.edu",
    "federalregister.gov",
    "congress.gov",
    "sec.gov",
    "ftc.gov",
    "regulations.gov",
    "justice.gov",
    "supremecourt.gov",
  ],
  "uk-legal": [
    "legislation.gov.uk",
    "gov.uk",
    "judiciary.uk",
    "ico.org.uk",
    "fca.org.uk",
    "cma.gov.uk",
  ],
  "eu-legal": [
    "eur-lex.europa.eu",
    "europarl.europa.eu",
    "ec.europa.eu",
    "edpb.europa.eu",
    "curia.europa.eu",
    "esma.europa.eu",
  ],
  "au-legal": [
    "legislation.gov.au",
    "austlii.edu.au",
    "oaic.gov.au",
    "asic.gov.au",
    "accc.gov.au",
  ],
  "sg-legal": [
    "sso.agc.gov.sg",
    "pdpc.gov.sg",
    "mas.gov.sg",
    "agc.gov.sg",
  ],
  "academic": [
    "arxiv.org",
    "pubmed.ncbi.nlm.nih.gov",
    "ssrn.com",
    "jstor.org",
    "semanticscholar.org",
  ],
};

export interface QueryBundle {
  /** Exact user query — sent to most engines */
  primary: string;
  /** Same as primary — kept for engines that previously used "recent" */
  recent: string;
  /** site:-restricted to caller-specified domains; equals primary if none given */
  scoped: string;
  /** Resolved time range, passed per-engine to their native freshness params */
  timeRange?: TimeRange;
  /** 1-indexed result page */
  page: number;
}

// Token-level synonym map for high-value domains
// Legal, medical, and tech synonyms cover 80% of professional queries
export const SYNONYMS: Record<string, string[]> = {
  // Legal
  "erasure":       ["deletion", "forgotten", "removal"],
  "obligation":    ["requirement", "duty", "mandate"],
  "fine":          ["penalty", "sanction", "enforcement"],
  "gdpr":          ["data protection regulation", "dsgvo"],
  "ai act":        ["artificial intelligence act", "eu ai regulation"],
  // Technical
  "transformer":   ["attention mechanism", "self-attention"],
  "llm":           ["large language model", "language model", "foundation model"],
  "rag":           ["retrieval augmented generation", "retrieval augmented"],
  // Medical
  "heart attack":  ["myocardial infarction", "cardiac arrest"],
  "stroke":        ["cerebrovascular accident", "CVA"],
};

export function expandQuery(query: string): string {
  const lower = query.toLowerCase();
  const expansions: string[] = [];

  for (const [term, alts] of Object.entries(SYNONYMS)) {
    if (lower.includes(term)) {
      // Add one best alternative — don't bloat the query
      expansions.push(alts[0]);
    }
  }

  if (expansions.length === 0) return query;
  // Append as OR clause — most engines support this
  return `${query} OR ${expansions.slice(0, 2).join(" OR ")}`;
}

/**
 * Build a QueryBundle from user input.
 *
 * The `recent` variant no longer appends year text — that polluted BM25 scoring
 * and changed the semantic meaning of the query. Time-range filtering is now
 * handled by each engine's native freshness parameter (see DDG `df=`, Bing
 * `freshness=`) using the `timeRange` field in the bundle.
 */
export function buildQueryBundle(
  query: string,
  scopedDomains?: string[],
  timeRange?: TimeRange,
  page = 1
): QueryBundle {
  const base = query.trim();

  const scoped =
    scopedDomains && scopedDomains.length > 0
      ? scopedDomains.map((d) => `site:${d}`).join(" OR ") + ` ${base}`
      : base;

  return {
    primary: expandQuery(base),
    recent: base,   // no longer injects years — engines use timeRange instead
    scoped,
    timeRange,
    page,
  };
}
