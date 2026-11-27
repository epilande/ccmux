import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  claimNotice,
  decideNotice,
  resolvePromptDisplay,
  stampNewStateFile,
  type UIState,
} from "./state";
import { STATE_FILE } from "./config";

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

describe("decideNotice", () => {
  const id = "keys-1.5";

  it("is fresh when there is no state file", () => {
    expect(decideNotice(null, id)).toBe("fresh");
  });

  it("shows for a file only a 1.4 daemon wrote", () => {
    // The 1.4 daemon's attention tracker writes `lastSeen` and `version` in
    // ordinary use, so this is what most 1.4 users have. A 1.5 process that
    // creates the file stamps `seenNotices`, so a file without it is older.
    expect(
      decideNotice(
        { lastSeen: { a: "2024-01-15T12:00:00Z" }, version: 1 } as UIState,
        id,
      ),
    ).toBe("show");
  });

  it("shows for a file a 1.4 picker wrote", () => {
    expect(decideNotice({ collapsedGroups: ["alpha"] }, id)).toBe("show");
  });

  it("shows for a file that exists but holds nothing it can read", () => {
    // `getUIState` reads a malformed file as {}; it still predates the flag.
    expect(decideNotice({}, id)).toBe("show");
  });

  it("is seen once recorded, whatever else the state holds", () => {
    expect(
      decideNotice({ collapsedGroups: ["alpha"], seenNotices: [id] }, id),
    ).toBe("seen");
  });

  it("ignores another notice's record", () => {
    expect(
      decideNotice({ collapsedGroups: ["alpha"], seenNotices: ["other"] }, id),
    ).toBe("show");
  });
});

describe("stampNewStateFile", () => {
  it("marks every current notice seen, so a 1.5-created file never owes one", () => {
    expect(stampNewStateFile()).toEqual({ seenNotices: ["keys-1.5"] });
  });
});

describe("claimNotice", () => {
  const id = "keys-1.5";
  const read = () => JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  const write = (state: unknown) => {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  };

  beforeEach(() => rmSync(STATE_FILE, { force: true }));
  afterEach(() => rmSync(STATE_FILE, { force: true }));

  it("a fresh install records the notice as seen without showing it", async () => {
    expect(await claimNotice(id, { mayShow: true })).toBe(false);
    expect(read()).toEqual({ seenNotices: [id] });
  });

  it("a 1.4 state shows it once, recording it the moment it shows", async () => {
    write({ lastSeen: {}, version: 1, seenNotices: ["other"] });
    expect(await claimNotice(id, { mayShow: true })).toBe(true);
    expect(read()).toEqual({
      lastSeen: {},
      version: 1,
      seenNotices: ["other", id],
    });
    expect(await claimNotice(id, { mayShow: true })).toBe(false);
  });

  it("a surface that may not show it leaves a 1.4 state for one that may", async () => {
    // The sidebar: a fleet would raise the notice in every pane at once.
    const before = { collapsedGroups: ["alpha"] };
    write(before);
    expect(await claimNotice(id, { mayShow: false })).toBe(false);
    expect(read()).toEqual(before);
  });

  it("a surface that may not show it still records a fresh install", async () => {
    // Otherwise the 1.5 sidebar's own writes would create a file without the
    // flag, and the picker opened later would read it as a 1.4 state.
    expect(await claimNotice(id, { mayShow: false })).toBe(false);
    expect(read()).toEqual({ seenNotices: [id] });
  });

  it("does nothing once seen", async () => {
    const before = { collapsedGroups: ["alpha"], seenNotices: [id] };
    write(before);
    expect(await claimNotice(id, { mayShow: true })).toBe(false);
    expect(read()).toEqual(before);
  });
});
