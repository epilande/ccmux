import { describe, expect, it } from "bun:test";
import {
  parseLaunchPane,
  parseRestoreCandidate,
  parseWindowIdByName,
  agentAttachWindowName,
  isSafeAgentShortId,
  AGENTS_WINDOW_NAME,
} from "./tmux";
import { PANE_FIELD_SEP } from "../../lib/tmux-format";

// Note: capturePane isn't unit-tested here. Preview/App tests call
// `mock.module("../utils/tmux")`, which is process-wide in Bun, so capturePane
// is the mocked stub by the time this file runs in the full suite. Its
// throw-on-failure contract is covered indirectly via Preview's failure fold;
// the real safety net is the `.catch()` at each call site.

// Format: "#{pane_id}<sep>#{pane_title}<sep>#{pane_active}"
// pane_active: "1" for the window's active pane, "0" otherwise.
const row = (...fields: string[]) => fields.join(PANE_FIELD_SEP);

describe("parseRestoreCandidate", () => {
  it("returns null when only the sidebar (self) is in the window", () => {
    const output = row("%1", "ccmux-sidebar", "1");
    expect(parseRestoreCandidate(output, "%1")).toBe(null);
  });

  it("returns null when self is the active pane (user-launched)", () => {
    // No probe leak to fix: the user typed `ccmux sidebar` in their own
    // focused pane, so probe replies route correctly.
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "ccmux-sidebar", "1"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe(null);
  });

  it("returns the active sibling when self is unfocused", () => {
    // Hook/toggle spawn: sidebar is non-active, the user's shell is.
    const output = [
      row("%1", "zsh", "1"),
      row("%2", "ccmux-sidebar", "0"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe("%1");
  });

  it("picks the active sibling when there are multiple non-sidebar panes", () => {
    const output = [
      row("%1", "nvim", "0"),
      row("%2", "ccmux-sidebar", "0"),
      row("%3", "zsh", "1"),
      row("%4", "htop", "0"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe("%3");
  });

  it("skips other ccmux-sidebar panes when picking the candidate", () => {
    // Defensive: if a stray sibling sidebar is somehow active, we'd rather
    // restore to a real shell pane than to another sidebar.
    const output = [
      row("%1", "ccmux-sidebar", "1"),
      row("%2", "ccmux-sidebar", "0"),
      row("%3", "zsh", "0"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe(null);
  });

  it("returns null when self is not in the output (mid-query race)", () => {
    // The window listing can come back without us if the pane was killed
    // between launch and the list-panes call. Bail safely.
    const output = row("%1", "zsh", "1");
    expect(parseRestoreCandidate(output, "%99")).toBe(null);
  });

  it("returns null for empty output", () => {
    expect(parseRestoreCandidate("", "%2")).toBe(null);
  });

  it("returns null when no sibling is active", () => {
    // Pathological: tmux always has an active pane per window, but be
    // defensive about it rather than handing focus to a non-active pane.
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "ccmux-sidebar", "0"),
    ].join("\n");
    expect(parseRestoreCandidate(output, "%2")).toBe(null);
  });
});

// Format: "#{window_id}<sep>#{window_name}"
describe("parseWindowIdByName", () => {
  it("finds the named window among others", () => {
    const output = [
      row("@1", "zsh"),
      row("@2", AGENTS_WINDOW_NAME),
      row("@3", "nvim"),
    ].join("\n");
    expect(parseWindowIdByName(output, AGENTS_WINDOW_NAME)).toBe("@2");
  });

  it("returns null when no window has the name", () => {
    const output = [row("@1", "zsh"), row("@2", "nvim")].join("\n");
    expect(parseWindowIdByName(output, AGENTS_WINDOW_NAME)).toBe(null);
  });

  it("returns null for empty output", () => {
    expect(parseWindowIdByName("", AGENTS_WINDOW_NAME)).toBe(null);
  });

  it("does not match a window whose name merely contains the tag", () => {
    const output = row("@1", `${AGENTS_WINDOW_NAME}-other`);
    expect(parseWindowIdByName(output, AGENTS_WINDOW_NAME)).toBe(null);
  });

  it("keeps per-agent attach windows distinct from the global view and each other", () => {
    const output = [
      row("@1", AGENTS_WINDOW_NAME),
      row("@2", agentAttachWindowName("1fadfe7f")),
      row("@3", agentAttachWindowName("d97c1019")),
    ].join("\n");
    expect(parseWindowIdByName(output, agentAttachWindowName("d97c1019"))).toBe(
      "@3",
    );
    expect(parseWindowIdByName(output, agentAttachWindowName("1fadfe7f"))).toBe(
      "@2",
    );
    expect(parseWindowIdByName(output, AGENTS_WINDOW_NAME)).toBe("@1");
  });
});

describe("isSafeAgentShortId", () => {
  it("accepts roster-shaped shorts and rejects shell metacharacters", () => {
    // Roster shorts come from external JSON and end up inside `sh -c`;
    // anything outside [\w-] is rejected before the launcher builds the
    // command. (The launcher itself is process-wide-mocked by App tests,
    // so the guard is tested as a pure function.)
    expect(isSafeAgentShortId("1fadfe7f")).toBe(true);
    expect(isSafeAgentShortId("agent_1-x")).toBe(true);
    expect(isSafeAgentShortId("abc; rm -rf ~")).toBe(false);
    expect(isSafeAgentShortId("a$(whoami)")).toBe(false);
    expect(isSafeAgentShortId("")).toBe(false);
  });
});

describe("parseLaunchPane", () => {
  it("returns the active sibling of a sidebar, never the sidebar itself", () => {
    const output = [
      row("%1", "zsh", "1"),
      row("%2", "ccmux-sidebar", "0"),
    ].join("\n");
    expect(parseLaunchPane(output, "%2", { excludeSelf: true })).toBe("%1");
  });

  it("skips the sidebar even when the sidebar is the active pane", () => {
    // The user is typing in the sidebar, but a spawn must still land in
    // the main area rather than halving the rail.
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "ccmux-sidebar", "1"),
    ].join("\n");
    expect(parseLaunchPane(output, "%2", { excludeSelf: true })).toBe("%1");
  });

  it("returns the active pane for a popup picker, which is not a pane", () => {
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "nvim", "1"),
    ].join("\n");
    expect(parseLaunchPane(output, null)).toBe("%2");
  });

  it("targets its OWN pane for an inline picker run from a shell", () => {
    // The inline picker vacates its pane on spawn, so that pane is exactly
    // where the split belongs. Excluding it halves the neighbour instead —
    // someone's editor — which is what shipped before this was surfaced.
    const output = [
      row("%1", "nvim", "0"),
      row("%2", "bun", "1"),
    ].join("\n");
    expect(parseLaunchPane(output, "%2")).toBe("%2");
  });

  it("returns its own pane for an inline picker alone in its window", () => {
    // Excluding self here yielded null, dropping placement entirely and
    // letting the new window land on tmux's current-session guess.
    expect(parseLaunchPane(row("%2", "bun", "1"), "%2")).toBe("%2");
  });

  it("still skips a titled persistent picker, which does not vacate", () => {
    const output = [
      row("%1", "zsh", "0"),
      row("%2", "ccmux-picker", "1"),
    ].join("\n");
    expect(parseLaunchPane(output, "%2")).toBe("%1");
  });

  it("falls back to the first eligible pane when the active one is ccmux's", () => {
    const output = [
      row("%1", "ccmux-picker", "1"),
      row("%2", "zsh", "0"),
      row("%3", "nvim", "0"),
    ].join("\n");
    expect(parseLaunchPane(output, null)).toBe("%2");
  });

  it("returns null when the window holds nothing but ccmux surfaces", () => {
    const output = row("%1", "ccmux-sidebar", "1");
    expect(parseLaunchPane(output, "%1", { excludeSelf: true })).toBe(null);
  });

  it("returns null on empty output", () => {
    expect(parseLaunchPane("", null)).toBe(null);
  });
});
