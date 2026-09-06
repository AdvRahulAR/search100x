import { parse } from "node-html-parser";
import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";
import { getStealthHeaders } from "../core/stealth.js";

/**
 * Startpage — Privacy-preserving proxy for Google Search results.
 * Zero API keys or subscriptions required.
 */
export class StartpageEngine implements Engine {
  readonly name = "startpage" as const;

  async search(query: string, timeoutMs = 7000): Promise<RawResult[]> {
    try {
      const url = "https://www.startpage.com/do/dsearch";
      const form = new URLSearchParams();
      form.set("query", query);
      form.set("cat", "web");
      form.set("cmd", "process_search");
      form.set("language", "english");

      const res = await http.post(url, form.toString(), {
        timeout: timeoutMs,
        headers: {
          ...getStealthHeaders(),
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://www.startpage.com",
          Referer: "https://www.startpage.com/",
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
    const items = root.querySelectorAll(".result, .w-gl__result, .result-item");
    for (const item of items) {
      if (results.length >= 10) break;
      const linkEl = item.querySelector("a.result-link, a.w-gl__result-title, h2 a") || item.querySelector("a");
      if (!linkEl) continue;
      const title = linkEl.text.trim();
      const href = linkEl.getAttribute("href") ?? "";
      if (!title || !href || !href.startsWith("http") || href.includes("startpage.com")) continue;
      const descEl = item.querySelector(".result-snippet, .w-gl__description, p");
      const snippet = descEl ? truncate(stripHtml(descEl.text.trim())) : title;
      results.push({ title, url: href, snippet });
    }
    return results;
  }
}
