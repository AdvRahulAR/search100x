import { RawResult, SourceName } from "./types.js";

/**
 * Every adapter must implement this interface.
 * The orchestrator calls search() with the chosen query variant, wraps results
 * in an Appearance, and feeds them into ResultContainer — adapters never touch scoring.
 *
 * timeRange and page are optional extras; adapters that support them should
 * consume them, others silently ignore them.
 */
export interface Engine {
  readonly name: SourceName;
  search(
    query: string,
    timeoutMs: number,
    timeRange?: string,
    page?: number
  ): Promise<RawResult[]>;
}
