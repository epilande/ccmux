import { describe, it, expect } from "bun:test";
import {
  parseToggleState,
  parseAutoOpenHook,
  parseSidebarPaneIds,
  parseResizeHook,
  resizeHookCommand,
  spawnDelaySeconds,
  ccmuxPortEnvPrefix,
  sidebarSpawnCmd,
} from "./sidebar";
import { PANE_FIELD_SEP } from "../lib/tmux-format";

// Joins fields with the same separator the production format strings use.
const row = (...fields: string[]) => fields.join(PANE_FIELD_SEP);

describe("parseToggleState", () => {
  it("extracts sidebar panes, windows, and non-sidebar paths", () => {
    // Format: "#{pane_id}<sep>#{session_name}:#{window_index}<sep>#{pane_title}<sep>#{pane_current_path}<sep>#{session_attached}<sep>#{window_active}"
    const output = [
      row("%0", "main:0", "zsh", "/home/user/project-a", "1", "1"),
      row("%1", "main:0", "ccmux-sidebar", "/somewhere/else", "1", "1"),
      row("%2", "main:1", "nvim", "/home/user/project-b", "1", "0"),
      row("%3", "work:0", "ccmux-sidebar", "/somewhere/else", "0", "1"),
      row("%4", "work:0", "zsh", "/home/user/work", "0", "1"),
    ].join("\n");
    const result = parseToggleState(output);
    expect(result.sidebarPaneIds).toEqual(["%1", "%3"]);
    expect(result.sidebarWindows).toEqual(new Set(["main:0", "work:0"]));
    expect(result.windows).toEqual(
      new Map([
        ["main:0", "/home/user/project-a"],
        ["main:1", "/home/user/project-b"],
        ["work:0", "/home/user/work"],
      ]),
    );
  });

  it("marks active windows of attached sessions only", () => {
    const output = [
      // attached session, active window -> priority
      row("%0", "main:0", "zsh", "/a", "1", "1"),
      // attached session, inactive window
      row("%1", "main:1", "zsh", "/b", "1", "0"),
      // detached session, active window -> not priority
      row("%2", "work:0", "zsh", "/c", "0", "1"),
    ].join("\n");
    const result = parseToggleState(output);
    expect(result.activeWindows).toEqual(new Set(["main:0"]));
  });

  it("leaves activeWindows empty when attachment fields are absent", () => {
    const output = row("%0", "main:0", "zsh", "/home/user");
    const result = parseToggleState(output);
    expect(result.activeWindows).toEqual(new Set());
    expect(result.windows.get("main:0")).toBe("/home/user");
  });

  it("uses first non-sidebar pane path per window", () => {
    const output = [
      row("%0", "main:0", "ccmux-sidebar", "/wrong/path", "1", "1"),
      row("%1", "main:0", "zsh", "/correct/path", "1", "1"),
      row("%2", "main:0", "nvim", "/other/path", "1", "1"),
    ].join("\n");
    const result = parseToggleState(output);
    expect(result.windows.get("main:0")).toBe("/correct/path");
  });

  it("returns empty results for no sidebars", () => {
    const output = [
      row("%0", "main:0", "zsh", "/home/user", "1", "1"),
      row("%1", "main:1", "nvim", "/home/user/code", "1", "0"),
    ].join("\n");
    const result = parseToggleState(output);
    expect(result.sidebarPaneIds).toEqual([]);
    expect(result.sidebarWindows).toEqual(new Set());
    expect(result.windows.size).toBe(2);
  });

  it("returns empty results for empty output", () => {
    const result = parseToggleState("");
    expect(result.sidebarPaneIds).toEqual([]);
    expect(result.sidebarWindows).toEqual(new Set());
    expect(result.activeWindows).toEqual(new Set());
    expect(result.windows.size).toBe(0);
  });

  it("handles sidebar-only windows (no non-sidebar pane path)", () => {
    const output = row("%0", "main:0", "ccmux-sidebar", "/some/path", "1", "1");
    const result = parseToggleState(output);
    expect(result.sidebarPaneIds).toEqual(["%0"]);
    expect(result.sidebarWindows).toEqual(new Set(["main:0"]));
    expect(result.windows.has("main:0")).toBe(false);
  });
});

describe("spawnDelaySeconds", () => {
  it("delays the first background batch past the active-window head start", () => {
    expect(spawnDelaySeconds(0)).toBeCloseTo(0.7);
    expect(spawnDelaySeconds(3)).toBeCloseTo(0.7);
  });

  it("staggers subsequent batches by the batch step", () => {
    expect(spawnDelaySeconds(4)).toBeCloseTo(0.95);
    expect(spawnDelaySeconds(7)).toBeCloseTo(0.95);
    expect(spawnDelaySeconds(8)).toBeCloseTo(1.2);
  });
});

describe("parseAutoOpenHook", () => {
  it("detects registered hook", () => {
    const output = [
      "after-new-session[0] -> run-shell 'some command'",
      "after-new-window[99] -> split-window -fhbd -l 30 -c '#{pane_current_path}' 'sleep 0.1 && exec ccmux sidebar'",
    ].join("\n");
    expect(parseAutoOpenHook(output)).toBe(true);
  });

  it("returns false when hook is absent", () => {
    const output = "after-new-session[0] -> run-shell 'some command'";
    expect(parseAutoOpenHook(output)).toBe(false);
  });

  it("returns false when index exists but no sidebar", () => {
    const output = "after-new-window[99] -> run-shell 'other command'";
    expect(parseAutoOpenHook(output)).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(parseAutoOpenHook("")).toBe(false);
  });

  it("returns false when keywords match on different lines", () => {
    const output = [
      "after-new-window[99] -> run-shell 'unrelated command'",
      "after-new-session[0] -> run-shell 'ccmux sidebar'",
    ].join("\n");
    expect(parseAutoOpenHook(output)).toBe(false);
  });
});

describe("parseSidebarPaneIds", () => {
  it("extracts sidebar pane IDs from mixed panes", () => {
    const output = [
      row("%0", "zsh"),
      row("%1", "ccmux-sidebar"),
      row("%2", "nvim"),
      row("%3", "ccmux-sidebar"),
    ].join("\n");
    expect(parseSidebarPaneIds(output)).toEqual(["%1", "%3"]);
  });

  it("returns empty array when no sidebars", () => {
    const output = [row("%0", "zsh"), row("%1", "nvim")].join("\n");
    expect(parseSidebarPaneIds(output)).toEqual([]);
  });

  it("returns empty array for empty output", () => {
    expect(parseSidebarPaneIds("")).toEqual([]);
  });

  it("handles single sidebar pane", () => {
    expect(parseSidebarPaneIds(row("%5", "ccmux-sidebar"))).toEqual(["%5"]);
  });

  it("ignores partial title matches", () => {
    const output = [
      row("%0", "ccmux-sidebar-old"),
      row("%1", "ccmux-sidebar"),
      row("%2", "my-ccmux-sidebar"),
    ].join("\n");
    expect(parseSidebarPaneIds(output)).toEqual(["%1"]);
  });
});

describe("resizeHookCommand", () => {
  // Verified live on tmux 3.6a: resizing one window re-pins only that window's
  // sidebar, a sidebar-less window is a no-op, and no ccmux process is started.
  it("emits the exact pure-shell hook body", () => {
    expect(resizeHookCommand(30)).toBe(
      `run-shell -b 'tmux -S "#{socket_path}" list-panes -t "#{hook_window}" ` +
        `-F "##{pane_id}" -f "##{==:##{pane_title},ccmux-sidebar}" 2>/dev/null ` +
        `| while read -r p; do tmux -S "#{socket_path}" resize-pane -t "$p" -x 30 2>/dev/null; done'`,
    );
  });

  it("never boots ccmux", () => {
    // The whole point of the rewrite: a client attach resizes every window, and
    // a ~120ms CLI boot per firing is what made that quadratic.
    expect(resizeHookCommand(42)).not.toContain("ccmux sidebar --resize");
    expect(resizeHookCommand(42)).not.toContain("ccmux ");
  });

  it("scopes the work to the resized window", () => {
    const cmd = resizeHookCommand(42);
    expect(cmd).toContain('list-panes -t "#{hook_window}"');
    // A global `list-panes -a` here is what re-pinned every sidebar per firing.
    expect(cmd).not.toContain("list-panes -a");
  });

  it("escapes inner formats so only the outer ones expand at fire time", () => {
    const cmd = resizeHookCommand(42);
    // `#{hook_window}` / `#{socket_path}` expand when run-shell fires...
    expect(cmd).toContain('"#{socket_path}"');
    // ...while `##{pane_id}` / `##{pane_title}` must reach the inner list-panes
    // as literal `#{...}`.
    expect(cmd).toContain('-F "##{pane_id}"');
    expect(cmd).toContain("##{pane_title}");
    expect(cmd).not.toContain('-F "#{pane_id}"');
  });

  it("bakes the width in and stays free of single quotes", () => {
    expect(resizeHookCommand(77)).toContain("-x 77");
    // The body is single-quoted at the tmux layer, which cannot escape a quote.
    const body = resizeHookCommand(77).replace(/^run-shell -b '/, "");
    expect(body.slice(0, -1)).not.toContain("'");
  });
});

describe("parseResizeHook", () => {
  it("detects the registered pure-shell resize hook", () => {
    const output = [
      "after-new-window[99] -> split-window -fhbd -l 30 'sleep 0.1 && exec ccmux sidebar'",
      `window-resized[99] -> ${resizeHookCommand(30)}`,
    ].join("\n");
    expect(parseResizeHook(output)).toBe(true);
  });

  it("still detects the legacy ccmux-booting hook body", () => {
    // Hooks live inside a running tmux server: an upgraded build must
    // recognize (and so be able to replace) a body registered before it.
    const output =
      "window-resized[99] -> run-shell -b 'ccmux sidebar --resize --width 30 --socket /tmp/tmux-501/default'";
    expect(parseResizeHook(output)).toBe(true);
  });

  it("returns false when hook is absent", () => {
    const output =
      "after-new-window[99] -> split-window -fhbd -l 30 'sleep 0.1 && exec ccmux sidebar'";
    expect(parseResizeHook(output)).toBe(false);
  });

  it("does not match the legacy after-resize-window hook name", () => {
    const output =
      "after-resize-window[99] -> run-shell -b 'ccmux sidebar --resize --width 30 --socket /tmp/tmux-501/default'";
    expect(parseResizeHook(output)).toBe(false);
  });

  it("returns false when index exists but wrong command", () => {
    const output = "window-resized[99] -> run-shell 'other command'";
    expect(parseResizeHook(output)).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(parseResizeHook("")).toBe(false);
  });

  it("returns false when keywords match on different lines", () => {
    const output = [
      "window-resized[99] -> run-shell 'unrelated command'",
      "after-new-window[99] -> split-window 'ccmux sidebar'",
    ].join("\n");
    expect(parseResizeHook(output)).toBe(false);
  });
});

describe("ccmuxPortEnvPrefix", () => {
  // CCMUX_PORT is process-global; snapshot and restore around each case.
  const original = process.env.CCMUX_PORT;
  const withPort = (value: string | undefined, fn: () => void) => {
    if (value === undefined) delete process.env.CCMUX_PORT;
    else process.env.CCMUX_PORT = value;
    try {
      fn();
    } finally {
      if (original === undefined) delete process.env.CCMUX_PORT;
      else process.env.CCMUX_PORT = original;
    }
  };

  it("returns no prefix when CCMUX_PORT is unset", () => {
    withPort(undefined, () => expect(ccmuxPortEnvPrefix()).toBe(""));
  });

  it("forwards a valid non-default port", () => {
    withPort("2270", () =>
      expect(ccmuxPortEnvPrefix()).toBe("env CCMUX_PORT=2270 "),
    );
  });

  it("forwards an explicitly-set default port", () => {
    withPort("2269", () =>
      expect(ccmuxPortEnvPrefix()).toBe("env CCMUX_PORT=2269 "),
    );
  });

  it("returns no prefix for non-numeric, zero, or out-of-range values", () => {
    for (const bad of ["", "garbage", "0", "-1", "70000", "22.5"]) {
      withPort(bad, () => expect(ccmuxPortEnvPrefix()).toBe(""));
    }
  });

  it("bakes the forwarded port into the spawn command", () => {
    withPort("2270", () =>
      expect(sidebarSpawnCmd(0.1)).toBe(
        "sleep 0.10 && exec env CCMUX_PORT=2270 ccmux sidebar",
      ),
    );
  });

  it("leaves the spawn command bare when no port is forwarded", () => {
    withPort(undefined, () =>
      expect(sidebarSpawnCmd(0.6)).toBe("sleep 0.60 && exec ccmux sidebar"),
    );
  });
});
