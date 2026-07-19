import { describe, it, expect, spyOn, afterAll } from "bun:test";
import type { Preferences } from "../lib/preferences";
import type { Backend } from "../lib/notify";
import * as preferencesMod from "../lib/preferences";
import * as notifyMod from "../lib/notify";
import { DbusNotifier } from "../lib/notify-dbus";
import { createNotifyCommand } from "./notify";

// Deliberately NOT `mock.module`: Bun's module mocks are process-global with
// no per-file restore, so they leak into sibling test files. `spyOn` patches
// the export in place and `mockRestore()` in `afterAll` puts the genuine
// implementation back before any sibling file loads. See the git history of
// this file for the full rationale (the leak broke Linux CI).
let prefs: Preferences = {};

let resolvedBackend: Backend | null = "osascript";
let probeOk = true;
const resolveBackendCalls: unknown[] = [];
const probeBackendCalls: string[] = [];
const deliverCalls: Array<{ backend: string; payload: unknown }> = [];

let dbusProbeOk = true;
let dbusNotifyId: number | null = 1;
const dbusProbeCalls: number[] = [];
const dbusNotifyCalls: unknown[] = [];
const dbusCloseCalls: number[] = [];

/** Resolved ccmux-notifier helper path (null = "not installed"). */
let notifierPath: string | null = "/libexec/ccmux-notifier";
/** What the helper's `list` subcommand reports back. */
let notifierSettings: Record<string, unknown> = {
  authorizationStatus: "authorized",
  alertStyle: "alert",
  alertSetting: "enabled",
  delivered: [],
};
/** Every ccmux-notifier subcommand `ccmux notify` shelled out to. */
const notifierSpawnArgs: string[][] = [];

const spies = [
  spyOn(preferencesMod, "getPreferences").mockImplementation(async () => prefs),
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
  spyOn(notifyMod, "resolveCcmuxNotifierBinary").mockImplementation(
    () => notifierPath,
  ),
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
  // The ccmux-notifier flow shells out to the helper's `request-permission` /
  // `list` subcommands via Bun.spawn; stub it so the JSON round-trip is
  // deterministic without a real .app on the runner. `deliver` is already
  // mocked, so the `post` never reaches here.
  spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
    notifierSpawnArgs.push(argv);
    const isList = argv.includes("list");
    const json = isList ? JSON.stringify(notifierSettings) : "{}";
    return {
      stdout: new Response(json).body,
      exited: Promise.resolve(0),
    };
  }) as unknown as typeof Bun.spawn),
];

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

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
  resolvedBackend = "osascript";
  probeOk = true;
  resolveBackendCalls.length = 0;
  probeBackendCalls.length = 0;
  deliverCalls.length = 0;
  dbusProbeOk = true;
  dbusNotifyId = 1;
  dbusProbeCalls.length = 0;
  dbusNotifyCalls.length = 0;
  dbusCloseCalls.length = 0;
  notifierPath = "/libexec/ccmux-notifier";
  notifierSettings = {
    authorizationStatus: "authorized",
    alertStyle: "alert",
    alertSetting: "enabled",
    delivered: [],
  };
  notifierSpawnArgs.length = 0;
}

describe("ccmux notify: unrecognized backend", () => {
  it("warns that the value is not recognized and falls back to the ladder", async () => {
    reset();
    // Hand-edited ccmux.json can carry a typo; the CLI must warn and degrade to
    // the auto ladder rather than exit or silently hard-disable.
    prefs = {
      notifications: { backend: "bogus" },
    } as unknown as Preferences;
    resolvedBackend = "osascript";
    const restorePlatform = withPlatform("darwin");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit).toBeNull();
      const err = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(err).toContain("is not a recognized backend");
      expect(deliverCalls[0]?.backend).toBe("osascript");
    } finally {
      restoreExit();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      restorePlatform();
    }
  });
});

describe("ccmux notify: osascript", () => {
  it("bare invocation delivers the test message and prints diagnostics + honest limits", async () => {
    reset();
    const restorePlatform = withPlatform("darwin");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit).toBeNull();
      expect(deliverCalls).toHaveLength(1);
      expect(deliverCalls[0]?.backend).toBe("osascript");

      const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      const err = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Backend: osascript");
      // Honest osascript limits + brew recommendation.
      expect(`${out}\n${err}`).toContain("brew install epilande/tap/ccmux");
    } finally {
      restoreExit();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      restorePlatform();
    }
  });

  it("exits 1 with a hint when the probe fails", async () => {
    reset();
    probeOk = false;
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
    } finally {
      restoreExit();
      errorSpy.mockRestore();
      restorePlatform();
    }
  });

  it("bare invocation labels the demo body with a 'Finished' subtitle", async () => {
    reset();
    const restorePlatform = withPlatform("darwin");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit).toBeNull();
      expect(deliverCalls[0]?.payload).toMatchObject({
        subtitle: "Finished",
        body: "Notifications are working",
      });
    } finally {
      restoreExit();
      logSpy.mockRestore();
      restorePlatform();
    }
  });

  it("a custom message carries no subtitle so no false event is implied", async () => {
    reset();
    const restorePlatform = withPlatform("darwin");
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify("Build failed");

      expect(exit).toBeNull();
      expect(deliverCalls[0]?.payload).toMatchObject({
        subtitle: undefined,
        body: "Build failed",
      });
    } finally {
      restoreExit();
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
});

describe("ccmux notify: ccmux-notifier backend", () => {
  it("runs request-permission, posts a probe, and reports the authorized state", async () => {
    reset();
    resolvedBackend = "ccmux-notifier";
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit).toBeNull();
      // request-permission + list both shelled out; the post went through the
      // mocked `deliver`.
      expect(
        notifierSpawnArgs.some((a) => a.includes("request-permission")),
      ).toBe(true);
      expect(notifierSpawnArgs.some((a) => a.includes("list"))).toBe(true);
      expect(deliverCalls[0]?.backend).toBe("ccmux-notifier");

      const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Backend: ccmux-notifier");
      expect(out).toContain("Authorization: authorized");
    } finally {
      restoreExit();
      logSpy.mockRestore();
    }
  });

  it("prints the Settings deep-link grant instructions when not authorized", async () => {
    reset();
    resolvedBackend = "ccmux-notifier";
    notifierSettings = {
      authorizationStatus: "denied",
      alertStyle: "none",
      alertSetting: "disabled",
      delivered: [],
    };
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      await runNotify();

      const err = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(err).toContain("not authorized");
      expect(err).toContain(
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
      );
      expect(err).toContain("Persistent");
    } finally {
      restoreExit();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("falls back to osascript AND delivers when the helper is not installed", async () => {
    reset();
    resolvedBackend = "ccmux-notifier";
    notifierPath = null;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify();

      expect(exit).toBeNull();
      const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      const err = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("ccmux-notifier helper not found");
      expect(err).toContain("brew install epilande/tap/ccmux");
      // The notification is actually delivered via the osascript floor, not
      // dropped: the daemon (and v1) both deliver here.
      expect(probeBackendCalls).toContain("osascript");
      expect(deliverCalls).toHaveLength(1);
      expect(deliverCalls[0]?.backend).toBe("osascript");
      expect(deliverCalls[0]?.payload).toMatchObject({
        body: "Notifications are working",
      });
      // No helper subcommands (request-permission/list) when the helper is absent.
      expect(notifierSpawnArgs).toHaveLength(0);
    } finally {
      restoreExit();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("stays quiet but still delivers via osascript on a custom message when the helper is not installed", async () => {
    reset();
    resolvedBackend = "ccmux-notifier";
    notifierPath = null;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify("custom message");

      expect(exit).toBeNull();
      // Honors the script-friendly quiet contract: no backend/hint diagnostics.
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      // Still delivers the message verbatim via the osascript floor.
      expect(deliverCalls).toHaveLength(1);
      expect(deliverCalls[0]?.backend).toBe("osascript");
      expect(deliverCalls[0]?.payload).toMatchObject({
        body: "custom message",
      });
    } finally {
      restoreExit();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("exits 1 when the helper is not installed and the osascript floor probe fails", async () => {
    reset();
    resolvedBackend = "ccmux-notifier";
    notifierPath = null;
    probeOk = false;
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
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });

  it("stays quiet on a custom message (still posts through the helper)", async () => {
    reset();
    resolvedBackend = "ccmux-notifier";
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runNotify("custom message");

      expect(exit).toBeNull();
      expect(deliverCalls[0]?.payload).toMatchObject({
        body: "custom message",
      });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      restoreExit();
      logSpy.mockRestore();
    }
  });
});

describe("ccmux notify: dbus backend", () => {
  it("one-shot: connects, probes, notifies, and closes — skipping lib probeBackend/deliver", async () => {
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
