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
  // Indian legal sources
  "indiankanoon.org": 0.95, "main.sci.gov.in": 0.95, "sci.gov.in": 0.95,
  "indiacode.nic.in": 0.95, "legislative.gov.in": 0.93, "sebi.gov.in": 0.90,
  "rbi.org.in": 0.90, "irdai.gov.in": 0.88, "trai.gov.in": 0.85,
  "mca.gov.in": 0.95, "ibbi.gov.in": 0.92,
  // Indian legal news / commentary / case law reporters
  "livelaw.in": 0.98, "barandbench.com": 0.98, "scconline.com": 0.98,
  "thehindu.com": 0.90, "indianexpress.com": 0.90, "scobserver.in": 0.98,
  // Academic
  "scholar.google.com": 0.88, "semanticscholar.org": 0.85,
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

export function spamSignalScore(title: string, snippet: string, url = ""): number {
  const text = `${title} ${snippet} ${url}`;
  const hits = PENALISE_PATTERNS.filter(p => p.test(text)).length;
  // Stronger penalty: each matching pattern cuts score by half, floor at 0.05
  return hits > 0 ? Math.max(0.05, Math.pow(0.35, hits)) : 1.0;
}