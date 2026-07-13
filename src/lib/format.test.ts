import { describe, it, expect, setSystemTime, afterAll } from "bun:test";
import { formatDuration, formatRelativeTime } from "./format";

describe("formatDuration", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("keeps seconds precision under an hour", () => {
    expect(formatDuration(60_000)).toBe("1m0s");
    expect(formatDuration(134_000)).toBe("2m14s");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59m59s");
  });

  it("drops seconds at an hour and above", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h0m");
    expect(formatDuration(65 * 60_000 + 30_000)).toBe("1h5m");
    expect(formatDuration(3 * 60 * 60_000 + 12 * 60_000)).toBe("3h12m");
  });

  it("clamps negative durations (clock skew) to 0s", () => {
    expect(formatDuration(-5_000)).toBe("0s");
  });
});

describe("formatRelativeTime", () => {
  afterAll(() => setSystemTime());

  it("should format seconds", () => {
    setSystemTime(new Date("2024-01-01T12:00:30Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("30s");
  });

  it("should format minutes", () => {
    setSystemTime(new Date("2024-01-01T12:05:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("5m");
  });

  it("should format hours", () => {
    setSystemTime(new Date("2024-01-01T15:00:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("3h");
  });

  it("should append suffix when provided", () => {
    setSystemTime(new Date("2024-01-01T12:05:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"), " ago")).toBe(
      "5m ago",
    );
  });

  it("should use empty suffix by default", () => {
    setSystemTime(new Date("2024-01-01T12:05:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("5m");
  });

  it("should show 0s for equal times", () => {
    setSystemTime(new Date("2024-01-01T12:00:00Z"));
    expect(formatRelativeTime(new Date("2024-01-01T12:00:00Z"))).toBe("0s");
  });
});
