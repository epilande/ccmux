import type { AttentionType, TmuxPane } from "../types/session";
import { CLAUDE_AGENT_DEF } from "../lib/agents";
import { detectTerminalStatus } from "./terminal-detector";
import { capturePane } from "./pane-io";
import { stripAnsi } from "../lib/strip-ansi";

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
 * Interactive shells. Split out of {@link NON_AGENT_COMMANDS} because two
 * callers need different questions answered: "is an agent running here"
 * (shells AND editors say no) versus "is anything running here at all" (an
 * editor says YES — someone is editing a file in this directory, which is
 * exactly the live work the prune guard refuses to delete under).
 */
const SHELL_COMMANDS = [
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "ksh",
  "nu",
  "pwsh",
];

/**
 * Foreground commands meaning no agent runs at the pane: a bare shell (a typed
 * Reply would EXECUTE as a command) or a terminal editor (keystrokes land as
 * normal-mode commands). Single owner for both idle-detection and the
 * notification-action liveness guard, so they can't drift. Bare names only; a
 * login shell's dash ("-zsh") is stripped before lookup.
 */
const NON_AGENT_COMMANDS = new Set([...SHELL_COMMANDS, "nvim", "vim", "vi"]);

/** Bare command name, with a login shell's leading dash ("-zsh") stripped. */
function bareCommand(command: string): string {
  return command.replace(/^-/, "");
}

/** True when the pane's foreground command is a shell or terminal editor, not a
 *  running agent. Strips a leading dash (login-shell "-zsh") before lookup. */
export function isNonAgentCommand(command: string | null): boolean {
  if (!command) return false;
  return NON_AGENT_COMMANDS.has(bareCommand(command));
}

/**
 * True when the pane is sitting at a bare interactive shell — nothing running
 * but the prompt itself. Deliberately NARROWER than
 * {@link isNonAgentCommand}: an editor is not an agent, but it is somebody
 * working.
 */
export function isShellCommand(command: string | null): boolean {
  if (!command) return false;
  return SHELL_COMMANDS.includes(bareCommand(command));
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
 * The same option row, but ANCHORED at the start of its line. Used where a
 * match must survive being the ONLY evidence a prompt is live
 * ({@link showsIdleClaudeComposer}), which the unanchored form is too loose
 * for: it also matches a number mid-sentence, and the line directly under an
 * idle composer is Claude's echo of the last prompt ("💬 1. fix the parser"),
 * which would then read as a live picker forever.
 *
 * A wrapped option keeps its number on the FIRST line and indents its
 * continuation without one (verified live at 22 columns on Claude Code
 * 2.1.222), so anchoring costs nothing at any pane width.
 */
const OPTION_LINE_RE = /^[\s│┃|>❯▶»]*\d{1,2}\.\s/;

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
 * True when a captured Claude pane positively shows an EMPTY, LIVE composer:
 * a line that is nothing but the prompt glyph, with no prompt of any kind
 * rendered BELOW it.
 *
 * What that proves is NO PROMPT IS UP, which is not the same as "the agent is
 * idle": Claude keeps the composer on screen while it works (verified live on
 * 2.1.222), so a caller that needs idle-versus-working must get that from the
 * log and use this only to retire a wait.
 *
 * This is the only evidence that can retire a `waiting_permission` marker no
 * hook will ever update (Escape fires none), so it is deliberately POSITIVE.
 * "No permission pattern matched" would not do: Claude's own permission prompt
 * matches none of its `terminalRules`. It renders "Do you want to proceed?"
 * plus numbered options and nothing else (verified live on Claude Code
 * 2.1.222), so a rules-only test reads a live prompt as an idle pane.
 *
 * BELOW the LAST composer line, not over the whole capture, for symmetric
 * reasons. A dismissed prompt is ERASED from the pane while the composer's own
 * earlier frames stay in scrollback, so residual prompt text above the live
 * composer is history (the same lingering-text trap the ambiguous-permission
 * correction documents) and anything prompt-shaped below it outlived the
 * composer and is live.
 *
 * A composer holding typed text does not match the glyph-only pattern, so a
 * half-written reply keeps the session `waiting`. That is the correct failure
 * direction throughout: staying `waiting` too long is a slow row, while
 * clearing a live prompt's attention indicator loses the prompt and leaves a
 * queued handoff to be typed into it, where the default option is usually Yes.
 *
 * `readyPattern` is the caller's, not a default, so an agent config that
 * carries none says so and gets no downgrade rather than being measured
 * against a glyph it never renders.
 */
export function showsIdleClaudeComposer(
  paneText: string,
  readyPattern: RegExp | undefined,
): boolean {
  if (!readyPattern) return false;
  const lines = stripAnsi(paneText).replace(/\n+$/, "").split("\n");
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    // Reset for /g-flagged user overrides; `.test()` is stateful.
    readyPattern.lastIndex = 0;
    if (readyPattern.test(lines[i])) {
      promptIdx = i;
      break;
    }
  }
  if (promptIdx < 0) return false;

  const belowLines = lines.slice(promptIdx + 1);
  const below = belowLines.join("\n");
  // Three independent readings of "a prompt is live below the composer", none
  // of which covers the others.
  //
  // The terminal rules catch the pickers, whose widget strings no other prompt
  // carries.
  if (classifyPaneContent(below).state !== "active") return false;
  // The terminator plus its option block catches the permission and plan
  // prompts, which match no rule at all.
  if (classifyClaudePromptPane(below) !== null) return false;
  // And an option row on its own catches what BOTH of those miss, which is the
  // case that makes this check a safety requirement rather than a belt: the
  // terminator is matched per LINE against a five-phrase whitelist, and
  // `capturePane` deliberately omits `-J`, so a pane narrow enough to wrap "Do
  // you want to proceed?" mid-phrase (verified live at 22 columns) hides a
  // fully live prompt from every check above, as would any future prompt
  // wording Claude adds. Option rows are short, so they survive wrapping at
  // any plausible width, and every interactive Claude prompt has them. A false
  // match here only holds the row at `waiting`, which is where it already was.
  return !belowLines.some((line) => OPTION_LINE_RE.test(line));
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
