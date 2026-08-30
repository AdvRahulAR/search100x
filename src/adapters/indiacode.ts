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
import { parse } from "node-html-parser";
import { getStealthHeaders } from "../core/stealth.js";

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
        headers: getStealthHeaders(),
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
    const root = parse(html);
    const results: RawResult[] = [];
    // Try multiple selectors for IndiaCode search result links
    const links = root.querySelectorAll('a[href*="act"], a[href*="Act"], a[href*="show-data"]');
    for (const link of links) {
      if (results.length >= 10) break;
      const href = link.getAttribute("href") ?? "";
      const title = link.text.trim();
      if (!title || title.length <= 5 || !href) continue;
      // Skip navigation/menu links
      if (href.includes("javascript:") || href.startsWith("#")) continue;
      const url = href.startsWith("http") ? href : `${INDIACODE_BASE}/${href.replace(/^\//, "")}`;
      results.push({
        title,
        url,
        snippet: `Indian legislation: ${title}. Available on India Code (indiacode.nic.in).`,
      });
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
      const form = new URLSearchParams();
      form.set("searchQuery", query);
      form.set("searchSelect", "all");
      const res = await http.post(url.toString(), form.toString(), {
        timeout: timeoutMs,
        headers: {
          ...getStealthHeaders(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        responseType: "text",
      });

      if (typeof res.data !== "string") return [];
      return this.parseResults(res.data);
    } catch {
      return [];
    }
  }

  private parseResults(html: string): RawResult[] {
    const root = parse(html);
    const results: RawResult[] = [];
    const links = root.querySelectorAll('a[href*="circular"], a[href*="order"], a[href*="regulation"], a[href*="Circular"], a[href*="Order"]');
    for (const link of links) {
      if (results.length >= 10) break;
      const href = link.getAttribute("href") ?? "";
      const title = link.text.trim();
      if (!title || title.length <= 5 || !href) continue;
      if (href.includes("javascript:") || href.startsWith("#")) continue;
      const url = href.startsWith("http") ? href : `https://www.sebi.gov.in/${href.replace(/^\//, "")}`;
      results.push({
        title,
        url,
        snippet: `SEBI regulation/circular: ${title}`,
      });
    }
    return results;
  }
}
