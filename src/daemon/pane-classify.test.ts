import { describe, it, expect } from "bun:test";
import {
  classifyClaudePromptPane,
  classifyPaneContent,
  classifyPaneTitle,
  isNonAgentCommand,
} from "./pane-classify";

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

  it("should detect not_working from ✳ prefix", () => {
    expect(classifyPaneTitle("✳ Claude Code")).toBe("not_working");
    expect(classifyPaneTitle("✳")).toBe("not_working");
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
