import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolvePromptDisplay } from "./state";

// Override STATE_FILE before importing state module
const testDir = join(tmpdir(), `ccmux-state-test-${Date.now()}`);
const testStateFile = join(testDir, "state.json");

// We need to mock the STATE_FILE import. Since the module reads from config,
// we'll test the logic directly by writing/reading the file ourselves
// and verifying the format matches what getUIState/setUIState expect.

describe("UIState file format", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it("should handle missing state file gracefully", async () => {
    const file = Bun.file(join(testDir, "nonexistent.json"));
    expect(await file.exists()).toBe(false);
  });

  it("should write and read state as JSON", async () => {
    const state = { pinnedGroups: ["alpha", "beta"], previewWidth: 45 };
    await Bun.write(testStateFile, JSON.stringify(state, null, 2) + "\n");

    const file = Bun.file(testStateFile);
    const loaded = await file.json();
    expect(loaded.pinnedGroups).toEqual(["alpha", "beta"]);
    expect(loaded.previewWidth).toBe(45);
  });

  it("should merge updates without losing existing keys", async () => {
    // Write initial state
    const initial = { pinnedGroups: ["alpha"], previewWidth: 35 };
    await Bun.write(testStateFile, JSON.stringify(initial, null, 2) + "\n");

    // Read, merge, write (simulating setUIState)
    const current = await Bun.file(testStateFile).json();
    const merged = { ...current, previewWidth: 50 };
    await Bun.write(testStateFile, JSON.stringify(merged, null, 2) + "\n");

    // Verify both keys preserved
    const result = await Bun.file(testStateFile).json();
    expect(result.pinnedGroups).toEqual(["alpha"]);
    expect(result.previewWidth).toBe(50);
  });

  it("should handle empty state object", async () => {
    await Bun.write(testStateFile, JSON.stringify({}, null, 2) + "\n");

    const loaded = await Bun.file(testStateFile).json();
    expect(loaded.pinnedGroups).toBeUndefined();
    expect(loaded.previewWidth).toBeUndefined();
  });

  it("should handle malformed JSON gracefully", async () => {
    await Bun.write(testStateFile, "not valid json{{{");

    try {
      await Bun.file(testStateFile).json();
      // If it doesn't throw, that's unexpected
      expect(true).toBe(false);
    } catch {
      // Expected: malformed JSON throws
      expect(true).toBe(true);
    }
  });
});

describe("resolvePromptDisplay", () => {
  it("prefers the runtime UIState toggle over everything", () => {
    expect(resolvePromptDisplay({ promptDisplay: "row2" }, "off")).toBe("row2");
  });

  it("uses the config default when no runtime toggle is set", () => {
    expect(resolvePromptDisplay({}, "row2")).toBe("row2");
  });

  it("lets a config default outrank a stale legacy showPrompt:false", () => {
    expect(resolvePromptDisplay({ showPrompt: false }, "inline")).toBe("inline");
  });

  it("migrates a legacy showPrompt:false to off when no config default exists", () => {
    expect(resolvePromptDisplay({ showPrompt: false })).toBe("off");
  });

  it("returns undefined when nothing is set (store default applies)", () => {
    expect(resolvePromptDisplay({})).toBeUndefined();
    expect(resolvePromptDisplay({ showPrompt: true })).toBeUndefined();
  });
});
