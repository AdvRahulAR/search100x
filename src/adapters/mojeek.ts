import { parse } from "node-html-parser";
import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

/**
 * Mojeek — HTML scraper, no API key, independent search index.
 *
 * Mechanism (from SearXNG mojeek.py):
 *  GET https://www.mojeek.com/search?q=QUERY&safe=0
 *  Cookie: lb=en (language), arc=global (region)
 *
 *  Selectors:
 *    results:  ul.results-standard > li
 *    url:      a.ob[href]          (outer link)
 *    title:    h2 a                (inner heading link)
 *    snippet:  p.s                 (description paragraph)
 *
 * Mojeek's own crawler index makes it complementary to Bing/DDG —
 * it finds different results, boosting cross-engine consensus signal.
 */

export class MojeekEngine implements Engine {
  readonly name = "mojeek" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const res = await http.get("https://www.mojeek.com/search", {
      params: { q: query, safe: 0 },
      timeout: timeoutMs,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      responseType: "text",
    });

    const root = parse(res.data as string);
    const results: RawResult[] = [];

    for (const el of root.querySelectorAll("ul.results-standard li")) {
      const url     = el.querySelector("a.ob")?.getAttribute("href") ?? "";
      const title   = el.querySelector("h2 a")?.text.trim() ?? "";
      const snippet = truncate(el.querySelector("p.s")?.text.trim() ?? "");

      if (!url || !title) continue;
      results.push({ title, url, snippet });
    }

    return results;
  }
}
