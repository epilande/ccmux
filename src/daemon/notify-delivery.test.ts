import { describe, it, expect } from "bun:test";
import {
  createNotifyDelivery,
  type DeliveryDeps,
  type DbusNotifierLike,
} from "./notify-delivery";
import type { NotificationPayload, SpawnFn } from "../lib/notify";
import type { NotificationActionInput } from "./notification-action";

const BASE_PAYLOAD: NotificationPayload = {
  title: "ccmux (main) · Claude Code",
  body: "Finished",
  event: "finished",
  sessionId: "abc123",
  agent: "Claude Code",
  project: "ccmux",
  pane: "%5",
};

/** A fake `DbusNotifier`: `probe`/`notify`/`retract`/`close` calls recorded,
 * `notify` returns incrementing ids and captures any registered `onAction`. */
function createFakeDbusNotifier(probeResult = true): {
  notifier: DbusNotifierLike;
  probeCalls: number[];
  notifyCalls: Array<{
    payload: NotificationPayload;
    onAction?: (actionKey: string, userText?: string) => void;
    canDefault?: boolean;
  }>;
  retractCalls: string[];
  closeCalls: number[];
} {
  let nextId = 1;
  const probeCalls: number[] = [];
  const notifyCalls: Array<{
    payload: NotificationPayload;
    onAction?: (actionKey: string, userText?: string) => void;
    canDefault?: boolean;
  }> = [];
  const retractCalls: string[] = [];
  const closeCalls: number[] = [];
  const notifier: DbusNotifierLike = {
    probe: async () => {
      probeCalls.push(probeCalls.length);
      return probeResult;
    },
    notify: async (payload, options) => {
      notifyCalls.push({
        payload,
        onAction: options?.onAction,
        canDefault: options?.canDefault,
      });
      return nextId++;
    },
    retract: async (sessionId) => {
      retractCalls.push(sessionId);
    },
    close: async () => {
      closeCalls.push(closeCalls.length);
    },
  };
  return { notifier, probeCalls, notifyCalls, retractCalls, closeCalls };
}

const NOTIFIER_PATH =
  "/opt/homebrew/libexec/ccmux-notifier.app/Contents/MacOS/ccmux-notifier";

function createDeps(overrides: Partial<DeliveryDeps> = {}): {
  deps: DeliveryDeps;
  delivered: Array<{ backend: string; payload: NotificationPayload }>;
  probeCalls: string[];
  logs: string[];
  spawnCalls: { argv: string[] }[];
  actionCalls: NotificationActionInput[];
  tmuxCaptureCalls: string[][];
  ttyWrites: Array<{ tty: string; data: string }>;
} {
  const delivered: Array<{ backend: string; payload: NotificationPayload }> =
    [];
  const probeCalls: string[] = [];
  const logs: string[] = [];
  const spawnCalls: { argv: string[] }[] = [];
  const actionCalls: NotificationActionInput[] = [];
  const tmuxCaptureCalls: string[][] = [];
  const ttyWrites: Array<{ tty: string; data: string }> = [];

  const defaultSpawn: SpawnFn = (argv) => {
    spawnCalls.push({ argv });
    return { exited: Promise.resolve(0) };
  };

  // Passthrough on, a non-kitty (generic OSC 9) client by default.
  const defaultRunTmuxCapture = (args: string[]): string | null => {
    tmuxCaptureCalls.push(args);
    if (args.includes("allow-passthrough")) return "on\n";
    if (args.includes("list-clients")) return "xterm-ghostty\n";
    return null;
  };

  const deps: DeliveryDeps = {
    getPrefs: overrides.getPrefs ?? (async () => ({})),
    resolveActiveClientTty:
      overrides.resolveActiveClientTty ?? (async () => "/dev/ttys002"),
    resolveBackend: overrides.resolveBackend ?? (() => "osascript"),
    probeBackend:
      overrides.probeBackend ??
      (async (backend) => {
        probeCalls.push(backend);
        return true;
      }),
    deliver:
      overrides.deliver ??
      (async (backend, payload) => {
        delivered.push({ backend, payload });
      }),
    resolveNotifierPath: overrides.resolveNotifierPath ?? (() => NOTIFIER_PATH),
    notifierCallbackUrl:
      overrides.notifierCallbackUrl ??
      "http://127.0.0.1:2269/notification-action",
    probeNotifier: overrides.probeNotifier ?? (async () => true),
    runNotificationAction:
      overrides.runNotificationAction ??
      ((input) => {
        actionCalls.push(input);
      }),
    // `??` would treat an explicit `ccmuxPath: null` override the same as
    // "not overridden"; `"ccmuxPath" in overrides` distinguishes the two.
    ccmuxPath:
      "ccmuxPath" in overrides
        ? (overrides.ccmuxPath ?? null)
        : "/opt/homebrew/bin/ccmux",
    tmuxPath: overrides.tmuxPath ?? "/opt/homebrew/bin/tmux",
    getPaneTty: overrides.getPaneTty ?? (() => "/dev/ttys061"),
    runTmuxCapture: overrides.runTmuxCapture ?? defaultRunTmuxCapture,
    writeToTty:
      overrides.writeToTty ??
      ((tty, data) => {
        ttyWrites.push({ tty, data });
      }),
    createDbusNotifier:
      overrides.createDbusNotifier ?? (() => createFakeDbusNotifier().notifier),
    spawn: overrides.spawn ?? defaultSpawn,
    log: overrides.log ?? ((message) => logs.push(message)),
  };

  return {
    deps,
    delivered,
    probeCalls,
    logs,
    spawnCalls,
    actionCalls,
    tmuxCaptureCalls,
    ttyWrites,
  };
}

describe("createNotifyDelivery: probe-once-disable", () => {
  it("probes the backend once on the first delivery and delivers on success", async () => {
    const { deps, delivered, probeCalls } = createDeps();
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(probeCalls).toEqual(["osascript"]);
    expect(delivered).toHaveLength(2);
  });

  it("disables all future delivery after a failed probe, logging once", async () => {
    let probeCallCount = 0;
    const { deps, delivered, logs } = createDeps({
      probeBackend: async () => {
        probeCallCount++;
        return false;
      },
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(probeCallCount).toBe(1);
    expect(delivered).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("failed its startup probe");
  });

  it("no backend resolved -> no probe, no delivery", async () => {
    const { deps, delivered, probeCalls } = createDeps({
      resolveBackend: () => null,
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);

    expect(probeCalls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
  });

  it("delivery failure is swallowed and does not disable future deliveries", async () => {
    let calls = 0;
    const { deps, logs } = createDeps({
      deliver: async () => {
        calls++;
        throw new Error("spawn failed");
      },
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(calls).toBe(2);
    expect(logs.some((l) => l.includes("delivery failed"))).toBe(true);
  });
});

describe("createNotifyDelivery: unrecognized backend", () => {
  it("logs once per run when the configured backend is unrecognized, still delivering via the ladder", async () => {
    const { deps, delivered, logs } = createDeps({
      getPrefs: async () => ({
        notifications: { backend: "bogus" as never },
      }),
      // The real resolveBackend maps the unknown value onto the ladder; the
      // fake stands in for its darwin result.
      resolveBackend: () => "osascript",
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(delivered.map((d) => d.backend)).toEqual(["osascript", "osascript"]);
    expect(
      logs.filter((l) => l.includes("is not a recognized backend")),
    ).toHaveLength(1);
  });
});

describe("createNotifyDelivery: ccmux-notifier rung", () => {
  it("stamps the resolved helper path + callback URL onto the delivered payload", async () => {
    const { deps, delivered } = createDeps({
      resolveBackend: () => "ccmux-notifier",
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.backend).toBe("ccmux-notifier");
    expect(delivered[0]?.payload.notifierPath).toBe(NOTIFIER_PATH);
    expect(delivered[0]?.payload.callbackUrl).toBe(
      "http://127.0.0.1:2269/notification-action",
    );
  });

  it("probes the helper once and caches it across deliveries", async () => {
    let probeCount = 0;
    const { deps, delivered } = createDeps({
      resolveBackend: () => "ccmux-notifier",
      probeNotifier: async () => {
        probeCount++;
        return true;
      },
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(probeCount).toBe(1);
    expect(delivered).toHaveLength(2);
  });

  it("falls to osascript when the helper is unresolvable", async () => {
    const { deps, delivered, probeCalls } = createDeps({
      resolveBackend: () => "ccmux-notifier",
      resolveNotifierPath: () => null,
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.backend).toBe("osascript");
    expect(probeCalls).toEqual(["osascript"]);
  });

  it("falls to osascript when the helper probe fails, logging once", async () => {
    const { deps, delivered, logs } = createDeps({
      resolveBackend: () => "ccmux-notifier",
      probeNotifier: async () => false,
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.backend).toBe("osascript");
    expect(
      logs.some(
        (l) => l.includes('"ccmux-notifier"') && l.includes("osascript"),
      ),
    ).toBe(true);
  });
});

describe("createNotifyDelivery: dbus routing", () => {
  it("dbus success routes to the DbusNotifier, not lib deliver", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps, delivered, probeCalls } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);

    expect(fake.notifyCalls).toHaveLength(1);
    expect(fake.notifyCalls[0]?.payload).toBe(BASE_PAYLOAD);
    expect(delivered).toHaveLength(0);
    expect(probeCalls).toHaveLength(0); // lib probeBackend never consulted
  });

  it("dbus probe failure falls back to notify-send for that delivery", async () => {
    const fake = createFakeDbusNotifier(false);
    const { deps, delivered, probeCalls, logs } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(fake.probeCalls).toHaveLength(1);
    expect(fake.notifyCalls).toHaveLength(0);
    expect(probeCalls).toEqual(["notify-send"]);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.backend).toBe("notify-send");
    expect(
      logs.some((l) => l.includes('"dbus"') && l.includes("falling back")),
    ).toBe(true);
  });

  it("default/Open action routes through the shared handler (live pane, one code path), not a direct spawn", async () => {
    // Regression: previously the dbus default-click jumped via a direct
    // performJump using the delivery-time pane snapshot, diverging from the
    // macOS HTTP path. It must route through runNotificationAction so the
    // handler re-reads the LIVE pane and the safety code paths stay unified.
    const fake = createFakeDbusNotifier(true);
    const { deps, spawnCalls, actionCalls } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const { deliver } = createNotifyDelivery(deps);

    const payload: NotificationPayload = {
      ...BASE_PAYLOAD, // pane: "%5"
      statusChangedAt: "t-9",
    };
    await deliver(payload);

    const onAction = fake.notifyCalls[0]?.onAction;
    expect(onAction).toBeDefined();
    onAction!("default");
    await Promise.resolve();
    await Promise.resolve();

    expect(actionCalls).toEqual([
      { sessionId: "abc123", action: "default", statusChangedAt: "t-9" },
    ]);
    // No direct tmux spawn from the delivery layer anymore.
    expect(spawnCalls).toHaveLength(0);
  });

  it("advertises canDefault=true for a bound session (default/Open pair shown)", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD); // pane: "%5"

    expect(fake.notifyCalls[0]?.canDefault).toBe(true);
  });

  it("advertises canDefault=false for a background session with no ccmuxPath (no dead Open button)", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
      ccmuxPath: null,
    });
    const { deliver } = createNotifyDelivery(deps);

    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      pane: null,
      background: true,
      // A button keeps onAction wired, but the jump still can't land.
      actions: [{ id: "approve", label: "Approve" }],
    };
    await deliver(payload);

    expect(fake.notifyCalls[0]?.onAction).toBeDefined();
    expect(fake.notifyCalls[0]?.canDefault).toBe(false);
  });

  it("approve/deny actions route to the shared notification-action handler", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps, actionCalls } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const { deliver } = createNotifyDelivery(deps);

    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      statusChangedAt: "t-1",
      attentionGeneration: 6,
      actions: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
    };
    await deliver(payload);

    const onAction = fake.notifyCalls[0]?.onAction;
    onAction!("approve");
    expect(actionCalls).toEqual([
      {
        sessionId: "abc123",
        action: "approve",
        statusChangedAt: "t-1",
        attentionGeneration: 6,
      },
    ]);
  });

  it("an answer action forwards the typed reply text", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps, actionCalls } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const { deliver } = createNotifyDelivery(deps);

    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      statusChangedAt: "t-2",
      reply: { id: "answer", label: "Reply" },
    };
    await deliver(payload);

    const onAction = fake.notifyCalls[0]?.onAction;
    onAction!("answer", "the staging bucket");
    expect(actionCalls).toEqual([
      {
        sessionId: "abc123",
        action: "answer",
        statusChangedAt: "t-2",
        userText: "the staging bucket",
      },
    ]);
  });

  it("routes both approve and answer from one payload carrying actions and reply", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps, actionCalls } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const { deliver } = createNotifyDelivery(deps);

    // A permission wait deny-with-feedback stamps buttons AND a reply together.
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      statusChangedAt: "t-3",
      actions: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
      reply: { id: "answer", label: "Reply" },
    };
    await deliver(payload);

    const onAction = fake.notifyCalls[0]?.onAction;
    onAction!("approve");
    onAction!("answer", "use a safer flag");
    expect(actionCalls).toEqual([
      { sessionId: "abc123", action: "approve", statusChangedAt: "t-3" },
      {
        sessionId: "abc123",
        action: "answer",
        statusChangedAt: "t-3",
        userText: "use a safer flag",
      },
    ]);
  });

  it("omits onAction for a background session with no ccmuxPath and no buttons", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
      ccmuxPath: null,
    });
    const { deliver } = createNotifyDelivery(deps);
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      pane: null,
      background: true,
    };

    await deliver(payload);

    expect(fake.notifyCalls[0]?.onAction).toBeUndefined();
  });

  it("still wires onAction for a background session with no ccmuxPath when buttons are present", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
      ccmuxPath: null,
    });
    const { deliver } = createNotifyDelivery(deps);
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      pane: null,
      background: true,
      actions: [{ id: "approve", label: "Approve" }],
    };

    await deliver(payload);

    expect(fake.notifyCalls[0]?.onAction).toBeDefined();
  });
});

describe("createNotifyDelivery: retract", () => {
  it("spawns `remove --group` for the ccmux-notifier backend after a successful delivery", async () => {
    const { deps, spawnCalls } = createDeps({
      resolveBackend: () => "ccmux-notifier",
    });
    const { deliver, retract } = createNotifyDelivery(deps);

    // A delivery must have probed the helper OK first — retract shares that cache.
    await deliver(BASE_PAYLOAD);
    await retract("abc123");

    expect(spawnCalls[0]?.argv).toEqual([
      NOTIFIER_PATH,
      "remove",
      "--group",
      "ccmux-abc123",
    ]);
  });

  it("no-ops the ccmux-notifier retract when nothing was delivered yet (probe never ran)", async () => {
    // Regression: retract must consult the same per-backend probe cache deliver
    // uses. With no prior delivery the helper was never probed, so nothing was
    // posted through it — there is nothing to remove.
    const { deps, spawnCalls } = createDeps({
      resolveBackend: () => "ccmux-notifier",
    });
    const { retract } = createNotifyDelivery(deps);

    await retract("abc123");

    expect(spawnCalls).toHaveLength(0);
  });

  it("no-ops the ccmux-notifier retract when the helper probe failed (delivery fell back to osascript)", async () => {
    // osascript deliveries post under a different identity and are unretractable
    // anyway; retract must not spawn the helper's `remove` for them.
    const { deps, spawnCalls } = createDeps({
      resolveBackend: () => "ccmux-notifier",
      probeNotifier: async () => false,
    });
    const { deliver, retract } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD); // probe fails -> falls to osascript
    await retract("abc123");

    expect(spawnCalls.some((c) => c.argv.includes("remove"))).toBe(false);
  });

  it("no-ops the ccmux-notifier retract when the helper is unresolvable", async () => {
    const { deps, spawnCalls } = createDeps({
      resolveBackend: () => "ccmux-notifier",
      resolveNotifierPath: () => null,
    });
    const { retract } = createNotifyDelivery(deps);

    await retract("abc123");

    expect(spawnCalls).toHaveLength(0);
  });

  it("calls DbusNotifier.retract for the dbus backend, sharing the delivery connection", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const { deliver, retract } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD); // establishes the shared dbus notifier
    await retract("abc123");

    expect(fake.retractCalls).toEqual(["abc123"]);
    // Same instance used for delivery + retract (constructed once).
    expect(fake.notifyCalls).toHaveLength(1);
  });

  it("no-ops retract for backends that cannot retract (osascript)", async () => {
    const { deps, spawnCalls } = createDeps({
      resolveBackend: () => "osascript",
    });
    const { retract } = createNotifyDelivery(deps);

    await retract("abc123");

    expect(spawnCalls).toHaveLength(0);
  });

  it("retract never throws when the underlying spawn throws", async () => {
    const { deps } = createDeps({
      resolveBackend: () => "ccmux-notifier",
      spawn: () => {
        throw new Error("spawn ENOENT");
      },
    });
    const { deliver, retract } = createNotifyDelivery(deps);

    // Deliver first so the probe cache marks the helper usable; retract then
    // reaches the (throwing) spawn and must still swallow it.
    await deliver(BASE_PAYLOAD);
    await expect(retract("abc123")).resolves.toBeUndefined();
  });
});

describe("createNotifyDelivery: osc backend", () => {
  it("writes the passthrough sequence to the bound pane's tty", async () => {
    const { deps, ttyWrites, tmuxCaptureCalls } = createDeps({
      resolveBackend: () => "osc",
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);

    expect(ttyWrites).toHaveLength(1);
    expect(ttyWrites[0]!.tty).toBe("/dev/ttys061");
    // tmux passthrough framing, generic OSC 9 (non-kitty default client).
    expect(ttyWrites[0]!.data).toContain("\x1bPtmux;");
    expect(ttyWrites[0]!.data).toContain("]9;");
    // Probed allow-passthrough and sniffed the client termname.
    expect(tmuxCaptureCalls.some((a) => a.includes("allow-passthrough"))).toBe(
      true,
    );
    // The termname sniff is scoped to the notification's own session via the
    // pane target, not server-wide.
    const listClientsCall = tmuxCaptureCalls.find((a) =>
      a.includes("list-clients"),
    );
    expect(listClientsCall).toEqual([
      "list-clients",
      "-t",
      BASE_PAYLOAD.pane!,
      "-F",
      "#{client_termname}",
    ]);
  });

  it("emits kitty OSC 99 when an attached client is a kitty terminal", async () => {
    const { deps, ttyWrites } = createDeps({
      resolveBackend: () => "osc",
      runTmuxCapture: (args) => {
        if (args.includes("allow-passthrough")) return "on";
        if (args.includes("list-clients")) return "xterm-kitty\n";
        return null;
      },
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);

    expect(ttyWrites).toHaveLength(1);
    expect(ttyWrites[0]!.data).toContain("]99;");
  });

  it("probes allow-passthrough once and caches the result across deliveries", async () => {
    let passthroughProbes = 0;
    const { deps, ttyWrites } = createDeps({
      resolveBackend: () => "osc",
      runTmuxCapture: (args) => {
        if (args.includes("allow-passthrough")) {
          passthroughProbes++;
          return "on";
        }
        if (args.includes("list-clients")) return "xterm-ghostty";
        return null;
      },
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(passthroughProbes).toBe(1);
    expect(ttyWrites).toHaveLength(2);
  });

  it("disables osc (no write, no fallback) when allow-passthrough is off, warning once", async () => {
    let passthroughProbes = 0;
    const { deps, ttyWrites, delivered, logs } = createDeps({
      resolveBackend: () => "osc",
      runTmuxCapture: (args) => {
        if (args.includes("allow-passthrough")) {
          passthroughProbes++;
          return "off";
        }
        return null;
      },
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(passthroughProbes).toBe(1);
    expect(ttyWrites).toHaveLength(0);
    // Explicit opt-in: no silent fallback to another backend.
    expect(delivered).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("allow-passthrough");
  });

  it("skips a paneless session without warning or write", async () => {
    const { deps, ttyWrites, logs } = createDeps({
      resolveBackend: () => "osc",
      getPaneTty: () => null,
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver({ ...BASE_PAYLOAD, pane: null });

    expect(ttyWrites).toHaveLength(0);
    // Paneless is a per-delivery debug skip, not the once-per-run warning.
    expect(logs).toHaveLength(0);
  });

  it("ignores actions and reply on the payload (informational rung)", async () => {
    const { deps, ttyWrites } = createDeps({
      resolveBackend: () => "osc",
    });
    const { deliver } = createNotifyDelivery(deps);

    await deliver({
      ...BASE_PAYLOAD,
      event: "waiting",
      subtitle: "Needs permission: Bash",
      actions: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
      reply: { id: "answer", label: "Reply" },
    });

    expect(ttyWrites).toHaveLength(1);
    // No button/reply metadata leaks into the escape (OSC 9 carries only text).
    expect(ttyWrites[0]!.data).not.toContain("Approve");
    expect(ttyWrites[0]!.data).not.toContain("Reply");
  });

  it("osc retract is a no-op (no tty write, no spawn)", async () => {
    const { deps, ttyWrites, spawnCalls } = createDeps({
      resolveBackend: () => "osc",
    });
    const { deliver, retract } = createNotifyDelivery(deps);

    await deliver(BASE_PAYLOAD);
    await retract("abc123");

    // Only the delivery wrote; retract added nothing.
    expect(ttyWrites).toHaveLength(1);
    expect(spawnCalls).toHaveLength(0);
  });
});
