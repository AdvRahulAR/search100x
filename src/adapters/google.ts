import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { stripHtml, truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

export class GoogleEngine implements Engine {
  readonly name = "google" as const;
  constructor(private apiKey: string, private cx: string) {}

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("cx", this.cx);
    url.searchParams.set("q", query);
    url.searchParams.set("num", "10");
    const res = await http.get(url.toString(), { timeout: timeoutMs });
    const data = res.data as Record<string, unknown> | undefined;
    const items = (data?.items as Array<Record<string, unknown>>) ?? [];
    return items.map((r) => ({
      title:   (r.title as string) ?? "",
      url:     (r.link as string) ?? "",
      snippet: truncate(stripHtml((r.snippet as string) ?? "")),
    }));
  }
}
