/**
 * toDocuments() — format search results for the Claude Citations API.
 *
 * Usage:
 *   const res = await s.search("SC AI Committee 2026", { enrichContent: 5 });
 *   const docs = toDocuments(res.results);
 *
 *   const response = await anthropic.messages.create({
 *     model: "claude-sonnet-4-6",
 *     max_tokens: 1024,
 *     messages: [{
 *       role: "user",
 *       content: [
 *         ...docs,
 *         { type: "text", text: "What are the key prohibitions in these regulations?" }
 *       ]
 *     }]
 *   });
 *
 * Claude will return inline citations referencing each document's title and URL.
 * The `context` field on each document carries the source URL — it is returned
 * verbatim in citation objects so you can render clickable links.
 *
 * Falls back to result.snippet when result.content is not populated,
 * so toDocuments() works even without enrichContent.
 */

import { SearchResult } from "./types.js";

export interface CitationDocument {
  type:     "document";
  source:   { type: "text"; media_type: "text/plain"; data: string };
  title:    string;
  /** Carries the source URL — returned verbatim in Claude's citation objects */
  context:  string;
  citations: { enabled: boolean };
}

export interface ToDocumentsOptions {
  /** Include results with no content/snippet (default: false) */
  includeEmpty?: boolean;
  /** Disable citations — useful for testing (default: citations enabled) */
  citations?: boolean;
  /** Maximum number of documents to include (default: all results) */
  limit?: number;
  /**
   * Minimum content length in characters to include a document (default: 0).
   * Set to e.g. 300 to skip results where only a short snippet was available
   * and no full page content was fetched — avoids sending thin context to the LLM.
   */
  minContentLength?: number;
  /**
   * Minimum relevance score (0–1) to include a document (default: 0).
   * Recommended: 0.70 to filter noise and off-topic results before sending
   * to the LLM. Results are already sorted by score descending.
   */
  minScore?: number;
}

/**
 * Convert search results into the document array expected by the
 * Anthropic Messages API for cited answer generation.
 *
 * Each document's `context` field carries the source URL. After the
 * LLM responds, Claude's citation objects reference this field so you
 * can map citations back to source links.
 */
export function toDocuments(
  results: SearchResult[],
  options: ToDocumentsOptions = {}
): CitationDocument[] {
  const { includeEmpty = false, citations = true, limit, minContentLength = 0, minScore = 0 } = options;

  const docs: CitationDocument[] = [];

  for (const r of results) {
    if (limit && docs.length >= limit) break;
    if (r.score < minScore) continue;

    const data = r.content ?? r.snippet ?? "";
    if (!data && !includeEmpty) continue;
    if (data.length < minContentLength) continue;

    docs.push({
      type:   "document",
      source: { type: "text", media_type: "text/plain", data },
      title:  r.title,
      context: r.url,
      citations: { enabled: citations },
    });
  }

  return docs;
}

/**
 * Build a ready-to-send messages payload for the Anthropic API.
 * Combines documents + user question into the correct content array shape.
 *
 * Example:
 *   const payload = buildCitedQuery(res.results, "What AI uses are prohibited?");
 *   const msg = await anthropic.messages.create({ model: "claude-sonnet-4-6", ...payload });
 */
export function buildCitedQuery(
  results:  SearchResult[],
  question: string,
  options?: ToDocumentsOptions
): { max_tokens: number; messages: { role: "user"; content: object[] }[] } {
  const docs = toDocuments(results, options);
  return {
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        ...docs,
        { type: "text", text: question },
      ],
    }],
  };
}
