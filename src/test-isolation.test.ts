import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join, relative, isAbsolute } from "path";
import {
  CCMUX_DIR,
  LOG_FILE,
  MARKERS_DIR,
  PID_FILE,
  PREFS_FILE,
  STATE_FILE,
  getPidFilePath,
} from "./lib/config";

/**
 * Guards `test-preload.ts`: a test run must never read or write the
 * developer's real ccmux dir. Before the preload, the hunk-review `debugLog`
 * appended to ~/.config/ccmux/ccmux.log on every `bun test`.
 */

const REAL_CCMUX_DIR = join(homedir(), ".config", "ccmux");

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("test isolation", () => {
  const testHome = process.env.CCMUX_TEST_HOME;

  it("runs with the test preload active", () => {
    expect(testHome).toBeTruthy();
  });

  // Equality, not just "not the real dir": a test file that sets CCMUX_HOME
  // at module scope and loads first would also freeze a temp dir, and this
  // must fail if isolation only holds by that accident.
  it("froze lib/config's ccmux dir at the preload's temp dir", () => {
    expect(CCMUX_DIR).toBe(testHome!);
  });

  it("keeps every ccmux-owned path out of the real config dir", () => {
    const paths = [
      CCMUX_DIR,
      LOG_FILE,
      PID_FILE,
      PREFS_FILE,
      STATE_FILE,
      MARKERS_DIR,
      getPidFilePath(),
    ];
    for (const p of paths) {
      expect(isInside(p, testHome!)).toBe(true);
      expect(isInside(p, REAL_CCMUX_DIR)).toBe(false);
    }
  });

  // The write that originally leaked, end to end: a completed review always
  // logs "review done". Everything is stubbed; nothing real is spawned.
  it("sends the hunk-review debug log to the temp LOG_FILE", async () => {
    // Non-literal "?real"-style specifier for the same reason as
    // review.test.ts: App.test.tsx mocks this module path.
    const { runHunkReview } = (await import(
      "./tui/utils/review" + "?isolation"
    )) as typeof import("./tui/utils/review");
    const result = await runHunkReview(
      { suspend: () => {}, resume: () => {} },
      "/repo",
      {
        which: () => "/opt/homebrew/bin/hunk",
        resolveRoot: async () => "/repo",
        gitStatus: async () => " M file\n",
        paneId: "",
        spawn: () => ({ exited: Promise.resolve(0) }),
      },
    );
    expect(result).toEqual({ ok: true, notes: [] });
    expect(readFileSync(LOG_FILE, "utf-8")).toContain(
      "[hunk-review] review done",
    );
  });
});
