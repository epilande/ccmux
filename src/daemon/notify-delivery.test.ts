import { describe, it, expect } from "bun:test";
import {
  createDeliverFn,
  type DeliveryDeps,
  type DbusNotifierLike,
} from "./notify-delivery";
import type { Backend, NotificationPayload, SpawnFn } from "../lib/notify";

const BASE_PAYLOAD: NotificationPayload = {
  title: "ccmux (main) · Claude Code",
  body: "Finished",
  event: "finished",
  sessionId: "abc123",
  agent: "Claude Code",
  project: "ccmux",
  pane: "%5",
};

/** A fake `DbusNotifier`: `probe`/`notify`/`close` calls recorded, `notify`
 * returns incrementing ids and captures any registered `onActivate`. */
function createFakeDbusNotifier(probeResult = true): {
  notifier: DbusNotifierLike;
  probeCalls: number[];
  notifyCalls: Array<{
    payload: NotificationPayload;
    onActivate?: () => void;
  }>;
  closeCalls: number[];
} {
  let nextId = 1;
  const probeCalls: number[] = [];
  const notifyCalls: Array<{
    payload: NotificationPayload;
    onActivate?: () => void;
  }> = [];
  const closeCalls: number[] = [];
  const notifier: DbusNotifierLike = {
    probe: async () => {
      probeCalls.push(probeCalls.length);
      return probeResult;
    },
    notify: async (payload, options) => {
      notifyCalls.push({ payload, onActivate: options?.onActivate });
      return nextId++;
    },
    close: async () => {
      closeCalls.push(closeCalls.length);
    },
  };
  return { notifier, probeCalls, notifyCalls, closeCalls };
}

function createDeps(overrides: Partial<DeliveryDeps> = {}): {
  deps: DeliveryDeps;
  delivered: Array<{ backend: string; payload: NotificationPayload }>;
  probeCalls: string[];
  logs: string[];
  spawnCalls: { argv: string[] }[];
} {
  const delivered: Array<{ backend: string; payload: NotificationPayload }> =
    [];
  const probeCalls: string[] = [];
  const logs: string[] = [];
  const spawnCalls: { argv: string[] }[] = [];

  const defaultSpawn: SpawnFn = (argv) => {
    spawnCalls.push({ argv });
    return { exited: Promise.resolve(0) };
  };

  const deps: DeliveryDeps = {
    getPrefs:
      overrides.getPrefs ??
      (async () => ({ notifications: { backend: "terminal-notifier" } })),
    getClientPid: overrides.getClientPid ?? (async () => 111),
    resolveTerminalBundleId:
      overrides.resolveTerminalBundleId ??
      (async () => "com.mitchellh.ghostty"),
    resolveActiveClientTty:
      overrides.resolveActiveClientTty ?? (async () => "/dev/ttys002"),
    resolveBackend: overrides.resolveBackend ?? (() => "terminal-notifier"),
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
    // `??` would treat an explicit `ccmuxPath: null` override the same as
    // "not overridden" and fall through to the default; `"ccmuxPath" in
    // overrides` distinguishes the two so tests can assert the
    // ccmux-not-found path.
    ccmuxPath:
      "ccmuxPath" in overrides
        ? (overrides.ccmuxPath ?? null)
        : "/opt/homebrew/bin/ccmux",
    tmuxPath: overrides.tmuxPath ?? "/opt/homebrew/bin/tmux",
    path: overrides.path ?? "/usr/bin:/bin:/opt/homebrew/bin",
    createDbusNotifier:
      overrides.createDbusNotifier ?? (() => createFakeDbusNotifier().notifier),
    spawn: overrides.spawn ?? defaultSpawn,
    log: overrides.log ?? ((message) => logs.push(message)),
  };

  return { deps, delivered, probeCalls, logs, spawnCalls };
}

describe("createDeliverFn: probe-once-disable", () => {
  it("probes the backend once on the first delivery and delivers on success", async () => {
    const { deps, delivered, probeCalls } = createDeps();
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(probeCalls).toEqual(["terminal-notifier"]);
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
    const deliver = createDeliverFn(deps);

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
    const deliver = createDeliverFn(deps);

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
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(calls).toBe(2);
    expect(logs.some((l) => l.includes("delivery failed"))).toBe(true);
  });
});

describe("createDeliverFn: per-backend probe isolation", () => {
  it("a failed backend stays disabled while a different backend probes fresh and delivers, and switching back doesn't re-probe or re-log", async () => {
    let currentBackend: Backend = "terminal-notifier";
    const probeOutcomes: Record<Backend, boolean> = {
      "terminal-notifier": false,
      osascript: true,
      "notify-send": true,
      dbus: true,
      command: true,
    };
    let probeCallCount = 0;
    const { deps, delivered, logs } = createDeps({
      getPrefs: async () => ({}),
      resolveBackend: () => currentBackend,
      probeBackend: async (backend) => {
        probeCallCount++;
        return probeOutcomes[backend];
      },
    });
    const deliver = createDeliverFn(deps);

    // Backend A ("terminal-notifier") fails its probe: disabled, logged once.
    await deliver(BASE_PAYLOAD);
    expect(delivered).toHaveLength(0);
    expect(probeCallCount).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"terminal-notifier"');

    // Config flips to backend B ("osascript"): gets its own fresh probe and delivers.
    currentBackend = "osascript";
    await deliver(BASE_PAYLOAD);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.backend).toBe("osascript");
    expect(probeCallCount).toBe(2);
    expect(logs).toHaveLength(1);

    // Flip back to A: still disabled from its cached probe result - no
    // re-probe, no second log line, and delivery count is unchanged.
    currentBackend = "terminal-notifier";
    await deliver(BASE_PAYLOAD);
    expect(delivered).toHaveLength(1);
    expect(probeCallCount).toBe(2);
    expect(logs).toHaveLength(1);

    // B continues to work without being re-probed.
    currentBackend = "osascript";
    await deliver(BASE_PAYLOAD);
    expect(delivered).toHaveLength(2);
    expect(probeCallCount).toBe(2);
  });
});

describe("createDeliverFn: icon modes", () => {
  it("icon 'terminal' uses the resolved terminal bundle id as sender", async () => {
    const { deps, delivered } = createDeps({
      getPrefs: async () => ({
        notifications: { backend: "terminal-notifier", icon: "terminal" },
      }),
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.payload.senderBundleId).toBe("com.mitchellh.ghostty");
    expect(delivered[0]?.payload.activateBundleId).toBe(
      "com.mitchellh.ghostty",
    );
  });

  it("default icon (unset) omits sender like 'none' but still resolves activate", async () => {
    const { deps, delivered } = createDeps();
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    // Default is "none": no -sender impersonation (silently dropped by macOS
    // for terminals that don't register), but click-to-activate still works.
    expect(delivered[0]?.payload.senderBundleId).toBeUndefined();
    expect(delivered[0]?.payload.activateBundleId).toBe(
      "com.mitchellh.ghostty",
    );
  });

  it("icon 'none' omits sender but still resolves activate", async () => {
    const { deps, delivered } = createDeps({
      getPrefs: async () => ({
        notifications: { backend: "terminal-notifier", icon: "none" },
      }),
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.payload.senderBundleId).toBeUndefined();
    expect(delivered[0]?.payload.activateBundleId).toBe(
      "com.mitchellh.ghostty",
    );
  });

  it("an explicit bundle id icon passes through as sender verbatim", async () => {
    const { deps, delivered } = createDeps({
      getPrefs: async () => ({
        notifications: {
          backend: "terminal-notifier",
          icon: "com.example.other",
        },
      }),
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.payload.senderBundleId).toBe("com.example.other");
  });

  it("unresolvable terminal bundle id -> sender/activate both undefined", async () => {
    const { deps, delivered } = createDeps({
      getPrefs: async () => ({
        notifications: { backend: "terminal-notifier", icon: "terminal" },
      }),
      getClientPid: async () => null,
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.payload.senderBundleId).toBeUndefined();
    expect(delivered[0]?.payload.activateBundleId).toBeUndefined();
  });

  it("does not enrich payloads for non-terminal-notifier backends", async () => {
    const { deps, delivered } = createDeps({
      resolveBackend: () => "osascript",
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.payload.senderBundleId).toBeUndefined();
    expect(delivered[0]?.payload.executeCommand).toBeUndefined();
    expect(delivered[0]?.backend).toBe("osascript");
  });
});

/**
 * Creates an executable shell script at a fresh temp path that just prints
 * its argv, so `executeCommand` strings can be run through a *real* shell
 * (proving the nested quoting is actually valid syntax, not just "looks
 * plausible") without needing a real ccmux/tmux on the machine.
 */
async function createEchoStub(): Promise<string> {
  const dir = (await Bun.$`mktemp -d`.text()).trim();
  const path = `${dir}/stub`;
  await Bun.write(path, '#!/bin/sh\necho "$@"\n');
  await Bun.$`chmod +x ${path}`.quiet();
  return path;
}

/** Runs `command` (an `executeCommand` string, which is itself a full
 * `/bin/sh -c '...'` invocation) through one more outer shell - mirroring
 * how terminal-notifier's own `-execute` is understood to invoke its
 * argument - and returns trimmed stdout. */
async function runExecuteCommand(command: string): Promise<string> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe" });
  const output = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return output;
}

describe("createDeliverFn: execute command", () => {
  it("builds a pane-jump command that a real shell parses as `ccmux switch <id>`", async () => {
    const ccmuxStub = await createEchoStub();
    const { deps, delivered } = createDeps({ ccmuxPath: ccmuxStub });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    const command = delivered[0]?.payload.executeCommand;
    expect(command).toBeDefined();
    expect(command!.startsWith("/bin/sh -c ")).toBe(true);
    expect(await runExecuteCommand(command!)).toBe("switch abc123");
  });

  it("quotes a PATH containing spaces and shell metacharacters instead of splicing it in raw", async () => {
    // Regression: `/Applications/Visual Studio Code.app/Contents/.../bin` is
    // on many real developer PATHs (VS Code shell integration). Spliced in
    // unquoted, the inner `sh -c` word-splits on the space and dies with
    // `sh: Studio: command not found` before ever reaching ccmux/tmux; a
    // `$(...)` in an unquoted PATH would additionally get expanded/executed.
    const pathStub = await Bun.$`mktemp -d`.text();
    const dir = pathStub.trim();
    const pathEchoStub = `${dir}/path-stub`;
    await Bun.write(pathEchoStub, '#!/bin/sh\necho "$PATH"\n');
    await Bun.$`chmod +x ${pathEchoStub}`.quiet();

    const dangerousPath =
      "/usr/bin:/bin:/Applications/Visual Studio Code.app/Contents/Resources/app/bin:$(echo pwned)";
    const { deps, delivered } = createDeps({
      ccmuxPath: pathEchoStub,
      path: dangerousPath,
    });
    const deliver = createDeliverFn(deps);
    // The stub ignores its argv and just echoes $PATH, so `switch <id>`
    // args are irrelevant here - only whether the command parses and PATH
    // survives intact matters.
    await deliver(BASE_PAYLOAD);

    const command = delivered[0]?.payload.executeCommand!;
    expect(await runExecuteCommand(command)).toBe(dangerousPath);
  });

  it("escapes a session id containing a single quote without breaking the outer quoting", async () => {
    const ccmuxStub = await createEchoStub();
    const { deps, delivered } = createDeps({ ccmuxPath: ccmuxStub });
    const deliver = createDeliverFn(deps);
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      sessionId: "it's-a-test",
    };

    await deliver(payload);

    const command = delivered[0]?.payload.executeCommand!;
    expect(await runExecuteCommand(command)).toBe("switch it's-a-test");
  });

  it("routes a background session to the picker-popup click target", async () => {
    const tmuxStub = await createEchoStub();
    const ccmuxStub = await createEchoStub();
    const { deps, delivered } = createDeps({
      tmuxPath: tmuxStub,
      ccmuxPath: ccmuxStub,
    });
    const deliver = createDeliverFn(deps);
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      pane: null,
      background: true,
    };

    await deliver(payload);

    const command = delivered[0]?.payload.executeCommand!;
    expect(await runExecuteCommand(command)).toBe(
      `display-popup -c /dev/ttys002 -E ${ccmuxStub}`,
    );
  });

  it("routes an unbound (no-pane, non-background) session to the popup too", async () => {
    const { deps, delivered } = createDeps();
    const deliver = createDeliverFn(deps);
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      pane: null,
      background: false,
    };

    await deliver(payload);

    expect(delivered[0]?.payload.executeCommand).toContain("display-popup");
  });

  it("omits executeCommand when no client is attached for the popup path", async () => {
    const { deps, delivered } = createDeps({
      resolveActiveClientTty: async () => null,
    });
    const deliver = createDeliverFn(deps);
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      pane: null,
      background: true,
    };

    await deliver(payload);

    expect(delivered[0]?.payload.executeCommand).toBeUndefined();
  });

  it("omits executeCommand entirely when ccmuxPath could not be resolved", async () => {
    const { deps, delivered } = createDeps({ ccmuxPath: null });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered[0]?.payload.executeCommand).toBeUndefined();
  });
});

describe("createDeliverFn: dbus routing", () => {
  it("dbus success routes to the DbusNotifier, not lib deliver", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps, delivered, probeCalls } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    expect(fake.notifyCalls).toHaveLength(1);
    expect(fake.notifyCalls[0]?.payload).toBe(BASE_PAYLOAD);
    expect(delivered).toHaveLength(0);
    expect(probeCalls).toHaveLength(0); // lib probeBackend never consulted
  });

  it("probes the dbus notifier once and reuses the connection across deliveries", async () => {
    const fake = createFakeDbusNotifier(true);
    let constructCount = 0;
    const { deps } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => {
        constructCount++;
        return fake.notifier;
      },
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(constructCount).toBe(1);
    expect(fake.probeCalls).toHaveLength(1);
    expect(fake.notifyCalls).toHaveLength(3);
  });

  it("dbus probe failure falls back to notify-send for that delivery, probing it once too", async () => {
    const fake = createFakeDbusNotifier(false);
    const { deps, delivered, probeCalls, logs } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);
    await deliver(BASE_PAYLOAD);

    expect(fake.probeCalls).toHaveLength(1); // dbus probed once, cached
    expect(fake.notifyCalls).toHaveLength(0); // never routed to dbus
    expect(probeCalls).toEqual(["notify-send"]); // notify-send probed once too
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.backend).toBe("notify-send");
    expect(
      logs.some((l) => l.includes('"dbus"') && l.includes("falling back")),
    ).toBe(true);
  });

  it("dbus probe failure followed by a notify-send probe failure disables delivery entirely", async () => {
    const fake = createFakeDbusNotifier(false);
    const { deps, delivered, logs } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
      probeBackend: async () => false,
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD);

    expect(delivered).toHaveLength(0);
    expect(logs).toHaveLength(2); // dbus fallback log + notify-send disable log
  });

  it("passes an onActivate that, on invocation, spawns tmux switch-client for a bound session", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps, spawnCalls } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const deliver = createDeliverFn(deps);

    await deliver(BASE_PAYLOAD); // pane: "%5"

    const onActivate = fake.notifyCalls[0]?.onActivate;
    expect(onActivate).toBeDefined();
    onActivate!();
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.argv).toEqual([
      "/opt/homebrew/bin/tmux",
      "switch-client",
      "-c",
      "/dev/ttys002",
      "-t",
      "%5",
    ]);
  });

  it("passes an onActivate that spawns tmux display-popup for a background session", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps, spawnCalls } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
    });
    const deliver = createDeliverFn(deps);
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      pane: null,
      background: true,
    };

    await deliver(payload);

    const onActivate = fake.notifyCalls[0]?.onActivate;
    onActivate!();
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.argv).toEqual([
      "/opt/homebrew/bin/tmux",
      "display-popup",
      "-c",
      "/dev/ttys002",
      "-E",
      "/opt/homebrew/bin/ccmux",
    ]);
  });

  it("omits onActivate for a background session when ccmuxPath is unresolved", async () => {
    const fake = createFakeDbusNotifier(true);
    const { deps } = createDeps({
      resolveBackend: () => "dbus",
      createDbusNotifier: () => fake.notifier,
      ccmuxPath: null,
    });
    const deliver = createDeliverFn(deps);
    const payload: NotificationPayload = {
      ...BASE_PAYLOAD,
      pane: null,
      background: true,
    };

    await deliver(payload);

    expect(fake.notifyCalls[0]?.onActivate).toBeUndefined();
  });
});
