/**
 * Browser Controller — Silent, User-Permitted Browser Automation via Chrome DevTools Protocol (CDP).
 *
 * Designed for AI agents and search100x workflows that encounter JavaScript-rendered SPAs,
 * Cloudflare Turnstile, CAPTCHA challenges, or HTTP 403 blocks.
 *
 * Zero external npm dependencies:
 * - Uses native Node.js WebSocket and node:http for CDP communication.
 * - Connects to user's existing Chrome/Edge instance (e.g. --remote-debugging-port=9222)
 *   OR spawns system Chrome/Edge headlessly on-demand.
 * - Strictly requires explicit user permission (enabled: true or --browser flag).
 */

import http from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractContent } from "./extractor.js";
import { parse } from "node-html-parser";

export interface BrowserOptions {
  /** Explicit user consent/permission to execute browser automation. Default: false */
  enabled?: boolean;
  /** Custom CDP debug endpoint if user has a running debug browser, e.g. "http://127.0.0.1:9222" */
  cdpUrl?: string;
  /** Custom path to Chrome/Edge/Chromium executable */
  executablePath?: string;
  /** Run in headless mode (default: true) */
  headless?: boolean;
  /** Custom user data dir (if omitted, an isolated temporary directory is used) */
  userDataDir?: string;
  /** Page navigation timeout in ms (default: 15000) */
  timeoutMs?: number;
}

export interface BrowserPageResult {
  url: string;
  html: string;
  text: string;
  title: string;
  durationMs: number;
}

/** Standard installation candidate paths across Windows, macOS, and Linux */
const BROWSER_CANDIDATES: string[] = [
  // Windows Google Chrome
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  // Windows Microsoft Edge
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  // Windows AppData Local paths
  (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe",
  (process.env.LOCALAPPDATA || "") + "\\Microsoft\\Edge\\Application\\msedge.exe",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/snap/bin/chromium",
];

/** Locates installed Google Chrome, Microsoft Edge, or Chromium executable on the host system */
export function findSystemBrowser(): string | undefined {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Check if an active CDP debug port is currently responding at the given host and port */
export async function isCdpRunning(host = "127.0.0.1", port = 9222): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(`http://${host}:${port}/json/version`, { timeout: 800 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Minimal CDP WebSocket client implementing standard JSON-RPC 2.0 */
export class CdpConnection {
  private ws: WebSocket;
  private msgId = 1;
  private callbacks = new Map<number, (res: unknown) => void>();

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
  }

  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const cleanup = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);

      this.ws.onmessage = (event) => {
        try {
          const raw = typeof event.data === "string" ? event.data : event.data.toString();
          const parsed = JSON.parse(raw) as { id?: number; result?: unknown; error?: unknown };
          if (typeof parsed.id === "number" && this.callbacks.has(parsed.id)) {
            const cb = this.callbacks.get(parsed.id)!;
            this.callbacks.delete(parsed.id);
            cb(parsed.result ?? parsed);
          }
        } catch {
          // ignore malformed frame
        }
      };
    });
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready();
    return new Promise<T>((resolve) => {
      const id = this.msgId++;
      this.callbacks.set(id, (val) => resolve(val as T));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Executes a silent browser navigation using Chrome DevTools Protocol.
 * Requires options.enabled = true to proceed.
 */
export async function fetchWithBrowser(
  url: string,
  options: BrowserOptions = {}
): Promise<BrowserPageResult> {
  if (!options.enabled) {
    throw new Error(
      "search100x browser automation requires explicit user consent. Set browser.enabled = true or pass the --browser flag."
    );
  }

  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 15000;

  let cdpHost = "127.0.0.1";
  let cdpPort = 9222;
  let spawnedProcess: ChildProcess | undefined;
  let tempUserDataDir: string | undefined;

  // 1. Check if user provided custom CDP URL or if default port 9222 is active
  if (options.cdpUrl) {
    try {
      const parsed = new URL(options.cdpUrl);
      cdpHost = parsed.hostname;
      cdpPort = Number(parsed.port || 9222);
    } catch {
      throw new Error(`Invalid cdpUrl: ${options.cdpUrl}`);
    }
  } else {
    const running = await isCdpRunning(cdpHost, cdpPort);
    if (!running) {
      // 2. Launch system Chrome or Edge headlessly on a dynamic port
      const browserExecutable = options.executablePath ?? findSystemBrowser();
      if (!browserExecutable) {
        throw new Error(
          "No Google Chrome or Microsoft Edge browser found on this system. Install Chrome/Edge or provide options.cdpUrl."
        );
      }

      // Pick a random unprivileged port for isolation
      cdpPort = 19000 + Math.floor(Math.random() * 1000);
      tempUserDataDir = options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "s100x-browser-"));

      const browserArgs = [
        options.headless !== false ? "--headless=new" : "--headless=new",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${tempUserDataDir}`,
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-default-apps",
        "--hide-scrollbars",
        "--metrics-recording-only",
        "--mute-audio",
        "--disable-blink-features=AutomationControlled", // Evade navigator.webdriver detection
      ];

      spawnedProcess = spawn(browserExecutable, browserArgs, {
        stdio: "ignore",
        detached: false,
      });

      // Wait up to 3s for browser to initialize CDP
      let ready = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await isCdpRunning(cdpHost, cdpPort)) {
          ready = true;
          break;
        }
      }

      if (!ready) {
        try { spawnedProcess.kill(); } catch {}
        if (tempUserDataDir) {
          try { fs.rmSync(tempUserDataDir, { recursive: true, force: true }); } catch {}
        }
        throw new Error("Failed to initialize system browser DevTools Protocol on port " + cdpPort);
      }
    }
  }

  let targetId: string | undefined;
  let conn: CdpConnection | undefined;

  try {
    // 3. Create a new target tab
    const createTargetRes = await new Promise<{ id: string; webSocketDebuggerUrl: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: cdpHost,
          port: cdpPort,
          path: `/json/new?${encodeURIComponent(url)}`,
          method: "PUT",
          timeout: 5000,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const data = JSON.parse(body) as { id: string; webSocketDebuggerUrl: string };
              resolve(data);
            } catch (e) {
              reject(new Error("Failed to parse browser target response: " + body));
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

    targetId = createTargetRes.id;
    const wsDebuggerUrl = createTargetRes.webSocketDebuggerUrl;

    // 4. Connect WebSocket to the tab
    conn = new CdpConnection(wsDebuggerUrl);
    await conn.ready();

    // Enable Page and Runtime domains
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");

    // Stealth: Remove navigator.webdriver flag in the browser context
    await conn.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = window.chrome || { runtime: {} };
      `,
    });

    // 5. Wait for page load or DOM completion
    const loadDeadline = Date.now() + timeoutMs;
    let pageHtml = "";
    let pageTitle = "";

    // Poll document state until complete or timeout
    while (Date.now() < loadDeadline) {
      await new Promise((r) => setTimeout(r, 600));

      const readyStateEval = await conn.send<{ result?: { value?: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });

      const state = readyStateEval?.result?.value;
      if (state === "complete" || state === "interactive") {
        // Wait brief moment for dynamic JS hydration
        await new Promise((r) => setTimeout(r, 400));

        const htmlEval = await conn.send<{ result?: { value?: string } }>("Runtime.evaluate", {
          expression: "document.documentElement.outerHTML",
          returnByValue: true,
        });

        const titleEval = await conn.send<{ result?: { value?: string } }>("Runtime.evaluate", {
          expression: "document.title",
          returnByValue: true,
        });

        pageHtml = htmlEval?.result?.value ?? "";
        pageTitle = titleEval?.result?.value ?? "";

        if (pageHtml.length > 200) {
          break;
        }
      }
    }

    if (!pageHtml) {
      throw new Error(`Browser navigation timed out after ${timeoutMs}ms: ${url}`);
    }

    // 6. Extract clean main readable content
    let text = extractContent(pageHtml, url) ?? "";
    if (!text || text.length < 50) {
      const root = parse(pageHtml);
      root.querySelectorAll("script, style, noscript, nav, header, footer").forEach((n) => n.remove());
      text = (root.querySelector("main, article, body")?.text ?? "").replace(/\s+/g, " ").trim();
    }

    return {
      url,
      html: pageHtml,
      text,
      title: pageTitle,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // 7. Clean up target tab
    if (conn) {
      conn.close();
    }
    if (targetId) {
      try {
        const closeReq = http.request({
          host: cdpHost,
          port: cdpPort,
          path: `/json/close/${targetId}`,
          method: "GET",
          timeout: 2000,
        });
        closeReq.on("error", () => {});
        closeReq.end();
      } catch {
        // ignore close error
      }
    }

    // 8. Terminate spawned on-demand browser process and temp directory
    if (spawnedProcess) {
      try {
        spawnedProcess.kill();
      } catch {
        // ignore
      }
    }
    if (tempUserDataDir) {
      try {
        fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
