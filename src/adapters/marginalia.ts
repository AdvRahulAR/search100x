import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

/**
 * Marginalia — indie/non-commercial web search engine.
 */
export class MarginaliaEngine implements Engine {
  readonly name = "marginalia" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const url = new URL("https://search.marginalia.nu/api/search/json");
    url.searchParams.set("query", query);
    url.searchParams.set("count", "20");

    const res = await http.get(url.toString(), {
      timeout: timeoutMs,
      headers: {
        Accept: "application/json",
      },
    });

    const items: any[] = res.data?.results ?? [];
    return items.map((r) => ({
      title:   r.title ?? "",
      url:     r.url ?? "",
      snippet: truncate(r.description ?? ""),
    }));
  }
}
