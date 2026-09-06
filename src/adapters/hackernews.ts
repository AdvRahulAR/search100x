/**
 * HackerNews search adapter — queries Algolia's public HN API.
 *
 * Zero API key required, 100% free, highly reliable public CDN.
 * Provides AI agents with developer discussions, launch announcements,
 * engineering debates, and real-world tech troubleshooting.
 */

import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { http } from "../core/http.js";
import { stripHtml, truncate } from "../core/normalizer.js";

const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search";

interface HnHit {
  title?: string;
  url?: string;
  story_text?: string;
  points?: number;
  num_comments?: number;
  objectID?: string;
  created_at?: string;
}

export class HackerNewsEngine implements Engine {
  readonly name = "hackernews" as const;

  async search(query: string, timeoutMs = 6000): Promise<RawResult[]> {
    try {
      const url = new URL(HN_SEARCH_URL);
      url.searchParams.set("query", query);
      url.searchParams.set("tags", "story");
      url.searchParams.set("hitsPerPage", "10");

      const res = await http.get(url.toString(), {
        timeout: timeoutMs,
        headers: {
          "Accept": "application/json",
          "User-Agent": "search100x/4.2.0 (compatible; +https://github.com/AdvRahulAR/search100x)",
        },
      });

      const data = res.data as Record<string, unknown> | undefined;
      const hits = (data?.hits as HnHit[]) ?? [];
      const results: RawResult[] = [];

      for (const hit of hits) {
        if (results.length >= 10) break;
        const title = (hit.title ?? "").trim();
        if (!title) continue;

        // If story has no external link (e.g. Ask HN, Show HN), link to the discussion thread
        const targetUrl = (hit.url && hit.url.startsWith("http"))
          ? hit.url
          : (hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : "");

        if (!targetUrl) continue;

        const points = typeof hit.points === "number" ? hit.points : 0;
        const comments = typeof hit.num_comments === "number" ? hit.num_comments : 0;
        const textSnippet = hit.story_text ? stripHtml(hit.story_text) : "";

        const prefix = [
          points > 0 ? `${points} points` : null,
          comments > 0 ? `${comments} comments` : null,
        ].filter(Boolean).join(", ");

        const snippetBody = textSnippet || `Discussion on Hacker News: ${title}`;
        const snippet = truncate(prefix ? `[HN: ${prefix}] ${snippetBody}` : snippetBody, 200);
        const publishedDate = hit.created_at ? new Date(hit.created_at) : undefined;

        results.push({
          title,
          url: targetUrl,
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
