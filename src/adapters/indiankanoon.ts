import { parse } from "node-html-parser";
import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

const KANOON_BASE = "https://indiankanoon.org";
const STATIC_UA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

export class IndianKanoonEngine implements Engine {
  readonly name = "indiankanoon" as const;

  async search(
    query: string,
    timeoutMs: number,
    _timeRange?: string,
    page = 1
  ): Promise<RawResult[]> {
    try {
      const pagenum = Math.max(0, page - 1);
      const url = new URL(`${KANOON_BASE}/search/`);
      url.searchParams.set("formInput", query);
      if (pagenum > 0) {
        url.searchParams.set("pagenum", String(pagenum));
      }

      const res = await http.get(url.toString(), {
        timeout: timeoutMs,
        headers: {
          "User-Agent": STATIC_UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
        responseType: "text",
      });

      if (typeof res.data !== "string") return [];
      return this.parseHtml(res.data);
    } catch {
      return [];
    }
  }

  private parseHtml(html: string): RawResult[] {
    const root = parse(html);
    const results: RawResult[] = [];

    const items = root.querySelectorAll(".result");
    for (const item of items) {
      if (results.length >= 10) break;

      const titleEl = item.querySelector(".result_title a");
      if (!titleEl) continue;

      const title = decodeHtml(titleEl.text.trim());
      const href = titleEl.getAttribute("href") ?? "";
      if (!title || !href) continue;

      const url = href.startsWith("http") ? href : `${KANOON_BASE}${href.startsWith("/") ? "" : "/"}${href}`;

      const headlineEl = item.querySelector(".headline");
      const snippetRaw = headlineEl ? headlineEl.text : "";
      const snippet = truncate(stripHtml(decodeHtml(snippetRaw)));

      let publishedAt: Date | undefined;
      const dateMatch = snippetRaw.match(/\bon\s+(\d{1,2}\s+[A-Za-z]+,\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{4})\b/i);
      if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d.getTime())) publishedAt = d;
      }

      results.push({
        title,
        url,
        snippet: snippet || `Indian Kanoon case law record: ${title}`,
        publishedAt,
      });
    }

    return results;
  }
}

function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
