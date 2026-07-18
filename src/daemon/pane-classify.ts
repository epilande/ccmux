import type { AttentionType, TmuxPane } from "../types/session";
import { CLAUDE_AGENT_DEF } from "../lib/agents";
import { detectTerminalStatus } from "./terminal-detector";
import { capturePane } from "./pane-io";

type PaneState = "plan_approval" | "working" | "waiting" | "idle" | "active";

export interface PaneDetectionResult {
  state: PaneState;
  attentionType: AttentionType;
  pendingTool: string | null;
}

function paneDetectionResult(
  state: PaneState,
  attentionType: AttentionType = null,
  pendingTool: string | null = null,
): PaneDetectionResult {
  return { state, attentionType, pendingTool };
}

/**
 * Classify pane title using universal agent status signals.
 *
 * - Braille spinner (U+2800-U+28FF) as first char → "working"
 * - ✳ (U+2733) as first char → "not_working"
 * - Otherwise → "unknown"
 */
export function classifyPaneTitle(
  title: string | null,
): "working" | "not_working" | "unknown" {
  if (!title || title.length === 0) return "unknown";
  const cp = title.codePointAt(0)!;
  if (cp >= 0x2800 && cp <= 0x28ff) return "working";
  if (cp === 0x2733) return "not_working";
  return "unknown";
}

/**
 * Foreground commands meaning no agent runs at the pane: a bare shell (a typed
 * Reply would EXECUTE as a command) or a terminal editor (keystrokes land as
 * normal-mode commands). Single owner for both idle-detection and the
 * notification-action liveness guard, so they can't drift. Bare names only; a
 * login shell's dash ("-zsh") is stripped before lookup.
 */
const NON_AGENT_COMMANDS = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "ksh",
  "nu",
  "pwsh",
  "nvim",
  "vim",
  "vi",
]);

/** True when the pane's foreground command is a shell or terminal editor, not a
 *  running agent. Strips a leading dash (login-shell "-zsh") before lookup. */
export function isNonAgentCommand(command: string | null): boolean {
  if (!command) return false;
  return NON_AGENT_COMMANDS.has(command.replace(/^-/, ""));
}

/**
 * Lines terminating a Claude prompt's command/option block (the plan picker's
 * "Would you like to proceed?" included). Single owner, shared by the
 * permission-context extractor (`notify-context.ts`) and
 * `classifyClaudePromptPane`, so the two can't drift.
 */
export const PROMPT_TERMINATOR_RE =
  /(requires approval|do you want to proceed|would you like to proceed|do you want to make this edit|do you want to create)/i;

/** A numbered option row ("1.", "2.", ...) after optional box/caret chrome. */
const OPTION_ROW_RE = /(^|\s)\d+\.\s/;

/**
 * True when a captured pane looks like Claude's AskUserQuestion picker: a
 * "Type something." choice plus an "Enter to select" footer. Mirrors the
 * `terminalRules` question anchors in `src/lib/agents.ts`. Used delivery-time to
 * disambiguate the shared `permission_prompt` marker (docs/agent-adapters.md),
 * and by `classifyClaudePromptPane` to fail closed when a picker sits below a
 * lingering terminator.
 */
export function matchesQuestionPickerSignature(paneText: string): boolean {
  const lower = paneText.toLowerCase();
  return lower.includes("type something.") && lower.includes("enter to select");
}

/**
 * Classify the CURRENT Claude prompt at the pane's bottom as a plan-approval
 * picker or a plain permission prompt, or null when no active prompt is present.
 * BOTTOM-ANCHORED on the LAST terminator, so a stale plan footer higher in
 * scrollback can't misclassify a fresh prompt below it (the both-directions
 * failure the stored `pendingTool` suffers). Pure, used by BOTH the press-time
 * handler guard (`handleNotificationAction`) and the notifier offer
 * (`buildNotificationContext`), so the offer and the enforcement can't disagree.
 *
 * A question picker (AskUserQuestion) renders no terminator of its own, so below
 * a lingering terminator its option rows would read as a permission prompt; the
 * below-region is checked against the picker signature first, returning null so
 * approve/deny fail closed.
 */
export function classifyClaudePromptPane(
  paneText: string,
): "plan_approval" | "permission" | null {
  const lines = paneText.split("\n");
  let termIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_TERMINATOR_RE.test(lines[i])) {
      termIdx = i;
      break;
    }
  }
  if (termIdx < 0) return null;

  const below = lines.slice(termIdx + 1);
  // Option rows below a lingering terminator belong to the picker (which has no
  // terminator of its own), not this prompt. null fails approve/deny closed; the
  // notifier's `answer` falls back to the stored type. Below-region only:
  // matching the WHOLE capture would regress the inverse layout (a stale picker
  // ABOVE a live permission prompt).
  if (matchesQuestionPickerSignature(below.join("\n"))) return null;
  const belowText = below.join("\n").toLowerCase();
  // The plan picker is the only prompt offering an "auto mode" option and the
  // only one whose footer shows the `/.claude/plans/` path.
  if (
    belowText.includes("use auto mode") ||
    belowText.includes("/.claude/plans/")
  ) {
    return "plan_approval";
  }
  // A permission prompt shows its numbered Yes/No options below the terminator.
  if (below.some((line) => OPTION_ROW_RE.test(line))) return "permission";
  return null;
}

/**
 * Classify pane content into a PaneState based on visible patterns.
 */
export function classifyPaneContent(content: string): PaneDetectionResult {
  if (content.includes("/.claude/plans/")) {
    return paneDetectionResult("plan_approval", "plan_approval");
  }

  const detected = detectTerminalStatus(content, CLAUDE_AGENT_DEF);
  if (detected.status === "waiting") {
    return paneDetectionResult(
      "waiting",
      detected.attentionType,
      detected.pendingTool,
    );
  }

  return paneDetectionResult("active");
}

/**
 * Detect pane state using tiered signals:
 *
 * 1. Shell/editor foreground command → idle (Claude not running)
 * 2. Braille spinner in pane title → working
 * 3. ✳ in pane title → idle unless content shows waiting/plan approval
 * 4. Unknown title or no pane data → fall back to content capture
 */
export async function detectPaneState(
  paneId: string,
  pane?: TmuxPane,
): Promise<PaneDetectionResult> {
  if (pane) {
    if (isNonAgentCommand(pane.currentCommand)) {
      return paneDetectionResult("idle");
    }

    const titleState = classifyPaneTitle(pane.paneTitle);
    if (titleState === "working") {
      return paneDetectionResult("working");
    }

    if (titleState === "not_working") {
      const detection = classifyPaneContent(await capturePane(paneId, 20));
      return detection.state === "active"
        ? paneDetectionResult("idle")
        : detection;
    }
  }

  return classifyPaneContent(await capturePane(paneId, 20));
}
