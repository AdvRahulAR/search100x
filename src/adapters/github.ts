/**
 * GitHub search adapter — queries GitHub's public Repository Search API.
 *
 * Zero API key required for standard rate limits (10 req/min unauthenticated).
 * Provides AI agents with open source libraries, implementation repositories,
 * toolkits, and code examples.
 */

import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { http } from "../core/http.js";
import { truncate } from "../core/normalizer.js";

const GITHUB_SEARCH_URL = "https://api.github.com/search/repositories";

interface GitHubRepoItem {
  full_name?: string;
  name?: string;
  html_url?: string;
  description?: string;
  stargazers_count?: number;
  language?: string;
  updated_at?: string;
}

export class GitHubEngine implements Engine {
  readonly name = "github" as const;

  async search(query: string, timeoutMs = 6000): Promise<RawResult[]> {
    try {
      const url = new URL(GITHUB_SEARCH_URL);
      url.searchParams.set("q", query);
      url.searchParams.set("per_page", "10");
      url.searchParams.set("sort", "stars");
      url.searchParams.set("order", "desc");

      const res = await http.get(url.toString(), {
        timeout: timeoutMs,
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "search100x/4.2.0 (compatible; +https://github.com/AdvRahulAR/search100x)",
        },
      });

      const data = res.data as Record<string, unknown> | undefined;
      const items = (data?.items as GitHubRepoItem[]) ?? [];
      const results: RawResult[] = [];

      for (const item of items) {
        if (results.length >= 10) break;
        const title = (item.full_name ?? item.name ?? "").trim();
        const url = (item.html_url ?? "").trim();
        if (!title || !url || !url.startsWith("http")) continue;

        const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : 0;
        const lang = item.language ? `${item.language} • ` : "";
        const desc = item.description ? item.description.trim() : `GitHub repository: ${title}`;

        const starLabel = stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : `${stars}`;
        const snippet = truncate(`[${lang}${starLabel} ★] ${desc}`, 200);
        const publishedDate = item.updated_at ? new Date(item.updated_at) : undefined;

        results.push({
          title,
          url,
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
