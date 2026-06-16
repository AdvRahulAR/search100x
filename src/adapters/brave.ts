import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

export class BraveEngine implements Engine {
  readonly name = "brave" as const;
  constructor(private apiKey: string) {}

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "10");
    url.searchParams.set("text_decorations", "false");
    const res = await http.get(url.toString(), {
      timeout: timeoutMs,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.apiKey,
      },
    });
    const items: any[] = res.data?.web?.results ?? [];
    return items.map((r) => ({
      title:   r.title ?? "",
      url:     r.url ?? "",
      snippet: truncate(stripHtml(r.extra_snippets?.[0] ?? r.description ?? "")),
    }));
  }
}
