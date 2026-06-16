import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http, HttpError } from "../core/http.js";

async function fetchWithRetry(url: string, timeoutMs: number, attempt = 0): Promise<RawResult[]> {
  try {
    const res = await http.get(url, { timeout: timeoutMs });
    const items: Array<{ title: string; snippet: string }> = res.data?.query?.search ?? [];
    return items.map((r) => ({
      title:   r.title,
      url:     `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
      snippet: truncate(stripHtml(r.snippet ?? "")),
    }));
  } catch (err) {
    if ((err as HttpError)?.response?.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      return fetchWithRetry(url, timeoutMs, attempt + 1);
    }
    throw err;
  }
}

export class WikipediaEngine implements Engine {
  readonly name = "wikipedia" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.searchParams.set("action", "query");
    url.searchParams.set("list", "search");
    url.searchParams.set("srsearch", query);
    url.searchParams.set("srlimit", "10");
    url.searchParams.set("format", "json");
    url.searchParams.set("origin", "*");
    return fetchWithRetry(url.toString(), timeoutMs);
  }
}
