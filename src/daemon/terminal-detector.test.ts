import { describe, expect, it } from "bun:test";
import { getBuiltinAgent } from "../lib/agents-test-helpers";
import { detectTerminalStatus, matchTerminalRule } from "./terminal-detector";

describe("terminal-detector", () => {
  const opencode = getBuiltinAgent("opencode");
  const codex = getBuiltinAgent("codex");
  const claude = getBuiltinAgent("claude");
  const gemini = getBuiltinAgent("gemini");
  const cursor = getBuiltinAgent("cursor");
  const antigravity = getBuiltinAgent("antigravity");
  const copilot = getBuiltinAgent("copilot");

  it("detects waiting/permission prompts for Codex", () => {
    const result = detectTerminalStatus(
      "Allow command?\nPress Enter to confirm or Esc to cancel",
      codex,
    );
    expect(result.status).toBe("waiting");
    expect(result.attentionType).toBe("permission");
    expect(result.pendingTool).toBe("Command");
  });

  it("detects busy state for Codex", () => {
    const result = detectTerminalStatus(
      "Codex is running... Esc to interrupt",
      codex,
    );
    expect(result.status).toBe("working");
    expect(result.attentionType).toBeNull();
  });

  it("uses first matching rule when multiple rules match", () => {
    const result = detectTerminalStatus("Allow once\nEsc interrupt", opencode);
    expect(result.status).toBe("waiting");
    expect(result.attentionType).toBe("permission");
    expect(result.pendingTool).toBe("Command");
  });

  it("strips ANSI before pattern matching", () => {
    const ansiPrompt = "\u001B[31mAllow command?\u001B[0m";
    const result = detectTerminalStatus(ansiPrompt, codex);
    expect(result.status).toBe("waiting");
  });

  it("detects Claude question menus as waiting", () => {
    const result = detectTerminalStatus(
      `What would you like to work on in FlashJump today?

❯ 1. Bug fix

Enter to select · ↑/↓ to navigate · Esc to cancel`,
      claude,
    );
    expect(result.status).toBe("waiting");
    expect(result.attentionType).toBe("question");
    expect(result.pendingTool).toBeNull();
  });

  it("detects Claude permission prompts from the real terminal wording", () => {
    const result = detectTerminalStatus(
      `Permission rule Bash(git push:*) requires confirmation for this command.
/permissions to update rules

Do you want to proceed?
❯ 1. Yes
  2. No

Esc to cancel · Tab to amend · ctrl+e to explain`,
      claude,
    );
    expect(result.status).toBe("waiting");
    expect(result.attentionType).toBe("permission");
    expect(result.pendingTool).toBeNull();
  });

  it("detects Claude permission prompts with 'requires approval' wording", () => {
    const result = detectTerminalStatus(
      `Bash command

   brew install codegrab
   Install codegrab via Homebrew

 This command requires approval

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for: brew install:*
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain`,
      claude,
    );
    expect(result.status).toBe("waiting");
    expect(result.attentionType).toBe("permission");
    expect(result.pendingTool).toBeNull();
  });

  it("detects Claude AskUserQuestion menus from the real terminal wording", () => {
    const result = detectTerminalStatus(
      `☐ Git push

It looks like the git push --dry-run was rejected at the permission prompt. Would you like me to try again?

❯ 1. Try again
    Attempt git push --dry-run again
  2. Skip
    Don't push, we're done
  3. Type something.
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`,
      claude,
    );
    expect(result.status).toBe("waiting");
    expect(result.attentionType).toBe("question");
    expect(result.pendingTool).toBeNull();
  });

  it("does not treat answered Claude questions in scrollback as waiting", () => {
    const result = detectTerminalStatus(
      `User answered Claude's questions:
  · What would you like to work on in FlashJump today? → Nothing, just say hi

Hi! Let me know whenever you'd like to dive into something with FlashJump.

❯ build and run the app`,
      claude,
    );
    expect(result.status).toBe("idle");
    expect(result.attentionType).toBeNull();
    expect(result.pendingTool).toBeNull();
  });

  it("supports matchAll rules for Claude menus", () => {
    const result = detectTerminalStatus(
      "What would you like to work on in FlashJump today?",
      claude,
    );
    expect(result.status).toBe("idle");
    expect(result.attentionType).toBeNull();
    expect(result.pendingTool).toBeNull();
  });

  it("returns idle when no patterns match", () => {
    const result = detectTerminalStatus("shell prompt ready", gemini);
    expect(result.status).toBe("idle");
    expect(result.attentionType).toBeNull();
    expect(result.pendingTool).toBeNull();
  });

  describe("matchTerminalRule", () => {
    it("returns null when no rule matches (no default-idle fallback)", () => {
      const result = matchTerminalRule("shell prompt ready", gemini);
      expect(result).toBeNull();
    });

    it("returns the matched rule's detection when a rule fires", () => {
      const result = matchTerminalRule(
        "Allow command?\nPress Enter to confirm or Esc to cancel",
        codex,
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe("waiting");
      expect(result!.attentionType).toBe("permission");
      expect(result!.pendingTool).toBe("Command");
    });
  });

  describe("cursor", () => {
    it("detects 'Run this command?' permission prompts", () => {
      const result = detectTerminalStatus(
        "Run this command?\nNot in allowlist: curl",
        cursor,
      );
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBe("Command");
    });

    it("detects 'Allow this web fetch?' permission prompts", () => {
      const result = detectTerminalStatus(
        "Allow this web fetch?\nFetch (y)",
        cursor,
      );
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBe("WebFetch");
    });

    it("ignores trailing empty lines so padded prompts still match", () => {
      // Cursor renders the web-fetch prompt with significant vertical
      // padding below it. Without the trim, the prompt text falls outside
      // the last-30-line inspection window. Pads 30 trailing empty lines
      // here to exercise the regression directly.
      const padded = `Allow this web fetch?\nFetch (y)${"\n".repeat(30)}`;
      const result = detectTerminalStatus(padded, cursor);
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
    });
  });

  describe("antigravity", () => {
    it("detects 'Requesting permission for:' prompts", () => {
      const result = detectTerminalStatus(
        `Requesting permission for:
  Command: rm -rf build/`,
        antigravity,
      );
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBe("Command");
    });

    it("detects 'Do you want to proceed?' prompts", () => {
      const result = detectTerminalStatus(
        `Command: rm -rf build/

Do you want to proceed?`,
        antigravity,
      );
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBe("Command");
    });

    it("detects the working footer", () => {
      const result = detectTerminalStatus(
        "Thinking about the next step...\nesc to cancel",
        antigravity,
      );
      expect(result.status).toBe("working");
      expect(result.attentionType).toBeNull();
    });

    it("does not treat the CSAT survey line as a permission prompt", () => {
      const result = matchTerminalRule(
        `Session complete.

How's the CLI experience so far?
1. Great  2. Okay  3. Poor`,
        antigravity,
      );
      expect(result).toBeNull();
    });
  });

  describe("copilot", () => {
    it("detects the run-command permission dialog", () => {
      const result = detectTerminalStatus(
        `Do you want to run this command?

  touch probe2.txt

❯ 1. Yes
  2. Yes, and don't ask again for \`touch\` in this directory
  3. No, and tell Copilot what to do differently (Esc to stop)`,
        copilot,
      );
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBe("Command");
    });

    it("detects the folder-trust dialog", () => {
      const result = detectTerminalStatus(
        `Do you trust the files in this folder?

  1. Yes
  2. Yes, and remember this folder for future sessions
  3. No (Esc)`,
        copilot,
      );
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBeNull();
    });

    it("detects the working footer", () => {
      const result = detectTerminalStatus(
        "● Working · 162 B  esc interrupt",
        copilot,
      );
      expect(result.status).toBe("working");
      expect(result.attentionType).toBeNull();
    });

    it("returns idle on the idle footer", () => {
      const result = matchTerminalRule(
        "/ commands · ? help · → next tab",
        copilot,
      );
      expect(result).toBeNull();
    });
  });
});
