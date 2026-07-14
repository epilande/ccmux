import { describe, expect, it } from "bun:test";
import {
  deliver,
  probeBackend,
  resolveBackend,
  type NotificationPayload,
  type SpawnFn,
} from "./notify";

const BASE_PAYLOAD: NotificationPayload = {
  title: "ccmux (main) · Claude Code",
  body: "Waiting for you",
  event: "waiting",
  sessionId: "abc123",
  agent: "claude",
  project: "ccmux",
  branch: "main",
  pane: "%3",
};

/** Records every call and resolves `exited` with `exitCode` (default 0). */
function fakeSpawn(exitCode = 0): {
  spawn: SpawnFn;
  calls: { argv: string[]; options?: Parameters<SpawnFn>[1] }[];
} {
  const calls: { argv: string[]; options?: Parameters<SpawnFn>[1] }[] = [];
  const spawn: SpawnFn = (argv, options) => {
    calls.push({ argv, options });
    return { exited: Promise.resolve(exitCode), kill: () => {} };
  };
  return { spawn, calls };
}

function throwingSpawn(): SpawnFn {
  return () => {
    throw new Error("spawn ENOENT");
  };
}

describe("resolveBackend", () => {
  it("darwin with terminal-notifier on PATH resolves to terminal-notifier", () => {
    const which = (cmd: string) =>
      cmd === "terminal-notifier" ? "/usr/local/bin/terminal-notifier" : null;
    expect(resolveBackend({}, "darwin", which)).toBe("terminal-notifier");
  });

  it("darwin without terminal-notifier falls back to osascript", () => {
    const which = () => null;
    expect(resolveBackend({}, "darwin", which)).toBe("osascript");
  });

  it("linux resolves to dbus", () => {
    expect(resolveBackend({}, "linux", () => null)).toBe("dbus");
  });

  it("unsupported platforms resolve to null", () => {
    expect(resolveBackend({}, "win32", () => null)).toBe(null);
  });

  it("an explicit non-auto backend wins regardless of platform", () => {
    expect(resolveBackend({ backend: "command" }, "darwin", () => null)).toBe(
      "command",
    );
    expect(
      resolveBackend({ backend: "notify-send" }, "win32", () => null),
    ).toBe("notify-send");
  });
});

describe("deliver: osascript", () => {
  it("builds argv-safe title/body with no sound clause when sound is unset", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("osascript", BASE_PAYLOAD, spawn);

    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      "--",
      BASE_PAYLOAD.title,
      BASE_PAYLOAD.body,
    ]);
  });

  it("appends the sound name clause and argv entry when sound is configured", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("osascript", { ...BASE_PAYLOAD, sound: "Glass" }, spawn);

    expect(calls[0].argv).toEqual([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)",
      "-e",
      "end run",
      "--",
      BASE_PAYLOAD.title,
      BASE_PAYLOAD.body,
      "Glass",
    ]);
  });

  it("puts `--` before the positional args so a flag-looking title is never parsed as an osascript option", async () => {
    const { spawn, calls } = fakeSpawn();
    const flagLikeTitle = "-e do shell script";
    await deliver(
      "osascript",
      { ...BASE_PAYLOAD, title: flagLikeTitle },
      spawn,
    );

    const argv = calls[0].argv;
    expect(argv).toEqual([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      "--",
      flagLikeTitle,
      BASE_PAYLOAD.body,
    ]);
    expect(argv.indexOf("--")).toBe(argv.indexOf(flagLikeTitle) - 1);
  });

  it("maps sound: true to the platform default sound name", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("osascript", { ...BASE_PAYLOAD, sound: true }, spawn);
    expect(calls[0].argv.at(-1)).toBe("default");
  });

  it("passes a shell-metacharacter body as a single plain argv entry, never interpolated into the script", async () => {
    const { spawn, calls } = fakeSpawn();
    const maliciousBody = '"$(rm -rf ~)"';
    await deliver("osascript", { ...BASE_PAYLOAD, body: maliciousBody }, spawn);

    const argv = calls[0].argv;
    // The AppleScript source (the -e clauses) never contains the body text.
    for (const arg of argv.slice(0, -2)) {
      expect(arg).not.toContain(maliciousBody);
    }
    // It shows up only as its own trailing argv element, verbatim.
    expect(argv.at(-1)).toBe(maliciousBody);
  });
});

describe("deliver: terminal-notifier", () => {
  it("builds the full argv with subtitle, group, sender, sound, activate, and execute", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver(
      "terminal-notifier",
      {
        ...BASE_PAYLOAD,
        subtitle: "Needs permission: Bash",
        sound: "Glass",
        senderBundleId: "com.mitchellh.ghostty",
        activateBundleId: "com.mitchellh.ghostty",
        executeCommand: "/opt/homebrew/bin/ccmux switch abc123",
      },
      spawn,
    );

    expect(calls[0].argv).toEqual([
      "terminal-notifier",
      "-title",
      BASE_PAYLOAD.title,
      "-subtitle",
      "Needs permission: Bash",
      "-message",
      BASE_PAYLOAD.body,
      "-group",
      "ccmux-abc123",
      "-sender",
      "com.mitchellh.ghostty",
      "-sound",
      "Glass",
      "-activate",
      "com.mitchellh.ghostty",
      "-execute",
      "/opt/homebrew/bin/ccmux switch abc123",
    ]);
  });

  it("omits optional flags entirely when not provided", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("terminal-notifier", BASE_PAYLOAD, spawn);

    expect(calls[0].argv).toEqual([
      "terminal-notifier",
      "-title",
      BASE_PAYLOAD.title,
      "-message",
      BASE_PAYLOAD.body,
      "-group",
      "ccmux-abc123",
    ]);
  });
});

describe("deliver: notify-send", () => {
  it("builds --app-name=ccmux argv with `--` before title and body", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("notify-send", BASE_PAYLOAD, spawn);

    expect(calls[0].argv).toEqual([
      "notify-send",
      "--app-name=ccmux",
      "--",
      BASE_PAYLOAD.title,
      BASE_PAYLOAD.body,
    ]);
  });

  it("keeps `--` before a flag-looking title so it isn't parsed as an option", async () => {
    const { spawn, calls } = fakeSpawn();
    const flagLikeTitle = "--icon=evil";
    await deliver(
      "notify-send",
      { ...BASE_PAYLOAD, title: flagLikeTitle },
      spawn,
    );

    const argv = calls[0].argv;
    expect(argv).toEqual([
      "notify-send",
      "--app-name=ccmux",
      "--",
      flagLikeTitle,
      BASE_PAYLOAD.body,
    ]);
    expect(argv.indexOf("--")).toBe(argv.indexOf(flagLikeTitle) - 1);
  });
});

describe("deliver: command", () => {
  it("runs the user command via sh -c with CCMUX_* env vars populated", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver(
      "command",
      {
        ...BASE_PAYLOAD,
        event: "finished",
        command: 'ntfy publish agents "$CCMUX_TITLE: $CCMUX_BODY"',
      },
      spawn,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual([
      "sh",
      "-c",
      'ntfy publish agents "$CCMUX_TITLE: $CCMUX_BODY"',
    ]);
    expect(calls[0].options?.env).toMatchObject({
      CCMUX_EVENT: "finished",
      CCMUX_SESSION_ID: "abc123",
      CCMUX_AGENT: "claude",
      CCMUX_PROJECT: "ccmux",
      CCMUX_BRANCH: "main",
      CCMUX_TITLE: BASE_PAYLOAD.title,
      CCMUX_BODY: BASE_PAYLOAD.body,
      CCMUX_PANE: "%3",
    });
  });

  it("falls back to empty-string env for a null branch/pane", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver(
      "command",
      { ...BASE_PAYLOAD, branch: null, pane: null, command: "echo hi" },
      spawn,
    );

    expect(calls[0].options?.env).toMatchObject({
      CCMUX_BRANCH: "",
      CCMUX_PANE: "",
    });
  });

  it("does not spawn when no command is configured", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("command", BASE_PAYLOAD, spawn);
    expect(calls).toHaveLength(0);
  });
});

describe("deliver: dbus (documented no-op)", () => {
  it("never spawns anything — real dispatch lives in DbusNotifier", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("dbus", BASE_PAYLOAD, spawn);
    expect(calls).toHaveLength(0);
  });
});

describe("probeBackend", () => {
  it('probes osascript with `-e "return 0"` and reports success on exit 0', async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect(await probeBackend("osascript", spawn)).toBe(true);
    expect(calls[0].argv).toEqual(["osascript", "-e", "return 0"]);
  });

  it("probes terminal-notifier with -help", async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect(await probeBackend("terminal-notifier", spawn)).toBe(true);
    expect(calls[0].argv).toEqual(["terminal-notifier", "-help"]);
  });

  it("probes notify-send with --version", async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect(await probeBackend("notify-send", spawn)).toBe(true);
    expect(calls[0].argv).toEqual(["notify-send", "--version"]);
  });

  it("reports disabled on a non-zero exit code", async () => {
    const { spawn } = fakeSpawn(1);
    expect(await probeBackend("osascript", spawn)).toBe(false);
  });

  it("reports disabled when spawn throws (binary missing)", async () => {
    expect(await probeBackend("notify-send", throwingSpawn())).toBe(false);
  });

  it("never probes the command backend; always reports available", async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect(await probeBackend("command", spawn)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("never probes the dbus backend either (no spawn-based probe); callers route it through DbusNotifier.probe() first", async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect(await probeBackend("dbus", spawn)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("deliver: failure modes are swallowed (fail-open)", () => {
  it("does not throw when spawn itself throws", async () => {
    await expect(
      deliver("osascript", BASE_PAYLOAD, throwingSpawn()),
    ).resolves.toBeUndefined();
  });

  it("does not throw on a non-zero exit code", async () => {
    const { spawn } = fakeSpawn(1);
    await expect(
      deliver("terminal-notifier", BASE_PAYLOAD, spawn),
    ).resolves.toBeUndefined();
  });

  it("resolves via the timeout (never stranded) when the process never exits, killing it exactly once", async () => {
    let killCalls = 0;
    const spawn: SpawnFn = () => ({
      // Never resolves: a "command" backend ignoring SIGTERM.
      exited: new Promise<number>(() => {}),
      kill: () => {
        killCalls += 1;
      },
    });

    await expect(
      deliver("notify-send", BASE_PAYLOAD, spawn, 20),
    ).resolves.toBeUndefined();
    expect(killCalls).toBe(1);
  });

  it("swallows a late `exited` rejection that arrives after the timeout already resolved", async () => {
    let rejectExited: (err: unknown) => void = () => {};
    const spawn: SpawnFn = () => ({
      exited: new Promise<number>((_resolve, reject) => {
        rejectExited = reject;
      }),
      kill: () => {},
    });

    await deliver("notify-send", BASE_PAYLOAD, spawn, 10);
    // Fires after delivery has already resolved via the timeout path; must
    // not surface as an unhandled rejection.
    rejectExited(new Error("boom, but too late"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
