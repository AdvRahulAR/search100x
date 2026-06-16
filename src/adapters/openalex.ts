import { Engine } from "../core/engine.js";
import { RawResult } from "../core/types.js";
import { truncate } from "../core/normalizer.js";
import { http } from "../core/http.js";

function reconstructAbstract(inv?: Record<string, number[]>): string {
  if (!inv) return "";
  const pos: [number, string][] = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) pos.push([p, word]);
  }
  return pos.sort((a, b) => a[0] - b[0]).map(([, w]) => w).join(" ");
}

export class OpenAlexEngine implements Engine {
  readonly name = "openalex" as const;

  async search(query: string, timeoutMs: number): Promise<RawResult[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("per-page", "10");
    url.searchParams.set("select", "title,doi,publication_date,open_access,primary_location,abstract_inverted_index,cited_by_count");
    const res = await http.get(url.toString(), {
      timeout: timeoutMs,
      headers: { "User-Agent": "search100x/1.0 (mailto:prathibhatgl@gmail.com)" },
    });
    const works: any[] = res.data?.results ?? [];
    return works
      .filter((w) => w.title && (w.open_access?.oa_url || w.primary_location?.landing_page_url || w.doi))
      .map((w) => {
        const articleUrl = w.open_access?.oa_url
          ?? w.primary_location?.landing_page_url
          ?? `https://doi.org/${w.doi?.replace("https://doi.org/", "")}`;
        const abstract   = reconstructAbstract(w.abstract_inverted_index);
        const year       = w.publication_date ? new Date(w.publication_date).getFullYear() : "";
        const journal    = w.primary_location?.source?.display_name ?? "";
        const citations  = w.cited_by_count ?? 0;
        const snippet    = truncate(`${journal && year ? `[${journal}, ${year}]` : ""} ${abstract || w.title} ${citations > 0 ? `Cited ${citations}×` : ""}`.trim());
        return { title: w.title, url: articleUrl, snippet };
      });
  }
}
