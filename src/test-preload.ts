import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Test-run preload (see `[test] preload` in bunfig.toml): point CCMUX_HOME at
 * a fresh temp dir before any test file is imported.
 *
 * `lib/config` freezes CCMUX_DIR, and with it LOG_FILE / STATE_FILE /
 * MARKERS_DIR, at module load. Without this, whichever test file happened to
 * import it first decided where the whole run wrote, and code under test that
 * logs (the hunk-review `debugLog`, for one) appended to the developer's real
 * ~/.config/ccmux/ccmux.log. Setting it here, ahead of every test module,
 * makes isolation the default for a full run and a single-file run alike.
 *
 * Always overrides an inherited CCMUX_HOME: a value from the developer's shell
 * points at a real daemon's state, which tests must not touch either.
 *
 * CCMUX_TEST_HOME records the same path so `test-isolation.test.ts` can prove
 * it was THIS preload that froze `lib/config`, not a test file that set
 * CCMUX_HOME at module scope and happened to load first.
 */
const testHome = mkdtempSync(join(tmpdir(), "ccmux-test-home-"));
process.env.CCMUX_HOME = testHome;
process.env.CCMUX_TEST_HOME = testHome;

// A preload-registered `afterAll` runs once after the whole run (bun's test
// runner never fires `process.on("exit")` here). Removes only the captured
// path, never a re-read of CCMUX_HOME, which test files reassign.
afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
