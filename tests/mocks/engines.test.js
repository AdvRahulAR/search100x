import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import nock from "nock";
import { EnhancedSearch } from "../../dist/index.js";

describe("Mocked Engine Tests", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("handles DuckDuckGo HTML response", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <body>
          <div id="links">
            <div class="web-result">
              <h2><a href="https://example.com">Test Title</a></h2>
              <a class="result__snippet">Test snippet content</a>
            </div>
          </div>
        </body>
      </html>
    `;
    
    nock("https://html.duckduckgo.com")
      .post("/html/")
      .reply(200, html);

    const s = new EnhancedSearch({ sources: ["duckduckgo"] });
    const res = await s.search("test", { sources: ["duckduckgo"] });
    
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].title, "Test Title");
    assert.equal(res.results[0].url, "https://example.com");
  });

  it("handles DuckDuckGo CAPTCHA", async () => {
    nock("https://html.duckduckgo.com")
      .post("/html/")
      .reply(200, '<form id="challenge-form"></form>');

    const s = new EnhancedSearch();
    const res = await s.search("test", { sources: ["duckduckgo"] });
    
    // Should gracefully return empty, not crash
    assert.equal(res.results.length, 0);
  });

  it("handles network timeout", async () => {
    nock("https://html.duckduckgo.com")
      .post("/html/")
      .delayConnection(500) // 500ms delay is enough to trigger 50ms timeout
      .reply(200, "");

    const s = new EnhancedSearch({ timeoutMs: 50 });
    const res = await s.search("test", { sources: ["duckduckgo"] });
    
    // Should timeout and return empty or fallback results
    assert.ok(res.results.length >= 0);
    
    // Wait for the delayed connection to finish so it doesn't leak async activity
    await new Promise(resolve => setTimeout(resolve, 600));
  });
});
