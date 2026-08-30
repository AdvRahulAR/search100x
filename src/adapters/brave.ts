import { parse } from "node-html-parser";
import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

/**
 * Brave Search — API version. Requires an API key.
 * Uses the official Brave Search API for structured JSON results.
 */
export class BraveEngine implements Engine {
  readonly name = "brave" as const;
  constructor(private apiKey: string) {}

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "10");
    url.searchParams.set("text_decorations", "false");
    const res = await http.get(url.toString(), {
      timeout: timeoutMs,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
    });
    const data = res.data as Record<string, unknown> | undefined;
    const web = data?.web as Record<string, unknown> | undefined;
    const items = (web?.results as Array<Record<string, unknown>>) ?? [];
    return items.map((r) => ({
      title:   (r.title as string) ?? "",
      url:     (r.url as string) ?? "",
      snippet: truncate(stripHtml(((r.extra_snippets as string[] | undefined)?.[0] ?? (r.description as string) ?? ""))),
    }));
  }
}

/**
 * Brave Search — HTML scraper, no API key required.
 *
 * Mechanism (from SearXNG brave.py):
 *  GET https://search.brave.com/search?q=QUERY&source=web
 *
 *  Results: div.snippet
 *    title:   .title a (text + href)
 *    snippet: .snippet-description
 *
 *  Bot detection: Brave may return a challenge page or 429.
 *  We detect this by checking for the absence of .snippet elements
 *  and return an empty array — the circuit breaker handles backoff.
 *
 *  Time-range: tfe=day|week|month|year (Brave's freshness parameter)
 *  Pagination: page=1, page=2, ...
 */
const BRAVE_FREE_URL = "https://search.brave.com/search";
const BRAVE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0";

const TFE: Record<string, string> = {
  day: "pd", week: "pw", month: "pm", year: "py",
};

export class BraveFreeEngine implements Engine {
  readonly name = "brave" as const;

  async search(
    query: string,
    timeoutMs: number,
    timeRange?: string,
    page = 1,
  ): Promise<RawResult[]> {
    const params: Record<string, string | number> = {
      q: query,
      source: "web",
      page,
    };
    if (timeRange && TFE[timeRange]) {
      params.tfe = TFE[timeRange];
    }

    const res = await http.get(BRAVE_FREE_URL, {
      params,
      timeout: timeoutMs,
      headers: {
        "User-Agent": BRAVE_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
      responseType: "text",
    });

    const root = parse(res.data as string);
    const results: RawResult[] = [];

    // Brave's HTML structure: div.snippet contains the result
    for (const el of root.querySelectorAll("div.snippet")) {
      const titleEl = el.querySelector(".title a") ?? el.querySelector("a.title");
      const title = titleEl?.text.trim() ?? "";
      const url = titleEl?.getAttribute("href") ?? "";
      if (!title || !url || !url.startsWith("http")) continue;

      const snippetEl = el.querySelector(".snippet-description") ?? el.querySelector(".snippet-content");
      const snippet = truncate(stripHtml(snippetEl?.text ?? ""));

      results.push({ title, url, snippet });
    }

    return results;
  }
}
