import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import {
  isProcessAlive,
  getDaemonPid,
  isDaemonRunningAsync,
  waitForDaemon,
  findDaemonPidByPort,
  stopDaemonByPort,
  isStandaloneBinary,
} from "./lifecycle";
import { getPidFilePath } from "../lib/config";

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
  delete process.env.CCMUX_HOME;
}

function writePidFile(pid: number) {
  writeFileSync(getPidFilePath(), String(pid));
}

function mockFetch(fn: (input: any, init?: any) => any) {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

// Routes by command: `lsof` (port discovery) returns `lsofStdout`, `ps`
// (identity check / diagnostics) returns `psStdout`. The ps default looks like
// a real ccmux daemon so port-kill tests pass without restating it; pass a
// non-daemon command line to exercise the foreign-squatter guard.
function mockBunSpawn(
  lsofStdout: string,
  psStdout = "/usr/bin/bun /app/src/index.ts daemon start",
) {
  Bun.spawn = ((cmd: string[]) => ({
    stdout: new Blob([cmd[0] === "ps" ? psStdout : lsofStdout]).stream(),
  })) as unknown as typeof Bun.spawn;
}

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
