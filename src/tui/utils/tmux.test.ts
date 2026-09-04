import { afterEach, describe, expect, it } from "bun:test";
import {
  parseLaunchPane,
  parseRestoreCandidate,
  parseWindowIdByName,
  agentAttachWindowName,
  isSafeAgentShortId,
  AGENTS_WINDOW_NAME,
} from "./tmux";
import { setPinnedTmuxClientTty } from "../../lib/tmux-client";
import { PANE_FIELD_SEP } from "../../lib/tmux-format";

// App/Preview tests `mock.module("../utils/tmux")` process-wide, so a plain
// import of the window launcher would be the stub by the time the full suite
// reaches this file. A distinct cache entry always gets the implementation,
// the same trick client-switch.test.ts uses.
const REAL_TMUX_SPECIFIER = "./tmux" + "?real";
const { openAgentsWindow } = (await import(
  REAL_TMUX_SPECIFIER
)) as typeof import("./tmux");

// Note: capturePane isn't unit-tested here. Preview/App tests call
// `mock.module("../utils/tmux")`, which is process-wide in Bun, so capturePane
// is the mocked stub by the time this file runs in the full suite. Its
// throw-on-failure contract is covered indirectly via Preview's failure fold;
// the real safety net is the `.catch()` at each call site.

// Format: "#{pane_id}<sep>#{pane_title}<sep>#{pane_active}"
// pane_active: "1" for the window's active pane, "0" otherwise.
const row = (...fields: string[]) => fields.join(PANE_FIELD_SEP);

describe("parseRestoreCandidate", () => {
  it("returns null when only the sidebar (self) is in the window", () => {
    const output = row("%1", "ccmux-sidebar", "1");
    expect(parseRestoreCandidate(output, "%1")).toBe(null);
  });

  it("returns null when self is the active pane (user-launched)", () => {
    // No probe leak to fix: the user typed `ccmux sidebar` in their own
    // focused pane, so probe replies route correctly.
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "ccmux-sidebar", "1"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe(null);
  });

  it("returns the active sibling when self is unfocused", () => {
    // Hook/toggle spawn: sidebar is non-active, the user's shell is.
    const output = [
      row("%1", "zsh", "1"),
      row("%2", "ccmux-sidebar", "0"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe("%1");
  });

  it("picks the active sibling when there are multiple non-sidebar panes", () => {
    const output = [
      row("%1", "nvim", "0"),
      row("%2", "ccmux-sidebar", "0"),
      row("%3", "zsh", "1"),
      row("%4", "htop", "0"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe("%3");
  });

  it("skips other ccmux-sidebar panes when picking the candidate", () => {
    // Defensive: if a stray sibling sidebar is somehow active, we'd rather
    // restore to a real shell pane than to another sidebar.
    const output = [
      row("%1", "ccmux-sidebar", "1"),
      row("%2", "ccmux-sidebar", "0"),
      row("%3", "zsh", "0"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe(null);
  });

  it("returns null when self is not in the output (mid-query race)", () => {
    // The window listing can come back without us if the pane was killed
    // between launch and the list-panes call. Bail safely.
    const output = row("%1", "zsh", "1");
    expect(parseRestoreCandidate(output, "%99")).toBe(null);
  });

  it("returns null for empty output", () => {
    expect(parseRestoreCandidate("", "%2")).toBe(null);
  });

  it("returns null when no sibling is active", () => {
    // Pathological: tmux always has an active pane per window, but be
    // defensive about it rather than handing focus to a non-active pane.
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "ccmux-sidebar", "0"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe(null);
  });
});

// Format: "#{window_id}<sep>#{window_name}"
describe("parseWindowIdByName", () => {
  it("finds the named window among others", () => {
    const output = [
      row("@1", "zsh"),
      row("@2", AGENTS_WINDOW_NAME),
      row("@3", "nvim"),
    ].join("\n");
    expect(parseWindowIdByName(output, AGENTS_WINDOW_NAME)).toBe("@2");
  });

  it("returns null when no window has the name", () => {
    const output = [row("@1", "zsh"), row("@2", "nvim")].join("\n");
    expect(parseWindowIdByName(output, AGENTS_WINDOW_NAME)).toBe(null);
  });

  it("returns null for empty output", () => {
    expect(parseWindowIdByName("", AGENTS_WINDOW_NAME)).toBe(null);
  });

  it("does not match a window whose name merely contains the tag", () => {
    const output = row("@1", `${AGENTS_WINDOW_NAME}-other`);
    expect(parseWindowIdByName(output, AGENTS_WINDOW_NAME)).toBe(null);
  });

  it("keeps per-agent attach windows distinct from the global view and each other", () => {
    const output = [
      row("@1", AGENTS_WINDOW_NAME),
      row("@2", agentAttachWindowName("1fadfe7f")),
      row("@3", agentAttachWindowName("d97c1019")),
    ].join("\n");
    expect(parseWindowIdByName(output, agentAttachWindowName("d97c1019"))).toBe(
      "@3",
    );
    expect(parseWindowIdByName(output, agentAttachWindowName("1fadfe7f"))).toBe(
      "@2",
    );
    expect(parseWindowIdByName(output, AGENTS_WINDOW_NAME)).toBe("@1");
  });
});

describe("isSafeAgentShortId", () => {
  it("accepts roster-shaped shorts and rejects shell metacharacters", () => {
    // Roster shorts come from external JSON and end up inside `sh -c`;
    // anything outside [\w-] is rejected before the launcher builds the
    // command. (The launcher itself is process-wide-mocked by App tests,
    // so the guard is tested as a pure function.)
    expect(isSafeAgentShortId("1fadfe7f")).toBe(true);
    expect(isSafeAgentShortId("agent_1-x")).toBe(true);
    expect(isSafeAgentShortId("abc; rm -rf ~")).toBe(false);
    expect(isSafeAgentShortId("a$(whoami)")).toBe(false);
    expect(isSafeAgentShortId("")).toBe(false);
  });
});

describe("parseLaunchPane", () => {
  it("returns the active sibling of a sidebar, never the sidebar itself", () => {
    const output = [
      row("%1", "zsh", "1"),
      row("%2", "ccmux-sidebar", "0"),
    ].join("\n");
    expect(parseLaunchPane(output, "%2", { excludeSelf: true })).toBe("%1");
  });

  it("skips the sidebar even when the sidebar is the active pane", () => {
    // The user is typing in the sidebar, but a spawn must still land in
    // the main area rather than halving the rail.
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "ccmux-sidebar", "1"),
    ].join("\n");
    expect(parseLaunchPane(output, "%2", { excludeSelf: true })).toBe("%1");
  });

  it("returns the active pane for a popup picker, which is not a pane", () => {
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "nvim", "1"),
    ].join("\n");
    expect(parseLaunchPane(output, null)).toBe("%2");
  });

  it("targets its OWN pane for an inline picker run from a shell", () => {
    // The inline picker vacates its pane on spawn, so that pane is exactly
    // where the split belongs. Excluding it halves the neighbour instead —
    // someone's editor — which is what shipped before this was surfaced.
    const output = [
      row("%1", "nvim", "0"),
      row("%2", "bun", "1"),
    ].join("\n");
    expect(parseLaunchPane(output, "%2")).toBe("%2");
  });

  it("returns its own pane for an inline picker alone in its window", () => {
    // Excluding self here yielded null, dropping placement entirely and
    // letting the new window land on tmux's current-session guess.
    expect(parseLaunchPane(row("%2", "bun", "1"), "%2")).toBe("%2");
  });

  it("still skips a titled persistent picker, which does not vacate", () => {
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "ccmux-picker", "1"),
    ].join("\n");
    expect(parseLaunchPane(output, "%2")).toBe("%1");
  });

  it("falls back to the first eligible pane when the active one is ccmux's", () => {
    const output = [
      row("%1", "ccmux-picker", "1"),
      row("%2", "zsh", "0"),
      row("%3", "nvim", "0"),
    ].join("\n");
    expect(parseLaunchPane(output, null)).toBe("%2");
  });

  it("returns null when the window holds nothing but ccmux surfaces", () => {
    const output = row("%1", "ccmux-sidebar", "1");
    expect(parseLaunchPane(output, "%1", { excludeSelf: true })).toBe(null);
  });

  it("returns null on empty output", () => {
    expect(parseLaunchPane("", null)).toBe(null);
  });
});

interface SpawnResponse {
  stdout?: string;
  exitCode?: number;
}

/** Stubs the three process spawns the window launcher makes: `Bun.which`
 *  for the claude binary, and `Bun.spawn` for every tmux call. */
function withTmuxStubs(responses: SpawnResponse[]): {
  calls: string[][];
  restore: () => void;
} {
  const originalSpawn = Bun.spawn;
  const originalWhich = Bun.which;
  const originalTmux = process.env.TMUX;
  const calls: string[][] = [];
  process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
  Bun.which = ((cmd: string) =>
    cmd === "claude" ? "/usr/bin/claude" : null) as typeof Bun.which;
  Bun.spawn = ((argv: string[]) => {
    calls.push([...argv]);
    const response = responses.shift() ?? {};
    return {
      stdout: new Blob([response.stdout ?? ""]).stream(),
      stderr: new Blob([""]).stream(),
      exited: Promise.resolve(response.exitCode ?? 0),
    };
  }) as unknown as typeof Bun.spawn;
  return {
    calls,
    restore: () => {
      Bun.spawn = originalSpawn;
      Bun.which = originalWhich;
      if (originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = originalTmux;
    },
  };
}

const windowRow = (id: string, name: string) =>
  [id, name].join(PANE_FIELD_SEP);

/** Both the flag slot and the env var have to be clear for the fallback
 *  cases, and put back for everything else in the suite. */
function withNoCapturedTty<T>(run: () => Promise<T>): Promise<T> {
  const previousEnv = process.env.CCMUX_CLIENT_TTY;
  delete process.env.CCMUX_CLIENT_TTY;
  setPinnedTmuxClientTty(undefined);
  return run().finally(() => {
    if (previousEnv === undefined) delete process.env.CCMUX_CLIENT_TTY;
    else process.env.CCMUX_CLIENT_TTY = previousEnv;
  });
}

afterEach(() => {
  setPinnedTmuxClientTty(undefined);
});

describe("openDedupedCommandWindow client pinning", () => {
  it("pins an existing-window switch to the captured client", async () => {
    const stubs = withTmuxStubs([
      { stdout: windowRow("@2", AGENTS_WINDOW_NAME) },
      {},
    ]);
    try {
      setPinnedTmuxClientTty("/dev/ttys005");
      const result = await openAgentsWindow("/tmp/proj");

      expect(result).toEqual({ ok: true, clientSwitched: true });
      expect(stubs.calls[1]).toEqual([
        "tmux",
        "switch-client",
        "-c",
        "/dev/ttys005",
        "-t",
        "@2",
      ]);
    } finally {
      stubs.restore();
    }
  });

  it("pins the switch that follows a fresh new-window", async () => {
    const stubs = withTmuxStubs([
      { stdout: "" },
      { stdout: "%9\n" },
      {},
    ]);
    try {
      setPinnedTmuxClientTty("/dev/ttys005");
      const result = await openAgentsWindow("/tmp/proj");

      expect(result).toEqual({ ok: true, clientSwitched: true });
      expect(stubs.calls[1]?.[1]).toBe("new-window");
      expect(stubs.calls[2]).toEqual([
        "tmux",
        "switch-client",
        "-c",
        "/dev/ttys005",
        "-t",
        "%9",
      ]);
    } finally {
      stubs.restore();
    }
  });

  it("opens the window but switches nobody when no client tty resolves", async () => {
    // A bare `switch-client` here would move the most-recently-active client,
    // which inside a popup is whichever OTHER terminal typed last.
    const stubs = withTmuxStubs([
      { stdout: "" },
      { exitCode: 1 },
      { stdout: "%9\n" },
    ]);
    try {
      const result = await withNoCapturedTty(() =>
        openAgentsWindow("/tmp/proj"),
      );

      expect(result).toEqual({ ok: true, clientSwitched: false });
      const verbs = stubs.calls.map((argv) => argv[1]);
      expect(verbs).toEqual(["list-windows", "display-message", "new-window"]);
    } finally {
      stubs.restore();
    }
  });

  it("refuses rather than switching when an existing window has no client", async () => {
    const stubs = withTmuxStubs([
      { stdout: windowRow("@2", AGENTS_WINDOW_NAME) },
      { exitCode: 1 },
    ]);
    try {
      const result = await withNoCapturedTty(() =>
        openAgentsWindow("/tmp/proj"),
      );

      expect(result).toEqual({ ok: true, clientSwitched: false });
      // list-windows, then the failed display-message. Nothing else: no
      // switch, and no duplicate window either.
      expect(stubs.calls.map((argv) => argv[1])).toEqual([
        "list-windows",
        "display-message",
      ]);
    } finally {
      stubs.restore();
    }
  });

  it("does not spawn a duplicate when a stale tty fails the switch", async () => {
    // Pre-#181 a failed switch meant one thing: the window vanished. A stale
    // captured tty fails identically, and falling through would defeat the
    // name dedupe on every activation.
    const stubs = withTmuxStubs([
      { stdout: windowRow("@2", AGENTS_WINDOW_NAME) },
      { exitCode: 1 },
      { stdout: windowRow("@2", AGENTS_WINDOW_NAME) },
    ]);
    try {
      setPinnedTmuxClientTty("/dev/ttys005");
      const result = await openAgentsWindow("/tmp/proj");

      expect(result).toEqual({ ok: true, clientSwitched: false });
      expect(stubs.calls.map((argv) => argv[1])).toEqual([
        "list-windows",
        "switch-client",
        "list-windows",
      ]);
    } finally {
      stubs.restore();
    }
  });

  it("still spawns when the existing window really did vanish", async () => {
    const stubs = withTmuxStubs([
      { stdout: windowRow("@2", AGENTS_WINDOW_NAME) },
      { exitCode: 1 },
      { stdout: "" },
      { stdout: "%9\n" },
      {},
    ]);
    try {
      setPinnedTmuxClientTty("/dev/ttys005");
      const result = await openAgentsWindow("/tmp/proj");

      expect(result).toEqual({ ok: true, clientSwitched: true });
      expect(stubs.calls.map((argv) => argv[1])).toEqual([
        "list-windows",
        "switch-client",
        "list-windows",
        "new-window",
        "switch-client",
      ]);
    } finally {
      stubs.restore();
    }
  });
});
