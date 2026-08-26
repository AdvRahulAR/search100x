import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function parseRss(xml: string): RawResult[] {
  const results: RawResult[] = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = decodeEntities(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "");
    const link  = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
    const src   = decodeEntities(item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "");
    const pub   = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
    if (!title || !link) continue;
    const dateStr = pub ? new Date(pub).toLocaleDateString("en-US") : "";
    const snippet = truncate(`${src ? `[${src}] ` : ""}${title}${dateStr ? ` — ${dateStr}` : ""}`);
    results.push({ title, url: link, snippet });
  }
  return results;
}

/**
 * Google News RSS engine.
 *
 * Supports any ISO 3166-1 alpha-2 country code (US, IN, GB, DE, FR, AU, etc.)
 * The Google News RSS API accepts any valid gl/ceid pair; unsupported regions
 * silently fall back to US results.
 */
export class GoogleNewsEngine implements Engine {
  readonly name = "googlenews" as const;
  private readonly region: string;

  constructor(region = "US") {
    this.region = region.toUpperCase();
  }

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const hl  = `en-${this.region}`;
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", hl);
    url.searchParams.set("gl", this.region);
    url.searchParams.set("ceid", `${this.region}:en`);

    const res = await http.get(url.toString(), {
      timeout: timeoutMs,
      headers: { "User-Agent": "search100x/1.1", Accept: "application/rss+xml" },
      responseType: "text",
    });
    return parseRss(res.data as string);
  }
}
