import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { stopDaemon, isDaemonRunning } from "./lifecycle";
import { getPidFilePath } from "../lib/config";

/**
 * Tests spawn real "sleep" processes to test actual signal delivery
 * rather than mocking process.kill.
 */

function spawnSleepProcess(): number {
  const child = spawn("sleep", ["60"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid!;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Save/restore the real PID file so tests don't interfere with a running daemon */
let savedPidFileContent: string | null = null;
let tempCcmuxHome: string | null = null;
// Restored (not deleted) on teardown: the test preload's isolated CCMUX_HOME
// must outlive this file, or later subprocesses fall back to ~/.config/ccmux.
const originalCcmuxHome = process.env.CCMUX_HOME;

function getTestPidFile(): string {
  return getPidFilePath();
}

function savePidFile() {
  tempCcmuxHome = join(
    tmpdir(),
    `ccmux-stop-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  process.env.CCMUX_HOME = tempCcmuxHome;
  const pidFile = getTestPidFile();
  mkdirSync(dirname(pidFile), { recursive: true });
  savedPidFileContent = existsSync(pidFile)
    ? readFileSync(pidFile, "utf-8")
    : null;
}

function restorePidFile() {
  const pidFile = getTestPidFile();
  if (savedPidFileContent !== null) {
    writeFileSync(pidFile, savedPidFileContent);
  } else if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
  if (tempCcmuxHome) {
    rmSync(tempCcmuxHome, { recursive: true, force: true });
    tempCcmuxHome = null;
  }
  if (originalCcmuxHome === undefined) delete process.env.CCMUX_HOME;
  else process.env.CCMUX_HOME = originalCcmuxHome;
}

describe("stopDaemon", () => {
  beforeEach(savePidFile);
  afterEach(restorePidFile);

  it("should return false when no PID file exists", async () => {
    const pidFile = getTestPidFile();
    if (existsSync(pidFile)) unlinkSync(pidFile);
    expect(await stopDaemon()).toBe(false);
  });

  it("should kill process and clean up PID file", async () => {
    const pid = spawnSleepProcess();
    expect(isAlive(pid)).toBe(true);

    const pidFile = getTestPidFile();
    writeFileSync(pidFile, String(pid));
    expect(await stopDaemon()).toBe(true);
    expect(existsSync(pidFile)).toBe(false);

    // Give OS time to reap
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(pid)).toBe(false);
  });

  it("should clean up PID file even when process is already dead", async () => {
    const pidFile = getTestPidFile();
    writeFileSync(pidFile, "999999");
    expect(await stopDaemon()).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });
});

describe("isDaemonRunning", () => {
  beforeEach(savePidFile);
  afterEach(restorePidFile);

  it("should return false when no PID file exists", () => {
    const pidFile = getTestPidFile();
    if (existsSync(pidFile)) unlinkSync(pidFile);
    expect(isDaemonRunning()).toBe(false);
  });

  it("should return true for alive process", () => {
    const pid = spawnSleepProcess();
    writeFileSync(getTestPidFile(), String(pid));
    expect(isDaemonRunning()).toBe(true);
    process.kill(pid, "SIGKILL");
  });

  it("should return false and clean up stale PID file for dead process", () => {
    const pidFile = getTestPidFile();
    writeFileSync(pidFile, "999999");
    expect(isDaemonRunning()).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });
});
