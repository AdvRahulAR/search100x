/**
 * Wikipedia full-text engine — fetches the actual article text
 * (not just the search snippet) using the MediaWiki extracts API.
 *
 * Phase 3: Enhanced Sources
 * Uses the REST API /page/summary and /page/html endpoints for
 * richer content than the standard search API.
 */

import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { http, HttpError } from "../core/http.js";
import { stripHtml, truncate } from "../core/normalizer.js";

async function fetchWithRetry(url: string, timeoutMs: number, attempt = 0): Promise<RawResult[]> {
  try {
    const res = await http.get(url, { timeout: timeoutMs });
    const items: Array<{ title: string; snippet: string }> = res.data?.query?.search ?? [];
    return items.map((r) => ({
      title: r.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
      snippet: truncate(stripHtml(r.snippet ?? "")),
    }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      return fetchWithRetry(url, timeoutMs, attempt + 1);
    }
    throw err;
  }
}

export class WikipediaFullTextEngine implements Engine {
  readonly name = "wikipedia" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    // Step 1: Search for relevant articles
    const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
    searchUrl.searchParams.set("action", "query");
    searchUrl.searchParams.set("list", "search");
    searchUrl.searchParams.set("srsearch", query);
    searchUrl.searchParams.set("srlimit", "5");
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("origin", "*");

    const results = await fetchWithRetry(searchUrl.toString(), timeoutMs);

    // Step 2: Fetch full-text extracts for top results (parallel, non-blocking)
    if (results.length > 0) {
      const extractPromises = results.slice(0, 3).map(async (r) => {
        try {
          const extractUrl = new URL("https://en.wikipedia.org/api/rest_v1/page/summary/" +
            encodeURIComponent(r.title.replace(/ /g, "_")));
          const extractRes = await http.get(extractUrl.toString(), { timeout: 3000 });
          const extract = extractRes.data?.extract;
          if (extract && extract.length > r.snippet.length) {
            r.snippet = extract;
          }
        } catch {
          // Keep original snippet if extract fetch fails
        }
        return r;
      });
      // Race against timeout — don't block on extracts
      await Promise.race([
        Promise.all(extractPromises),
        new Promise((r) => setTimeout(r, Math.min(timeoutMs, 3000))),
      ]);
    }

    return results;
  }
}

/**
 * DuckDuckGo Lite engine — HTML scraping fallback that works without
 * JavaScript rendering. More reliable than the HTML API for some queries.
 *
 * Phase 3: Fallback Engines
 */
export class DuckDuckGoLiteEngine implements Engine {
  readonly name = "duckduckgo" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    try {
      const url = new URL("https://lite.duckduckgo.com/lite/");
      const res = await http.post(url.toString(), {
        q: query,
        kl: "",
      }, {
        timeout: timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "text/html",
        },
        responseType: "text",
      });

      if (typeof res.data !== "string") return [];
      return this.parseLiteHtml(res.data);
    } catch {
      return [];
    }
  }

  private parseLiteHtml(html: string): RawResult[] {
    const results: RawResult[] = [];
    // DDG Lite has simple HTML tables with results
    const rowPattern = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/gi;
    let match;
    while ((match = rowPattern.exec(html)) !== null && results.length < 10) {
      const url = match[1];
      const title = match[2].trim().replace(/&/g, "&");
      const snippet = match[3].replace(/<[^>]+>/g, "").trim();
      if (url && title && !url.includes("duckduckgo.com")) {
        results.push({ title, url, snippet });
      }
    }
    return results;
  }
}

/**
 * Google News India engine — fetches India-local news.
 *
 * Phase 3: Locale-aware engines
 */
export class GoogleNewsIndiaEngine implements Engine {
  readonly name = "googlenews" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    try {
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", query);
      url.searchParams.set("hl", "en-IN");
      url.searchParams.set("gl", "IN");
      url.searchParams.set("ceid", "IN:en");

      const res = await http.get(url.toString(), {
        timeout: timeoutMs,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; search100x/3.0)" },
        responseType: "text",
      });

      if (typeof res.data !== "string") return [];
      return this.parseRss(res.data);
    } catch {
      return [];
    }
  }

  private parseRss(xml: string): RawResult[] {
    const results: RawResult[] = [];
    const itemPattern = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<pubDate>([\s\S]*?)<\/pubDate>[\s\S]*?<\/item>/gi;
    let match;
    while ((match = itemPattern.exec(xml)) !== null && results.length < 10) {
      const title = match[1].trim();
      const url = match[2].trim();
      const dateStr = match[3].trim();
      let publishedAt: Date | undefined;
      try { publishedAt = new Date(dateStr); } catch { /* ignore */ }
      results.push({
        title,
        url,
        snippet: title,
        publishedAt,
      });
    }
    return results;
  }
}
