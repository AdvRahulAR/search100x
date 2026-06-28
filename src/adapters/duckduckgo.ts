import { parse } from "node-html-parser";
import { Engine } from "../core/engine.js";
import { RawResult, Logger } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

/**
 * DuckDuckGo Web — HTML no-JS endpoint, no API key required.
 *
 * Mechanism (from SearXNG duckduckgo.py):
 *  POST https://html.duckduckgo.com/html/
 *  Body (form-encoded): q=QUERY&kl=wt-wt&b=    (b= empty for page 1)
 *
 *  Page 1: no VQD needed — one request, parse results directly.
 *  Page 2+: VQD is extracted from the <input name="vqd"> hidden field
 *           in the page-1 response and cached for 1 hour per query.
 *
 *  Results: #links .web-result
 *    title:   h2 a (text + href is the real URL, not a redirect)
 *    snippet: a.result__snippet
 *
 *  CAPTCHA: form#challenge-form present → return []
 *
 * UA must be static — DDG ties VQD to the User-Agent used for the initial
 * page-1 request.  Changing UA between page-1 and page-2 invalidates VQD.
 */

const DDG_URL    = "https://html.duckduckgo.com/html/";
const STATIC_UA  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0";
const VQD_TTL    = 60 * 60 * 1000; // 1 hour
const VQD_MAX    = 200;             // max queries to cache per instance

const TIME_RANGE: Record<string, string> = {
  day: "d", week: "w", month: "m", year: "y",
};

const DDG_HEADERS = {
  "User-Agent":      STATIC_UA,
  "Content-Type":    "application/x-www-form-urlencoded",
  Accept:            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Sec-Fetch-Dest":  "document",
  "Sec-Fetch-Mode":  "navigate",
  "Sec-Fetch-Site":  "same-origin",
  Referer:           DDG_URL,
};

export class DuckDuckGoEngine implements Engine {
  readonly name = "duckduckgo" as const;
  // Instance-level VQD cache — isolated per EnhancedSearch instance,
  // no cross-request interference in multi-instance deployments.
  private vqdCache = new Map<string, { vqd: string; expiresAt: number }>();

  constructor(private logger?: Logger) {}

  private getCachedVqd(query: string): string | undefined {
    const entry = this.vqdCache.get(query);
    if (!entry || Date.now() > entry.expiresAt) {
      this.vqdCache.delete(query);
      return undefined;
    }
    return entry.vqd;
  }

  private cacheVqd(query: string, vqd: string): void {
    // Evict oldest entry when at capacity
    if (this.vqdCache.size >= VQD_MAX) {
      const oldest = [...this.vqdCache.entries()].reduce((a, b) =>
        a[1].expiresAt < b[1].expiresAt ? a : b
      );
      this.vqdCache.delete(oldest[0]);
    }
    this.vqdCache.set(query, { vqd, expiresAt: Date.now() + VQD_TTL });
  }

  async search(
    query: string,
    timeoutMs: number,
    timeRange?: string,
    page = 1
  ): Promise<RawResult[]> {
    const form = new URLSearchParams();
    form.set("q", query);
    form.set("kl", "wt-wt");

    if (timeRange && TIME_RANGE[timeRange]) {
      form.set("df", TIME_RANGE[timeRange]);
    }

    if (page === 1) {
      form.set("b", "");
    } else {
      const vqd = this.getCachedVqd(query);
      if (!vqd) {
        // Cannot paginate safely without VQD — DDG blocks requests without it
        this.logger?.warn(`[duckduckgo] no cached VQD for pagination — skipping page ${page}`);
        return [];
      }
      form.set("vqd", vqd);
      form.set("nextParams", "");
      form.set("api", "d.js");
      form.set("o", "json");
      form.set("v", "l");
      const offset = 10 + (page - 2) * 15; // page 2→10, page 3→25 …
      form.set("dc", String(offset + 1));
      form.set("s", String(offset));
    }

    const res = await http.post(DDG_URL, form.toString(), {
      timeout: timeoutMs,
      headers: DDG_HEADERS,
      responseType: "text",
    });

    const html = res.data as string;
    const root = parse(html);

    // CAPTCHA guard
    if (root.querySelector("form#challenge-form")) {
      this.logger?.warn("[duckduckgo] CAPTCHA detected — returning empty results");
      return [];
    }

    // Extract and cache VQD from hidden form field (for subsequent page requests)
    const vqdEl = root.querySelector('input[name="vqd"]');
    if (vqdEl) {
      const vqd = vqdEl.getAttribute("value");
      if (vqd) this.cacheVqd(query, vqd);
    }

    const results: RawResult[] = [];

    for (const el of root.querySelectorAll("#links .web-result")) {
      const link    = el.querySelector("h2 a");
      const title   = link?.text.trim() ?? "";
      const url     = link?.getAttribute("href") ?? "";
      const snippet = truncate(stripHtml(el.querySelector("a.result__snippet")?.text ?? ""));

      if (!title || !url || !url.startsWith("http")) continue;
      results.push({ title, url, snippet });
    }

    return results;
  }
}

