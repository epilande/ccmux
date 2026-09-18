import { describe, it, expect, spyOn } from "bun:test";
import { CLAUDE_AGENT_DEF } from "../lib/agents";
import type { TmuxPane } from "../types/session";
import {
  classifyClaudePromptPane,
  classifyPaneContent,
  classifyPaneTitle,
  detectPaneState,
  isNonAgentCommand,
  isShellCommand,
  showsIdleClaudeComposer,
} from "./pane-classify";
import * as paneIo from "./pane-io";

describe("classifyPaneTitle", () => {
  it("should detect working from braille spinner chars", () => {
    expect(classifyPaneTitle("⠂ Claude Code")).toBe("working");
    expect(classifyPaneTitle("⠐ Claude Code")).toBe("working");
    expect(classifyPaneTitle("⠿ some title")).toBe("working");
  });

  it("should detect working at braille range boundaries", () => {
    expect(classifyPaneTitle("⠀")).toBe("working"); // U+2800 (lower bound)
    expect(classifyPaneTitle("⣿")).toBe("working"); // U+28FF (upper bound)
  });

  it("should not treat chars adjacent to braille range as working", () => {
    expect(classifyPaneTitle(String.fromCodePoint(0x27ff))).toBe("unknown");
    expect(classifyPaneTitle(String.fromCodePoint(0x2900))).toBe("unknown");
  });

  // Claude Code ≥2.1.236 writes a static ✳ title under tmux for the whole
  // turn (tengu_static_title_under_mux). Treating it as idle is what fired
  // false Finished notifications on JSONL gaps (issue #204).
  it("treats a static ✳ title as no information, not idle", () => {
    expect(classifyPaneTitle("✳ Claude Code")).toBe("unknown");
    expect(classifyPaneTitle("✳")).toBe("unknown");
    expect(classifyPaneTitle("✳ can continue")).toBe("unknown");
  });

  it("detects working from half-circle busy-spinner title glyphs", () => {
    // Claude Code 2.1.228 swapped Braille for these outside a multiplexer.
    expect(classifyPaneTitle("◐ Wire up the summary column")).toBe("working");
    expect(classifyPaneTitle("◑ Wire up the summary column")).toBe("working");
    expect(classifyPaneTitle("◓")).toBe("working");
    expect(classifyPaneTitle("◒")).toBe("working");
  });

  it("should return unknown for other titles", () => {
    expect(classifyPaneTitle("web-app")).toBe("unknown");
    expect(classifyPaneTitle("")).toBe("unknown");
    expect(classifyPaneTitle(null)).toBe("unknown");
  });
});

describe("isNonAgentCommand", () => {
  it("should detect shell commands as non-agent", () => {
    expect(isNonAgentCommand("zsh")).toBe(true);
    expect(isNonAgentCommand("bash")).toBe(true);
    expect(isNonAgentCommand("fish")).toBe(true);
    expect(isNonAgentCommand("sh")).toBe(true);
    expect(isNonAgentCommand("dash")).toBe(true);
    expect(isNonAgentCommand("-zsh")).toBe(true);
    expect(isNonAgentCommand("-bash")).toBe(true);
    expect(isNonAgentCommand("ksh")).toBe(true);
    expect(isNonAgentCommand("nu")).toBe(true);
    expect(isNonAgentCommand("pwsh")).toBe(true);
    expect(isNonAgentCommand("-fish")).toBe(true);
  });

  it("should detect editors as non-agent", () => {
    expect(isNonAgentCommand("nvim")).toBe(true);
    expect(isNonAgentCommand("vim")).toBe(true);
    expect(isNonAgentCommand("vi")).toBe(true);
  });

  it("should not detect other commands as non-agent", () => {
    expect(isNonAgentCommand("2.1.38")).toBe(false);
    expect(isNonAgentCommand("claude")).toBe(false);
    expect(isNonAgentCommand("node")).toBe(false);
    expect(isNonAgentCommand(null)).toBe(false);
  });
});

describe("classifyPaneContent", () => {
  it("should detect plan_approval when content contains plan path", () => {
    const content = `  Read /Users/test/.claude/plans/abc123.md
  Do you want to approve this plan?`;
    expect(classifyPaneContent(content)).toEqual({
      state: "plan_approval",
      attentionType: "plan_approval",
      pendingTool: null,
    });
  });

  it("should detect Claude question menus as waiting", () => {
    const content = `What would you like to work on in FlashJump today?
  1. Bug fix
Enter to select · ↑/↓ to navigate · Esc to cancel`;
    expect(classifyPaneContent(content)).toEqual({
      state: "waiting",
      attentionType: "question",
      pendingTool: null,
    });
  });

  it("should detect Claude permission prompts as waiting", () => {
    const content = `Permission rule Bash(git push:*) requires confirmation for this command.
/permissions to update rules

Do you want to proceed?
❯ 1. Yes
  2. No

Esc to cancel · Tab to amend · ctrl+e to explain`;
    expect(classifyPaneContent(content)).toEqual({
      state: "waiting",
      attentionType: "permission",
      pendingTool: null,
    });
  });

  it("should detect Claude AskUserQuestion menus as waiting", () => {
    const content = `☐ Git push

It looks like the git push --dry-run was rejected at the permission prompt. Would you like me to try again?

❯ 1. Try again
    Attempt git push --dry-run again
  2. Skip
    Don't push, we're done
  3. Type something.
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`;
    expect(classifyPaneContent(content)).toEqual({
      state: "waiting",
      attentionType: "question",
      pendingTool: null,
    });
  });

  it("should return active when content has no plan path", () => {
    const content = `  ● Allow Bash: bun run typecheck
  Yes  No`;
    expect(classifyPaneContent(content)).toEqual({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
  });

  it("should return active for working session output", () => {
    const content = `  Reading file src/daemon/index.ts
  Analyzing code patterns...`;
    expect(classifyPaneContent(content)).toEqual({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
  });

  it("should return active for empty content", () => {
    expect(classifyPaneContent("")).toEqual({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
  });

  // Issue #204: mid-turn JSONL silence plus a static ✳ title used to map
  // this pane to idle because classifyPaneContent had no working signal.
  it("detects working from a Claude spinner status line with elapsed time", () => {
    const content = [
      "⏺ I'll keep going.",
      "",
      "  Running tests…",
      "",
      "· Mustering… (9m 19s · ↓ 23.1k tokens)",
      "",
      "────────────────────────────────────────────",
      "❯ ",
    ].join("\n");
    expect(classifyPaneContent(content)).toEqual({
      state: "working",
      attentionType: null,
      pendingTool: null,
    });
  });

  it("detects working from each Claude spinner glyph plus a duration", () => {
    for (const glyph of ["·", "✢", "✳", "✶", "✻", "✽"]) {
      expect(classifyPaneContent(`${glyph} Thinking… (12s)`).state).toBe(
        "working",
      );
    }
  });

  it("still detects working when the duration wraps onto the next line", () => {
    expect(
      classifyPaneContent("✶ Whisking…\n(1m 3s · ↓ 4.2k tokens)").state,
    ).toBe("working");
  });

  it("does not treat a finished 'Baked for' line as still working", () => {
    expect(classifyPaneContent("✻ Baked for 28s").state).toBe("active");
  });

  it("lets a waiting prompt win over a leftover spinner line higher in the pane", () => {
    const content = [
      "· Mustering… (12s)",
      "Permission rule Bash(git push:*) requires confirmation for this command.",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "Esc to cancel · Tab to amend · ctrl+e to explain",
    ].join("\n");
    expect(classifyPaneContent(content).state).toBe("waiting");
  });

  // `·` is Claude's universal chrome separator, so a duration anywhere on a
  // line is not a working signal. Only a glyph at column 0 followed by a space
  // is the status line; assistant text and tool output are indented by two.
  it("ignores a duration on a line that is not the status line", () => {
    for (const line of [
      "  · build (2m 3s)",
      "  ⎿  Ran 12 tests · 3 files (4s)",
      "⏺ Ran the suite · 3 files (4s)",
    ]) {
      expect(classifyPaneContent(line).state).toBe("active");
    }
  });

  it("ignores near misses on the duration itself", () => {
    for (const line of [
      // The real 2.1.274 post-turn line: no parenthesized duration.
      "✻ Brewed for 53s · done 12:42 AM",
      // Fractional seconds are tool-output timings, not the status line.
      "✻ Thinking… (1.2s)",
      "· Ran in (0.4s)",
      // A parenthesized hint with no digits at all.
      "✻ Thinking… (esc to interrupt)",
    ]) {
      expect(classifyPaneContent(line).state).toBe("active");
    }
  });

  // Real Claude Code 2.1.274 panes under tmux (160x40), captured with
  // `tmux capture-pane -p | sed 's/[[:space:]]*$//' | grep -v '^$' | tail -10`:
  // blank lines are stripped and trailing whitespace removed, which is why the
  // composer box below reads as rule / ❯ / rule with nothing between, and why
  // the foreground-tool capture's harness header line is dropped. The
  // 160-column rules are written as `RULE` rather than pasted: their LENGTH
  // is the load-bearing part, since it keeps the statusline's own `(2h17m)`
  // more than 80 characters away from the post-turn glyph above it.
  const RULE = "─".repeat(160);

  const WORKING_2_1_274 = [
    "⏺ Sleeping for 45 seconds",
    "  ⎿  $ sleep 45",
    "✶ Noodling… (4s · ↓ 116 tokens · thinking with medium effort)",
    "                                                                                          Advisor Tool (experimental) is on and may use more tokens · /advisor",
    RULE,
    "❯",
    RULE,
    "  🌿 main* │ 🤖 Fable 5.1 │ 🧠 4% │ 🔄 37% (2h18m) │ 📅 22% │ 💰 $0.72 │ 📦 v2.1.274 │ 📝 +0/-0",
    "  💬 Run `sleep 45` with the Bash tool, wait for it to finish, then reply with the si...",
    "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  const FOREGROUND_TOOL_2_1_274 = [
    "⏺ Running the requested filesystem scan now.",
    "⏺ Searching whole filesystem for a nonexistent filename, then printing marker",
    "✳ Ruminating… (5s · ↓ 158 tokens)",
    "                                                                                          Advisor Tool (experimental) is on and may use more tokens · /advisor",
    RULE,
    "❯",
    RULE,
    "  🤖 Fable 5.1 │ 🧠 4% │ 🔄 49% (2h8m) │ 📅 23% │ 💰 $0.40 │ 📦 v2.1.274 │ 📝 +0/-0",
    "  💬 Run this exact command with the Bash tool in the foreground and wait for it: fin...",
    "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  const POST_TURN_2_1_274 = [
    "     [exited with code 0]",
    '⏺ Background command "Sleep for 45 seconds in the background" completed (exit code 0)',
    "⏺ done",
    "✻ Brewed for 53s · done 12:42 AM",
    RULE,
    "❯",
    RULE,
    "  🌿 main* │ 🤖 Fable 5.1 │ 🧠 4% │ 🔄 38% (2h17m) │ 📅 22% │ 💰 $0.82 │ 📦 v2.1.274 │ 📝 +0/-0",
    "  💬 Run `sleep 45` with the Bash tool, wait for it to finish, then reply with the si...",
    "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  it("classifies the live 2.1.274 working capture as working", () => {
    expect(classifyPaneContent(WORKING_2_1_274).state).toBe("working");
  });

  // The reporter's gap type: a long foreground tool call, where the JSONL goes
  // silent for the whole call while the title stays a static ✳.
  it("classifies the live 2.1.274 foreground-tool capture as working", () => {
    expect(classifyPaneContent(FOREGROUND_TOOL_2_1_274).state).toBe("working");
  });

  it("classifies the live 2.1.274 post-turn capture as active", () => {
    expect(classifyPaneContent(POST_TURN_2_1_274).state).toBe("active");
  });
});

function fakeClassifyPane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId: "%1",
    panePid: 1000,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 0,
    target: "ccmux:0.1",
    tty: "ttys001",
    startTime: null,
    windowActivity: null,
    paneTitle: "✳ can continue",
    currentCommand: "claude",
    currentPath: "/tmp/proj",
    ...overrides,
  };
}

describe("detectPaneState", () => {
  it("keeps a session working when the title is static ✳ and the pane still shows a spinner", async () => {
    const capture = spyOn(paneIo, "capturePane").mockResolvedValue(
      [
        "⏺ I'll keep going.",
        "· Mustering… (9m 19s · ↓ 23.1k tokens)",
        "❯ ",
      ].join("\n"),
    );
    try {
      const result = await detectPaneState("%1", fakeClassifyPane());
      expect(result.state).toBe("working");
    } finally {
      capture.mockRestore();
    }
  });
});

describe("classifyClaudePromptPane", () => {
  // Verbatim-shape ExitPlanMode picker (Claude Code 2.1.211): the "use auto
  // mode" option and the ~/.claude/plans/ footer both sit below the terminator.
  const PLAN_PICKER = [
    "  ──────────────────────────────────────────────",
    "   Claude has written up a plan and is ready to execute. Would you like to proceed?",
    "",
    "   ❯ 1. Yes, and use auto mode",
    "     2. Yes, manually approve edits",
    "     3. No, refine with Ultraplan on Claude Code on the web",
    "     4. Tell Claude what to change",
    "",
    "   ctrl+g to edit in  Nvim  · ~/.claude/plans/plan-lexical-twilight.md",
  ].join("\n");

  const BASH_PROMPT = [
    " This command requires approval",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again this session",
    "   3. No",
    " Esc to cancel · Tab to amend",
  ].join("\n");

  const EDIT_PROMPT = [
    " Edit file",
    " sample.txt",
    " Do you want to make this edit to sample.txt?",
    " ❯ 1. Yes",
    "   2. Yes, allow all edits during this session (shift+tab)",
    "   3. No",
    " Esc to cancel · Tab to amend",
  ].join("\n");

  it("classifies the ExitPlanMode picker as plan_approval", () => {
    expect(classifyClaudePromptPane(PLAN_PICKER)).toBe("plan_approval");
  });

  it("classifies a Bash approval prompt as permission", () => {
    expect(classifyClaudePromptPane(BASH_PROMPT)).toBe("permission");
  });

  it("classifies an Edit/Write diff prompt as permission", () => {
    expect(classifyClaudePromptPane(EDIT_PROMPT)).toBe("permission");
  });

  it("is bottom-anchored: a stale plan footer above a fresh Bash prompt is still permission", () => {
    const staleplanThenBash = [
      // stale plan picker higher in scrollback
      "   Would you like to proceed?",
      "   ❯ 1. Yes, and use auto mode",
      "     2. Yes, manually approve edits",
      "   ~/.claude/plans/plan-old.md",
      "",
      "  ⏺ Running the command now...",
      // fresh Bash permission prompt below
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
    ].join("\n");
    expect(classifyClaudePromptPane(staleplanThenBash)).toBe("permission");
  });

  it("returns null when a question picker renders below a lingering resolved terminator", () => {
    // A resolved permission prompt's terminator narrative lingers in scrollback
    // above a LIVE AskUserQuestion picker, whose numbered rows would otherwise
    // read as a permission prompt. The picker has no terminator of its own.
    const staleTermThenPicker = [
      " This command requires approval",
      " ❯ 1. Yes",
      "   2. No",
      "  ⏺ Ran it. Now a question:",
      " ☐ Fav color",
      "What's your favorite color?",
      "❯ 1. Blue",
      "  2. Green",
      "  3. Type something.",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(classifyClaudePromptPane(staleTermThenPicker)).toBeNull();
  });

  it("is inverse-safe: a stale picker above a fresh permission prompt is still permission", () => {
    // The opposite layout: stale picker chrome higher in scrollback, then a live
    // permission prompt below. Anchoring the picker check on the below-region
    // (not the whole capture) keeps this a legitimate permission classification.
    const stalePickerThenPermission = [
      " ☐ Fav color",
      "What's your favorite color?",
      "❯ 1. Blue",
      "  2. Type something.",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "  ⏺ Now a real permission prompt:",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, don't ask again this session",
      "   3. No",
    ].join("\n");
    expect(classifyClaudePromptPane(stalePickerThenPermission)).toBe(
      "permission",
    );
  });

  it("returns null when no active prompt terminator is present", () => {
    const idle = ["  ⏺ All done.", "", " ❯ "].join("\n");
    expect(classifyClaudePromptPane(idle)).toBeNull();
  });

  it("returns null for a terminator with no numbered options or plan markers", () => {
    // A stray terminator phrase in prose, with nothing picker-like below it.
    expect(
      classifyClaudePromptPane("do you want to proceed later?\nsome prose"),
    ).toBeNull();
  });
});

/**
 * The narrower sibling of `isNonAgentCommand`, used by the prune guard. The
 * two questions genuinely differ: "is an agent running here" (an editor says
 * no) versus "is anything running here at all" (an editor says yes — someone
 * is editing a file in a directory that is about to be deleted).
 */
describe("isShellCommand", () => {
  it("accepts every interactive shell, login form included", () => {
    for (const cmd of [
      "zsh",
      "bash",
      "fish",
      "sh",
      "dash",
      "ksh",
      "nu",
      "pwsh",
    ]) {
      expect(isShellCommand(cmd)).toBe(true);
      expect(isShellCommand(`-${cmd}`)).toBe(true);
    }
  });

  // The whole reason this is separate from isNonAgentCommand.
  it("rejects terminal editors, which isNonAgentCommand accepts", () => {
    for (const cmd of ["nvim", "vim", "vi"]) {
      expect(isShellCommand(cmd)).toBe(false);
      expect(isNonAgentCommand(cmd)).toBe(true);
    }
  });

  it("rejects agents and anything unknown", () => {
    expect(isShellCommand("claude")).toBe(false);
    expect(isShellCommand("node")).toBe(false);
    expect(isShellCommand(null)).toBe(false);
    expect(isShellCommand("")).toBe(false);
  });
});

/**
 * The evidence that retires a `waiting_permission` marker no hook will ever
 * update (issue #117). Fixtures are trimmed captures of a real Claude Code
 * 2.1.222 pane, taken before and after Escape on a live permission prompt.
 */
describe("showsIdleClaudeComposer", () => {
  /** Claude's own glyph pattern, which every real caller passes. */
  const idleComposer = (
    text: string,
    pattern: RegExp | undefined = CLAUDE_AGENT_DEF.readyPattern,
  ): boolean => showsIdleClaudeComposer(text, pattern);

  const COMPOSER = [
    "⏺ I'll run that command.",
    "",
    "  Ran 1 shell command",
    "",
    "✻ Baked for 28s",
    "",
    "────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────",
    "  🤖 Opus 5 │ 🧠 4% │ ⏱️ 0m48s │ 📦 v2.1.222",
    "  💬 run the bash command: touch probe.txt",
    "  -- INSERT -- ⏸ manual mode on · ← for agents",
    "",
    "",
  ].join("\n");

  const PERMISSION_PROMPT = [
    "⏺ I'll run that command.",
    "",
    "  Running 1 shell command…",
    "  ⎿  $ touch /tmp/probe.txt",
    "",
    "────────────────────────────────────────────",
    " Bash command",
    "",
    "   touch /tmp/probe.txt",
    "   Create empty probe file",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to tmp/ from this project",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain",
    "",
    "",
  ].join("\n");

  it("accepts an empty composer with only chrome under it", () => {
    expect(idleComposer(COMPOSER)).toBe(true);
  });

  // Finding 3: `classifyPaneContent` can now answer `working`, and a
  // spinner-shaped line under the composer is chrome, not a prompt. Treating
  // it as a live prompt would pin the row at `waiting` on a stale
  // `waiting_permission` marker no hook will ever retire.
  it("accepts a spinner-shaped status line below an empty composer", () => {
    expect(idleComposer("❯ \n· foo (45m)")).toBe(true);
  });

  // The same 2.1.222 fixture read by the content classifier: an idle composer
  // is `active`, not `working` — the post-turn "Baked for 28s" line carries
  // no parenthesized duration.
  it("reads as active content, not a working spinner", () => {
    expect(classifyPaneContent(COMPOSER).state).toBe("active");
  });

  // The regression that matters: a live prompt must keep its waiting row.
  it("refuses a live permission prompt", () => {
    expect(idleComposer(PERMISSION_PROMPT)).toBe(false);
  });

  // A permission prompt matches NONE of Claude's terminalRules (verified
  // live), so this is the case a rules-only test would get wrong.
  it("refuses a permission prompt rendered below an older composer frame", () => {
    expect(idleComposer(`${COMPOSER}\n${PERMISSION_PROMPT}`)).toBe(false);
  });

  it("refuses the AskUserQuestion picker below an older composer frame", () => {
    const picker = [
      "What's your favorite color?",
      "❯ 1. Blue",
      "  5. Type something.",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");
    expect(idleComposer(`${COMPOSER}\n${picker}`)).toBe(false);
  });

  it("refuses a plan picker below an older composer frame", () => {
    const plan = [
      "Would you like to proceed?",
      "❯ 1. Yes",
      "  2. No, keep planning",
      "Plan saved to /Users/x/.claude/plans/2026-08-05.md",
    ].join("\n");
    expect(idleComposer(`${COMPOSER}\n${plan}`)).toBe(false);
  });

  // Pins reading 1 (`classifyPaneContent`): Claude's startup/session picker
  // (`terminalRules` matchAll "what would you like to work on" + "enter to
  // select", src/lib/agents.ts:560) carries no numbered rows at all, so
  // reading 3's option-row check can't see it, and its wording is nowhere
  // near `PROMPT_TERMINATOR_RE`, so reading 2 can't either. Only the terminal
  // rule catches it.
  it("refuses the startup picker below an older composer frame", () => {
    const startupPicker = [
      " What would you like to work on?",
      "",
      " ❯ Continue the handoff work",
      "   Review the open PR",
      "",
      " Enter to select · Esc to exit",
    ].join("\n");
    expect(idleComposer(`${COMPOSER}\n${startupPicker}`)).toBe(false);
  });

  // Pins reading 1 (`classifyPaneContent`): a bare approval narrative
  // (`terminalRules` matchAny "requires approval", src/lib/agents.ts:549)
  // with no option block below it. Reading 3 finds no numbered row to match.
  // Reading 2 finds the terminator phrase itself ("requires approval" is one
  // of `PROMPT_TERMINATOR_RE`'s alternatives) but then finds no option row
  // beneath it, so `classifyClaudePromptPane` returns null rather than
  // refusing. Only the terminal rule catches this one.
  it("refuses a bare approval narrative with no options rendered yet", () => {
    const narrative = " This command requires approval before it can run.";
    expect(idleComposer(`${COMPOSER}\n${narrative}`)).toBe(false);
  });

  // Pins reading 2 (`classifyClaudePromptPane`): the option rows use `⎿`
  // chrome, which sits outside `OPTION_LINE_RE`'s anchored class, so reading
  // 3 can't see them, but they still satisfy the unanchored `OPTION_ROW_RE`
  // that `classifyClaudePromptPane` uses internally. No terminal rule matches
  // "Do you want to proceed?", so reading 1 stays "active". Only the
  // terminator-plus-options reading catches this one.
  it("refuses a permission prompt whose options use unanchored chrome", () => {
    const boxedOptions = [
      " Do you want to proceed?",
      " ⎿ 1. Yes",
      " ⎿ 2. No",
    ].join("\n");
    expect(idleComposer(`${COMPOSER}\n${boxedOptions}`)).toBe(false);
  });

  /**
   * The case both of the other readings miss, and the reason the option-row
   * check is a safety requirement. Verbatim capture of a live Claude Code
   * 2.1.222 permission prompt at 22 columns: "Do you want to proceed?" wraps
   * mid-phrase, and `capturePane` omits `-J`, so the terminator arrives split
   * across two lines and matches nothing. The permission prompt matches no
   * terminal rule either. Only the option rows survive, and they do so intact
   * because a wrapped option keeps its number on the first line.
   */
  const NARROW_WRAPPED_PROMPT = [
    "──────────────────────",
    " Bash command",
    "",
    "   touch a-file-wit",
    "   h-a-fairly-long-",
    "   name.txt",
    "   Create an empty",
    "   file",
    "",
    " Do you want to",
    " proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always",
    "      allow access to",
    "      h117b/ from this",
    "      project",
    "   3. No",
    "",
    " Esc to cancel · Tab",
    " to amend · ctrl+e to",
    " explain",
  ].join("\n");

  it("refuses a live prompt whose terminator wrapped off a narrow pane", () => {
    const narrowComposer = [
      "──────────────────────",
      "❯ ",
      "──────────────────────",
    ].join("\n");
    expect(idleComposer(`${narrowComposer}\n${NARROW_WRAPPED_PROMPT}`)).toBe(
      false,
    );
  });

  // Version drift needs no narrow pane: the terminator is a five-phrase
  // whitelist, so any wording Claude adds later lands here.
  it("refuses a prompt whose wording is not in the terminator whitelist", () => {
    const unlisted = [
      "Claude wants to run a command outside the workspace.",
      "Shall I go ahead with this?",
      " ❯ 1. Yes",
      "   2. No",
    ].join("\n");
    expect(idleComposer(`${COMPOSER}\n${unlisted}`)).toBe(false);
  });

  // Why the option-row pattern is ANCHORED. The line under an idle composer
  // is Claude's echo of the last prompt, and a numbered one would otherwise
  // read as a live picker for as long as that prompt is the last.
  it("is not fooled by a numbered list in the prompt echo below the composer", () => {
    const echoed = COMPOSER.replace(
      "  💬 run the bash command: touch probe.txt",
      "  💬 1. fix the parser 2. run the tests",
    );
    expect(echoed).toContain("💬 1. fix the parser");
    expect(idleComposer(echoed)).toBe(true);
  });

  // Scrollback ABOVE the live composer is history, and pinning the row on it
  // is exactly the lingering-text trap that keeps a spent wait alive.
  it("ignores residual prompt text above the composer", () => {
    const residual = [
      "This command requires approval",
      "Do you want to proceed?",
      "  1. Yes",
      "",
    ].join("\n");
    expect(idleComposer(`${residual}${COMPOSER}`)).toBe(true);
  });

  it("refuses a composer holding typed text", () => {
    const typed = COMPOSER.replace("❯ ", "❯ check the settings first");
    expect(idleComposer(typed)).toBe(false);
  });

  it("refuses a pane with no composer at all", () => {
    expect(idleComposer("⠂ Baking…\n  running a tool")).toBe(false);
  });

  it("refuses when the agent has no readyPattern to prove idleness with", () => {
    expect(showsIdleClaudeComposer(COMPOSER, undefined)).toBe(false);
  });

  it("honors a user-overridden prompt glyph", () => {
    const dollarPrompt = COMPOSER.replace("❯ ", "$ ");
    expect(idleComposer(dollarPrompt, /^\$\s*$/)).toBe(true);
    expect(idleComposer(dollarPrompt)).toBe(false);
  });

  it("looks past ANSI styling around the prompt glyph", () => {
    const styled = COMPOSER.replace("❯ ", "\x1b[36m❯\x1b[0m ");
    expect(idleComposer(styled)).toBe(true);
  });
});
