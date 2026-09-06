/**
 * search100x HTTP Server Entry Point
 *
 * Runs the zero-dependency native HTTP micro-server (<25MB RAM).
 * Provides SearXNG API drop-in compatibility, native search100x API, and Web UI.
 */

import { startMicroServer } from "./micro-server.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

startMicroServer({
  port: PORT,
  host: HOST,
  searchConfig: {
    braveApiKey: process.env.BRAVE_API_KEY,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    googleApiKey: process.env.GOOGLE_API_KEY,
    googleCx: process.env.GOOGLE_CX,
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 7000),
    newsRegion: process.env.NEWS_REGION ?? "US",
  },
}).catch((err: unknown) => {
  console.error("Failed to start search100x micro-server:", err);
  process.exit(1);
});
