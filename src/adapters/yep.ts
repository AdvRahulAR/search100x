import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

/**
 * Yep — privacy-focused search engine by Ahrefs.
 */
export class YepEngine implements Engine {
  readonly name = "yep" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const url = new URL("https://api.yep.com/v1/search");
    url.searchParams.set("q", query);
    url.searchParams.set("no_correct", "false");
    url.searchParams.set("safeSearch", "off");

    const res = await http.get(url.toString(), {
      timeout: timeoutMs,
      headers: {
        Accept: "application/json",
      },
    });

    const items: any[] = res.data?.organic ?? [];
    return items.map((r) => ({
      title:   r.title ?? "",
      url:     r.url ?? "",
      snippet: truncate(r.snippet ?? ""),
    }));
  }
}
