import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCcmuxNotifierArgv,
  deliver,
  deliverTimeoutFor,
  DELIVER_TIMEOUT_MS,
  foldSubtitleIntoBody,
  normalizeBackendConfig,
  NOTIFIER_DELIVER_TIMEOUT_MS,
  probeBackend,
  probeCcmuxNotifier,
  resolveBackend,
  resolveCcmuxNotifierBinary,
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

/** A ccmux-notifier payload as the delivery layer stamps it. */
const NOTIFIER_PAYLOAD: NotificationPayload = {
  ...BASE_PAYLOAD,
  notifierPath:
    "/opt/homebrew/libexec/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
  callbackUrl: "http://127.0.0.1:2269/notification-action",
  statusChangedAt: "2024-01-15T12:00:00Z",
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
  it("darwin auto resolves to ccmux-notifier (delivery layer falls to osascript when unresolvable)", () => {
    expect(resolveBackend({}, "darwin")).toBe("ccmux-notifier");
  });

  it("linux resolves to dbus", () => {
    expect(resolveBackend({}, "linux")).toBe("dbus");
  });

  it("unsupported platforms resolve to null", () => {
    expect(resolveBackend({}, "win32")).toBe(null);
  });

  it("an explicit non-auto backend wins regardless of platform", () => {
    expect(resolveBackend({ backend: "command" }, "darwin")).toBe("command");
    expect(resolveBackend({ backend: "notify-send" }, "win32")).toBe(
      "notify-send",
    );
    expect(resolveBackend({ backend: "osascript" }, "darwin")).toBe(
      "osascript",
    );
  });
});

describe("normalizeBackendConfig", () => {
  it("maps the removed terminal-notifier backend to auto and flags it", () => {
    expect(normalizeBackendConfig("terminal-notifier")).toEqual({
      backend: undefined,
      removed: "terminal-notifier",
    });
  });

  it("passes through a live backend value untouched", () => {
    expect(normalizeBackendConfig("dbus")).toEqual({
      backend: "dbus",
      removed: null,
    });
    expect(normalizeBackendConfig("ccmux-notifier")).toEqual({
      backend: "ccmux-notifier",
      removed: null,
    });
  });

  it("passes through undefined (unset) untouched", () => {
    expect(normalizeBackendConfig(undefined)).toEqual({
      backend: undefined,
      removed: null,
    });
  });
});

describe("resolveCcmuxNotifierBinary", () => {
  it("prefers CCMUX_NOTIFIER_PATH pointing at the .app bundle, normalized to the inner binary", () => {
    const resolved = resolveCcmuxNotifierBinary({
      env: { CCMUX_NOTIFIER_PATH: "/Apps/ccmux-notifier.app" },
      exists: (p) =>
        p === "/Apps/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
      which: () => null,
    });
    expect(resolved).toBe(
      "/Apps/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
    );
  });

  it("accepts CCMUX_NOTIFIER_PATH pointing directly at the inner binary", () => {
    const resolved = resolveCcmuxNotifierBinary({
      env: { CCMUX_NOTIFIER_PATH: "/custom/ccmux-notifier" },
      exists: (p) => p === "/custom/ccmux-notifier",
      which: () => null,
    });
    expect(resolved).toBe("/custom/ccmux-notifier");
  });

  it("returns null for a set-but-nonexistent CCMUX_NOTIFIER_PATH (never silently falls through)", () => {
    const resolved = resolveCcmuxNotifierBinary({
      env: { CCMUX_NOTIFIER_PATH: "/gone/ccmux-notifier" },
      exists: () => false,
      ccmuxPath: "/opt/homebrew/bin/ccmux",
      which: () => "/usr/local/bin/ccmux-notifier",
    });
    expect(resolved).toBeNull();
  });

  it("falls to the brew libexec sibling of the ccmux binary when env is unset", () => {
    const resolved = resolveCcmuxNotifierBinary({
      env: {},
      ccmuxPath: "/opt/homebrew/bin/ccmux",
      // Identity realpath: these lexical tests must not touch the real
      // filesystem (a genuinely brew-installed ccmux would resolve into
      // the Cellar and dodge the mocked `exists`).
      realpath: (p) => p,
      // `path.join` normalizes the `..`, so the sibling lands at
      // <prefix>/libexec/... (not <prefix>/bin/../libexec/...).
      exists: (p) =>
        p ===
        "/opt/homebrew/libexec/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
      which: () => null,
    });
    expect(resolved).toBe(
      "/opt/homebrew/libexec/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
    );
  });

  it("prefers the running executable's sibling over the PATH-resolved ccmux's (shadowed brew install)", () => {
    // A dev/bun-linked ccmux shadows the brew one on PATH; the compiled
    // binary must still find the helper next to ITSELF in the keg.
    const resolved = resolveCcmuxNotifierBinary({
      env: {},
      execPath: "/opt/homebrew/Cellar/ccmux/1.2.0/bin/ccmux",
      ccmuxPath: "/Users/dev/.bun/bin/ccmux",
      realpath: (p) => p,
      exists: (p) =>
        p ===
        "/opt/homebrew/Cellar/ccmux/1.2.0/libexec/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
      which: () => null,
    });
    expect(resolved).toBe(
      "/opt/homebrew/Cellar/ccmux/1.2.0/libexec/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
    );
  });

  it("falls through a bun execPath (dev) to the PATH-resolved ccmux's sibling", () => {
    const resolved = resolveCcmuxNotifierBinary({
      env: {},
      execPath: "/Users/dev/.bun/bin/bun",
      ccmuxPath: "/opt/homebrew/bin/ccmux",
      realpath: (p) => p,
      exists: (p) =>
        p ===
        "/opt/homebrew/libexec/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
      which: () => null,
    });
    expect(resolved).toBe(
      "/opt/homebrew/libexec/ccmux-notifier.app/Contents/MacOS/ccmux-notifier",
    );
  });

  it("falls to PATH (which) when env and sibling both miss", () => {
    const resolved = resolveCcmuxNotifierBinary({
      env: {},
      ccmuxPath: "/opt/homebrew/bin/ccmux",
      exists: () => false,
      which: (cmd) =>
        cmd === "ccmux-notifier" ? "/usr/local/bin/ccmux-notifier" : null,
    });
    expect(resolved).toBe("/usr/local/bin/ccmux-notifier");
  });

  it("returns null when nothing resolves", () => {
    const resolved = resolveCcmuxNotifierBinary({
      env: {},
      ccmuxPath: null,
      exists: () => false,
      which: () => null,
    });
    expect(resolved).toBeNull();
  });

  describe("brew symlink resolution (real filesystem)", () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "ccmux-notify-brew-"));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("resolves the helper in the Cellar keg when ccmux is a prefix symlink into it", () => {
      // Mirror Homebrew's layout: the real binary + helper live in a versioned
      // keg, and <prefix>/bin/ccmux is a SYMLINK into it. A lexical
      // `../libexec` join off the prefix symlink would miss the keg (the helper
      // isn't linked into the prefix) — only realpath-ing the symlink first
      // lands in the keg where the helper actually is.
      const keg = join(root, "Cellar", "ccmux", "1.2.0");
      mkdirSync(join(keg, "bin"), { recursive: true });
      const helper = join(
        keg,
        "libexec",
        "ccmux-notifier.app",
        "Contents",
        "MacOS",
        "ccmux-notifier",
      );
      mkdirSync(join(helper, ".."), { recursive: true });
      writeFileSync(join(keg, "bin", "ccmux"), "#!/bin/sh\n");
      writeFileSync(helper, "#!/bin/sh\n");

      // <prefix>/bin/ccmux -> Cellar keg's bin/ccmux
      const prefixBin = join(root, "bin");
      mkdirSync(prefixBin, { recursive: true });
      const prefixCcmux = join(prefixBin, "ccmux");
      symlinkSync(join(keg, "bin", "ccmux"), prefixCcmux);

      // Default `exists` (real existsSync) + real realpathSync on the symlink.
      const resolved = resolveCcmuxNotifierBinary({
        env: {},
        ccmuxPath: prefixCcmux,
        which: () => null,
      });
      // realpathSync canonicalizes (e.g. /var -> /private/var on macOS), so
      // compare on the stable trailing keg-relative segment.
      expect(resolved).not.toBeNull();
      expect(
        resolved!.endsWith(
          join(
            "1.2.0",
            "libexec",
            "ccmux-notifier.app",
            "Contents",
            "MacOS",
            "ccmux-notifier",
          ),
        ),
      ).toBe(true);
    });
  });
});

describe("deliverTimeoutFor", () => {
  it("gives ccmux-notifier a long cap above the helper's 180s auth timeout", () => {
    // A short generic cap would kill the helper mid-requestAuthorization on a
    // fresh install (it blocks up to 180s before it can post).
    expect(deliverTimeoutFor("ccmux-notifier")).toBe(
      NOTIFIER_DELIVER_TIMEOUT_MS,
    );
    expect(NOTIFIER_DELIVER_TIMEOUT_MS).toBeGreaterThan(180_000);
  });

  it("keeps the short 3s cap for every other spawn backend", () => {
    expect(deliverTimeoutFor("osascript")).toBe(DELIVER_TIMEOUT_MS);
    expect(deliverTimeoutFor("notify-send")).toBe(DELIVER_TIMEOUT_MS);
    expect(deliverTimeoutFor("command")).toBe(DELIVER_TIMEOUT_MS);
    expect(DELIVER_TIMEOUT_MS).toBe(3000);
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
    expect(argv.indexOf("--")).toBe(argv.indexOf(flagLikeTitle) - 1);
  });

  it("maps sound: true to the platform default sound name", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("osascript", { ...BASE_PAYLOAD, sound: true }, spawn);
    expect(calls[0].argv.at(-1)).toBe("default");
  });

  it("passes a shell-metacharacter body as a single plain argv entry", async () => {
    const { spawn, calls } = fakeSpawn();
    const maliciousBody = '"$(rm -rf ~)"';
    await deliver("osascript", { ...BASE_PAYLOAD, body: maliciousBody }, spawn);

    const argv = calls[0].argv;
    for (const arg of argv.slice(0, -2)) {
      expect(arg).not.toContain(maliciousBody);
    }
    expect(argv.at(-1)).toBe(maliciousBody);
  });

  // The subtitle x sound matrix: subtitle is rendered natively (its own
  // `item N of argv`), and the positional indices must stay in lockstep with
  // the clause whether or not the optional sound clause is also present.
  it("renders a subtitle natively with no sound (item 3)", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver(
      "osascript",
      { ...BASE_PAYLOAD, subtitle: "Needs permission: Bash" },
      spawn,
    );
    expect(calls[0].argv).toEqual([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)",
      "-e",
      "end run",
      "--",
      BASE_PAYLOAD.title,
      BASE_PAYLOAD.body,
      "Needs permission: Bash",
    ]);
  });

  it("renders subtitle (item 3) and sound (item 4) together", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver(
      "osascript",
      { ...BASE_PAYLOAD, subtitle: "Finished", sound: "Glass" },
      spawn,
    );
    expect(calls[0].argv).toEqual([
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv) sound name (item 4 of argv)",
      "-e",
      "end run",
      "--",
      BASE_PAYLOAD.title,
      BASE_PAYLOAD.body,
      "Finished",
      "Glass",
    ]);
  });

  it("keeps sound at item 3 when there is no subtitle", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("osascript", { ...BASE_PAYLOAD, sound: "Glass" }, spawn);
    // Regression guard: without a subtitle, the sound clause must stay item 3,
    // not shift to item 4.
    expect(calls[0].argv[4]).toBe(
      "display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)",
    );
  });
});

describe("foldSubtitleIntoBody", () => {
  it("joins subtitle and body with a newline", () => {
    expect(
      foldSubtitleIntoBody({ subtitle: "Finished", body: "Wrapped up." }),
    ).toBe("Finished\nWrapped up.");
  });

  it("drops an empty body (no trailing newline)", () => {
    expect(foldSubtitleIntoBody({ subtitle: "Finished", body: "" })).toBe(
      "Finished",
    );
  });

  it("drops an empty/absent subtitle (no leading newline)", () => {
    expect(foldSubtitleIntoBody({ subtitle: "", body: "just the body" })).toBe(
      "just the body",
    );
    expect(foldSubtitleIntoBody({ body: "just the body" })).toBe(
      "just the body",
    );
  });

  it("is empty when both parts are empty", () => {
    expect(foldSubtitleIntoBody({ subtitle: "", body: "" })).toBe("");
  });
});

describe("deliver: ccmux-notifier", () => {
  it("builds the post argv with group, callback URL, and payload JSON", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("ccmux-notifier", NOTIFIER_PAYLOAD, spawn);

    expect(calls[0].argv).toEqual([
      NOTIFIER_PAYLOAD.notifierPath!,
      "post",
      "--title",
      NOTIFIER_PAYLOAD.title,
      "--body",
      NOTIFIER_PAYLOAD.body,
      "--group",
      "ccmux-abc123",
      "--callback-url",
      NOTIFIER_PAYLOAD.callbackUrl!,
      "--payload",
      '{"sessionId":"abc123","statusChangedAt":"2024-01-15T12:00:00Z"}',
    ]);
  });

  it("adds --subtitle, --sound, --actions, and --reply-action only when present", async () => {
    const argv = buildCcmuxNotifierArgv({
      ...NOTIFIER_PAYLOAD,
      subtitle: "Needs permission: Bash",
      sound: "Glass",
      actions: [
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ],
      reply: { id: "answer", label: "Reply" },
    })!;

    expect(argv).toContain("--subtitle");
    expect(argv[argv.indexOf("--subtitle") + 1]).toBe("Needs permission: Bash");
    expect(argv[argv.indexOf("--sound") + 1]).toBe("Glass");
    expect(argv[argv.indexOf("--actions") + 1]).toBe(
      "approve:Approve,deny:Deny",
    );
    expect(argv[argv.indexOf("--reply-action") + 1]).toBe("answer:Reply");
  });

  it("omits the optional flags entirely when absent", async () => {
    const argv = buildCcmuxNotifierArgv(NOTIFIER_PAYLOAD)!;
    expect(argv).not.toContain("--subtitle");
    expect(argv).not.toContain("--sound");
    expect(argv).not.toContain("--actions");
    expect(argv).not.toContain("--reply-action");
  });

  it("omits --body when the body is empty (the subtitle carries the event)", async () => {
    const argv = buildCcmuxNotifierArgv({
      ...NOTIFIER_PAYLOAD,
      subtitle: "Finished",
      body: "",
    })!;
    expect(argv).not.toContain("--body");
    expect(argv).toContain("--subtitle");
    expect(argv[argv.indexOf("--subtitle") + 1]).toBe("Finished");
  });

  it("omits statusChangedAt from the payload JSON when unset", async () => {
    const argv = buildCcmuxNotifierArgv({
      ...NOTIFIER_PAYLOAD,
      statusChangedAt: undefined,
    })!;
    expect(argv[argv.indexOf("--payload") + 1]).toBe('{"sessionId":"abc123"}');
  });

  it("refuses to build (null) without a resolved notifierPath or callbackUrl", async () => {
    expect(buildCcmuxNotifierArgv(BASE_PAYLOAD)).toBeNull();
    expect(
      buildCcmuxNotifierArgv({ ...BASE_PAYLOAD, notifierPath: "/x" }),
    ).toBeNull();
    const { spawn, calls } = fakeSpawn();
    await deliver("ccmux-notifier", BASE_PAYLOAD, spawn);
    expect(calls).toHaveLength(0);
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

  it("folds the subtitle into body line 1 (no native subtitle slot)", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver(
      "notify-send",
      { ...BASE_PAYLOAD, subtitle: "Needs permission: Bash", body: "rm -rf x" },
      spawn,
    );
    expect(calls[0].argv.at(-1)).toBe("Needs permission: Bash\nrm -rf x");
  });

  it("uses the subtitle alone when the body is empty (no trailing newline)", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver(
      "notify-send",
      { ...BASE_PAYLOAD, subtitle: "Finished", body: "" },
      spawn,
    );
    expect(calls[0].argv.at(-1)).toBe("Finished");
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
        subtitle: "Finished",
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
      CCMUX_SUBTITLE: "Finished",
      CCMUX_BODY: BASE_PAYLOAD.body,
      CCMUX_PANE: "%3",
    });
  });

  it("exposes an empty CCMUX_SUBTITLE when the payload has no subtitle", async () => {
    const { spawn, calls } = fakeSpawn();
    await deliver("command", { ...BASE_PAYLOAD, command: "echo hi" }, spawn);
    expect(calls[0].options?.env).toMatchObject({ CCMUX_SUBTITLE: "" });
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

  it("never probes command/dbus/ccmux-notifier here; always reports available", async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect(await probeBackend("command", spawn)).toBe(true);
    expect(await probeBackend("dbus", spawn)).toBe(true);
    expect(await probeBackend("ccmux-notifier", spawn)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("probeCcmuxNotifier", () => {
  it("probes the resolved binary path with --version, success on exit 0", async () => {
    const { spawn, calls } = fakeSpawn(0);
    expect(await probeCcmuxNotifier("/bin/ccmux-notifier", spawn)).toBe(true);
    expect(calls[0].argv).toEqual(["/bin/ccmux-notifier", "--version"]);
  });

  it("reports disabled on non-zero exit", async () => {
    const { spawn } = fakeSpawn(1);
    expect(await probeCcmuxNotifier("/bin/ccmux-notifier", spawn)).toBe(false);
  });

  it("reports disabled when spawn throws", async () => {
    expect(
      await probeCcmuxNotifier("/bin/ccmux-notifier", throwingSpawn()),
    ).toBe(false);
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
      deliver("ccmux-notifier", NOTIFIER_PAYLOAD, spawn),
    ).resolves.toBeUndefined();
  });

  it("resolves via the timeout (never stranded) when the process never exits, killing it once", async () => {
    let killCalls = 0;
    const spawn: SpawnFn = () => ({
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

  it("swallows a late `exited` rejection that arrives after the timeout resolved", async () => {
    let rejectExited: (err: unknown) => void = () => {};
    const spawn: SpawnFn = () => ({
      exited: new Promise<number>((_resolve, reject) => {
        rejectExited = reject;
      }),
      kill: () => {},
    });

    await deliver("notify-send", BASE_PAYLOAD, spawn, 10);
    rejectExited(new Error("boom, but too late"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
