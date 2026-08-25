export interface SearXNGConfig {
  /** Base URL of your SearXNG instance, e.g. "https://searx.example.com". Defaults to hardcoded instance. */
  baseUrl?:    string;
  /** Bearer token if your instance requires Authorization header */
  token?:     string;
  /** Comma-separated sub-engines to enable, e.g. "google,bing,brave,ddg" — blank = all */
  engines?:   string;
  /** BCP-47 language code, default "en" */
  language?:  string;
  /** Native freshness filter passed to SearXNG */
  timeRange?: "day" | "week" | "month" | "year";
}
