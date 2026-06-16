import express from "express";
import { EnhancedSearch, DOMAIN_PRESETS } from "./search.js";
import { SourceName } from "./core/types.js";

const search = new EnhancedSearch({
  braveApiKey:  process.env.BRAVE_API_KEY,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  googleApiKey: process.env.GOOGLE_API_KEY,
  googleCx:     process.env.GOOGLE_CX,
  timeoutMs:    Number(process.env.TIMEOUT_MS ?? 7000),
  newsRegion:   process.env.NEWS_REGION ?? "US",
});

const app = express();
app.use(express.json());

/**
 * GET /search
 *
 * Query params:
 *   q        — required, the search query
 *   limit    — max results (default: 15)
 *   sources  — comma-separated engine names
 *   preset   — domain preset name (india-legal, us-legal, uk-legal, eu-legal, ...)
 *   scope    — comma-separated custom domains (alternative to preset)
 *   enrich   — fetch top-N page contents (default: 0)
 *
 * Examples:
 *   /search?q=GDPR+article+17
 *   /search?q=Competition+Act+UK&preset=uk-legal
 *   /search?q=SEC+rule+10b-5&preset=us-legal&limit=10
 *   /search?q=EU+AI+Act&scope=eur-lex.europa.eu,ec.europa.eu&enrich=3
 */
app.get("/search", async (req, res) => {
  const { q, limit, sources, preset, scope, enrich } = req.query;

  if (!q || typeof q !== "string") {
    res.status(400).json({ error: "Missing required param: q" });
    return;
  }

  // Resolve domain scope: preset name takes precedence over raw scope list
  let scopedDomains: string[] | undefined;
  if (typeof preset === "string") {
    const domains = DOMAIN_PRESETS[preset];
    if (!domains) {
      res.status(400).json({
        error: `Unknown preset "${preset}"`,
        available: Object.keys(DOMAIN_PRESETS),
      });
      return;
    }
    scopedDomains = domains;
  } else if (typeof scope === "string") {
    scopedDomains = scope.split(",").map((d) => d.trim()).filter(Boolean);
  }

  try {
    const response = await search.search(q, {
      limit:        limit ? Number(limit) : 15,
      sources:      typeof sources === "string" ? (sources.split(",") as SourceName[]) : undefined,
      scopedDomains,
      enrichTopN:   enrich ? Number(enrich) : 0,
    });
    res.json(response);
  } catch (err) {
    console.error("[server]", err);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/presets", (_req, res) =>
  res.json(
    Object.fromEntries(
      Object.entries(DOMAIN_PRESETS).map(([name, domains]) => [name, domains])
    )
  )
);

app.get("/health", (_req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.get("/metrics", (_req, res) =>
  res.json({ circuitBreakers: search.metrics() })
);

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`search100x API  http://localhost:${PORT}`);
  console.log(`  GET /search?q=GDPR+right+to+erasure`);
  console.log(`  GET /search?q=Competition+law+UK&preset=uk-legal`);
  console.log(`  GET /search?q=SEC+enforcement&preset=us-legal&limit=10`);
  console.log(`  GET /presets        — list all domain presets`);
  console.log(`  GET /metrics        — circuit breaker state`);
});
