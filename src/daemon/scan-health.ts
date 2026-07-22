import { SCAN_DEGRADED_THRESHOLD } from "../lib/config";
import type { DaemonHealth } from "../types";

/**
 * Emitted the moment the daemon crosses into `degraded` or back to `recovered`,
 * so the caller logs and broadcasts exactly once per transition rather than
 * every scan.
 */
export interface ScanHealthTransition {
  kind: "degraded" | "recovered";
  reason: string;
  since: string;
}

export interface ScanHealthOptions {
  threshold?: number;
}

/**
 * Tracks the consecutive-scan-failure streak and derives a degraded/recovered
 * state from it. Pure and I/O-free: it never logs, broadcasts, or reads a
 * clock (the caller passes `now`), so the whole state machine is unit-testable.
 * The daemon owns one instance and wires the transitions to logging + SSE.
 */
export class ScanHealth {
  private readonly threshold: number;
  private consecutiveFailures = 0;
  private degraded = false;
  private reason = "";
  private since = "";

  constructor(options: ScanHealthOptions = {}) {
    this.threshold = options.threshold ?? SCAN_DEGRADED_THRESHOLD;
  }

  /**
   * Count one failed scan. Returns a `"degraded"` transition exactly on the
   * scan that pushes the streak to the threshold; null before, and while
   * already degraded (so callers can suppress per-scan spam).
   */
  recordFailure(reason: string, now: Date): ScanHealthTransition | null {
    this.consecutiveFailures++;
    if (!this.degraded && this.consecutiveFailures >= this.threshold) {
      this.degraded = true;
      this.reason = reason;
      this.since = now.toISOString();
      return { kind: "degraded", reason: this.reason, since: this.since };
    }
    return null;
  }

  /**
   * Reset the streak. Returns a `"recovered"` transition once if currently
   * degraded; null otherwise (a success below the threshold resets silently).
   */
  recordSuccess(): ScanHealthTransition | null {
    this.consecutiveFailures = 0;
    if (!this.degraded) return null;
    const transition: ScanHealthTransition = {
      kind: "recovered",
      reason: this.reason,
      since: this.since,
    };
    this.degraded = false;
    this.reason = "";
    this.since = "";
    return transition;
  }

  snapshot(): DaemonHealth {
    return this.degraded
      ? { degraded: true, reason: this.reason, since: this.since }
      : { degraded: false };
  }
}
