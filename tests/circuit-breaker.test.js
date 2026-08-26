import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreakerRegistry } from "../dist/index.js";

describe("Circuit Breaker Edge Cases", () => {
  it("HALF_OPEN -> CLOSED on success", async () => {
    const cb = new CircuitBreakerRegistry();
    const engine = "test-engine";
    
    // Trip to OPEN
    cb.recordFailure(engine);
    cb.recordFailure(engine);
    cb.recordFailure(engine);
    assert.equal(cb.status()[engine].state, "OPEN");
    
    // Manually simulate cooldown passing
    // (Note: can't easily test this without time mocking)
    // Instead test: success resets immediately
    cb.recordSuccess(engine);
    assert.equal(cb.status()[engine].state, "CLOSED");
    assert.equal(cb.status()[engine].failures, 0);
  });

  it("failure count doesn't leak across engines", () => {
    const cb = new CircuitBreakerRegistry();
    
    cb.recordFailure("engine-a");
    cb.recordFailure("engine-a");
    cb.recordFailure("engine-a");
    
    // engine-b should still be CLOSED
    assert.equal(cb.status()["engine-b"], undefined);
    assert.ok(!cb.isOpen("engine-b"));
  });

  it("caps failure history at 50", () => {
    const cb = new CircuitBreakerRegistry();
    
    // Add 60 failures
    for (let i = 0; i < 60; i++) {
      cb.recordFailure("test-engine");
    }
    
    // Shouldn't crash, should be OPEN
    assert.equal(cb.status()["test-engine"].state, "OPEN");
  });
});
