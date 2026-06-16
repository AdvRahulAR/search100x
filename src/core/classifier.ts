// ── Live-data intent detection ────────────────────────────────────────────────

export type LiveIntent = "weather" | "stocks" | "time" | "sports_live";

const LIVE_DATA_SIGNALS: Record<LiveIntent, Record<string, number>> = {
  weather: {
    weather: 3.0, temperature: 3.0, forecast: 2.5, humidity: 2.5,
    rain: 2.0, sunny: 2.0, "feels like": 2.5, celsius: 3.0, fahrenheit: 3.0,
    wind: 1.5, storm: 2.0, cloudy: 2.0, drizzle: 2.0, snow: 2.0,
  },
  stocks: {
    stock: 2.5, "share price": 3.0, nifty: 3.0, sensex: 3.0,
    nasdaq: 3.0, nyse: 3.0, ticker: 3.0, "market cap": 3.0,
  },
  time: {
    "current time": 3.0, "what time": 3.0, timezone: 2.5, utc: 2.5,
  },
  sports_live: {
    "live score": 3.0, "match score": 3.0, wicket: 3.0, innings: 3.0,
    "playing now": 3.0, scorecard: 3.0,
  },
};

/**
 * Detects whether a query is asking for live/real-time data.
 * Returns the intent type or null if it's a normal research query.
 * Pure token arithmetic — sub-millisecond, no network.
 */
export function detectLiveIntent(query: string): LiveIntent | null {
  const lower = query.toLowerCase();
  const tokens = lower.split(/\s+/);
  const bigrams = tokens.slice(0, -1).map((t, i) => `${t} ${tokens[i + 1]}`);
  const all = [...tokens, ...bigrams];

  for (const [intent, signals] of Object.entries(LIVE_DATA_SIGNALS) as [LiveIntent, Record<string, number>][]) {
    const score = all.reduce((sum, tok) => sum + (signals[tok] ?? 0), 0);
    if (score >= 3.0) return intent;
  }
  return null;
}

// ── Domain-intent scoring ─────────────────────────────────────────────────────

// Weighted token sets per category
// Weights tuned to minimise overlap between categories
const CLASS_SIGNALS: Record<string, Record<string, number>> = {
  news: {
    // Temporal signals
    today: 2.0, yesterday: 2.0, latest: 1.8, breaking: 2.5, update: 1.5,
    // News verbs
    arrested: 2.0, announced: 1.8, launched: 1.5, killed: 2.0, elected: 2.0,
    // Temporal qualifiers
    "2024": 1.2, "2025": 1.2, "2026": 1.2, now: 1.5, recent: 1.8,
  },
  legal: {
    // Legal instruments
    act: 1.8, law: 1.5, regulation: 2.0, statute: 2.5, section: 2.0,
    clause: 2.0, amendment: 2.0, compliance: 1.8, liability: 2.0,
    // Legal actors
    court: 2.0, judge: 2.0, ruling: 2.0, verdict: 2.5, plaintiff: 3.0,
    defendant: 3.0, attorney: 2.5, litigation: 3.0, judgment: 2.5,
    // Jurisdictions
    gdpr: 3.0, hipaa: 3.0, ccpa: 3.0, sebi: 2.5, rbi: 2.0,
  },
  academic: {
    // Research signals
    paper: 1.5, study: 1.5, research: 1.8, analysis: 1.5, survey: 1.8,
    review: 1.5, findings: 2.0, methodology: 3.0, hypothesis: 3.0,
    // Academic identifiers
    arxiv: 3.0, pubmed: 3.0, doi: 3.0, journal: 2.0, abstract: 2.0,
    // Citation patterns ("et al") — check raw query
    "et al": 3.0,
  },
};

export interface QueryClass {
  category: "news" | "legal" | "academic" | "general";
  confidence: number;   // [0,1] — how strong the signal is
}

export function classifyQuery(query: string): QueryClass {
  const tokens = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return { category: "general", confidence: 1.0 };
  }

  // Also check bigrams (e.g. "et al", "section 43")
  const bigrams = tokens.slice(0, -1).map((t, i) => `${t} ${tokens[i+1]}`);
  const allTokens = [...tokens, ...bigrams];

  const scores: Record<string, number> = { news: 0, legal: 0, academic: 0 };

  for (const tok of allTokens) {
    for (const [cat, signals] of Object.entries(CLASS_SIGNALS)) {
      if (signals[tok]) scores[cat] += signals[tok];
    }
  }

  const maxScore = Math.max(...Object.values(scores));
  const total    = Object.values(scores).reduce((a, b) => a + b, 0);

  if (maxScore < 1.5) {
    return { category: "general", confidence: 1.0 };
  }

  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  const confidence = total > 0 ? maxScore / total : 0;

  // Confidence: if winner is 55%+ of total signal → high confidence
  // If two categories tie/close → low confidence → fall back to "general"
  if (confidence < 0.55) {
    return { category: "general", confidence: 0.5 };
  }

  return {
    category: winner as QueryClass["category"],
    confidence: Math.min(0.99, confidence),
  };
}
