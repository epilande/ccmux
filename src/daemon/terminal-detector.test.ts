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
  const omp = getBuiltinAgent("omp");

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

  describe("codex-cli 0.146.0 pane text (issue #103)", () => {
    // Verbatim `tmux capture-pane -p` excerpts from a real Codex 0.146.0
    // pane (2026-08-03, sandbox CODEX_HOME, approval_policy=on-request,
    // sandbox_mode=workspace-write, no approvals reviewer, no hooks).
    const COMMAND_APPROVAL = `• Running git ls-remote https://github.com/epilande/ccmux.git HEAD


  Would you like to run the following command?

  Environment: local

  Reason: Do you want to allow this read-only GitHub request to retrieve the repository's HEAD revision?

  $ git ls-remote https://github.com/epilande/ccmux.git HEAD

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`git ls-remote\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

    const EDIT_APPROVAL = `• Added /tmp/scratch/outside-edit-test.txt (+1 -0)
    1 +hello


  Would you like to make the following edits?


› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

    const WORKING_FOOTER = `• Ran sleep 25

• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close`;

    it("classifies the command-approval widget as waiting/permission", () => {
      const result = detectTerminalStatus(COMMAND_APPROVAL, codex);
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBe("Command");
    });

    it("classifies the edit-approval widget as waiting/permission", () => {
      const result = detectTerminalStatus(EDIT_APPROVAL, codex);
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
    });

    it("classifies the modern working footer as working", () => {
      const result = detectTerminalStatus(WORKING_FOOTER, codex);
      expect(result.status).toBe("working");
      expect(result.attentionType).toBeNull();
    });

    it("still matches the approval heading alone (footer-free variants)", () => {
      // "Would you like to grant these permissions?" is the third heading in
      // the 0.146.0 binary; it did not render under the capture config, so
      // this asserts the heading carries the match on its own.
      const result = detectTerminalStatus(
        "  Would you like to grant these permissions?\n\n› 1. Yes, and allow these permissions for this session",
        codex,
      );
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
    });

    it("an idle composer is not a wait", () => {
      const result = detectTerminalStatus(
        `› Implement {feature}\n\n  gpt-5.6-sol default · /tmp/scratch`,
        codex,
      );
      expect(result.status).toBe("idle");
      expect(result.attentionType).toBeNull();
    });
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

    it("detects the URL-access permission dialog", () => {
      const result = detectTerminalStatus(
        `Copilot is attempting to access the following URL:

  https://example.com

Do you want to allow this access?

❯ 1. Yes
  2. Yes, and approve all URLs from "https://example.com" for the rest of the running session
  3. Yes, and approve all URLs from "https://example.com" permanently
  4. No, and tell Copilot what to do differently (Esc to stop)`,
        copilot,
      );
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBe("Url");
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

  describe("omp", () => {
    it("detects the working footer", () => {
      const result = detectTerminalStatus("Working…", omp);
      expect(result.status).toBe("working");
      expect(result.attentionType).toBeNull();
    });

    it("does not match ASCII 'Working...' (three dots)", () => {
      const result = matchTerminalRule("Working...", omp);
      expect(result).toBeNull();
    });

    it("detects the approval prompt as waiting/permission", () => {
      const result = detectTerminalStatus("Allow tool: bash", omp);
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBeNull();
    });

    it("matches the approval prompt case-insensitively", () => {
      const result = detectTerminalStatus("ALLOW TOOL: BASH", omp);
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBeNull();
    });

    it("prefers the waiting rule over working when both are present", () => {
      const result = detectTerminalStatus("Allow tool: bash\nWorking…", omp);
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.pendingTool).toBeNull();
    });
  });
});
