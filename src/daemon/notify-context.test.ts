import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFinishedContext,
  buildNotificationContext,
  extractPermissionPrompt,
  extractQuestionPrompt,
  matchesQuestionPickerSignature,
  type NotifyContextSession,
} from "./notify-context";

// Mirror of the module's MAX_CONTEXT_CHARS cap; kept local so the clamp test
// stays honest without exporting the constant.
const MAX = 300;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-notify-ctx-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write JSONL lines to a transcript file and return its path. */
async function writeTranscript(lines: object[]): Promise<string> {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function assistantToolUse(name: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name, input }],
    },
    timestamp: "2024-01-15T12:00:00Z",
  };
}

function assistantText(text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: "2024-01-15T12:00:00Z",
  };
}

/** A user-role text turn (string content), e.g. a fresh prompt or an
 *  "[Request interrupted by user]" marker after an assistant turn. */
function userText(text: string) {
  return {
    type: "user",
    message: { role: "user", content: text },
    timestamp: "2024-01-15T12:00:00Z",
  };
}

/** A permission session whose pane capture returns `paneText`. */
function permissionSession(
  paneText: string,
  overrides: Partial<NotifyContextSession> = {},
): { session: NotifyContextSession; capturePane: () => Promise<string> } {
  return {
    session: {
      agentType: "claude",
      logPath: null,
      attentionType: "permission",
      pendingTool: "Bash",
      tmuxPane: "%42",
      lastPrompt: null,
      ...overrides,
    },
    capturePane: async () => paneText,
  };
}

/** The realistic tmux capture-pane output for a Claude Bash approval, box
 *  chrome and all (no ANSI — capture-pane -p strips colour). */
const BORDERED_PROMPT = [
  "  ⏺ I'll check the site.",
  "",
  "╭─────────────────────────────────────────────────╮",
  "│ Bash command                                      │",
  "│                                                   │",
  "│   rtk curl -sI https://example.com/               │",
  "│   Fetch example.com front page                    │",
  "│                                                   │",
  "│ Do you want to proceed?                           │",
  "│ ❯ 1. Yes                                          │",
  "│   2. Yes, and don't ask again this session        │",
  "│   3. No, and tell Claude what to do differently   │",
  "╰─────────────────────────────────────────────────╯",
].join("\n");

/** Verbatim Claude Code 2.1.210 Edit approval capture (single-space indent,
 *  ╌ = U+254C full-width dividers around the diff). */
const EDIT_PROMPT = [
  " Edit file",
  " sample.txt",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " 1 -goodbye world",
  " 1 +hello world",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " Do you want to make this edit to sample.txt?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
  " Esc to cancel · Tab to amend",
].join("\n");

/** Verbatim Claude Code 2.1.210 Write approval capture. */
const WRITE_PROMPT = [
  " Create file",
  " notes.md",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " 1 test",
  "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌",
  " Do you want to create notes.md?",
  " ❯ 1. Yes",
  "   2. Yes, allow all edits during this session (shift+tab)",
  "   3. No",
  " Esc to cancel · Tab to amend",
].join("\n");

/** The bare shape described in the task prompt (no borders, stacked
 *  "requires approval" + "Do you want to proceed?" terminators). */
const BARE_PROMPT = [
  "Bash command",
  "  rtk curl -sI https://example.com/",
  "  Fetch example.com front page",
  " This command requires approval",
  " Do you want to proceed?",
  " ❯ 1. Yes",
].join("\n");

/** Verbatim shape of a Claude AskUserQuestion picker (200-col pane capture):
 *  a header chip, the question line, the numbered options with descriptions,
 *  the "Type something." / "Chat about this" tail, and the select footer. */
const QUESTION_PICKER = [
  " ☐ Fav color",
  "What's your favorite color?",
  "❯ 1. Blue",
  "     Calm, cool, and the most commonly picked favorite color.",
  "  2. Green",
  "     Fresh and natural.",
  "  5. Type something.",
  "──────────────",
  "  6. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

/** Same picker with a question that does NOT end in "?" (exercises the
 *  last-header-line fallback). */
const QUESTION_PICKER_NO_MARK = [
  " ☐ Pick one",
  "Choose the deployment target",
  "❯ 1. Staging",
  "  2. Production",
  "  3. Type something.",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

/** A prose numbered list in Claude's output sits in scrollback ABOVE the real
 *  picker (question + its own numbered options + footer). The extractor must
 *  anchor on the bottom picker, not the prose list. */
const QUESTION_PICKER_WITH_PROSE = [
  "Here are the options I considered:",
  "1. Add tests",
  "2. Refactor the parser",
  "What's your favorite color?",
  "❯ 1. Blue",
  "  2. Green",
  "  3. Type something.",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

describe("matchesQuestionPickerSignature", () => {
  it("matches the picker's Type something / Enter to select signature", () => {
    expect(matchesQuestionPickerSignature(QUESTION_PICKER)).toBe(true);
  });
  it("does not match a plain permission prompt", () => {
    expect(matchesQuestionPickerSignature(BORDERED_PROMPT)).toBe(false);
  });
});

describe("extractQuestionPrompt", () => {
  it("extracts the question line above the first option", () => {
    expect(extractQuestionPrompt(QUESTION_PICKER)).toBe(
      "What's your favorite color?",
    );
  });

  it("falls back to the last header line when no line ends in '?'", () => {
    expect(extractQuestionPrompt(QUESTION_PICKER_NO_MARK)).toBe(
      "Choose the deployment target",
    );
  });

  it("anchors on the real picker, not a prose numbered list above it", () => {
    expect(extractQuestionPrompt(QUESTION_PICKER_WITH_PROSE)).toBe(
      "What's your favorite color?",
    );
  });

  it("returns null when there is no numbered option list", () => {
    expect(
      extractQuestionPrompt("just some prose\nno options here"),
    ).toBeNull();
  });

  it("returns null when nothing but a header chip sits above the options", () => {
    expect(
      extractQuestionPrompt(" ☐ Fav color\n❯ 1. Blue\n  2. Green"),
    ).toBeNull();
  });
});

describe("extractPermissionPrompt", () => {
  it("pulls the command block from a bordered prompt (header split by blank)", () => {
    expect(extractPermissionPrompt(BORDERED_PROMPT)).toBe(
      "rtk curl -sI https://example.com/\nFetch example.com front page",
    );
  });

  it("handles the bare shape with stacked terminator lines", () => {
    // No blank line separates the "Bash command" header, so it rides along;
    // the two stacked chrome lines are excluded as boundaries.
    expect(extractPermissionPrompt(BARE_PROMPT)).toBe(
      "Bash command\nrtk curl -sI https://example.com/\nFetch example.com front page",
    );
  });

  it("keeps the Edit diff block across its ╌ dividers", () => {
    expect(extractPermissionPrompt(EDIT_PROMPT)).toBe(
      "Edit file\nsample.txt\n1 -goodbye world\n1 +hello world",
    );
  });

  it("keeps the Write block across its ╌ dividers", () => {
    expect(extractPermissionPrompt(WRITE_PROMPT)).toBe(
      "Create file\nnotes.md\n1 test",
    );
  });

  it("returns null when no permission prompt is present", () => {
    expect(
      extractPermissionPrompt("just some assistant output\nno prompt here"),
    ).toBeNull();
  });

  it("returns null for an unknown shape (terminator but no block)", () => {
    expect(
      extractPermissionPrompt("Do you want to proceed?\n1. Yes"),
    ).toBeNull();
  });

  it("anchors on the newest prompt when scrollback holds an older one", () => {
    // Two bordered prompt boxes in scrollback; the box borders collapse to
    // blank boundaries, so the newest box's command block is isolated.
    const box = (cmd: string) =>
      [
        "╭──────────────────────────────╮",
        "│ Bash command                  │",
        "│                               │",
        `│   ${cmd}`.padEnd(32) + "│",
        "│                               │",
        "│ Do you want to proceed?       │",
        "│ ❯ 1. Yes                      │",
        "╰──────────────────────────────╯",
      ].join("\n");
    const text = `${box("echo stale")}\nsome output\n${box("echo fresh")}`;
    expect(extractPermissionPrompt(text)).toBe("echo fresh");
  });

  it("strips control characters from the captured block", () => {
    const text = [
      "Bash command",
      "  echo \x07\x1b[31mhi\x1b[0m",
      " Do you want to proceed?",
    ].join("\n");
    const out = extractPermissionPrompt(text);
    expect(out).not.toBeNull();
    // Bell + CSI bytes gone; printable text survives.
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\x1b");
    expect(out).toContain("echo");
    expect(out).toContain("hi");
  });

  it("clamps a very long command with an ellipsis", () => {
    const long = "echo " + "y".repeat(400);
    const text = ["Bash command", `  ${long}`, " Do you want to proceed?"].join(
      "\n",
    );
    const out = extractPermissionPrompt(text);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(MAX + 2);
    expect(out!.endsWith("…")).toBe(true);
  });
});

describe("buildNotificationContext: permission (pane capture)", () => {
  it("renders the captured command block", async () => {
    const { session, capturePane } = permissionSession(BORDERED_PROMPT);
    expect(await buildNotificationContext(session, { capturePane })).toEqual({
      body: "rtk curl -sI https://example.com/\nFetch example.com front page",
    });
  });

  it("returns null body when the pane has no prompt (fail-open to base body)", async () => {
    const { session, capturePane } = permissionSession("idle pane, no prompt");
    expect(await buildNotificationContext(session, { capturePane })).toEqual({
      body: null,
    });
  });

  it("returns null body when the session has no pane", async () => {
    const { session, capturePane } = permissionSession(BORDERED_PROMPT, {
      tmuxPane: null,
    });
    expect(await buildNotificationContext(session, { capturePane })).toEqual({
      body: null,
    });
  });

  it("fails open to null body when the capture throws", async () => {
    const session: NotifyContextSession = {
      agentType: "claude",
      logPath: null,
      attentionType: "permission",
      pendingTool: "Bash",
      tmuxPane: "%42",
      lastPrompt: null,
    };
    const capturePane = async () => {
      throw new Error("tmux gone");
    };
    expect(await buildNotificationContext(session, { capturePane })).toEqual({
      body: null,
    });
  });

  it("reclassifies to a question when the pane shows the AskUserQuestion picker (no permission terminator)", async () => {
    const { session, capturePane } = permissionSession(QUESTION_PICKER);
    expect(await buildNotificationContext(session, { capturePane })).toEqual({
      body: "What's your favorite color?",
      reclassifyAs: "question",
    });
  });
});

describe("buildNotificationContext: question (pane-first)", () => {
  it("renders the pane picker even when the transcript tail holds stale prior-turn text", async () => {
    // Reality during an AskUserQuestion wait: the picker's tool_use is not
    // flushed, so the transcript's last assistant text is the PREVIOUS turn.
    // The body must come from the live pane, not that stale text.
    const path = await writeTranscript([
      assistantText("stale text from the previous turn"),
    ]);
    expect(
      await buildNotificationContext(
        {
          agentType: "claude",
          logPath: path,
          attentionType: "question",
          pendingTool: null,
          tmuxPane: "%42",
          lastPrompt: null,
        },
        { capturePane: async () => QUESTION_PICKER },
      ),
    ).toEqual({ body: "What's your favorite color?" });
  });

  it("falls back to the transcript tail for a plain-text question (no picker on the pane)", async () => {
    // A plain assistant-text question IS flushed, so with no picker on the
    // pane the transcript tail is the current source.
    const path = await writeTranscript([
      assistantText("first"),
      assistantText("which option do you prefer?"),
    ]);
    expect(
      await buildNotificationContext(
        {
          agentType: "claude",
          logPath: path,
          attentionType: "question",
          pendingTool: null,
          tmuxPane: "%42",
          lastPrompt: null,
        },
        { capturePane: async () => "idle pane, no picker" },
      ),
    ).toEqual({ body: "which option do you prefer?" });
  });

  it("falls back to the transcript tail when the pane capture throws", async () => {
    const path = await writeTranscript([
      assistantText("which option do you prefer?"),
    ]);
    expect(
      await buildNotificationContext(
        {
          agentType: "claude",
          logPath: path,
          attentionType: "question",
          pendingTool: null,
          tmuxPane: "%42",
          lastPrompt: null,
        },
        {
          capturePane: async () => {
            throw new Error("tmux gone");
          },
        },
      ),
    ).toEqual({ body: "which option do you prefer?" });
  });

  it("returns null body when the pane holds no picker and the transcript has no assistant text", async () => {
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "x" }),
    ]);
    expect(
      await buildNotificationContext(
        {
          agentType: "claude",
          logPath: path,
          attentionType: "question",
          pendingTool: null,
          tmuxPane: "%42",
          lastPrompt: null,
        },
        { capturePane: async () => "idle pane, no picker" },
      ),
    ).toEqual({ body: null });
  });

  it("returns null body when logPath is absent and no pane picker", async () => {
    expect(
      await buildNotificationContext(
        {
          agentType: "claude",
          logPath: null,
          attentionType: "question",
          pendingTool: null,
          tmuxPane: "%42",
          lastPrompt: null,
        },
        { capturePane: async () => "" },
      ),
    ).toEqual({ body: null });
  });
});

describe("buildNotificationContext: gating", () => {
  it("returns null body for a non-claude agent", async () => {
    const { capturePane } = permissionSession(BORDERED_PROMPT);
    expect(
      await buildNotificationContext(
        {
          agentType: "codex",
          logPath: null,
          attentionType: "permission",
          pendingTool: "Bash",
          tmuxPane: "%42",
          lastPrompt: null,
        },
        { capturePane },
      ),
    ).toEqual({ body: null });
  });

  it("returns null body for a plan_approval wait", async () => {
    const { capturePane } = permissionSession(BORDERED_PROMPT);
    expect(
      await buildNotificationContext(
        {
          agentType: "claude",
          logPath: null,
          attentionType: "plan_approval",
          pendingTool: "Bash",
          tmuxPane: "%42",
          lastPrompt: null,
        },
        { capturePane },
      ),
    ).toEqual({ body: null });
  });
});

describe("buildFinishedContext", () => {
  /** A finished Claude session backed by `logPath`, with an optional
   *  `lastPrompt` fallback. */
  function finishedSession(
    overrides: Partial<NotifyContextSession> = {},
  ): NotifyContextSession {
    return {
      agentType: "claude",
      logPath: null,
      attentionType: null,
      pendingTool: null,
      tmuxPane: null,
      lastPrompt: null,
      ...overrides,
    };
  }

  it("returns the last assistant text from the transcript tail (Claude)", async () => {
    const path = await writeTranscript([
      assistantText("earlier turn"),
      assistantText("All done. The tests pass."),
    ]);
    expect(await buildFinishedContext(finishedSession({ logPath: path }))).toBe(
      "All done. The tests pass.",
    );
  });

  it("falls through to lastPrompt when a user turn follows the last assistant text (stale tail)", async () => {
    // An interrupted/denied turn or a fresh prompt lands as a user text AFTER
    // the last assistant text; quoting that assistant text would be the
    // previous turn's answer, so the ladder falls through to lastPrompt.
    const path = await writeTranscript([
      assistantText("Old answer from the previous turn."),
      userText("[Request interrupted by user]"),
    ]);
    expect(
      await buildFinishedContext(
        finishedSession({ logPath: path, lastPrompt: "resume the refactor" }),
      ),
    ).toBe("resume the refactor");
  });

  it("returns null on a stale tail when there is no lastPrompt", async () => {
    const path = await writeTranscript([
      assistantText("Old answer."),
      userText("a fresh prompt"),
    ]);
    expect(
      await buildFinishedContext(finishedSession({ logPath: path })),
    ).toBeNull();
  });

  it("falls back to lastPrompt when the transcript has no assistant text", async () => {
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "x" }),
    ]);
    expect(
      await buildFinishedContext(
        finishedSession({ logPath: path, lastPrompt: "fix the flaky test" }),
      ),
    ).toBe("fix the flaky test");
  });

  it("falls back to lastPrompt for a non-Claude agent (no transcript read)", async () => {
    expect(
      await buildFinishedContext(
        finishedSession({ agentType: "codex", lastPrompt: "ship the release" }),
      ),
    ).toBe("ship the release");
  });

  it("returns null when there is neither assistant text nor a lastPrompt", async () => {
    expect(await buildFinishedContext(finishedSession())).toBeNull();
  });

  it("fails open to null when the transcript read throws (missing file)", async () => {
    // A logPath pointing at a nonexistent file: the read rejects, and with no
    // lastPrompt the ladder bottoms out at null rather than throwing.
    expect(
      await buildFinishedContext(
        finishedSession({ logPath: join(dir, "does-not-exist.jsonl") }),
      ),
    ).toBeNull();
  });

  it("falls through to lastPrompt when the transcript read throws (missing file)", async () => {
    // The transcript branch's own failure must NOT skip the lastPrompt step:
    // an unreadable logPath still yields the clamped lastPrompt.
    expect(
      await buildFinishedContext(
        finishedSession({
          logPath: join(dir, "does-not-exist.jsonl"),
          lastPrompt: "wire up the notifier",
        }),
      ),
    ).toBe("wire up the notifier");
  });

  it("clamps the finished body tighter than the waiting context (2 lines / 200 chars)", async () => {
    const fiveLines = ["one", "two", "three", "four", "five"].join("\n");
    const path = await writeTranscript([assistantText(fiveLines)]);
    const out = await buildFinishedContext(finishedSession({ logPath: path }));
    expect(out).not.toBeNull();
    // Only the first two lines survive, with a trailing ellipsis.
    expect(out).toBe("one\ntwo…");
  });

  it("clamps a long single-line closing to 200 chars", async () => {
    const long = "x".repeat(400);
    const path = await writeTranscript([assistantText(long)]);
    const out = await buildFinishedContext(finishedSession({ logPath: path }));
    expect(out).not.toBeNull();
    expect(out!.endsWith("…")).toBe(true);
    // 200 chars of content plus the single ellipsis.
    expect([...out!].length).toBeLessThanOrEqual(201);
  });
});
