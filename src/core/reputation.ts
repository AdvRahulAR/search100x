const BOOST_DOMAINS: Record<string, number> = {
  // Tech
  "github.com": 0.85, "stackoverflow.com": 0.82, "developer.mozilla.org": 0.90,
  "docs.python.org": 0.88, "pkg.go.dev": 0.85, "crates.io": 0.82,
  "nodejs.org": 0.88, "npmjs.com": 0.80, "pypi.org": 0.80,
  // News
  "reuters.com": 0.85, "apnews.com": 0.85, "bbc.com": 0.82,
  "ft.com": 0.82, "economist.com": 0.82, "theatlantic.com": 0.78,
  // Legal/regulatory
  "law.cornell.edu": 0.95, "sec.gov": 0.95, "eur-lex.europa.eu": 0.95,
  // Academic
  "scholar.google.com": 0.88, "semanticscholar.org": 0.85,
};

const PENALISE_PATTERNS = [
  /\b(top|best)[\s-]?\d+\b/i,          // "top 10", "top10", "best-5"
  /\b(deals?|coupon|discount|promo)\b/i,
  /\b(click.?here|buy.?now|order.?now)\b/i,
  /\baffiliate\b/i,
];

const GOV_EDU = /\.(gov|edu|ac\.[a-z]{2,4})$/;
const TRUSTED  = /wikipedia\.org|reuters\.com|bbc\.(com|co\.uk)|arxiv\.org|pubmed\.ncbi|nature\.com|science\.org/;
const ORG      = /\.org$/;

function getBaseTldScore(host: string): number {
  if (GOV_EDU.test(host))  return 1.00;
  if (TRUSTED.test(host))  return 0.80;
  if (ORG.test(host))      return 0.70;
  return 0.50;
}

export function domainReputation(url: string): number {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host in BOOST_DOMAINS) {
      const target = BOOST_DOMAINS[host];
      const base = getBaseTldScore(host);
      return target / base;
    }
  } catch {
    // ignore
  }
  return 1.0;
}

export function spamSignalScore(title: string, snippet: string): number {
  const text = `${title} ${snippet}`;
  const hits = PENALISE_PATTERNS.filter(p => p.test(text)).length;
  // Graded penalty: each matching pattern removes 0.20, floor at 0.40
  // Prevents a single "Top 10" in a legitimate headline from burying the result
  return Math.max(0.40, 1.0 - hits * 0.20);
}
