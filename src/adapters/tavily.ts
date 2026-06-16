import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

/**
 * Tavily — purpose-built for LLM grounding, 1000 free queries/month.
 * Returns pre-extracted, clean content (not raw HTML snippets).
 * Set TAVILY_API_KEY to enable.
 */
export class TavilyEngine implements Engine {
  readonly name = "tavily" as const;
  constructor(private apiKey: string) {}

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const res = await http.post(
      "https://api.tavily.com/search",
      { query, search_depth: "basic", max_results: 10, include_answer: false },
      {
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    const items: any[] = res.data?.results ?? [];
    return items.map((r) => ({
      title:   r.title ?? "",
      url:     r.url ?? "",
      snippet: truncate(r.content ?? r.snippet ?? ""),
    }));
  }
}
