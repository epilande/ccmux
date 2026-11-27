import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import {
  isProcessAlive,
  getDaemonPid,
  isDaemonRunningAsync,
  waitForDaemon,
  findDaemonPidByPort,
  stopDaemonByPort,
  stopForRestart,
  isStandaloneBinary,
  daemonSpawnArgv,
  shouldRetryHealthProbe,
  type HealthFetch,
} from "./lifecycle";
import { DAEMON_PORT, getPidFilePath } from "../lib/config";

/**
 * Tests spawn real "sleep" processes and use signal delivery
 * rather than mocking process.kill.
 */

const spawnedPids: number[] = [];

function spawnSleepProcess(): number {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  spawnedPids.push(child.pid!);
  return child.pid!;
}

let tempCcmuxHome: string | null = null;
// Restored (not deleted) on teardown: the test preload's isolated CCMUX_HOME
// must outlive this file, or later subprocesses fall back to ~/.config/ccmux.
const originalCcmuxHome = process.env.CCMUX_HOME;
const originalFetch = globalThis.fetch;
const originalBunSpawn = Bun.spawn;

function setupTempHome() {
  tempCcmuxHome = join(
    tmpdir(),
    `ccmux-lifecycle-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  process.env.CCMUX_HOME = tempCcmuxHome;
  const pidFile = getPidFilePath();
  mkdirSync(dirname(pidFile), { recursive: true });
}

function teardown() {
  // Kill all spawned sleep processes
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  spawnedPids.length = 0;

  // Restore mocks
  globalThis.fetch = originalFetch;
  Bun.spawn = originalBunSpawn;

  // Clean up temp dir
  if (tempCcmuxHome) {
    rmSync(tempCcmuxHome, { recursive: true, force: true });
    tempCcmuxHome = null;
  }
  if (originalCcmuxHome === undefined) delete process.env.CCMUX_HOME;
  else process.env.CCMUX_HOME = originalCcmuxHome;
}

function writePidFile(pid: number) {
  writeFileSync(getPidFilePath(), String(pid));
}

function mockFetch(fn: (input: any, init?: any) => any) {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

// Routes by command: `lsof` (port discovery) returns `lsofStdout`, `ss` (the
// Linux fallback for port discovery) returns `ssStdout`, `ps` (identity check
// / diagnostics) returns `psStdout`. The ps default looks like a real ccmux
// daemon so port-kill tests pass without restating it; pass a non-daemon
// command line to exercise the foreign-squatter guard. A tool named in
// `missing` throws on spawn, the way Bun.spawn does for a binary that is not
// on PATH.
function mockBunSpawn(
  lsofStdout: string,
  psStdout = "/usr/bin/bun /app/src/index.ts daemon start",
  options: {
    ssStdout?: string;
    ssExit?: number;
    lsofExit?: number;
    missing?: string[];
  } = {},
) {
  const { ssStdout = "", ssExit = 0, lsofExit = 0, missing = [] } = options;
  Bun.spawn = ((cmd: string[]) => {
    if (missing.includes(cmd[0]!)) {
      throw new Error(`Executable not found in $PATH: "${cmd[0]}"`);
    }
    const stdout =
      cmd[0] === "ps" ? psStdout : cmd[0] === "ss" ? ssStdout : lsofStdout;
    return {
      stdout: new Blob([stdout]).stream(),
      exited: Promise.resolve(
        cmd[0] === "ss" ? ssExit : cmd[0] === "lsof" ? lsofExit : 0,
      ),
    };
  }) as unknown as typeof Bun.spawn;
}

/** An `ss` LISTEN line with no owner: the socket of a process ss may not name. */
const SS_OWNERLESS = "LISTEN 0      512    127.0.0.1:2269 0.0.0.0:*\n";

/** One `ss -ltnpH` line for a listener on the daemon port owned by `pid`. */
function ssListener(pid: number): string {
  return `LISTEN 0      512    127.0.0.1:2269 0.0.0.0:* users:(("bun",pid=${pid},fd=11))\n`;
}

/** Neither port-lookup tool is on PATH. */
const NO_LOOKUP_TOOLS = { missing: ["lsof", "ss"] };

describe("isProcessAlive", () => {
  it("returns true for a live process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a non-existent PID", () => {
    expect(isProcessAlive(999999)).toBe(false);
  });
});

describe("getDaemonPid", () => {
  beforeEach(setupTempHome);
  afterEach(teardown);

  it("returns null when no PID file exists", () => {
    const pidFile = getPidFilePath();
    if (existsSync(pidFile)) unlinkSync(pidFile);
    expect(getDaemonPid()).toBeNull();
  });

  it("returns PID for alive process", () => {
    const pid = spawnSleepProcess();
    writePidFile(pid);
    expect(getDaemonPid()).toBe(pid);
  });

  it("returns null for dead process", () => {
    writePidFile(999999);
    expect(getDaemonPid()).toBeNull();
  });

  it("does not clean up stale PID file", () => {
    writePidFile(999999);
    getDaemonPid();
    expect(existsSync(getPidFilePath())).toBe(true);
  });
});

describe("isDaemonRunningAsync", () => {
  beforeEach(setupTempHome);
  afterEach(teardown);

  it("returns false when PID reused by another process but health fails", async () => {
    // Simulate PID reuse: a live PID that is not our daemon
    const pid = spawnSleepProcess();
    writePidFile(pid);
    mockFetch(() => {
      throw new Error("connection refused");
    });
    expect(await isDaemonRunningAsync()).toBe(false);
    // The PID is alive (reused), so the stale file must be preserved, never
    // unlinked -- we must not act on a recycled PID.
    expect(existsSync(getPidFilePath())).toBe(true);
  });

  it("cleans up the PID file when the process is dead and health fails", async () => {
    writePidFile(999999); // dead PID
    mockFetch(() => {
      throw new Error("connection refused");
    });
    expect(await isDaemonRunningAsync()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(false);
  });

  it("returns true when PID absent but health endpoint responds ok", async () => {
    mockFetch(async () => new Response("ok", { status: 200 }));
    expect(await isDaemonRunningAsync()).toBe(true);
  });

  it("returns false when PID absent and health endpoint fails", async () => {
    mockFetch(() => {
      throw new Error("connection refused");
    });
    expect(await isDaemonRunningAsync()).toBe(false);
  });

  it("returns false when PID absent and health returns non-ok", async () => {
    mockFetch(async () => new Response("error", { status: 503 }));
    expect(await isDaemonRunningAsync()).toBe(false);
  });
});

describe("waitForDaemon", () => {
  beforeEach(setupTempHome);
  afterEach(teardown);

  it("returns true when daemon running and health responds", async () => {
    const pid = spawnSleepProcess();
    writePidFile(pid);
    mockFetch(async () => new Response("ok", { status: 200 }));
    expect(await waitForDaemon(5, 10)).toBe(true);
  });

  it("returns false after max attempts when no daemon", async () => {
    mockFetch(() => {
      throw new Error("connection refused");
    });
    expect(await waitForDaemon(3, 10)).toBe(false);
  });

  it("returns false when PID alive but health never responds", async () => {
    const pid = spawnSleepProcess();
    writePidFile(pid);
    mockFetch(() => {
      throw new Error("connection refused");
    });
    expect(await waitForDaemon(3, 10)).toBe(false);
  });

  it("retries until health responds", async () => {
    const pid = spawnSleepProcess();
    writePidFile(pid);
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount < 3) throw new Error("not ready");
      return new Response("ok", { status: 200 });
    });
    expect(await waitForDaemon(5, 10)).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

describe("findDaemonPidByPort", () => {
  beforeEach(setupTempHome);
  afterEach(teardown);

  it("returns PID when lsof finds a listener", async () => {
    mockBunSpawn("12345\n");
    expect(await findDaemonPidByPort()).toBe(12345);
  });

  it("returns null when lsof returns empty output", async () => {
    mockBunSpawn("");
    expect(await findDaemonPidByPort()).toBeNull();
  });

  it("returns null when lsof returns non-numeric output", async () => {
    mockBunSpawn("no matches\n");
    expect(await findDaemonPidByPort()).toBeNull();
  });

  it("returns null when Bun.spawn throws", async () => {
    Bun.spawn = (() => {
      throw new Error("command not found");
    }) as unknown as typeof Bun.spawn;
    expect(await findDaemonPidByPort()).toBeNull();
  });

  it("falls back to ss when lsof is not on PATH", async () => {
    // The common Linux shape: lsof is an optional package, ss (iproute2) is not.
    mockBunSpawn("", undefined, {
      missing: ["lsof"],
      ssStdout: ssListener(4321),
    });
    expect(await findDaemonPidByPort()).toBe(4321);
  });

  it("falls back to ss when lsof runs but names no listener", async () => {
    // Also what a no-op `lsof` stub looks like, so a stub cannot hide ss.
    mockBunSpawn("", undefined, { ssStdout: ssListener(4321) });
    expect(await findDaemonPidByPort()).toBe(4321);
  });

  it("prefers lsof's answer when both tools name a listener", async () => {
    mockBunSpawn("12345\n", undefined, { ssStdout: ssListener(4321) });
    expect(await findDaemonPidByPort()).toBe(12345);
  });

  it("returns null when ss shows the socket without an owner (another user's)", async () => {
    mockBunSpawn("", undefined, {
      missing: ["lsof"],
      ssStdout: SS_OWNERLESS,
    });
    expect(await findDaemonPidByPort()).toBeNull();
  });

  it("asks ss for the daemon port's listening TCP sockets only", async () => {
    const calls: string[][] = [];
    Bun.spawn = ((cmd: string[]) => {
      calls.push(cmd);
      if (cmd[0] === "lsof") throw new Error("not found");
      return { stdout: new Blob([ssListener(4321)]).stream() };
    }) as unknown as typeof Bun.spawn;
    await findDaemonPidByPort();
    const ss = calls.find((cmd) => cmd[0] === "ss");
    expect(ss).toEqual(["ss", "-ltnpH", `sport = :${DAEMON_PORT}`]);
  });
});

describe("stopDaemonByPort", () => {
  beforeEach(setupTempHome);
  afterEach(teardown);

  it("kills the daemon listening on the port", async () => {
    // lsof finds the listener; ps reports a ccmux `daemon start` command line.
    const pid = spawnSleepProcess();
    mockBunSpawn(`${pid}\n`);
    expect(await stopDaemonByPort()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("kills a zombie that holds the port but never answers health", async () => {
    // The frozen-daemon case the feature exists for: it still LISTENs on the
    // port but its event loop is dead, so /health throws. It must still be
    // killed. This is the only test that fails if the removed health gate
    // (`if (!(await isDaemonRunningAsync())) return false`) is reintroduced.
    mockFetch(() => {
      throw new Error("connection refused");
    });
    const pid = spawnSleepProcess();
    mockBunSpawn(`${pid}\n`);
    expect(await stopDaemonByPort()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("does not kill a PID-file process that does not own the port", async () => {
    // PID-reuse safety: the PID file may name an unrelated live process after
    // the daemon died and the OS recycled its PID. stopDaemonByPort must signal
    // only the actual port listener, never the PID-file PID.
    const innocent = spawnSleepProcess();
    writePidFile(innocent);
    mockBunSpawn(""); // nothing is listening on the port
    expect(await stopDaemonByPort()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(innocent)).toBe(true);
  });

  it("does not kill a foreign process that merely listens on the port", async () => {
    // Squatter guard: an unrelated process bound to port 2269 is not the ccmux
    // daemon (its command line lacks the `daemon start` tail), so leave it be.
    const innocent = spawnSleepProcess();
    mockBunSpawn(`${innocent}\n`, "python3 -m http.server 2269");
    expect(await stopDaemonByPort()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(innocent)).toBe(true);
  });

  it("returns false when nothing is listening on the port", async () => {
    mockBunSpawn(""); // lsof finds no listener
    expect(await stopDaemonByPort()).toBe(false);
  });

  it("does not kill a listener that is not the expected confirm-time pid", async () => {
    const listener = spawnSleepProcess();
    mockBunSpawn(`${listener}\n`);
    expect(await stopDaemonByPort(listener + 1)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(listener)).toBe(true);
  });

  it("kills the listener when it still matches the expected confirm-time pid", async () => {
    const listener = spawnSleepProcess();
    mockBunSpawn(`${listener}\n`);
    expect(await stopDaemonByPort(listener)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(listener)).toBe(false);
  });

  it("kills the daemon ss finds when lsof is not on PATH", async () => {
    const pid = spawnSleepProcess();
    mockBunSpawn("", undefined, {
      missing: ["lsof"],
      ssStdout: ssListener(pid),
    });
    expect(await stopDaemonByPort()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("clears the pid file when a lookup ran and found no listener", async () => {
    // Zombie recovery depends on this: no listener means no daemon, so a pid
    // file left behind would only block the fresh `Daemon.start`.
    const innocent = spawnSleepProcess();
    writePidFile(innocent);
    mockBunSpawn("", undefined, { missing: ["lsof"] }); // ss ran, found nothing
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(false);
    expect(isProcessAlive(innocent)).toBe(true);
  });

  it("keeps a live daemon's pid file when no lookup tool can run", async () => {
    // Nothing can say who holds the port, and the daemon may well be up. Its
    // pid file is what `daemon stop` and `daemon status` still go by.
    const daemon = spawnSleepProcess();
    writePidFile(daemon);
    mockBunSpawn("", undefined, NO_LOOKUP_TOOLS);
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(true);
    expect(isProcessAlive(daemon)).toBe(true);
  });

  it("drops a pid file whose live pid is not a ccmux daemon when no lookup tool can run", async () => {
    // A recycled pid: kept, it would make the next `Daemon.start` refuse.
    const squatter = spawnSleepProcess();
    writePidFile(squatter);
    mockBunSpawn("", "python3 -m http.server 8000", NO_LOOKUP_TOOLS);
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(false);
    expect(isProcessAlive(squatter)).toBe(true);
  });

  it("keeps a live daemon's pid file when ss sees the listener but cannot name it", async () => {
    // A socket is listening, so this is not "no listener": it is one that
    // cannot be identified, and the pid file may be all there is to stop it by.
    const daemon = spawnSleepProcess();
    writePidFile(daemon);
    mockBunSpawn("", undefined, { missing: ["lsof"], ssStdout: SS_OWNERLESS });
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(true);
    expect(isProcessAlive(daemon)).toBe(true);
  });

  it("keeps a live daemon's pid file when ss fails", async () => {
    // ss exits 0 when nothing matches, so a non-zero exit (a filter it does
    // not support, a kernel without sock_diag) is a lookup that did not run.
    const daemon = spawnSleepProcess();
    writePidFile(daemon);
    mockBunSpawn("", undefined, { missing: ["lsof"], ssExit: 1 });
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(true);
  });

  it("keeps a live daemon's pid file when lsof fails empty and ss is missing", async () => {
    // lsof exits 1 with nothing on stdout both for "no match" and for an
    // error, so on its own it cannot confirm that nothing is listening.
    const daemon = spawnSleepProcess();
    writePidFile(daemon);
    mockBunSpawn("", undefined, { lsofExit: 1, missing: ["ss"] });
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(true);
    expect(isProcessAlive(daemon)).toBe(true);
  });

  it("keeps a live daemon's pid file when lsof fails empty and ss fails", async () => {
    const daemon = spawnSleepProcess();
    writePidFile(daemon);
    mockBunSpawn("", undefined, { lsofExit: 1, ssExit: 1 });
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(true);
  });

  it("clears the pid file when lsof fails empty but ss confirms no listener", async () => {
    const innocent = spawnSleepProcess();
    writePidFile(innocent);
    mockBunSpawn("", undefined, { lsofExit: 1 }); // ss ran clean, found nothing
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(false);
  });

  it("still kills the pid lsof names, whatever its exit code", async () => {
    const pid = spawnSleepProcess();
    mockBunSpawn(`${pid}\n`, undefined, { lsofExit: 1, missing: ["ss"] });
    expect(await stopDaemonByPort()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("drops a dead pid file when no lookup tool can run", async () => {
    const dead = spawnSleepProcess();
    process.kill(dead, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    writePidFile(dead);
    mockBunSpawn("", undefined, NO_LOOKUP_TOOLS);
    expect(await stopDaemonByPort()).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(false);
  });
});

describe("stopForRestart", () => {
  beforeEach(setupTempHome);
  afterEach(teardown);

  it("refuses when the daemon still answers and no lookup tool can find it", async () => {
    // The no-lsof machine before this fix: restart removed the live daemon's
    // pid file, spawned a second daemon that died on bind, and left `daemon
    // stop` with nothing to go by. Now nothing is touched.
    const daemon = spawnSleepProcess();
    writePidFile(daemon);
    mockBunSpawn("", undefined, NO_LOOKUP_TOOLS);
    mockFetch(async () => new Response("ok", { status: 200 }));
    expect(await stopForRestart()).toBe("still-running");
    expect(existsSync(getPidFilePath())).toBe(true);
    expect(isProcessAlive(daemon)).toBe(true);
  });

  it("refuses when ss sees the listener but cannot name it", async () => {
    const daemon = spawnSleepProcess();
    writePidFile(daemon);
    mockBunSpawn("", undefined, { missing: ["lsof"], ssStdout: SS_OWNERLESS });
    mockFetch(async () => new Response("ok", { status: 200 }));
    expect(await stopForRestart()).toBe("still-running");
    expect(existsSync(getPidFilePath())).toBe(true);
    expect(isProcessAlive(daemon)).toBe(true);
  });

  it("refuses when the listener is not a ccmux daemon", async () => {
    const squatter = spawnSleepProcess();
    mockBunSpawn(`${squatter}\n`, "python3 -m http.server 2269");
    mockFetch(async () => new Response("ok", { status: 200 }));
    expect(await stopForRestart()).toBe("still-running");
    expect(isProcessAlive(squatter)).toBe(true);
  });

  it("clears the way once ss finds and kills the daemon", async () => {
    const daemon = spawnSleepProcess();
    writePidFile(daemon);
    mockBunSpawn("", undefined, {
      missing: ["lsof"],
      ssStdout: ssListener(daemon),
    });
    expect(await stopForRestart()).toBe("stopped");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isProcessAlive(daemon)).toBe(false);
    expect(existsSync(getPidFilePath())).toBe(false);
  });

  it("clears the way when nothing is left serving", async () => {
    // The stop found nothing to kill, but nothing answers either (a daemon
    // that died on its own): the restart can go ahead and spawn.
    mockBunSpawn("", undefined, NO_LOOKUP_TOOLS);
    mockFetch(() => {
      throw new Error("connection refused");
    });
    expect(await stopForRestart()).toBe("stopped");
  });
});

describe("isStandaloneBinary", () => {
  it("detects a compiled binary by its embedded bunfs entry path", () => {
    expect(isStandaloneBinary("/$bunfs/root/index.js")).toBe(true);
    expect(isStandaloneBinary("B:/~BUN/root/index.js")).toBe(true);
    expect(isStandaloneBinary("B:\\~BUN\\root\\index.js")).toBe(true);
  });

  it("detects a compiled binary by its execPath (not the bun runtime)", () => {
    // execPath is the binary itself -> standalone, even if argv[1] isn't a bunfs path.
    expect(isStandaloneBinary("/some/argv", "/usr/local/bin/ccmux")).toBe(true);
    expect(
      isStandaloneBinary("/x", "/opt/homebrew/bin/ccmux-macos-arm64"),
    ).toBe(true);
  });

  it("treats `bun <script>` (execPath = bun) as not standalone", () => {
    expect(
      isStandaloneBinary(
        "/Users/me/ccmux/dist/index.js",
        "/opt/homebrew/bin/bun",
      ),
    ).toBe(false);
    expect(
      isStandaloneBinary("/Users/me/ccmux/src/index.ts", "/root/.bun/bin/bun"),
    ).toBe(false);
  });

  it("treats a missing argv[1] as standalone", () => {
    expect(isStandaloneBinary(undefined)).toBe(true);
    expect(isStandaloneBinary("")).toBe(true);
  });

  it("treats a real dev script path as not standalone", () => {
    expect(isStandaloneBinary("/Users/me/ccmux/src/index.ts")).toBe(false);
    expect(isStandaloneBinary("/home/me/ccmux/dist/index.js")).toBe(false);
  });
});

describe("daemonSpawnArgv", () => {
  it("resolves a relative bun script against the import-time cwd (bin/ccmux + sidebar chdir)", () => {
    // Pre-fix spawn forwarded argv[1] as-is. After the sidebar chdirs to
    // CCMUX_CALLER_PWD, bun looks for dist/index.js in the caller's directory
    // and cannot start the replacement daemon.
    expect(
      daemonSpawnArgv("dist/index.js", "/usr/local/bin/bun", "/opt/ccmux"),
    ).toEqual(["/opt/ccmux/dist/index.js", "daemon", "start"]);
    expect(
      daemonSpawnArgv("src/index.ts", "/root/.bun/bin/bun", "/home/me/ccmux"),
    ).toEqual(["/home/me/ccmux/src/index.ts", "daemon", "start"]);
  });

  it("keeps an already-absolute script path", () => {
    expect(
      daemonSpawnArgv("/opt/ccmux/src/index.ts", "/usr/bin/bun", "/elsewhere"),
    ).toEqual(["/opt/ccmux/src/index.ts", "daemon", "start"]);
  });

  it("omits the script path for a compiled binary", () => {
    expect(
      daemonSpawnArgv("/$bunfs/root/index.js", "/usr/local/bin/ccmux", "/tmp"),
    ).toEqual(["daemon", "start"]);
  });

  it("bun finds the resolved script after cwd has left the package root", async () => {
    const root = join(
      tmpdir(),
      `ccmux-daemon-spawn-${process.pid}-${Date.now()}`,
    );
    const caller = join(
      tmpdir(),
      `ccmux-caller-pwd-${process.pid}-${Date.now()}`,
    );
    mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(caller, { recursive: true });
    writeFileSync(
      join(root, "dist", "index.js"),
      'process.stdout.write("ok\\n");',
    );
    try {
      const args = daemonSpawnArgv("dist/index.js", process.execPath, root);
      expect(args[0]).toBe(resolve(root, "dist/index.js"));

      // Sidebar has already chdir'd; spawn inherits that cwd. A relative
      // argv[1] (the pre-fix spawn) makes bun miss the script.
      const proc = Bun.spawn([process.execPath, args[0]], {
        cwd: caller,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit).toBe(0);
      expect(stdout).toBe("ok\n");
      expect(stderr).toBe("");

      const relative = Bun.spawn([process.execPath, "dist/index.js"], {
        cwd: caller,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await relative.exited).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(caller, { recursive: true, force: true });
    }
  });
});

describe("shouldRetryHealthProbe", () => {
  it("retries a timeout (a listener accepted but answered late)", () => {
    expect(
      shouldRetryHealthProbe(
        new DOMException("The operation timed out.", "TimeoutError"),
      ),
    ).toBe(true);
    expect(
      shouldRetryHealthProbe(new DOMException("aborted", "AbortError")),
    ).toBe(true);
  });

  it("does NOT retry a refused connection, so the cold path stays fast", async () => {
    // The real runtime shape, not a hand-built one: bind a port, close it,
    // then probe it. Bun rejects with a plain Error, code ConnectionRefused.
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const url = `http://127.0.0.1:${server.port}/health`;
    server.stop(true);
    let refused: unknown;
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeDefined();
    expect((refused as { name?: string }).name).not.toBe("TimeoutError");
    expect(shouldRetryHealthProbe(refused)).toBe(false);
  });

  it("does NOT retry an unknown error shape", () => {
    expect(shouldRetryHealthProbe(new Error("boom"))).toBe(false);
    expect(shouldRetryHealthProbe(new TypeError("fetch failed"))).toBe(false);
    expect(shouldRetryHealthProbe(undefined)).toBe(false);
    expect(shouldRetryHealthProbe(null)).toBe(false);
    expect(shouldRetryHealthProbe("timed out")).toBe(false);
  });
});

describe("isDaemonRunningAsync health retry", () => {
  beforeEach(setupTempHome);
  afterEach(teardown);

  const timeout = () =>
    new DOMException("The operation timed out.", "TimeoutError");

  /** Records the budget of every probe and answers from a queue. */
  function probes(answers: Array<"ok" | "timeout" | "refused">) {
    const budgets: number[] = [];
    const fetchHealth: HealthFetch = async (_url, timeoutMs) => {
      budgets.push(timeoutMs);
      const answer = answers.shift();
      if (answer === "ok") return new Response("{}", { status: 200 });
      if (answer === "timeout") throw timeout();
      const error = new Error("Unable to connect.");
      Object.assign(error, { code: "ConnectionRefused" });
      throw error;
    };
    return { fetchHealth, budgets };
  }

  it("a daemon still booting: first probe times out, the retry answers", async () => {
    const { fetchHealth, budgets } = probes(["timeout", "ok"]);
    expect(await isDaemonRunningAsync(fetchHealth)).toBe(true);
    expect(budgets).toEqual([100, 1000]);
  });

  it("two timeouts is not running", async () => {
    const { fetchHealth, budgets } = probes(["timeout", "timeout"]);
    expect(await isDaemonRunningAsync(fetchHealth)).toBe(false);
    expect(budgets).toEqual([100, 1000]);
  });

  it("a refused connection probes exactly once", async () => {
    const { fetchHealth, budgets } = probes(["refused"]);
    expect(await isDaemonRunningAsync(fetchHealth)).toBe(false);
    expect(budgets).toEqual([100]);
  });

  it("a healthy daemon probes exactly once", async () => {
    const { fetchHealth, budgets } = probes(["ok"]);
    expect(await isDaemonRunningAsync(fetchHealth)).toBe(true);
    expect(budgets).toEqual([100]);
  });

  it("a non-ok response is not retried", async () => {
    const budgets: number[] = [];
    const fetchHealth: HealthFetch = async (_url, timeoutMs) => {
      budgets.push(timeoutMs);
      return new Response("nope", { status: 500 });
    };
    expect(await isDaemonRunningAsync(fetchHealth)).toBe(false);
    expect(budgets).toEqual([100]);
  });
});
