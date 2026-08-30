import { parse } from "node-html-parser";
import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";
import { getStealthHeaders, getRandomProfile } from "../core/stealth.js";

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
    // Cross-runtime base64url decode (works in Node.js and Deno)
    // base64url uses '-' and '_' instead of '+' and '/'
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const decoded = atob(padded);
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
        ...getStealthHeaders(),
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Sec-Fetch-Site": "none",
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
