import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { MouseButtons } from "@opentui/core/testing";
import { createSignal } from "solid-js";
import { SessionItem, alignText } from "./SessionItem";
import { TickContext } from "../store";
import { mockEnrichedSession } from "./test-helpers";
import type { EnrichedSession } from "../../types";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderItem(
  props: {
    session?: EnrichedSession;
    selected?: boolean;
    index?: number;
    sidebar?: boolean;
    isActiveSession?: boolean;
    columns?: import("../../lib/preferences").ColumnsConfig;
    promptDisplay?: import("../../lib/preferences").PromptDisplay;
    highlights?: import("./SessionItem").SessionItemHighlights | null;
    transcriptSnippet?: string;
  },
  width = 100,
  height = 3,
) {
  const [tick] = createSignal(0);
  const session = props.session ?? mockEnrichedSession();
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <SessionItem
          session={session}
          selected={props.selected ?? false}
          index={props.index ?? 0}
          previewWidth={30}
          sidebar={props.sidebar}
          isActiveSession={props.isActiveSession}
          columns={props.columns}
          promptDisplay={props.promptDisplay}
          highlights={props.highlights}
          transcriptSnippet={props.transcriptSnippet}
        />
      </TickContext.Provider>
    ),
    { width, height },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("SessionItem", () => {
  it("renders session index 1 for first item", async () => {
    const frame = await renderItem({ index: 0 });
    expect(frame).toContain(" 1 ");
  });

  it("renders session index 5 for fifth item", async () => {
    const frame = await renderItem({ index: 4 });
    expect(frame).toContain(" 5 ");
  });

  it("renders no shortcut digit for index >= 9", async () => {
    // Index 9 = 10th session, no keyboard shortcut
    const frame0 = await renderItem({ index: 0 });
    const frame9 = await renderItem({ index: 9 });
    // First session has "1", tenth should not have "10"
    expect(frame0).toContain(" 1 ");
    expect(frame9).not.toContain(" 10 ");
  });

  it("renders project dirname", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ cwd: "/Users/test/Code/myapp" }),
    });
    expect(frame).toContain("myapp");
  });

  it("renders git branch", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ gitBranch: "main" }),
    });
    expect(frame).toContain(":main");
  });

  it("renders worktree indicator", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ gitBranch: "feat", isWorktree: true }),
    });
    expect(frame).toContain(":feat+");
  });

  it("does not render worktree indicator when not worktree", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ gitBranch: "feat", isWorktree: false }),
    });
    expect(frame).toContain(":feat");
    expect(frame).not.toContain(":feat+");
  });

  it("renders idle status", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ status: "idle" }),
    });
    expect(frame).toContain("● idle");
  });

  it("renders the invoke badge for a running subprocess invoke row", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        agentType: "codex",
        status: "working",
        tmuxPane: null,
        originInvocationId: "inv_run1",
        originInvocationStatus: "running",
      }),
    });
    // A running invoke renders the active "working" badge (matching a normal
    // working session by design). It is not a terminal outcome, so it shows no
    // ✓/✗; the succeeded/failed cases below assert the invoke-specific path.
    expect(frame).toContain("working");
    expect(frame).not.toContain("✓");
    expect(frame).not.toContain("✗");
  });

  it("renders the invoke badge for a succeeded invoke row", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        agentType: "codex",
        status: "idle",
        attentionState: "unread",
        tmuxPane: null,
        originInvocationId: "inv_ok1",
        originInvocationStatus: "succeeded",
      }),
    });
    expect(frame).toContain("✓");
    expect(frame).toContain("done");
  });

  it("renders the invoke badge for a failed invoke row", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        agentType: "codex",
        status: "idle",
        attentionState: "unread",
        tmuxPane: null,
        originInvocationId: "inv_bad1",
        originInvocationStatus: "failed",
      }),
    });
    expect(frame).toContain("✗");
    expect(frame).toContain("failed");
  });

  it("uses the normal status badge for a real session (no invoke status)", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ status: "working" }),
    });
    // Normal working badge, not the invoke spinner/labels
    expect(frame).toContain("working");
    expect(frame).not.toContain("✓");
    expect(frame).not.toContain("✗");
  });

  it("renders attention label for waiting permission", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        status: "waiting",
        attentionType: "permission",
      }),
    });
    expect(frame).toContain("Permission");
  });

  it("renders attention label for pending tool", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Edit",
      }),
    });
    expect(frame).toContain("Edit");
    // pendingTool takes priority over "Permission"
    expect(frame).not.toContain("Permission");
  });

  it("right-aligns attention label adjacent to agent column", async () => {
    const width = 160;
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          status: "waiting",
          attentionType: "permission",
          agentType: "claude",
        }),
      },
      width,
    );
    const line = frame.split("\n").find((l) => l.includes("Permission"));
    expect(line).toBeDefined();
    const permIdx = line!.indexOf("Permission");
    const claudeIdx = line!.indexOf("Claude");
    // Permission must sit in the right half (not pinned to project column)
    expect(permIdx).toBeGreaterThan(width / 2);
    // Permission must be immediately before the agent column (small gap)
    expect(claudeIdx).toBeGreaterThan(permIdx);
    expect(claudeIdx - (permIdx + "Permission".length)).toBeLessThan(5);
  });

  it("renders subagent count", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        status: "idle",
        subagents: [
          {
            agentId: "sub1",
            status: "working",
            attentionType: null,
            pendingTool: null,
            lastActivityAt: null,
          },
          {
            agentId: "sub2",
            status: "idle",
            attentionType: null,
            pendingTool: null,
            lastActivityAt: null,
          },
        ],
      }),
    });
    expect(frame).toContain("2 Agent");
  });

  it("ellipsizes an attention label longer than the cap", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash(git status --porcelain)",
        }),
      },
      160,
    );
    // Capped to 12 chars with an ellipsis; the full tool string never shows.
    expect(frame).toContain("…");
    expect(frame).not.toContain("Bash(git status --porcelain)");
  });

  it("ellipsizes a long path instead of clipping it mid-word", async () => {
    // At a narrow width the dirname no longer fits; it must show `…`, not a
    // silent hard clip like "claude-tool".
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          cwd: "/Users/epilande/Code/epilande/claude-toolkit",
          gitBranch: "main",
        }),
      },
      40,
    );
    expect(frame).toContain("…");
    expect(frame).toContain("claude-to");
    expect(frame).not.toContain("claude-toolkit");
  });

  it("shows agent column at wide width", async () => {
    const frame = await renderItem(
      { session: mockEnrichedSession({ agentType: "claude" }) },
      160,
    );
    expect(frame).toContain("Claude");
  });

  it("keeps sibling columns on the row when a search highlight overflows the project cell", async () => {
    // A search highlight renders untruncated, so the cell must flex-clip it
    // instead of shoving siblings off-row (see SessionItem's `highlightUnbounded`).
    const longPath = "/Users/epilande/Code/" + "a".repeat(180);
    const frame = await renderItem(
      {
        session: mockEnrichedSession({ agentType: "claude", cwd: longPath }),
        highlights: { project: longPath },
      },
      160,
    );
    // The agent column survives at the row's right edge.
    expect(frame).toContain("Claude");
  });

  it("hides agent column at narrow width", async () => {
    const frame = await renderItem(
      { session: mockEnrichedSession({ agentType: "claude" }) },
      60,
    );
    expect(frame).not.toContain("Claude");
  });

  it("calls onActivate when clicked", async () => {
    const [tick] = createSignal(0);
    let calls = 0;
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <SessionItem
            session={mockEnrichedSession()}
            selected={false}
            index={0}
            previewWidth={30}
            onActivate={() => {
              calls++;
            }}
          />
        </TickContext.Provider>
      ),
      { width: 100, height: 3 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(5, 0);
    expect(calls).toBe(1);
  });

  it("right-click fires onContextMenu, not onActivate", async () => {
    const [tick] = createSignal(0);
    let activateCalls = 0;
    let contextMenuCalls = 0;
    let lastX = -1;
    let lastY = -1;
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <SessionItem
            session={mockEnrichedSession()}
            selected={false}
            index={0}
            previewWidth={30}
            onActivate={() => {
              activateCalls++;
            }}
            onContextMenu={(event) => {
              contextMenuCalls++;
              lastX = event.x;
              lastY = event.y;
            }}
          />
        </TickContext.Provider>
      ),
      { width: 100, height: 3 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(7, 0, MouseButtons.RIGHT);

    expect(contextMenuCalls).toBe(1);
    expect(activateCalls).toBe(0);
    expect(lastX).toBe(7);
    expect(lastY).toBe(0);
  });

  it("left-click does not fire onContextMenu", async () => {
    const [tick] = createSignal(0);
    let activateCalls = 0;
    let contextMenuCalls = 0;
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <SessionItem
            session={mockEnrichedSession()}
            selected={false}
            index={0}
            previewWidth={30}
            onActivate={() => {
              activateCalls++;
            }}
            onContextMenu={() => {
              contextMenuCalls++;
            }}
          />
        </TickContext.Provider>
      ),
      { width: 100, height: 3 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(5, 0, MouseButtons.LEFT);

    expect(activateCalls).toBe(1);
    expect(contextMenuCalls).toBe(0);
  });
});

describe("SessionItem sidebar mode", () => {
  it("hides index in sidebar mode", async () => {
    const frame = await renderItem({ index: 0, sidebar: true }, 30);
    expect(frame).not.toContain(" 1 ");
  });

  it("shows project dirname in sidebar mode", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({ cwd: "/Users/test/Code/myapp" }),
        sidebar: true,
      },
      30,
    );
    expect(frame).toContain("myapp");
  });

  it("renders agent short code (not full name) in sidebar mode", async () => {
    const frame = await renderItem(
      { session: mockEnrichedSession({ agentType: "claude" }), sidebar: true },
      30,
    );
    expect(frame).toContain("cc");
    expect(frame).not.toContain("Claude");
  });

  it("renders prompt and time on row 2 in sidebar mode by default", async () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          lastPrompt: "fix the bug",
          lastActivityAt: oneMinuteAgo,
        }),
        sidebar: true,
      },
      30,
    );
    const lines = frame.split("\n");
    expect(lines[1]).toContain("fix the bug");
    expect(lines[1]).toContain("1m");
  });

  it("does not render the pane target in sidebar mode by default", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          tmuxTarget: "dev:1.0",
          lastPrompt: "fix the bug",
        }),
        sidebar: true,
      },
      30,
    );
    expect(frame).not.toContain("dev:1.0");
  });

  it("renders the short PR label on row 1 in sidebar mode", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          branchPRs: [{ id: "66", href: "https://github.com/x/y/pull/66" }],
        }),
        sidebar: true,
      },
      30,
    );
    const lines = frame.split("\n");
    expect(lines[0]).toContain("#66");
    expect(lines[0]).not.toContain("PR #66");
  });

  it("collapses sidebar row 2 when only time has data", async () => {
    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          lastPrompt: null,
          lastActivityAt: oneMinuteAgo,
        }),
        sidebar: true,
      },
      30,
    );
    const lines = frame.split("\n");
    expect(lines[1].trim()).toBe("");
  });

  it("collapses sidebar row 2 when prompt and time are both missing", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          lastPrompt: null,
          lastActivityAt: null,
          lastUserInputAt: null,
        }),
        sidebar: true,
      },
      30,
    );
    const lines = frame.split("\n");
    expect(lines[1].trim()).toBe("");
  });

  it("shows ! for attention instead of full label", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          status: "waiting",
          attentionType: "permission",
        }),
        sidebar: true,
      },
      30,
    );
    expect(frame).toContain("!");
    expect(frame).not.toContain("Permission");
  });

  it("right-aligns ! adjacent to agent short code in sidebar", async () => {
    const width = 30;
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          status: "waiting",
          attentionType: "permission",
          agentType: "claude",
        }),
        sidebar: true,
      },
      width,
    );
    const line = frame
      .split("\n")
      .find((l) => l.includes("!") && l.includes("cc"));
    expect(line).toBeDefined();
    const exclamIdx = line!.indexOf("!");
    const ccIdx = line!.indexOf("cc");
    // ! sits in the right half, immediately before the agent code
    expect(exclamIdx).toBeGreaterThan(width / 2);
    expect(ccIdx).toBeGreaterThan(exclamIdx);
    expect(ccIdx - (exclamIdx + 1)).toBeLessThan(5);
  });

  it("shows active indicator for active session", async () => {
    const frame = await renderItem(
      { sidebar: true, isActiveSession: true },
      30,
    );
    expect(frame).toContain("▎");
  });

  it("hides active indicator for inactive session", async () => {
    const frame = await renderItem(
      { sidebar: true, isActiveSession: false },
      30,
    );
    expect(frame).not.toContain("▎");
  });

  it("hides subagent count in sidebar mode", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          status: "idle",
          subagents: [
            {
              agentId: "sub1",
              status: "working",
              attentionType: null,
              pendingTool: null,
              lastActivityAt: null,
            },
          ],
        }),
        sidebar: true,
      },
      30,
    );
    expect(frame).not.toContain("Agent");
  });
});

describe("SessionItem row 2 (subtitle)", () => {
  it("renders lastPrompt on row 2 when present", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: "refactor this file" }),
      columns: { row2: { left: ["prompt"] } },
      promptDisplay: "row2",
    });
    expect(frame).toContain("refactor this file");
  });

  it("normalizes whitespace in prompt", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt: "multi\n  line\t  prompt",
      }),
      columns: { row2: { left: ["prompt"] } },
      promptDisplay: "row2",
    });
    expect(frame).toContain("multi line prompt");
    expect(frame).not.toContain("multi\n");
  });

  it("collapses to height 1 when row 2 has no content", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: null }),
    });
    const lines = frame.split("\n");
    expect(lines[0].trim()).not.toBe("");
    expect(lines[1].trim()).toBe("");
  });

  it("renders 2 lines when prompt present", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: "do the thing" }),
      columns: { row2: { left: ["prompt"] } },
      promptDisplay: "row2",
    });
    const lines = frame.split("\n");
    expect(lines[0].trim()).not.toBe("");
    expect(lines[1]).toContain("do the thing");
  });

  it("renders cwd subtitle when configured and present", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        cwd: "/Users/test/Code/deep/nested",
        paneCwd: "/Users/test/Code/deep/nested",
      }),
      columns: { row2: { left: ["cwd"] } },
      promptDisplay: "row2",
    });
    expect(frame).toContain("nested");
  });

  it("renders branch subtitle when configured and present", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ gitBranch: "feature/xyz" }),
      columns: { row2: { left: ["branch"] } },
      promptDisplay: "row2",
    });
    expect(frame).toContain("feature/xyz");
  });

  it("collapses row 2 when configured subtitle has no data", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ gitBranch: null }),
      columns: { row2: { left: ["branch"] } },
      promptDisplay: "row2",
    });
    const lines = frame.split("\n");
    expect(lines[1].trim()).toBe("");
  });

  it("renders split subtitle with right-side field", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt: "hi",
        tmuxTarget: "dev:1.0",
      }),
      columns: { row2: { left: ["prompt"], right: ["pane"] } },
      promptDisplay: "row2",
    });
    expect(frame).toContain("hi");
    expect(frame).toContain("dev:1.0");
  });

  it("renders lastPrompt inline on row 1 with the default layout", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: "fix the daemon race" }),
    });
    const lines = frame.split("\n");
    // Default is inline: the prompt rides row 1 and row 2 stays collapsed.
    expect(lines[0]).toContain("fix the daemon race");
    expect(lines[1].trim()).toBe("");
  });

  it("reduces slash-command markup to the command line", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt:
          "<command-name>/code-review</command-name> <command-message>code-review</command-message> <command-args>--fix</command-args>",
      }),
    });
    expect(frame).toContain("/code-review --fix");
    expect(frame).not.toContain("<command-name>");
  });

  it("unwraps local-command stdout markup", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt: "<local-command-stdout>Cancelled</local-command-stdout>",
      }),
    });
    expect(frame).toContain("Cancelled");
    expect(frame).not.toContain("<local-command-stdout>");
  });

  it("renders the matched older prompt line when only prompts highlights match", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt: "the newest message",
        prompts: ["please refactor the parser", "the newest message"],
      }),
      highlights: {
        lastPrompt: null,
        // A single highlighted prompt line (substring match, one <b> span).
        prompts: "please <b>refactor the parser</b>",
      },
    });
    // The older matched prompt surfaces (markup stripped), not the newest.
    expect(frame).toContain("please refactor the parser");
    expect(frame).not.toContain("the newest message");
    expect(frame).not.toContain("<b>");
  });

  it("renders the transcript snippet when a transcript-only match has no prompt highlight", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt: "the newest message",
      }),
      // No lastPrompt and no prompts highlight: the transcript snippet is the
      // only signal for why the row matched, so it renders in the prompt cell.
      highlights: { lastPrompt: null },
      // Distinctive head token: the cell truncates to its budget, so assert on
      // the leading text that survives the clip rather than the whole snippet.
      transcriptSnippet: "ZZHIT from the assistant transcript",
    });
    expect(frame).toContain("ZZHIT");
    expect(frame).not.toContain("the newest message");
  });

  it("prefers a prompt highlight over the transcript snippet when both are present", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt: "the newest message",
        prompts: ["please refactor the parser", "the newest message"],
      }),
      highlights: {
        lastPrompt: null,
        prompts: "please <b>refactor the parser</b>",
      },
      transcriptSnippet: "unrelated transcript snippet",
    });
    // The prompt-match line wins the ladder; the transcript snippet stays hidden.
    expect(frame).toContain("please refactor the parser");
    expect(frame).not.toContain("unrelated transcript snippet");
  });

  it("windows a highlight whose match sits beyond the prompt budget (leading ellipsis)", async () => {
    // The match is deep past any row budget at width 100; the head must clip
    // to a leading "…" so the row stays a single line instead of wrapping.
    const lead = "EARLYMARKER " + "x".repeat(300);
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          lastPrompt: `${lead} NEEDLE tail`,
        }),
        highlights: {
          lastPrompt: `${lead} <b>NEEDLE</b> tail`,
        },
        columns: { row2: { left: ["prompt"] } },
        promptDisplay: "row2",
      },
      100,
    );
    expect(frame).toContain("NEEDLE"); // the bold match is kept and visible
    expect(frame).toContain("…"); // head clipped with a leading ellipsis
    expect(frame).not.toContain("EARLYMARKER"); // far pre-context dropped
  });
});

describe("SessionItem prompt mode (inline)", () => {
  it("renders the prompt inline on row 1 by default and stays one line", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: "wire up the inline prompt" }),
    });
    const lines = frame.split("\n");
    expect(lines[0]).toContain("wire up the inline prompt");
    expect(lines[1].trim()).toBe("");
  });

  it("keeps the prompt on its own row in the sidebar (no room to inline)", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({ lastPrompt: "narrow rail prompt" }),
        sidebar: true,
        promptDisplay: "inline",
      },
      30,
    );
    const lines = frame.split("\n");
    // The 30-col rail can't fit an inline prompt, so inline falls back to row 2.
    expect(lines[0]).not.toContain("narrow rail prompt");
    expect(lines[1]).toContain("narrow rail prompt");
  });

  it("places the pr alongside the inline prompt on row 1", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt: "short one",
        branchPRs: [{ id: "25", href: "https://github.com/x/y/pull/25" }],
      }),
    });
    const lines = frame.split("\n");
    expect(lines[0]).toContain("short one");
    expect(lines[0]).toContain("#25");
    expect(lines[1].trim()).toBe("");
  });
});

describe("SessionItem prompt mode (off + inline truncation)", () => {
  it("hides the prompt and collapses to one line when mode is off", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: "fix the daemon race" }),
      promptDisplay: "off",
    });
    const lines = frame.split("\n");
    expect(frame).not.toContain("fix the daemon race");
    expect(lines[1].trim()).toBe("");
  });

  it("hides the whole detail row, pr included, when mode is off", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt: "ship the feature",
        backgroundChildren: [
          { kind: "pr", id: "42", href: "https://github.com/x/y/pull/42" },
        ],
      }),
      promptDisplay: "off",
    });
    const lines = frame.split("\n");
    expect(frame).not.toContain("#42");
    expect(frame).not.toContain("ship the feature");
    expect(lines[1].trim()).toBe("");
  });

  it("renders branch-derived PRs for pane sessions", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        branchPRs: [{ id: "25", href: "https://github.com/x/y/pull/25" }],
      }),
    });
    expect(frame).toContain("#25");
  });

  it("truncates a long inline prompt instead of pushing the pr off", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        lastPrompt:
          "an extremely long prompt that would overflow the entire row width and then some, ".repeat(
            3,
          ),
        branchPRs: [{ id: "25", href: "https://github.com/x/y/pull/25" }],
      }),
    });
    const lines = frame.split("\n");
    // Inline default: pr sits next to the branch, then the prompt fills the
    // rest of the row and truncates rather than shoving the pr off.
    expect(lines[0]).toContain("an extremely long");
    expect(lines[0]).toContain("#25");
    expect(lines[0].indexOf("#25")).toBeLessThan(
      lines[0].indexOf("an extremely long"),
    );
    expect(lines[1].trim()).toBe("");
  });

  it("prefers background children over branch-derived PRs", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({
        backgroundChildren: [
          { kind: "pr", id: "42", href: "https://github.com/x/y/pull/42" },
        ],
        branchPRs: [{ id: "25", href: "https://github.com/x/y/pull/25" }],
      }),
    });
    expect(frame).toContain("#42");
    expect(frame).not.toContain("#25");
  });

  it("hides a prompt placed on row 1 by a user override", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: "row one prompt" }),
      columns: { row1: { left: ["index", "status", "project", "prompt"] } },
      promptDisplay: "off",
    });
    expect(frame).not.toContain("row one prompt");
  });
});

describe("SessionItem active indicator", () => {
  it("renders active indicator on row 1 when session is active", async () => {
    const frame = await renderItem({ isActiveSession: true });
    expect(frame).toContain("▎");
  });

  it("does not render active indicator when session is inactive", async () => {
    const frame = await renderItem({ isActiveSession: false });
    expect(frame).not.toContain("▎");
  });

  it("extends active indicator to row 2 when subtitle is present", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: "active prompt" }),
      isActiveSession: true,
      columns: { row2: { left: ["prompt"] } },
      promptDisplay: "row2",
    });
    const lines = frame.split("\n");
    expect(lines[0]).toContain("▎");
    expect(lines[1]).toContain("▎");
  });

  it("does not extend active indicator when row 2 is collapsed", async () => {
    const frame = await renderItem({
      session: mockEnrichedSession({ lastPrompt: null }),
      isActiveSession: true,
    });
    const lines = frame.split("\n");
    expect(lines[0]).toContain("▎");
    expect(lines[1]).not.toContain("▎");
  });
});

describe("alignText", () => {
  it("passes through for left side", () => {
    expect(alignText("hi", 10, "left")).toBe("hi");
  });

  it("pads left with spaces for right side", () => {
    expect(alignText("hi", 5, "right")).toBe("   hi");
  });

  it("passes through when text is exactly width", () => {
    expect(alignText("hello", 5, "right")).toBe("hello");
  });

  it("passes through when text exceeds width", () => {
    expect(alignText("too long", 5, "right")).toBe("too long");
  });

  it("handles empty string", () => {
    expect(alignText("", 3, "right")).toBe("   ");
    expect(alignText("", 3, "left")).toBe("");
  });
});

describe("SessionItem right-aligned fields", () => {
  it("right-aligns pane and time on row 1 right side at wide width", async () => {
    const frame = await renderItem(
      {
        session: mockEnrichedSession({
          tmuxTarget: "dev:1.0",
          lastActivityAt: "2024-01-15T11:59:00Z",
        }),
      },
      160,
    );
    expect(frame).toContain("     dev:1.0");
  });
});
