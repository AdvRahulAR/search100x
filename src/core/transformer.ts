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
    primary: base,
    recent: base,   // no longer injects years — engines use timeRange instead
    scoped,
    timeRange,
    page,
  };
}
