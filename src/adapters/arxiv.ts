/**
 * ArXiv search adapter — queries ArXiv's public Atom XML API.
 *
 * Zero API key required, 100% open-access scientific preprints.
 * Provides AI agents with academic papers across AI, machine learning,
 * physics, mathematics, computer science, and quantitative biology.
 */

import { parse } from "node-html-parser";
import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { http } from "../core/http.js";
import { truncate } from "../core/normalizer.js";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";

export class ArXivEngine implements Engine {
  readonly name = "arxiv" as const;

  async search(query: string, timeoutMs = 8000): Promise<RawResult[]> {
    try {
      const cleanQuery = query.replace(/[^a-zA-Z0-9\s_-]/g, " ").trim();
      if (!cleanQuery) return [];

      const url = new URL(ARXIV_API_URL);
      url.searchParams.set("search_query", `all:${cleanQuery}`);
      url.searchParams.set("start", "0");
      url.searchParams.set("max_results", "10");
      url.searchParams.set("sortBy", "relevance");
      url.searchParams.set("sortOrder", "descending");

      const res = await http.get(url.toString(), {
        timeout: timeoutMs,
        responseType: "text",
        headers: {
          "Accept": "application/atom+xml,application/xml,text/xml",
          "User-Agent": "search100x/4.2.0 (compatible; +https://github.com/AdvRahulAR/search100x)",
        },
      });

      if (typeof res.data !== "string") return [];

      const root = parse(res.data);
      const entries = root.querySelectorAll("entry");
      const results: RawResult[] = [];

      for (const entry of entries) {
        if (results.length >= 10) break;

        const title = entry.querySelector("title")?.text.replace(/\s+/g, " ").trim() ?? "";
        if (!title) continue;

        const id = entry.querySelector("id")?.text.trim() ?? "";
        // ArXiv ID is canonical URL: http://arxiv.org/abs/...
        const paperUrl = id.startsWith("http") ? id.replace("http://", "https://") : "";
        if (!paperUrl) continue;

        const summary = entry.querySelector("summary")?.text.replace(/\s+/g, " ").trim() ?? "";
        const published = entry.querySelector("published")?.text.trim();
        const authorEls = entry.querySelectorAll("author name");
        const authors = authorEls.map((a) => a.text.trim()).filter(Boolean).slice(0, 3).join(", ");
        const authorPrefix = authors ? `[${authors}${authorEls.length > 3 ? " et al." : ""}] ` : "[ArXiv] ";

        const snippet = truncate(`${authorPrefix}${summary || title}`, 200);
        const publishedDate = published ? new Date(published) : undefined;

        results.push({
          title,
          url: paperUrl,
          snippet,
          publishedAt: publishedDate,
        });
      }

      return results;
    } catch {
      return [];
    }
  }
}
