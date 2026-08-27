import { describe, expect, it } from "bun:test";
import { newSessionOptions } from "./new-session-options";
import type { NewSessionDraft } from "./store";

const draft = (overrides: Partial<NewSessionDraft> = {}): NewSessionDraft => ({
  cwd: "/repo",
  agent: "claude",
  placement: "window",
  destination: "worktree",
  prompt: "",
  moveChanges: false,
  untracked: "move",
  worktreeName: null,
  fork: null,
  existingWorktree: null,
  pr: null,
  issue: null,
  returnToSources: null,
  returnToWorktrees: null,
  field: "agent",
  dropdown: null,
  ...overrides,
});

describe("newSessionOptions destination", () => {
  /**
   * Unreachable today (`newSessionFields` drops the row) and listed anyway,
   * because a missing mode here is what makes the next mode-aware change a
   * real bug: keys, pills and overlay would offer a destination the daemon
   * has already decided.
   */
  it("returns null for a spawn cut from a PR", () => {
    expect(
      newSessionOptions("destination", {
        agents: [],
        tooShort: false,
        draft: draft({
          pr: {
            number: 151,
            title: "Worktrees panel: open-PR list",
            repoRoot: "/repo",
          },
        }),
      }),
    ).toBeNull();
  });

  it("returns null for a spawn cut from an issue", () => {
    expect(
      newSessionOptions("destination", {
        agents: [],
        tooShort: false,
        draft: draft({
          issue: {
            number: 144,
            title: "Notifications are swallowed inside nested tmux",
            repoRoot: "/repo",
          },
        }),
      }),
    ).toBeNull();
  });
});
