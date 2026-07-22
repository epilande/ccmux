import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

/** Redirect STATE_FILE to a temp dir so tests don't touch real ~/.config/ccmux/state.json */
const tempRoot = join(
  tmpdir(),
  `ccmux-scanhealth-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import { Daemon } from "./index";
import { ScanHealth } from "./scan-health";
import { ProcessDiscoveryError } from "./processes";
import { PaneDiscoveryError } from "./pane-discovery";

/**
 * Covers the daemon-side glue `scan()`'s catch hands to `recordScanFailure`
 * (issue #46): the `reason` derivation, the `alreadyDegraded`-before-
 * `recordFailure` ordering, the one-shot degraded log + broadcast, and the
 * `Scan skipped` spam-suppression predicate. The pure state machine lives in
 * `scan-health.test.ts`; this locks the wiring around it.
 */
type DaemonInternals = {
  scanHealth: ScanHealth;
  server: { broadcastDaemonHealth: () => void };
  recordScanFailure(error: unknown): void;
};

describe("Daemon recordScanFailure (scan-health wiring)", () => {
  let daemon: Daemon;
  let internals: DaemonInternals;
  let broadcasts: number;
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;

  /** All `console.error` calls this test made, flattened to their first arg. */
  const errorLines = () => errorSpy.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    daemon = new Daemon();
    internals = daemon as unknown as DaemonInternals;
    // Low threshold keeps the failure loops short; the boundary itself is
    // exercised by scan-health.test.ts.
    internals.scanHealth = new ScanHealth({ threshold: 3 });
    broadcasts = 0;
    internals.server = {
      broadcastDaemonHealth: () => {
        broadcasts += 1;
      },
    };
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("logs 'Scan skipped' per scan while below the degraded threshold", () => {
    internals.recordScanFailure(new ProcessDiscoveryError("ps spawn failed"));
    internals.recordScanFailure(new ProcessDiscoveryError("ps spawn failed"));

    const skipped = errorLines().filter((l) => l.startsWith("Scan skipped:"));
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toBe("Scan skipped: ps spawn failed");
    expect(broadcasts).toBe(0);
    expect(internals.scanHealth.snapshot().degraded).toBe(false);
  });

  it("fires one degraded log + broadcast on the threshold scan, suppressing 'Scan skipped'", () => {
    internals.recordScanFailure(new PaneDiscoveryError("tmux gone"));
    internals.recordScanFailure(new PaneDiscoveryError("tmux gone"));
    errorSpy.mockClear();

    // Third failure crosses threshold=3.
    internals.recordScanFailure(new PaneDiscoveryError("tmux gone"));

    const lines = errorLines();
    expect(lines.some((l) => l.startsWith("Daemon degraded: tmux gone"))).toBe(
      true,
    );
    // The crossing scan does NOT also emit the per-scan spam line.
    expect(lines.some((l) => l.startsWith("Scan skipped:"))).toBe(false);
    expect(broadcasts).toBe(1);
    expect(internals.scanHealth.snapshot()).toMatchObject({
      degraded: true,
      reason: "tmux gone",
    });
  });

  it("suppresses 'Scan skipped' and does not re-broadcast while already degraded", () => {
    for (let i = 0; i < 3; i++) {
      internals.recordScanFailure(new ProcessDiscoveryError("ps spawn failed"));
    }
    expect(broadcasts).toBe(1); // degraded transition only
    errorSpy.mockClear();

    // Steady-state outage: the exact 46h-of-spam scenario must stay silent.
    internals.recordScanFailure(new ProcessDiscoveryError("ps spawn failed"));
    internals.recordScanFailure(new ProcessDiscoveryError("ps spawn failed"));

    expect(errorLines().some((l) => l.startsWith("Scan skipped:"))).toBe(false);
    expect(broadcasts).toBe(1); // no additional broadcasts
  });

  it("derives reason 'scan error' for a non-discovery throw and never suppresses it", () => {
    // A generic (non-discovery) error logs 'Scan error:' every scan and reports
    // a static reason, never the error's own message.
    for (let i = 0; i < 3; i++) {
      internals.recordScanFailure(new Error("reconcile blew up"));
    }

    expect(errorLines().filter((l) => l === "Scan error:")).toHaveLength(3);
    // Degraded transition still fires on the generic path, with the static reason.
    expect(internals.scanHealth.snapshot()).toMatchObject({
      degraded: true,
      reason: "scan error",
    });
    expect(broadcasts).toBe(1);
  });

  it("captures the message of the crossing failure as the degraded reason", () => {
    internals.recordScanFailure(new ProcessDiscoveryError("first"));
    internals.recordScanFailure(new ProcessDiscoveryError("second"));
    internals.recordScanFailure(new ProcessDiscoveryError("crossing"));

    expect(internals.scanHealth.snapshot()).toMatchObject({
      degraded: true,
      reason: "crossing",
    });
    expect(
      errorLines().some((l) => l.startsWith("Daemon degraded: crossing")),
    ).toBe(true);
  });
});
