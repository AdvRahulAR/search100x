import { Logger } from "./types.js";

/**
 * Per-engine circuit breaker.
 *
 * States:
 *   CLOSED    → normal operation
 *   OPEN      → engine skipped (cooldown active)
 *   HALF_OPEN → one trial request; success → CLOSED, failure → OPEN
 *
 * This is a CLASS, not a module-level singleton, so each EnhancedSearch
 * instance has its own isolated breaker state. Module-level globals caused
 * test interference and broke multi-instance deployments.
 */

const FAILURE_THRESHOLD = 3;
const WINDOW_MS         = 60_000;      // 1-minute rolling failure window
const MAX_COOLDOWN_MS   = 10 * 60_000; // 10 minutes max cooldown
const BASE_COOLDOWN_MS  = 30_000;      // 30s initial cooldown (exponential backoff)

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface Breaker {
  state:               BreakerState;
  failures:            number[];  // timestamps of recent failures
  openedAt:            number;
  halfOpenTrialActive: boolean;
  consecutiveOpens:    number;  // for exponential backoff calculation
}

export class CircuitBreakerRegistry {
  private breakers = new Map<string, Breaker>();

  constructor(private logger?: Logger) {}

  private get(engine: string): Breaker {
    if (!this.breakers.has(engine)) {
      this.breakers.set(engine, {
        state: "CLOSED",
        failures: [],
        openedAt: 0,
        halfOpenTrialActive: false,
        consecutiveOpens: 0,
      });
    }
    return this.breakers.get(engine)!;
  }

  /** Returns true if this engine should be skipped for the current request */
  isOpen(engine: string): boolean {
    const b = this.get(engine);
    if (b.state === "CLOSED") return false;

    if (b.state === "OPEN") {
      // Exponential backoff: 30s, 60s, 120s, 240s, ... max 10min
      const cooldown = Math.min(
        BASE_COOLDOWN_MS * Math.pow(2, b.consecutiveOpens - 1),
        MAX_COOLDOWN_MS
      );
      if (Date.now() - b.openedAt >= cooldown) {
        b.state = "HALF_OPEN";
        b.halfOpenTrialActive = false;
        return false;
      }
      return true;
    }

    // HALF_OPEN: allow exactly one trial
    if (b.halfOpenTrialActive) return true;
    b.halfOpenTrialActive = true;
    return false;
  }

  recordSuccess(engine: string): void {
    const b = this.get(engine);
    b.state = "CLOSED";
    b.failures = [];
    b.openedAt = 0;
    b.halfOpenTrialActive = false;
    b.consecutiveOpens = 0;  // reset backoff on success
  }

  recordFailure(engine: string): void {
    const b   = this.get(engine);
    const now = Date.now();
    b.failures = b.failures.filter((t) => now - t < WINDOW_MS);
    b.failures.push(now);
    // Hard cap — prevent unbounded growth under sustained failure storms
    if (b.failures.length > 50) b.failures = b.failures.slice(-50);

    if (b.state === "HALF_OPEN" || b.failures.length >= FAILURE_THRESHOLD) {
      b.state = "OPEN";
      b.openedAt = now;
      b.halfOpenTrialActive = false;
      b.consecutiveOpens++;
      const cooldown = Math.min(
        BASE_COOLDOWN_MS * Math.pow(2, b.consecutiveOpens - 1),
        MAX_COOLDOWN_MS
      );
      this.logger?.warn(
        `[circuit] ${engine} tripped OPEN (${b.failures.length} failures, cooldown=${Math.round(cooldown / 1000)}s)`
      );
    }
  }


  status(): Record<string, { state: BreakerState; failures: number }> {
    const out: Record<string, { state: BreakerState; failures: number }> = {};
    for (const [name, b] of this.breakers) {
      out[name] = { state: b.state, failures: b.failures.length };
    }
    return out;
  }

  reset(): void {
    this.breakers.clear();
  }
}
