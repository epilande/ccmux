import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  renderOpenCodePlugin,
  renderOpenCodeTuiPlugin,
  getPluginSourceForTests,
} from "./plugin-script";

let tempRoot: string;

beforeEach(() => {
  tempRoot = join(
    tmpdir(),
    `ccmux-render-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(tempRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// Both installed plugins go through the same install-time substitution, and
// a broken substitution in either ships a file OpenCode cannot load.
describe.each([
  ["renderOpenCodePlugin (1.x server plugin)", renderOpenCodePlugin],
  ["renderOpenCodeTuiPlugin (2.x TUI plugin)", renderOpenCodeTuiPlugin],
])("%s", (_name, renderPlugin) => {
  const render = (dir: string, version: string) =>
    renderPlugin({ markersDir: dir, version });

  it("substitutes the markersDir as a JSON-encoded string literal", () => {
    const out = render("/Users/u/.config/ccmux/session-pids", "1.0.0");
    expect(out).toContain('markersDir: "/Users/u/.config/ccmux/session-pids"');
    expect(out).not.toContain("__CCMUX_MARKERS_DIR__");
  });

  it("escapes special characters in the markersDir via JSON.stringify", () => {
    const funky = '/tmp/weird"path\\with\nnewline';
    const out = render(funky, "1.0.0");
    expect(out).toContain(`markersDir: ${JSON.stringify(funky)}`);
    expect(out).not.toContain("__CCMUX_MARKERS_DIR__");
  });

  it("substitutes the version in both the sentinel comment and the constant", () => {
    const out = render("/tmp", "2.4.1");
    expect(out.split("\n")[0]).toBe("// ccmux-plugin v2.4.1");
    expect(out).toContain('version: "2.4.1"');
    expect(out).not.toContain("__CCMUX_VERSION__");
  });

  it("keeps the sentinel header as the first line for install/uninstall checks", () => {
    const out = render("/tmp", "9.9.9");
    const firstLine = out.split("\n", 1)[0];
    expect(firstLine).toMatch(/^\/\/ ccmux-plugin v\d+\.\d+\.\d+/);
  });

  it("is idempotent: rendering twice with the same input gives the same output", () => {
    const a = render("/tmp/a", "1.0.0");
    const b = render("/tmp/a", "1.0.0");
    expect(a).toBe(b);
  });

  it("does not accidentally substitute bare tokens that are part of another word", () => {
    // The sentinels are prefixed with `__` which is unlikely to appear
    // mid-identifier, but assert the rendered output contains no stray
    // CCMUX_VERSION / CCMUX_MARKERS_DIR fragments at all.
    const out = render("/tmp", "1.0.0");
    expect(out.includes("CCMUX_VERSION")).toBe(false);
    expect(out.includes("CCMUX_MARKERS_DIR")).toBe(false);
  });
});

describe("rendered plugins as real modules", () => {
  it("the 1.x server plugin can be imported and executed", async () => {
    const out = renderOpenCodePlugin({
      markersDir: join(tempRoot, "markers"),
      version: "1.0.0",
    });
    const pluginPath = join(tempRoot, "rendered.mjs");
    writeFileSync(pluginPath, out);
    const mod = await import(pluginPath);
    expect(typeof mod.makePlugin).toBe("function");
    expect(typeof mod.default).toBe("function");
    expect(mod.default.version).toBe("1.0.0");
  });

  it("the 2.x TUI plugin loads as OpenCode expects and writes to the rendered markers dir", async () => {
    const markersDir = join(tempRoot, "markers");
    const out = renderOpenCodeTuiPlugin({ markersDir, version: "1.0.0" });
    const pluginPath = join(tempRoot, "tui.mjs");
    writeFileSync(pluginPath, out);
    const mod = await import(pluginPath);
    // OpenCode 2 requires a default export with an id and a setup function.
    expect(mod.default.id).toBe("ccmux");
    expect(mod.default.version).toBe("1.0.0");
    expect(typeof mod.default.setup).toBe("function");

    // Minimal TUI context: one pane showing an idle session.
    const cleanup = mod.default.setup({
      ui: { router: { current: () => ({ type: "session", sessionID: "ses_r" }) } },
      data: {
        listen: () => () => {},
        session: {
          get: () => ({ title: "t", location: { directory: "/repo" } }),
          root: (id: string) => id,
          family: (id: string) => [id],
          status: () => "idle",
          message: { list: () => [] },
          permission: { list: () => [], sync: async () => {} },
          form: { list: () => [], sync: async () => {} },
        },
      },
    });
    const markerPath = join(markersDir, "opencode-ses_r.json");
    try {
      expect(JSON.parse(readFileSync(markerPath, "utf-8"))).toMatchObject({
        agent_type: "opencode",
        pid: process.pid,
        session_id: "ses_r",
        state: "idle",
      });
    } finally {
      cleanup();
    }
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe("getPluginSourceForTests", () => {
  it("returns the raw authored source with both sentinels intact", () => {
    const src = getPluginSourceForTests();
    expect(src).toContain('"__CCMUX_MARKERS_DIR__"');
    expect(src).toContain('"__CCMUX_VERSION__"');
    expect(src).toContain("// ccmux-plugin v__CCMUX_VERSION__");
  });
});
