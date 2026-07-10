import { describe, it, expect, spyOn, afterAll } from "bun:test";
import type { Preferences } from "../lib/preferences";
import type { Backend } from "../lib/notify";
import * as preferencesMod from "../lib/preferences";
import * as notifyMod from "../lib/notify";
import * as tmuxClientMod from "../lib/tmux-client";
import * as focusMod from "../daemon/focus";
import { DbusNotifier } from "../lib/notify-dbus";
import { createNotifyCommand, resolveSenderBundleId } from "./notify";

// Deliberately NOT `mock.module`: Bun's module mocks are process-global with
// no per-file restore, so they leak into sibling test files that exercise the
// real implementations (`lib/notify.test.ts`, `lib/notify-dbus.test.ts`,
// `lib/tmux-client.test.ts`, `daemon/focus.test.ts`), failing them when this
// file loads first (order-dependent: Linux CI, not macOS). And the obvious
// restore recipe — capture the real module at top level and swap it back in
// `afterAll` — deadlocks Bun 1.3.x when the poisoned order actually occurs
// (a top-level `await import()`/`require()` of a module that this file also
// `mock.module`s hangs the whole run).
//
// `spyOn(namespace, name)` sidesteps both: it patches the export in place on
// the shared module record (so `notify.ts`'s static imports observe the fake
// at call time), and `mockRestore()` in `afterAll` puts the genuine
// implementation back before any sibling file loads. The dbus path is
// stubbed at `DbusNotifier.prototype` (probe/notify/close) instead of
// replacing the class — the real constructor is inert (it connects lazily),
// so instances created by the command are safe to construct for real.
let prefs: Preferences = {};

let resolvedBackend: Backend | null = "terminal-notifier";
let probeOk = true;
const resolveBackendCalls: unknown[] = [];
const probeBackendCalls: string[] = [];
const deliverCalls: Array<{ backend: string; payload: unknown }> = [];

let dbusProbeOk = true;
let dbusNotifyId: number | null = 1;
const dbusProbeCalls: number[] = [];
const dbusNotifyCalls: unknown[] = [];
const dbusCloseCalls: number[] = [];

let clientPid: number | null = null;
let terminalBundleId: string | null = null;

const spies = [
  // Neutralize preferences I/O so tests never touch the real ccmux.json.
  spyOn(preferencesMod, "getPreferences").mockImplementation(async () => prefs),
  // Stand in for src/lib/notify.ts: resolveBackend/probeBackend are the only
  // failure signals the command can observe (deliver is void, so there is no
  // delivery-failure path to test - see notify.ts's plan).
  spyOn(notifyMod, "resolveBackend").mockImplementation((config) => {
    resolveBackendCalls.push(config);
    return resolvedBackend;
  }),
  spyOn(notifyMod, "probeBackend").mockImplementation(async (backend) => {
    probeBackendCalls.push(backend);
    return probeOk;
  }),
  spyOn(notifyMod, "deliver").mockImplementation(async (backend, payload) => {
    deliverCalls.push({ backend, payload });
  }),
  // Stand in for src/lib/notify-dbus.ts: the dbus backend is one-shot
  // (probe/notify/close) and routes through `DbusNotifier` entirely,
  // bypassing resolveBackend/probeBackend/deliver above.
  spyOn(DbusNotifier.prototype, "probe").mockImplementation(async () => {
    dbusProbeCalls.push(dbusProbeCalls.length);
    return dbusProbeOk;
  }),
  spyOn(DbusNotifier.prototype, "notify").mockImplementation(
    async (payload) => {
      dbusNotifyCalls.push(payload);
      return dbusNotifyId;
    },
  ),
  spyOn(DbusNotifier.prototype, "close").mockImplementation(async () => {
    dbusCloseCalls.push(dbusCloseCalls.length);
  }),
  // The "terminal" icon's bundle-id resolution depends on real tmux/platform
  // state (`$TMUX`, darwin, an actual `.app`-hosted client) - deterministically
  // mocked here rather than left to whatever environment happens to run the
  // test (a real tmux session on the test runner's machine would otherwise
  // make "no sender" assertions flaky).
  spyOn(tmuxClientMod, "getActiveTmuxClientPid").mockImplementation(
    async () => clientPid,
  ),
  spyOn(focusMod, "resolveTerminalBundleId").mockImplementation(
    async () => terminalBundleId,
  ),
];

// Hand every export back to its real implementation once this file's tests
// complete, so sibling files loaded afterwards see real behavior.
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

/**
 * Sentinel for process.exit: a no-op mock wouldn't halt execution, so a
 * failure path would fall through to the diagnostics printer. Throwing halts
 * like the real exit; the test catches it to assert the code.
 */
class ExitError extends Error {
  constructor(public code?: number) {
    super(`process.exit(${code})`);
  }
}

function withExitSentinel(): () => void {
  const original = process.exit;
  process.exit = ((code?: number) => {
    throw new ExitError(code);
  }) as never;
  return () => {
    process.exit = original;
  };
}

/**
 * Pins `process.platform` so assertions on `printFailureHints`' output are
 * deterministic. Those hints branch on the platform (the icon-impersonation
 * advice is macOS-only), so a test asserting the darwin text would otherwise
 * fail on a Linux runner - the exact break that only surfaced on CI.
 */
function withPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(process, "platform", original);
  };
}

async function runNotify(message?: string): Promise<ExitError | null> {
  try {
    await createNotifyCommand().parseAsync(message ? [message] : [], {
      from: "user",
    });
    return null;
  } catch (err) {
    if (err instanceof ExitError) return err;
    throw err;
  }
}

function reset(): void {
  prefs = {};
  resolvedBackend = "terminal-notifier";
  probeOk = true;
  clientPid = null;
  terminalBundleId = null;
  resolveBackendCalls.length = 0;
  probeBackendCalls.length = 0;
  deliverCalls.length = 0;
  dbusProbeOk = true;
  dbusNotifyId = 1;
  dbusProbeCalls.length = 0;
  dbusNotifyCalls.length = 0;
  dbusCloseCalls.length = 0;
}

describe("ccmux notify", () => {
  it("bare invocation sends the test message and prints diagnostics", async () => {
    reset();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit).toBeNull();
      expect(deliverCalls).toHaveLength(1);
      expect(deliverCalls[0]?.backend).toBe("terminal-notifier");
      expect(deliverCalls[0]?.payload).toMatchObject({
        body: "Notifications are working",
      });

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("Backend: terminal-notifier");
      expect(output).toContain("Probe: ok");
      expect(output).toContain("Effective config:");
    } finally {
      restoreExit();
      logSpy.mockRestore();
    }
  });

  it("exits 1 with a hint when the probe fails", async () => {
    reset();
    probeOk = false;
    // The `notifications.icon none` hint is macOS-only; pin the platform so
    // this assertion holds regardless of the runner's OS.
    const restorePlatform = withPlatform("darwin");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit?.code).toBe(1);
      expect(deliverCalls).toHaveLength(0);
      expect(
        errorSpy.mock.calls.some((c) =>
          String(c[0]).includes("is not available"),
        ),
      ).toBe(true);
      expect(
        errorSpy.mock.calls.some((c) =>
          String(c[0]).includes("notifications.icon none"),
        ),
      ).toBe(true);
    } finally {
      restoreExit();
      errorSpy.mockRestore();
      restorePlatform();
    }
  });

  it("exits 1 when no backend resolves for the platform", async () => {
    reset();
    resolvedBackend = null;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit?.code).toBe(1);
      expect(probeBackendCalls).toHaveLength(0);
      expect(deliverCalls).toHaveLength(0);
      expect(
        errorSpy.mock.calls.some((c) =>
          String(c[0]).includes("No supported notification backend"),
        ),
      ).toBe(true);
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });

  it("delivers a supplied message verbatim and stays quiet on success", async () => {
    reset();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify("custom message");

      expect(exit).toBeNull();
      expect(deliverCalls).toHaveLength(1);
      expect(deliverCalls[0]?.payload).toMatchObject({
        body: "custom message",
      });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      restoreExit();
      logSpy.mockRestore();
    }
  });

  it("passes senderBundleId only for an explicit bundle id icon", async () => {
    reset();
    prefs = { notifications: { icon: "com.example.term" } };
    const restoreExit = withExitSentinel();
    try {
      await runNotify("hi");
      expect(deliverCalls[0]?.payload).toMatchObject({
        senderBundleId: "com.example.term",
      });
    } finally {
      restoreExit();
    }
  });

  it("passes no senderBundleId for the default terminal icon or none", async () => {
    reset();
    const restoreExit = withExitSentinel();
    try {
      await runNotify("hi");
      expect(
        (deliverCalls[0]?.payload as { senderBundleId?: string })
          .senderBundleId,
      ).toBeUndefined();

      reset();
      prefs = { notifications: { icon: "none" } };
      await runNotify("hi");
      expect(
        (deliverCalls[0]?.payload as { senderBundleId?: string })
          .senderBundleId,
      ).toBeUndefined();
    } finally {
      restoreExit();
    }
  });
});

describe("ccmux notify: dbus backend", () => {
  it("one-shot: connects, probes, notifies, and closes the DbusNotifier — skipping lib probeBackend/deliver entirely", async () => {
    reset();
    resolvedBackend = "dbus";
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit).toBeNull();
      expect(dbusProbeCalls).toHaveLength(1);
      expect(dbusNotifyCalls).toHaveLength(1);
      expect(dbusNotifyCalls[0]).toMatchObject({
        body: "Notifications are working",
      });
      expect(dbusCloseCalls).toHaveLength(1);
      expect(probeBackendCalls).toHaveLength(0);
      expect(deliverCalls).toHaveLength(0);

      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("Backend: dbus");
    } finally {
      restoreExit();
      logSpy.mockRestore();
    }
  });

  it("delivers a supplied message verbatim via the DbusNotifier", async () => {
    reset();
    resolvedBackend = "dbus";
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify("custom message");
      expect(exit).toBeNull();
      expect(dbusNotifyCalls[0]).toMatchObject({ body: "custom message" });
    } finally {
      restoreExit();
    }
  });

  it("exits 1 with a dbus-specific hint when the probe fails, still closing the notifier", async () => {
    reset();
    resolvedBackend = "dbus";
    dbusProbeOk = false;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit?.code).toBe(1);
      expect(dbusNotifyCalls).toHaveLength(0);
      expect(dbusCloseCalls).toHaveLength(1);
      expect(
        errorSpy.mock.calls.some((c) =>
          String(c[0]).includes("is not available"),
        ),
      ).toBe(true);
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });

  it("exits 1 when notify() itself fails (returns null)", async () => {
    reset();
    resolvedBackend = "dbus";
    dbusNotifyId = null;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit?.code).toBe(1);
      expect(dbusCloseCalls).toHaveLength(1);
      expect(
        errorSpy.mock.calls.some((c) =>
          String(c[0]).includes("Failed to deliver"),
        ),
      ).toBe(true);
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });
});

/** Ensure `$TMUX` is unset/set for the duration of the test. */
function withTmuxEnv(value: string | undefined): () => void {
  const original = process.env.TMUX;
  if (value === undefined) delete process.env.TMUX;
  else process.env.TMUX = value;
  return () => {
    if (original === undefined) delete process.env.TMUX;
    else process.env.TMUX = original;
  };
}

describe("resolveSenderBundleId", () => {
  it("icon 'none' -> undefined regardless of platform/tmux", async () => {
    expect(await resolveSenderBundleId("none", "darwin")).toBeUndefined();
    expect(await resolveSenderBundleId("none", "linux")).toBeUndefined();
  });

  it("an explicit bundle id passes through verbatim regardless of platform/tmux", async () => {
    expect(await resolveSenderBundleId("com.example.term", "linux")).toBe(
      "com.example.term",
    );
  });

  it("icon 'terminal' on a non-darwin platform -> undefined without resolving", async () => {
    reset();
    clientPid = 42;
    terminalBundleId = "com.mitchellh.ghostty";
    expect(await resolveSenderBundleId("terminal", "linux")).toBeUndefined();
  });

  it("icon 'terminal' on darwin outside tmux -> undefined without resolving", async () => {
    reset();
    clientPid = 42;
    terminalBundleId = "com.mitchellh.ghostty";
    const restore = withTmuxEnv(undefined);
    try {
      expect(await resolveSenderBundleId("terminal", "darwin")).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("icon 'terminal' on darwin inside tmux resolves the terminal bundle id", async () => {
    reset();
    clientPid = 42;
    terminalBundleId = "com.mitchellh.ghostty";
    const restore = withTmuxEnv("/tmp/sock,1,0");
    try {
      expect(await resolveSenderBundleId("terminal", "darwin")).toBe(
        "com.mitchellh.ghostty",
      );
    } finally {
      restore();
    }
  });

  it("icon 'terminal' falls back to undefined when no client pid resolves", async () => {
    reset();
    clientPid = null;
    const restore = withTmuxEnv("/tmp/sock,1,0");
    try {
      expect(await resolveSenderBundleId("terminal", "darwin")).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("icon 'terminal' falls back to undefined when the bundle id can't be resolved", async () => {
    reset();
    clientPid = 42;
    terminalBundleId = null;
    const restore = withTmuxEnv("/tmp/sock,1,0");
    try {
      expect(await resolveSenderBundleId("terminal", "darwin")).toBeUndefined();
    } finally {
      restore();
    }
  });
});
