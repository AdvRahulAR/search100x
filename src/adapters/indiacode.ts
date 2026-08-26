/**
 * IndiaCode engine — searches the India Code database (indiacode.nic.in)
 * for central acts, sections, and amendments.
 *
 * Phase 3: Indian Legal Source Adapters
 * Ported from Vaquill-AI/open-india-law indiacode-html-extractor.ts
 *
 * Uses the SectionPageContent API endpoint that returns structured
 * act/section/footnote data in HTML format.
 */

import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { http } from "../core/http.js";

const INDIACODE_BASE = "https://www.indiacode.nic.in";
const SEARCH_URL = `${INDIACODE_BASE}/search`;

export class IndiaCodeEngine implements Engine {
  readonly name = "indiacode" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      const url = new URL(SEARCH_URL);
      url.searchParams.set("query", query);
      url.searchParams.set("searchType", "act");

      const res = await http.get(url.toString(), {
        timeout: timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
          "Accept": "text/html",
          "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131"',
          "sec-ch-ua-platform": '"Windows"',
          "sec-ch-ua-mobile": "?0",
        },
        responseType: "text",
      });

      clearTimeout(timer);

      if (typeof res.data !== "string") return [];
      return this.parseSearchResults(res.data, query);
    } catch {
      return [];
    }
  }

  private parseSearchResults(html: string, query: string): RawResult[] {
    const results: RawResult[] = [];
    // Look for act listing links
    const actPattern = /<a[^>]+href="([^"]*act[^"]*)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = actPattern.exec(html)) !== null && results.length < 10) {
      const url = match[1].startsWith("http") ? match[1] : `${INDIACODE_BASE}/${match[1].replace(/^\//, "")}`;
      const title = match[2].trim();
      if (title.length > 5) {
        results.push({
          title,
          url,
          snippet: `Indian legislation: ${title}. Available on India Code (indiacode.nic.in).`,
        });
      }
    }
    return results;
  }
}

/**
 * SEBI engine — searches SEBI (Securities and Exchange Board of India) for
 * regulations, circulars, and orders.
 *
 * Uses the SEBI public search API at sebi.gov.in.
 */
export class SebiEngine implements Engine {
  readonly name = "sebi" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    try {
      const url = new URL("https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doSearch=yes");
      const res = await http.post(url.toString(), {
        searchQuery: query,
        searchSelect: "all",
      }, {
        timeout: timeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      if (typeof res.data !== "string") return [];
      return this.parseResults(res.data);
    } catch {
      return [];
    }
  }

  private parseResults(html: string): RawResult[] {
    const results: RawResult[] = [];
    const linkPattern = /<a[^>]+href="([^"]*(?:circular|order|regulation)[^"]*)"[^>]*>([^<]+)<\/a>/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null && results.length < 10) {
      const url = match[1].startsWith("http") ? match[1] : `https://www.sebi.gov.in${match[1]}`;
      results.push({
        title: match[2].trim(),
        url,
        snippet: `SEBI regulation: ${match[2].trim()}`,
      });
    }
    return results;
  }
}
