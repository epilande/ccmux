import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { sessionAutoOpenHookCommand } from "./sidebar";
import { tmuxArgvFor } from "../lib/tmux-exec";

const tmuxBinary = Bun.which("tmux");
const root = resolve(import.meta.dir, "../..");

it.skipIf(!tmuxBinary)("auto-opens sidebars in new sessions and windows until toggled off", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccmux-sidebar-"));
  const socket = `/tmp/ccmux-sidebar-${crypto.randomUUID()}`;
  const bin = join(home, "bin");
  const env = {
    ...process.env,
    CCMUX_HOME: home,
    CCMUX_TMUX_SOCKET: socket,
    TMUX: `${socket},0,0`,
    PATH: `${bin}:${process.env.PATH}`,
  };
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ccmux"),
    `#!${process.execPath}
import { tmuxArgv } from ${JSON.stringify(join(root, "src/lib/tmux-exec.ts"))};
Bun.spawnSync(tmuxArgv("select-pane", "-t", process.env.TMUX_PANE, "-T", "ccmux-sidebar"));
const window = Bun.spawnSync(tmuxArgv("display-message", "-p", "-t", process.env.TMUX_PANE, "#{window_id}")).stdout.toString().trim();
Bun.spawnSync(tmuxArgv("wait-for", "-S", "sidebar-ready-" + window));
Bun.spawnSync(tmuxArgv("wait-for", "sidebar-exit"));
`,
    { mode: 0o755 },
  );

  function tmux(...args: string[]): string {
    const result = Bun.spawnSync(
      tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, ...args),
      { env },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  function sidebar(...args: string[]): void {
    const result = Bun.spawnSync(
      [process.execPath, "src/index.ts", "sidebar", ...args],
      { cwd: root, env },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }

  async function expectSidebar(target: string, width: number): Promise<void> {
    const window = tmux("display-message", "-p", "-t", target, "#{window_id}");
    const ready = Bun.spawn(tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, "wait-for", `sidebar-ready-${window}`), { env, timeout: 5000 });
    // The after-new-session split waits out the pre-attach window, so arrival
    // is bounded rather than immediate: poll for the pane, then its shape.
    let panes = 0;
    for (let i = 0; i < 30 && panes !== 2; i++) {
      panes = tmux("list-panes", "-t", target, "-F", "#{pane_id}")
        .split("\n")
        .filter(Boolean).length;
      if (panes !== 2) await Bun.sleep(200);
    }
    expect(panes).toBe(2);
    expect(await ready.exited).toBe(0);
    const expected = `ccmux-sidebar:${width}`;
    const shapes = tmux("list-panes", "-t", target, "-F", "#{pane_title}:#{pane_width}").split("\n");
    expect(shapes.filter((pane) => pane === expected)).toHaveLength(1);
    expect(shapes).toHaveLength(2);
    expect(tmux("display-message", "-p", "-t", target, "#{pane_title}")).not.toBe("ccmux-sidebar");
  }

  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "seed", "-x", "160", "-y", "40", "sleep 60");
    tmux("set-option", "-g", "default-shell", "/bin/sh");
    sidebar("--toggle", "--width", "30");
    expect(tmux("show-hooks", "-g")).toContain("--width 30");
    await expectSidebar("seed:", 30);

    tmux("new-session", "-d", "-s", "fresh", "-x", "160", "-y", "40", "sleep 60");
    await expectSidebar("fresh:", 30);
    const firstWindow = tmux("display-message", "-p", "-t", "fresh:", "#{window_id}");
    const secondWindow = tmux("new-window", "-d", "-t", "fresh:", "-P", "-F", "#{window_id}", "sleep 60");
    await expectSidebar(secondWindow, 30);

    tmux("new-session", "-d", "-s", "mirror", "-t", "fresh");
    expect(tmux("list-panes", "-t", firstWindow, "-F", "#{pane_id}").split("\n")).toHaveLength(2);
    const sharedWindow = tmux("new-window", "-d", "-t", "mirror:", "-P", "-F", "#{window_id}", "sleep 60");
    await expectSidebar(sharedWindow, 30);

    tmux("new-session", "-d", "-s", "first-group", "-t", "newgroup");
    await expectSidebar("first-group:", 30);

    sidebar("--apply-width", "42");
    tmux("new-session", "-d", "-s", "resized", "-x", "160", "-y", "40", "sleep 60");
    await expectSidebar("resized:", 42);
    const resizedWindow = tmux("new-window", "-d", "-t", "resized:", "-P", "-F", "#{window_id}", "sleep 60");
    await expectSidebar(resizedWindow, 42);
    expect(tmux("list-panes", "-t", firstWindow, "-F", "#{pane_width}", "-f", '#{==:#{pane_title},ccmux-sidebar}')).toBe("42");

    sidebar("--toggle");
    tmux("new-session", "-d", "-s", "disabled", "-x", "160", "-y", "40", "sleep 60");
    expect(tmux("list-panes", "-t", "disabled:", "-F", "#{pane_id}").split("\n")).toHaveLength(1);
    const disabledWindow = tmux("new-window", "-d", "-t", "disabled:", "-P", "-F", "#{window_id}", "sleep 60");
    expect(tmux("list-panes", "-t", disabledWindow, "-F", "#{pane_id}").split("\n")).toHaveLength(1);
  } finally {
    Bun.spawnSync(tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, "kill-server"), { env });
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);

it.skipIf(!tmuxBinary)("repins a sidebar pane to the configured width when it settled wrong", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccmux-sidebar-"));
  const socket = `/tmp/ccmux-sidebar-${crypto.randomUUID()}`;
  const env = {
    ...process.env,
    CCMUX_HOME: home,
    CCMUX_TMUX_SOCKET: socket,
    TMUX: `${socket},0,0`,
  };

  function tmux(...args: string[]): string {
    const result = Bun.spawnSync(
      tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, ...args),
      { env },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  // The boot re-pin runs inside the sidebar process, so drive it through a
  // subprocess: this test process may itself sit in tmux, where ambient
  // resolution ignores CCMUX_TMUX_SOCKET and the call would miss the socket.
  const driver = join(home, "repin-driver.ts");
  writeFileSync(
    driver,
    `import { repinSidebarPaneWidth } from ${JSON.stringify(join(root, "src/commands/sidebar.ts"))};\nawait repinSidebarPaneWidth(process.argv[2], Number(process.argv[3]));\n`,
  );
  function repin(paneId: string, width: number): void {
    const result = Bun.spawnSync([process.execPath, driver, paneId, String(width)], { env });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }

  const paneWidth = (paneId: string): string =>
    tmux("display-message", "-p", "-t", paneId, "#{pane_width}");

  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "repin", "-x", "160", "-y", "40", "sleep 60");
    const pane = tmux("split-window", "-h", "-d", "-t", "repin:", "-P", "-F", "#{pane_id}", "-l", "100", "sleep 60");
    expect(paneWidth(pane)).toBe("100");

    repin(pane, 30);
    expect(paneWidth(pane)).toBe("30");

    repin(pane, 30);
    expect(paneWidth(pane)).toBe("30");
  } finally {
    Bun.spawnSync(tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, "kill-server"), { env });
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

it.skipIf(!tmuxBinary)("re-arms the resize hook when a mixed-version upgrade orphaned the auto-open hooks", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccmux-sidebar-"));
  const socket = `/tmp/ccmux-sidebar-${crypto.randomUUID()}`;
  const env = {
    ...process.env,
    CCMUX_HOME: home,
    CCMUX_TMUX_SOCKET: socket,
    TMUX: `${socket},0,0`,
  };

  function tmux(...args: string[]): string {
    const result = Bun.spawnSync(
      tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, ...args),
      { env },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  const driver = join(home, "repair-driver.ts");
  writeFileSync(
    driver,
    `import { repairResizeHook } from ${JSON.stringify(join(root, "src/commands/sidebar.ts"))};\nawait repairResizeHook(Number(process.argv[2]));\n`,
  );
  function repair(width: number): void {
    const result = Bun.spawnSync([process.execPath, driver, String(width)], { env });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }

  const resizeHookBody = (): string =>
    tmux("show-hooks", "-gw")
      .split("\n")
      .find((line) => line.includes("window-resized[99]")) ?? "";

  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "repair", "-x", "160", "-y", "40", "sleep 60");

    repair(30);
    expect(resizeHookBody()).toBe("");

    // A pre-`after-new-session` build's toggle-off leaves the new hook live
    // while removing the hooks it knew, including `window-resized[99]`.
    tmux("set-hook", "-g", "after-new-session[99]", "split-window -fhbd 'sleep 60 && exec ccmux sidebar'");
    repair(30);
    expect(resizeHookBody()).toContain("-x 30");
  } finally {
    Bun.spawnSync(tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, "kill-server"), { env });
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

it.skipIf(!tmuxBinary)("waits out the pre-attach window before splitting the initial sidebar", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccmux-sidebar-"));
  const socket = `/tmp/ccmux-sidebar-${crypto.randomUUID()}`;
  const bin = join(home, "bin");
  const env = {
    ...process.env,
    CCMUX_HOME: home,
    CCMUX_TMUX_SOCKET: socket,
    TMUX: `${socket},0,0`,
    PATH: `${bin}:${process.env.PATH}`,
  };
  mkdirSync(bin);
  // A stand-in that keeps the pane alive: the hook's spawn command must not
  // boot a real ccmux inside the test server.
  writeFileSync(join(bin, "ccmux"), "#!/bin/sh\nsleep 300\n", { mode: 0o755 });

  function tmux(...args: string[]): string {
    const result = Bun.spawnSync(
      tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, ...args),
      { env },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  const paneWidths = (target: string): string[] =>
    tmux("list-panes", "-t", target, "-F", "#{pane_left}:#{pane_width}")
      .split("\n")
      .sort();

  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "seed", "-x", "80", "-y", "24", "sleep 60");
    tmux("set-hook", "-g", "after-new-session[99]", sessionAutoOpenHookCommand(30, "left"));

    // The attaching client resizes the window during the bounded wait; the
    // split must land at the resized window, not the pre-attach default that
    // tmux would then redistribute proportionally.
    tmux("new-session", "-d", "-s", "flash", "-x", "80", "-y", "24", "sleep 60");
    tmux("resize-window", "-t", "flash:", "-x", "220", "-y", "50");
    // The bounded attach-wait runs in tmux's real shell against the platform
    // clock, so the deferral window can only be observed as real time; the
    // polls below watch the actual pane count rather than a fixed duration.
    for (let i = 0; i < 25; i++) {
      if (tmux("list-panes", "-t", "flash:", "-F", "#{pane_id}").split("\n").length === 2) break;
      await Bun.sleep(200);
    }
    expect(paneWidths("flash:")).toEqual(["0:30", "31:189"]);

    // A session nobody attaches still gets its sidebar, just after the wait.
    tmux("new-session", "-d", "-s", "lonely", "-x", "80", "-y", "24", "sleep 60");
    await Bun.sleep(300);
    expect(tmux("list-panes", "-t", "lonely:", "-F", "#{pane_id}").split("\n")).toHaveLength(1);
    for (let i = 0; i < 25; i++) {
      if (tmux("list-panes", "-t", "lonely:", "-F", "#{pane_id}").split("\n").length === 2) break;
      await Bun.sleep(200);
    }
    expect(paneWidths("lonely:")).toEqual(["0:30", "31:49"]);
  } finally {
    Bun.spawnSync(tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, "kill-server"), { env });
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);

it.skipIf(!tmuxBinary)("passes a shell-metacharacter start directory to the split without executing it", async () => {
  const home = mkdtempSync(join(tmpdir(), "ccmux-sidebar-"));
  const socket = `/tmp/ccmux-sidebar-${crypto.randomUUID()}`;
  const bin = join(home, "bin");
  const env = {
    ...process.env,
    CCMUX_HOME: home,
    CCMUX_TMUX_SOCKET: socket,
    TMUX: `${socket},0,0`,
    PATH: `${bin}:${process.env.PATH}`,
  };
  mkdirSync(bin);
  writeFileSync(join(bin, "ccmux"), "#!/bin/sh\nsleep 300\n", { mode: 0o755 });
  // No slashes: the metacharacters must stay a single directory name. The
  // injected command writes a tmux environment variable, observable without
  // creating a file at a relative path.
  const dir = join(home, "weird x$(tmux set-environment -g CCMUX_INJECTED 1)");
  const otherDir = join(home, "other window cwd");
  mkdirSync(dir);
  mkdirSync(otherDir);

  function tmux(...args: string[]): string {
    const result = Bun.spawnSync(
      tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, ...args),
      { env },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }

  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "seed", "-x", "160", "-y", "40", "sleep 60");
    tmux("set-hook", "-g", "after-new-session[99]", sessionAutoOpenHookCommand(30, "left"));
    tmux("new-session", "-d", "-s", "meta", "-x", "160", "-y", "40", "-c", dir, "sleep 60");
    // Switch the session's current window during the wait: split-window
    // resolves a `-c` format against the current window, so the hook must use
    // the fire-time snapshot of the captured pane, not a live expansion.
    tmux("new-window", "-d", "-t", "meta:", "-c", otherDir, "sleep 60");
    tmux("select-window", "-t", "meta:1");
    for (let i = 0; i < 30; i++) {
      if (tmux("list-panes", "-t", "meta:0", "-F", "#{pane_id}").split("\n").filter(Boolean).length === 2) break;
      await Bun.sleep(200);
    }
    const paths = tmux("list-panes", "-t", "meta:0", "-F", "#{pane_current_path}").split("\n").sort();
    const real = realpathSync(dir);
    expect(paths).toEqual([real, real]);
    expect(tmux("show-environment", "-g").split("\n").some((line) => line.startsWith("CCMUX_INJECTED"))).toBe(false);
  } finally {
    Bun.spawnSync(tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, "kill-server"), { env });
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);
