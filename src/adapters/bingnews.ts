import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function extractRealUrl(bingUrl: string): string {
  try {
    const u    = new URL(decodeEntities(bingUrl));
    const real = u.searchParams.get("url");
    return real ? decodeURIComponent(real) : bingUrl;
  } catch { return bingUrl; }
}

const FRESHNESS: Record<string, string> = { day: "Day", week: "Week", month: "Month" };

export class BingNewsEngine implements Engine {
  readonly name = "bingnews" as const;

  constructor(private region = "US") {}

  async search(
    query: string,
    timeoutMs: number,
    timeRange?: string,
    page = 1
  ): Promise<RawResult[]> {
    const mkt    = `en-${this.region.toUpperCase()}`;
    const offset = (page - 1) * 10;

    const params: Record<string, string | number> = {
      q:      query,
      format: "rss",
      mkt,
      offset,
    };
    if (timeRange && FRESHNESS[timeRange]) {
      params.freshness = FRESHNESS[timeRange];
    }

    const res = await http.get("https://www.bing.com/news/search", {
      params,
      timeout: timeoutMs,
      headers: { "User-Agent": "search100x/1.1", Accept: "application/rss+xml" },
      responseType: "text",
    });

    const fmt     = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });
    const xml     = res.data as string;
    const results: RawResult[] = [];

    for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const title   = decodeEntities(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "");
      const rawLink = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
      const desc    = stripHtml(decodeEntities(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ""));
      const src     = decodeEntities(item.match(/<News:Source>([\s\S]*?)<\/News:Source>/)?.[1] ?? "");
      const pub     = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
      if (!title || !rawLink) continue;
      const url     = extractRealUrl(rawLink);
      let dateStr = "";
      if (pub) {
        const parsed = new Date(pub);
        if (!isNaN(parsed.getTime())) dateStr = fmt.format(parsed);
      }
      const snippet = truncate(desc || `${src ? `[${src}] ` : ""}${title}${dateStr ? ` — ${dateStr}` : ""}`);
      results.push({ title, url, snippet });
    }
    return results;
  }
}
