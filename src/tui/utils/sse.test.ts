import { describe, it, expect } from "bun:test";
import { dispatchSSEEvent, type SSECallbacks } from "./sse";
import type {
  DaemonHealth,
  InvocationSnapshotEntry,
  SSEEvent,
} from "../../types";

// Locks the client half of the invocation-snapshot wiring: `onInit` is the
// only consumer of the optional `invocations` arg, so a dropped third arg or a
// missing `?? []` would silently disable reconnect reconciliation with every
// other test still green. Driven through the pure dispatcher (no socket) so it
// is immune to App.test's process-wide SSEClient mock.

function makeCallbacks(over: Partial<SSECallbacks> = {}): SSECallbacks {
  return {
    onInit: () => {},
    onSessionCreated: () => {},
    onSessionUpdated: () => {},
    onSessionRemoved: () => {},
    onConnectionStateChange: () => {},
    onError: () => {},
    ...over,
  };
}

describe("dispatchSSEEvent init handling", () => {
  it("threads init.invocations through to onInit", () => {
    let received: InvocationSnapshotEntry[] | undefined;
    dispatchSSEEvent(
      {
        type: "init",
        timestamp: "2024-01-15T12:00:00Z",
        sessions: [],
        activePaneId: null,
        invocations: [{ invocationId: "inv_a", status: "running" }],
        health: { degraded: false },
      },
      makeCallbacks({ onInit: (_s, _p, inv) => (received = inv) }),
    );
    expect(received).toEqual([{ invocationId: "inv_a", status: "running" }]);
  });

  it("routes init.health to onDaemonHealth when present", () => {
    let received: DaemonHealth | undefined;
    dispatchSSEEvent(
      {
        type: "init",
        timestamp: "2024-01-15T12:00:00Z",
        sessions: [],
        activePaneId: null,
        invocations: [],
        health: {
          degraded: true,
          reason: "ps spawn failed",
          since: "2024-01-15T12:00:00Z",
        },
      },
      makeCallbacks({ onDaemonHealth: (h) => (received = h) }),
    );
    expect(received).toEqual({
      degraded: true,
      reason: "ps spawn failed",
      since: "2024-01-15T12:00:00Z",
    });
  });

  it("skips onDaemonHealth when an init frame omits health (older daemon)", () => {
    let called = false;
    // Older daemon: no health field on init, so the client leaves its default
    // healthy state untouched rather than clobbering it.
    const legacyInit = {
      type: "init",
      timestamp: "2024-01-15T12:00:00Z",
      sessions: [],
      activePaneId: null,
      invocations: [],
    } as unknown as SSEEvent;
    dispatchSSEEvent(
      legacyInit,
      makeCallbacks({ onDaemonHealth: () => (called = true) }),
    );
    expect(called).toBe(false);
  });

  it("passes [] to onInit when an init frame omits invocations (older daemon)", () => {
    let called = false;
    let received: InvocationSnapshotEntry[] | undefined;
    // An older daemon's init frame has no invocations field; the wire shape
    // predates the snapshot, so cast past the now-required property.
    const legacyInit = {
      type: "init",
      timestamp: "2024-01-15T12:00:00Z",
      sessions: [],
      activePaneId: null,
    } as unknown as SSEEvent;
    dispatchSSEEvent(
      legacyInit,
      makeCallbacks({
        onInit: (_s, _p, inv) => {
          called = true;
          received = inv;
        },
      }),
    );
    expect(called).toBe(true);
    expect(received).toEqual([]);
  });
});

describe("dispatchSSEEvent daemon_health handling", () => {
  it("routes a daemon_health event to onDaemonHealth", () => {
    let received: DaemonHealth | undefined;
    dispatchSSEEvent(
      {
        type: "daemon_health",
        timestamp: "2024-01-15T12:00:00Z",
        health: {
          degraded: true,
          reason: "ps spawn failed",
          since: "2024-01-15T12:00:00Z",
        },
      },
      makeCallbacks({ onDaemonHealth: (h) => (received = h) }),
    );
    expect(received).toEqual({
      degraded: true,
      reason: "ps spawn failed",
      since: "2024-01-15T12:00:00Z",
    });
  });

  it("routes a recovered daemon_health event", () => {
    let received: DaemonHealth | undefined;
    dispatchSSEEvent(
      {
        type: "daemon_health",
        timestamp: "2024-01-15T12:00:00Z",
        health: { degraded: false },
      },
      makeCallbacks({ onDaemonHealth: (h) => (received = h) }),
    );
    expect(received).toEqual({ degraded: false });
  });
});
