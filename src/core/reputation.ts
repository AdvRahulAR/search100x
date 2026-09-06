const BOOST_DOMAINS: Record<string, number> = {
  // Tech
  "github.com": 0.85, "stackoverflow.com": 0.82, "developer.mozilla.org": 0.90,
  "docs.python.org": 0.88, "pkg.go.dev": 0.85, "crates.io": 0.82,
  "nodejs.org": 0.88, "npmjs.com": 0.80, "pypi.org": 0.80,
  "huggingface.co": 0.88, "news.ycombinator.com": 0.85, "gitlab.com": 0.82,
  "kubernetes.io": 0.88, "docker.com": 0.85, "bleepingcomputer.com": 0.85,
  "nvd.nist.gov": 0.95, "cve.mitre.org": 0.95, "owasp.org": 0.88,
  // Business & Finance
  "bloomberg.com": 0.88, "wsj.com": 0.86, "cnbc.com": 0.82, "hbr.org": 0.88,
  "marketwatch.com": 0.82, "forbes.com": 0.80, "fortune.com": 0.80,
  "techcrunch.com": 0.82, "venturebeat.com": 0.80, "crunchbase.com": 0.82,
  "economictimes.indiatimes.com": 0.85, "livemint.com": 0.85,
  "business-standard.com": 0.85, "moneycontrol.com": 0.84,
  "financialexpress.com": 0.82, "investopedia.com": 0.82,
  "coindesk.com": 0.82, "cointelegraph.com": 0.80, "defillama.com": 0.85,
  // News
  "reuters.com": 0.85, "apnews.com": 0.85, "bbc.com": 0.82,
  "ft.com": 0.85, "economist.com": 0.85, "theatlantic.com": 0.78,
  // Legal/regulatory
  "law.cornell.edu": 0.95, "sec.gov": 0.95, "eur-lex.europa.eu": 0.95,
  // Indian legal sources
  "indiankanoon.org": 0.95, "main.sci.gov.in": 0.95, "sci.gov.in": 0.95,
  "indiacode.nic.in": 0.95, "legislative.gov.in": 0.93, "sebi.gov.in": 0.90,
  "rbi.org.in": 0.90, "irdai.gov.in": 0.88, "trai.gov.in": 0.85,
  "mca.gov.in": 0.95, "ibbi.gov.in": 0.92,
  "doj.gov.in": 0.93, "njdg.ecourts.gov.in": 0.90,
  "districts.ecourts.gov.in": 0.88, "nclat.nic.in": 0.90,
  "tdsat.gov.in": 0.88, "nclt.gov.in": 0.90,
  "cbdt.gov.in": 0.88, "cbic.gov.in": 0.88,
  "egazette.gov.in": 0.93, "latestlaws.com": 0.85,
  // Indian legal news / commentary / case law reporters
  "livelaw.in": 0.98, "barandbench.com": 0.98, "scconline.com": 0.98,
  "thehindu.com": 0.90, "indianexpress.com": 0.90, "scobserver.in": 0.98,
  // Academic & Science
  "scholar.google.com": 0.88, "semanticscholar.org": 0.85, "arxiv.org": 0.92,
  "nature.com": 0.92, "science.org": 0.92, "pubmed.ncbi.nlm.nih.gov": 0.95,
};

const PENALISE_PATTERNS = [
  /\b(top|best)[\s-]?\d+\b/i,          // "top 10", "top10", "best-5"
  /\b(deals?|coupon|discount|promo)\b/i,
  /\b(click.?here|buy.?now|order.?now)\b/i,
  /\baffiliate\b/i,
  /\b(brewing|distilling|realesaletter|trans4mind)\b/i,
];

const GOV_EDU = /\.(gov|edu|ac\.[a-z]{2,4})$/;
const TRUSTED  = /wikipedia\.org|reuters\.com|bbc\.(com|co\.uk)|arxiv\.org|pubmed\.ncbi|nature\.com|science\.org|indiankanoon\.org|main\.sci\.gov\.in|sci\.gov\.in|indiacode\.nic\.in/;
const ORG      = /\.org$/;

function getBaseTldScore(host: string): number {
  if (GOV_EDU.test(host))  return 1.00;
  if (TRUSTED.test(host))  return 0.80;
  if (ORG.test(host))      return 0.70;
  return 0.50;
}

let customBoosts: Record<string, number> = {};

/** Set custom domain authority overrides — merged with built-in boosts */
export function setCustomDomainBoosts(boosts: Record<string, number>): void {
  customBoosts = { ...boosts };
}

export function domainReputation(url: string): number {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    // Exact match first
    if (host in customBoosts) {
      const target = customBoosts[host];
      const base = getBaseTldScore(host);
      return target / base;
    }
    if (host in BOOST_DOMAINS) {
      const target = BOOST_DOMAINS[host];
      const base = getBaseTldScore(host);
      return target / base;
    }
    // Try parent domain (e.g., docs.scconline.com → scconline.com)
    const parts = host.split(".");
    if (parts.length > 2) {
      const parent = parts.slice(1).join(".");
      if (parent in customBoosts) {
        const target = customBoosts[parent];
        const base = getBaseTldScore(host);
        return target / base;
      }
      if (parent in BOOST_DOMAINS) {
        const target = BOOST_DOMAINS[parent];
        const base = getBaseTldScore(host);
        return target / base;
      }
    }
  } catch {
    // ignore
  }
  return 1.0;
}

export function spamSignalScore(title: string, snippet: string, url = ""): number {
  const text = `${title} ${snippet} ${url}`;
  const hits = PENALISE_PATTERNS.filter(p => p.test(text)).length;
  // Stronger penalty: each matching pattern cuts score by half, floor at 0.05
  return hits > 0 ? Math.max(0.05, Math.pow(0.35, hits)) : 1.0;
}