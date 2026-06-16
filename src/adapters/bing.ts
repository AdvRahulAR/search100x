import { parse } from "node-html-parser";
import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

/**
 * Bing Web — HTML scraper, no API key required.
 *
 * Mechanism (from SearXNG bing.py):
 *  GET https://www.bing.com/search?q=QUERY&mkt=en-US&adlt=off&first=1
 *
 *  Results: ol#b_results li.b_algo
 *    title:   h2 a
 *    content: p elements (strip span.algoSlug_icon first)
 *
 *  URL encoding:
 *    Bing wraps outbound URLs: bing.com/ck/a?!&&p=...&u=a1{BASE64URL}&ntb=1
 *    Strip "a1" prefix, base64url-decode to get the real URL.
 *
 *  Time-range: freshness=Day|Week|Month  (no Year — Bing doesn't support it)
 *  Pagination:  first=1 (page 1), first=11 (page 2), first=21 (page 3) ...
 */

const FRESHNESS: Record<string, string> = { day: "Day", week: "Week", month: "Month" };

function decodeBingUrl(href: string): string {
  try {
    const u = new URL(href);
    if (!href.includes("bing.com/ck/a")) return href;
    const uParam = u.searchParams.get("u");
    if (!uParam?.startsWith("a1")) return href;
    const encoded = uParam.slice(2);
    const padded  = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64url").toString("utf-8");
    // Validate decoded value is a real URL before returning
    new URL(decoded);
    return decoded;
  } catch {
    return href;
  }
}

export class BingEngine implements Engine {
  readonly name = "bing" as const;

  constructor(private region = "US") {}

  async search(
    query: string,
    timeoutMs: number,
    timeRange?: string,
    page = 1
  ): Promise<RawResult[]> {
    const mkt   = `en-${this.region.toUpperCase()}`;
    const first = (page - 1) * 10 + 1;

    const params: Record<string, string | number> = {
      q:    query,
      mkt:  mkt,
      adlt: "off",
      first,
    };
    if (timeRange && FRESHNESS[timeRange]) {
      params.freshness = FRESHNESS[timeRange];
    }

    const res = await http.get("https://www.bing.com/search", {
      params,
      timeout: timeoutMs,
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
        Accept:            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        Connection:        "keep-alive",
        "Sec-Fetch-Dest":  "document",
        "Sec-Fetch-Mode":  "navigate",
        "Sec-Fetch-Site":  "none",
      },
      responseType: "text",
    });

    const root = parse(res.data as string);
    const results: RawResult[] = [];

    for (const el of root.querySelectorAll("ol#b_results li.b_algo")) {
      const link  = el.querySelector("h2 a");
      const title = link?.text.trim() ?? "";
      const rawHref = link?.getAttribute("href") ?? "";
      if (!title || !rawHref) continue;

      const url = decodeBingUrl(rawHref);

      for (const icon of el.querySelectorAll("span.algoSlug_icon")) {
        icon.remove();
      }
      const snippet = truncate(
        stripHtml(el.querySelectorAll("p").map((p) => p.text).join(" "))
      );
      results.push({ title, url, snippet });
    }

    return results;
  }
}
