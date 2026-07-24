import { describe, it, expect } from "bun:test";
import { ScanHealth } from "./scan-health";

const T0 = new Date("2024-01-15T12:00:00Z");
const T1 = new Date("2024-01-15T12:05:00Z");

/** Fail `n` times against a fresh tracker, returning every transition seen. */
function failN(health: ScanHealth, n: number, reason = "ps spawn failed") {
  const transitions = [];
  for (let i = 0; i < n; i++) {
    transitions.push(health.recordFailure(reason, T0));
  }
  return transitions;
}

describe("ScanHealth", () => {
  it("returns null for failures below the threshold and stays healthy", () => {
    const health = new ScanHealth({ threshold: 3 });
    expect(health.recordFailure("x", T0)).toBeNull();
    expect(health.recordFailure("x", T0)).toBeNull();
    expect(health.snapshot()).toEqual({ degraded: false });
  });

  it("fires exactly one degraded transition on the threshold scan", () => {
    const health = new ScanHealth({ threshold: 3 });
    const [first, second, third] = failN(health, 3, "ps spawn failed");
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).toEqual({
      kind: "degraded",
      reason: "ps spawn failed",
      since: T0.toISOString(),
    });
  });

  it("captures the reason and since of the transitioning failure", () => {
    const health = new ScanHealth({ threshold: 2 });
    health.recordFailure("first reason", T0);
    const transition = health.recordFailure("crossing reason", T1);
    expect(transition).toEqual({
      kind: "degraded",
      reason: "crossing reason",
      since: T1.toISOString(),
    });
    expect(health.snapshot()).toEqual({
      degraded: true,
      reason: "crossing reason",
      since: T1.toISOString(),
    });
  });

  it("returns null for continued failures once already degraded", () => {
    const health = new ScanHealth({ threshold: 2 });
    failN(health, 2);
    expect(health.recordFailure("still failing", T1)).toBeNull();
    expect(health.recordFailure("still failing", T1)).toBeNull();
  });

  it("resets silently on success below the threshold", () => {
    const health = new ScanHealth({ threshold: 3 });
    health.recordFailure("x", T0);
    health.recordFailure("x", T0);
    expect(health.recordSuccess()).toBeNull();
    expect(health.snapshot()).toEqual({ degraded: false });
    // Streak was reset: two more failures do not yet cross the threshold.
    expect(health.recordFailure("x", T0)).toBeNull();
    expect(health.recordFailure("x", T0)).toBeNull();
    expect(health.recordFailure("x", T0)).toEqual({
      kind: "degraded",
      reason: "x",
      since: T0.toISOString(),
    });
  });

  it("fires exactly one recovered transition, then null", () => {
    const health = new ScanHealth({ threshold: 2 });
    failN(health, 2);
    const recovered = health.recordSuccess();
    expect(recovered).toEqual({
      kind: "recovered",
      reason: "ps spawn failed",
      since: T0.toISOString(),
    });
    expect(health.snapshot()).toEqual({ degraded: false });
    expect(health.recordSuccess()).toBeNull();
  });

  it("can degrade again after recovering", () => {
    const health = new ScanHealth({ threshold: 2 });
    failN(health, 2);
    health.recordSuccess();
    expect(health.recordFailure("second outage", T1)).toBeNull();
    expect(health.recordFailure("second outage", T1)).toEqual({
      kind: "degraded",
      reason: "second outage",
      since: T1.toISOString(),
    });
  });

  it("defaults the threshold to SCAN_DEGRADED_THRESHOLD (10)", () => {
    const health = new ScanHealth();
    expect(failN(health, 9).every((t) => t === null)).toBe(true);
    expect(health.recordFailure("ps spawn failed", T0)).toEqual({
      kind: "degraded",
      reason: "ps spawn failed",
      since: T0.toISOString(),
    });
  });

  it("snapshot reports the healthy and degraded shapes", () => {
    const health = new ScanHealth({ threshold: 1 });
    expect(health.snapshot()).toEqual({ degraded: false });
    health.recordFailure("boom", T0);
    expect(health.snapshot()).toEqual({
      degraded: true,
      reason: "boom",
      since: T0.toISOString(),
    });
  });
});
