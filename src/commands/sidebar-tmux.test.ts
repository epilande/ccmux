import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
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
    expect(tmux("list-panes", "-t", target, "-F", "#{pane_id}").split("\n")).toHaveLength(2);
    const window = tmux("display-message", "-p", "-t", target, "#{window_id}");
    const ready = Bun.spawn(tmuxArgvFor(tmuxBinary ?? "tmux", "-S", socket, "wait-for", `sidebar-ready-${window}`), { env, timeout: 5000 });
    expect(await ready.exited).toBe(0);
    const expected = `ccmux-sidebar:${width}`;
    const panes = tmux("list-panes", "-t", target, "-F", "#{pane_title}:#{pane_width}").split("\n");
    expect(panes.filter((pane) => pane === expected)).toHaveLength(1);
    expect(panes).toHaveLength(2);
    expect(tmux("display-message", "-p", "-t", target, "#{pane_title}")).not.toBe("ccmux-sidebar");
  }

  try {
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "seed", "-x", "160", "-y", "40", "sleep 60");
    tmux("set-option", "-g", "default-shell", "/bin/sh");
    sidebar("--toggle", "--width", "30");
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
}, 15000);

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
