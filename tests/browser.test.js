import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findSystemBrowser,
  fetchWithBrowser,
  isCdpRunning,
  CdpConnection,
} from "../dist/index.js";

describe("Silent Browser Automation via Chrome DevTools Protocol (CDP)", () => {
  test("findSystemBrowser detects a system browser on Windows/macOS/Linux", () => {
    const browserPath = findSystemBrowser();
    if (browserPath) {
      assert.equal(typeof browserPath, "string");
      assert.ok(browserPath.length > 0);
      assert.ok(
        browserPath.toLowerCase().includes("chrome") ||
        browserPath.toLowerCase().includes("edge") ||
        browserPath.toLowerCase().includes("chromium"),
        `Expected browser path to contain chrome/edge/chromium, got: ${browserPath}`
      );
    }
  });

  test("fetchWithBrowser throws descriptive error when user permission is missing", async () => {
    await assert.rejects(
      async () => await fetchWithBrowser("https://example.com", {}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("consent") || err.message.includes("permission") || err.message.includes("disabled"),
          `Expected error message to mention permission, got: ${err.message}`
        );
        return true;
      }
    );

    await assert.rejects(
      async () => await fetchWithBrowser("https://example.com", { enabled: false }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("consent") || err.message.includes("permission"));
        return true;
      }
    );
  });

  test("isCdpRunning returns false for an inactive port", async () => {
    const running = await isCdpRunning("http://127.0.0.1:49151");
    assert.equal(running, false);
  });

  test("CdpConnection fails cleanly when connecting to a non-existent CDP endpoint", async () => {
    const cdp = new CdpConnection("http://127.0.0.1:49151");
    await assert.rejects(
      async () => await cdp.connect(),
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });

  const systemBrowser = findSystemBrowser();
  if (systemBrowser) {
    test("fetchWithBrowser successfully launches headless browser and extracts rendered content", async () => {
      const res = await fetchWithBrowser("https://example.com", {
        enabled: true,
        headless: true,
        timeoutMs: 15000,
        waitForNetworkIdle: true,
      });

      assert.ok(res, "Expected result from fetchWithBrowser");
      assert.equal(typeof res.title, "string");
      assert.ok(res.title.includes("Example Domain"));
      assert.ok(res.text.includes("Example Domain"));
      assert.ok(res.html.includes("<html") || res.html.includes("<!doctype html>"));
      assert.ok(typeof res.durationMs === "number");
      assert.ok(res.durationMs > 0);
    });
  }
});
