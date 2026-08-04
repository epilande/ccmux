import { afterEach, beforeEach, describe, it, expect, spyOn } from "bun:test";
import {
  findPaneHostingPid,
  PaneDiscoveryError,
  scanTmuxPanesOrThrow,
} from "./pane-discovery";
import type { ProcessTree, ProcessNode } from "./process-tree";
import type { TmuxPane } from "../types/session";
import * as preferences from "../lib/preferences";
import { resetTmuxSocketCache } from "../lib/tmux-socket";
import { PANE_FIELD_SEP } from "../lib/tmux-format";

describe("scanTmuxPanesOrThrow", () => {
  const ORIGINAL_SOCKET_ENV = process.env.CCMUX_TMUX_SOCKET;
  let prefsSpy: ReturnType<
    typeof spyOn<typeof preferences, "getPreferencesSync">
  >;
  let originalSpawn: typeof Bun.spawn;

  /** Canned `tmux list-panes` result, so no tmux binary is involved. */
  function withTmuxResult(opts: {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }): void {
    Bun.spawn = (() => ({
      exited: Promise.resolve(opts.exitCode),
      stdout: new Blob([opts.stdout ?? ""]).stream(),
      stderr: new Blob([opts.stderr ?? ""]).stream(),
    })) as unknown as typeof Bun.spawn;
  }

  beforeEach(() => {
    // A developer's own tmuxSocket would otherwise leak into the argv and into
    // the thrown message's `attemptedTmuxSocketPath()`.
    prefsSpy = spyOn(preferences, "getPreferencesSync").mockImplementation(
      () => ({}),
    );
    delete process.env.CCMUX_TMUX_SOCKET;
    resetTmuxSocketCache();
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
    prefsSpy.mockRestore();
    resetTmuxSocketCache();
    if (ORIGINAL_SOCKET_ENV === undefined) delete process.env.CCMUX_TMUX_SOCKET;
    else process.env.CCMUX_TMUX_SOCKET = ORIGINAL_SOCKET_ENV;
  });

  it("reports tmux's own words for a server that is not there, without throwing", async () => {
    withTmuxResult({
      exitCode: 1,
      stderr: "no server running on /private/tmp/tmux-501/fix98\n",
    });
    // The empty pane list is what the scan loop acts on (reaping included);
    // `noServer` only tells /server-info which socket went dead.
    expect(await scanTmuxPanesOrThrow()).toEqual({
      panes: [],
      noServer: "no server running on /private/tmp/tmux-501/fix98",
    });
  });

  it("reports the other no-server shape too", async () => {
    withTmuxResult({
      exitCode: 1,
      stderr: "error connecting to /private/tmp/tmux-501/fix98 (No such file)",
    });
    const scan = await scanTmuxPanesOrThrow();
    expect(scan.panes).toEqual([]);
    expect(scan.noServer).toContain("error connecting to");
  });

  it("still throws for any other non-zero exit", async () => {
    withTmuxResult({ exitCode: 1, stderr: "lost server" });
    expect(scanTmuxPanesOrThrow()).rejects.toBeInstanceOf(PaneDiscoveryError);
  });

  it("gives no reason for a live server that simply has no panes", async () => {
    withTmuxResult({ exitCode: 0, stdout: "" });
    expect(await scanTmuxPanesOrThrow()).toEqual({ panes: [], noServer: null });
  });

  it("gives no reason alongside parsed panes", async () => {
    const line = [
      "%7",
      "4242",
      "work",
      "1",
      "0",
      "/dev/ttys001",
      "1700000000",
      "1700000100",
      "claude",
      "node",
      "/repo",
    ].join(PANE_FIELD_SEP);
    withTmuxResult({ exitCode: 0, stdout: `${line}\n` });

    const scan = await scanTmuxPanesOrThrow();
    expect(scan.noServer).toBe(null);
    expect(scan.panes).toHaveLength(1);
    expect(scan.panes[0]).toMatchObject({
      paneId: "%7",
      panePid: 4242,
      target: "work:1.0",
    });
  });
});

describe("findPaneHostingPid", () => {
  const makePane = (paneId: string, panePid: number): TmuxPane => ({
    paneId,
    panePid,
    sessionName: "test",
    windowIndex: 0,
    paneIndex: 0,
    target: `test:0.${paneId.replace("%", "")}`,
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: null,
    currentCommand: null,
    currentPath: null,
  });

  const makeTree = (nodes: ProcessNode[]): ProcessTree => {
    const map = new Map<number, ProcessNode>();
    for (const n of nodes) map.set(n.pid, n);
    return {
      getProcess: (pid: number) => map.get(pid),
    } as unknown as ProcessTree;
  };

  it("returns the pane whose panePid is a direct ancestor of pid", () => {
    const panes = [makePane("%1", 1000), makePane("%2", 2000)];
    const tree = makeTree([
      { pid: 3000, ppid: 2500, comm: "opencode" },
      { pid: 2500, ppid: 2000, comm: "bash" },
      { pid: 2000, ppid: 1, comm: "zsh" },
    ]);
    expect(findPaneHostingPid(3000, panes, tree)?.paneId).toBe("%2");
  });

  it("returns the pane when the pid IS the pane's panePid", () => {
    const panes = [makePane("%self", 4242)];
    const tree = makeTree([{ pid: 4242, ppid: 1, comm: "zsh" }]);
    expect(findPaneHostingPid(4242, panes, tree)?.paneId).toBe("%self");
  });

  it("returns null when pid is not hosted by any pane", () => {
    const panes = [makePane("%1", 1000)];
    const tree = makeTree([
      { pid: 5000, ppid: 9000, comm: "opencode" },
      { pid: 9000, ppid: 1, comm: "launchd" },
    ]);
    expect(findPaneHostingPid(5000, panes, tree)).toBeNull();
  });

  it("returns null when panes list is empty", () => {
    const tree = makeTree([{ pid: 1, ppid: 0, comm: "init" }]);
    expect(findPaneHostingPid(1, [], tree)).toBeNull();
  });

  it("terminates cleanly on a ppid cycle (shouldn't happen, but safe)", () => {
    const panes = [makePane("%1", 1000)];
    const tree = makeTree([
      { pid: 100, ppid: 200, comm: "a" },
      { pid: 200, ppid: 100, comm: "b" },
    ]);
    expect(findPaneHostingPid(100, panes, tree)).toBeNull();
  });

  it("stops walking at pid <= 1 without matching init", () => {
    // An imaginary pane whose panePid is 1 (init) must NOT be reported
    // as hosting an unrelated process just because the walk bottoms out.
    const panes = [makePane("%init", 1)];
    const tree = makeTree([{ pid: 500, ppid: 1, comm: "detached" }]);
    expect(findPaneHostingPid(500, panes, tree)).toBeNull();
  });
});
