import { TimeRange, DomainCategory, DomainCategoryInfo } from "./types.js";

/**
 * Domain presets — named shorthands for common authoritative-source queries.
 * Pass a preset's value as `scopedDomains` in SearchOptions, or build your own.
 */
export const DOMAIN_PRESETS: Record<string, string[]> = {
  // --- Legal Presets ---
  "legal": [
    "law.cornell.edu",
    "legislation.gov.uk",
    "eur-lex.europa.eu",
    "indiankanoon.org",
    "indiacode.nic.in",
    "supremecourt.gov",
    "main.sci.gov.in",
    "curia.europa.eu",
    "courtlistener.com",
    "bailii.org",
    "austlii.edu.au",
  ],
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
    "main.sci.gov.in",
    "sci.gov.in",
    "legislative.gov.in",
    "indiankanoon.org",
    "livelaw.in",
    "barandbench.com",
    "scconline.com",
    "scobserver.in",
    "ibbi.gov.in",
    "ncbc.gov.in",
    "gst.gov.in",
    "doj.gov.in",
    "egazette.gov.in",
    "nclat.nic.in",
    "nclt.gov.in",
    "tdsat.gov.in",
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
    "courtlistener.com",
    "justia.com",
    "oyez.org",
  ],
  "uk-legal": [
    "legislation.gov.uk",
    "gov.uk",
    "judiciary.uk",
    "ico.org.uk",
    "fca.org.uk",
    "cma.gov.uk",
    "bailii.org",
    "nationalarchives.gov.uk",
  ],
  "eu-legal": [
    "eur-lex.europa.eu",
    "europarl.europa.eu",
    "ec.europa.eu",
    "edpb.europa.eu",
    "curia.europa.eu",
    "esma.europa.eu",
    "eba.europa.eu",
  ],
  "au-legal": [
    "legislation.gov.au",
    "austlii.edu.au",
    "oaic.gov.au",
    "asic.gov.au",
    "accc.gov.au",
    "hcourt.gov.au",
  ],
  "sg-legal": [
    "sso.agc.gov.sg",
    "pdpc.gov.sg",
    "mas.gov.sg",
    "agc.gov.sg",
    "judiciary.gov.sg",
  ],

  // --- Tech Presets ---
  "tech": [
    "github.com",
    "news.ycombinator.com",
    "stackoverflow.com",
    "dev.to",
    "huggingface.co",
    "hashnode.com",
  ],
  "tech-ai": [
    "huggingface.co",
    "arxiv.org",
    "paperswithcode.com",
    "openai.com",
    "anthropic.com",
    "deepmind.google",
    "replicate.com",
    "distill.pub",
  ],
  "tech-dev": [
    "github.com",
    "gitlab.com",
    "stackoverflow.com",
    "developer.mozilla.org",
    "npmjs.com",
    "pypi.org",
    "crates.io",
    "pkg.go.dev",
  ],
  "tech-security": [
    "cve.mitre.org",
    "nvd.nist.gov",
    "bleepingcomputer.com",
    "krebsonsecurity.com",
    "thehackernews.com",
    "portswigger.net",
    "owasp.org",
    "darkreading.com",
  ],
  "tech-cloud": [
    "aws.amazon.com",
    "cloud.google.com",
    "learn.microsoft.com",
    "kubernetes.io",
    "docker.com",
    "cloudflare.com",
    "datadoghq.com",
  ],

  // --- Business & Finance Presets ---
  "business": [
    "bloomberg.com",
    "reuters.com",
    "wsj.com",
    "ft.com",
    "forbes.com",
    "fortune.com",
    "economist.com",
    "cnbc.com",
    "hbr.org",
    "marketwatch.com",
  ],
  "business-india": [
    "economictimes.indiatimes.com",
    "livemint.com",
    "business-standard.com",
    "moneycontrol.com",
    "financialexpress.com",
    "bseindia.com",
    "nseindia.com",
    "sebi.gov.in",
  ],
  "finance": [
    "bloomberg.com",
    "ft.com",
    "wsj.com",
    "reuters.com",
    "cnbc.com",
    "marketwatch.com",
    "investopedia.com",
    "sec.gov",
    "morningstar.com",
  ],
  "crypto": [
    "coindesk.com",
    "cointelegraph.com",
    "defillama.com",
    "theblock.co",
    "decrypt.co",
    "messari.io",
    "etherscan.io",
  ],
  "startups": [
    "techcrunch.com",
    "venturebeat.com",
    "crunchbase.com",
    "sifted.eu",
    "inc42.com",
    "ycombinator.com",
    "producthunt.com",
  ],

  // --- Academic & Science ---
  "academic": [
    "arxiv.org",
    "pubmed.ncbi.nlm.nih.gov",
    "ssrn.com",
    "jstor.org",
    "semanticscholar.org",
    "nature.com",
    "science.org",
    "researchgate.net",
    "biorxiv.org",
    "medrxiv.org",
  ],

  // --- Medical & Healthcare ---
  "medical": [
    "pubmed.ncbi.nlm.nih.gov",
    "ncbi.nlm.nih.gov",
    "who.int",
    "cdc.gov",
    "thelancet.com",
    "nejm.org",
    "bmj.com",
    "mayoclinic.org",
    "fda.gov",
    "cochranelibrary.com",
  ],
};

/**
 * Domain Categories — high-level groups that organize specific domain presets
 * into overarching industry and research categories (Legal, Tech, Business, Academic, Medical).
 */
export const DOMAIN_CATEGORIES: Record<DomainCategory, DomainCategoryInfo> = {
  legal: {
    name: "Legal",
    description: "Statutes, regulations, court judgments, gazettes, and legal commentary across multiple jurisdictions",
    presets: {
      "legal": DOMAIN_PRESETS["legal"],
      "india-legal": DOMAIN_PRESETS["india-legal"],
      "us-legal": DOMAIN_PRESETS["us-legal"],
      "uk-legal": DOMAIN_PRESETS["uk-legal"],
      "eu-legal": DOMAIN_PRESETS["eu-legal"],
      "au-legal": DOMAIN_PRESETS["au-legal"],
      "sg-legal": DOMAIN_PRESETS["sg-legal"],
    },
    allDomains: [...new Set([
      ...DOMAIN_PRESETS["legal"],
      ...DOMAIN_PRESETS["india-legal"],
      ...DOMAIN_PRESETS["us-legal"],
      ...DOMAIN_PRESETS["uk-legal"],
      ...DOMAIN_PRESETS["eu-legal"],
      ...DOMAIN_PRESETS["au-legal"],
      ...DOMAIN_PRESETS["sg-legal"],
    ])],
  },
  tech: {
    name: "Tech",
    description: "Software engineering, artificial intelligence, security vulnerabilities, developer docs, and cloud platforms",
    presets: {
      "tech": DOMAIN_PRESETS["tech"],
      "tech-ai": DOMAIN_PRESETS["tech-ai"],
      "tech-dev": DOMAIN_PRESETS["tech-dev"],
      "tech-security": DOMAIN_PRESETS["tech-security"],
      "tech-cloud": DOMAIN_PRESETS["tech-cloud"],
    },
    allDomains: [...new Set([
      ...DOMAIN_PRESETS["tech"],
      ...DOMAIN_PRESETS["tech-ai"],
      ...DOMAIN_PRESETS["tech-dev"],
      ...DOMAIN_PRESETS["tech-security"],
      ...DOMAIN_PRESETS["tech-cloud"],
    ])],
  },
  business: {
    name: "Business",
    description: "Global business news, financial markets, startup ecosystems, VC funding, and cryptocurrency",
    presets: {
      "business": DOMAIN_PRESETS["business"],
      "business-india": DOMAIN_PRESETS["business-india"],
      "finance": DOMAIN_PRESETS["finance"],
      "crypto": DOMAIN_PRESETS["crypto"],
      "startups": DOMAIN_PRESETS["startups"],
    },
    allDomains: [...new Set([
      ...DOMAIN_PRESETS["business"],
      ...DOMAIN_PRESETS["business-india"],
      ...DOMAIN_PRESETS["finance"],
      ...DOMAIN_PRESETS["crypto"],
      ...DOMAIN_PRESETS["startups"],
    ])],
  },
  academic: {
    name: "Academic",
    description: "Peer-reviewed scientific journals, research repositories, open access preprints, and scholarly publications",
    presets: {
      "academic": DOMAIN_PRESETS["academic"],
    },
    allDomains: [...new Set(DOMAIN_PRESETS["academic"])],
  },
  medical: {
    name: "Medical",
    description: "Health organizations, clinical trial registries, biomedical research, and medical guidelines",
    presets: {
      "medical": DOMAIN_PRESETS["medical"],
    },
    allDomains: [...new Set(DOMAIN_PRESETS["medical"])],
  },
};

/** Get all unique domains for a high-level category (e.g., "legal", "tech", "business") */
export function getCategoryDomains(category: string): string[] {
  const cat = category.toLowerCase() as DomainCategory;
  if (cat in DOMAIN_CATEGORIES) {
    return DOMAIN_CATEGORIES[cat].allDomains;
  }
  return [];
}

/** List all available category keys */
export function listDomainCategories(): DomainCategory[] {
  return Object.keys(DOMAIN_CATEGORIES) as DomainCategory[];
}

/** List all available preset names */
export function listDomainPresets(): string[] {
  return Object.keys(DOMAIN_PRESETS);
}

/**
 * Resolves a preset or category name to its domain list.
 * Supports exact preset names (e.g. "tech-ai", "india-legal") or category names (e.g. "tech", "business", "legal").
 */
export function resolvePresetDomains(name: string): string[] | undefined {
  const lower = name.trim().toLowerCase();
  if (lower in DOMAIN_PRESETS) {
    return DOMAIN_PRESETS[lower];
  }
  const cat = lower as DomainCategory;
  if (cat in DOMAIN_CATEGORIES) {
    return DOMAIN_CATEGORIES[cat].allDomains;
  }
  return undefined;
}

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
  // Indian legal
  "ipc":           ["indian penal code", "bharatiya nyaya sanhita"],
  "crpc":          ["code of criminal procedure", "bharatiya nagarik suraksha sanhita"],
  "fir":           ["first information report", "police complaint"],
  "498a":          ["dowry harassment", "cruelty by husband"],
  "bns":           ["bharatiya nyaya sanhita", "indian penal code"],
  "bnss":          ["bharatiya nagarik suraksha sanhita", "code of criminal procedure"],
  // Technical
  "transformer":   ["attention mechanism", "self-attention"],
  "llm":           ["large language model", "language model", "foundation model"],
  "rag":           ["retrieval augmented generation", "retrieval augmented"],
  "k8s":           ["kubernetes"],
  "vector db":     ["vector database", "embeddings search"],
  // Business & Finance
  "ipo":           ["initial public offering", "public issue"],
  "m&a":           ["mergers and acquisitions", "acquisition"],
  "ebitda":        ["operating profit", "operating earnings"],
  "pe ratio":      ["price to earnings", "valuation multiple"],
  "vc":            ["venture capital", "startup funding"],
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

  let scoped = base;
  if (scopedDomains && scopedDomains.length > 0) {
    const topDomains = scopedDomains.slice(0, 6);
    const siteClause = topDomains.map((d) => `site:${d}`).join(" OR ");
    scoped = `(${siteClause}) ${base}`;
  }

  return {
    primary: expandQuery(base),
    recent: base,   // no longer injects years — engines use timeRange instead
    scoped,
    timeRange,
    page,
  };
}
