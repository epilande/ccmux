import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNotificationContext,
  extractPermissionPrompt,
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
    expect(await buildNotificationContext(session, { capturePane })).toBe(
      "rtk curl -sI https://example.com/\nFetch example.com front page",
    );
  });

  it("returns null when the pane has no prompt (fail-open to base body)", async () => {
    const { session, capturePane } = permissionSession("idle pane, no prompt");
    expect(await buildNotificationContext(session, { capturePane })).toBeNull();
  });

  it("returns null when the session has no pane", async () => {
    const { session, capturePane } = permissionSession(BORDERED_PROMPT, {
      tmuxPane: null,
    });
    expect(await buildNotificationContext(session, { capturePane })).toBeNull();
  });

  it("fails open to null when the capture throws", async () => {
    const session: NotifyContextSession = {
      agentType: "claude",
      logPath: null,
      attentionType: "permission",
      pendingTool: "Bash",
      tmuxPane: "%42",
    };
    const capturePane = async () => {
      throw new Error("tmux gone");
    };
    expect(await buildNotificationContext(session, { capturePane })).toBeNull();
  });
});

describe("buildNotificationContext: question (transcript)", () => {
  it("renders the last assistant text", async () => {
    const path = await writeTranscript([
      assistantText("first"),
      assistantText("which option do you prefer?"),
    ]);
    expect(
      await buildNotificationContext({
        agentType: "claude",
        logPath: path,
        attentionType: "question",
        pendingTool: null,
        tmuxPane: "%42",
      }),
    ).toBe("which option do you prefer?");
  });

  it("returns null when there is no assistant text", async () => {
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "x" }),
    ]);
    expect(
      await buildNotificationContext({
        agentType: "claude",
        logPath: path,
        attentionType: "question",
        pendingTool: null,
        tmuxPane: "%42",
      }),
    ).toBeNull();
  });

  it("returns null when logPath is absent", async () => {
    expect(
      await buildNotificationContext({
        agentType: "claude",
        logPath: null,
        attentionType: "question",
        pendingTool: null,
        tmuxPane: "%42",
      }),
    ).toBeNull();
  });
});

describe("buildNotificationContext: gating", () => {
  it("returns null for a non-claude agent", async () => {
    const { capturePane } = permissionSession(BORDERED_PROMPT);
    expect(
      await buildNotificationContext(
        {
          agentType: "codex",
          logPath: null,
          attentionType: "permission",
          pendingTool: "Bash",
          tmuxPane: "%42",
        },
        { capturePane },
      ),
    ).toBeNull();
  });

  it("returns null for a plan_approval wait", async () => {
    const { capturePane } = permissionSession(BORDERED_PROMPT);
    expect(
      await buildNotificationContext(
        {
          agentType: "claude",
          logPath: null,
          attentionType: "plan_approval",
          pendingTool: "Bash",
          tmuxPane: "%42",
        },
        { capturePane },
      ),
    ).toBeNull();
  });
});
