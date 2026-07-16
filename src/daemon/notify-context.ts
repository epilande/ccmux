/**
 * Notification body enrichment: extract a short plain-text description of WHAT
 * a session is waiting on (the pending command / question) or, for a finished
 * session, its closing words, so the notification body shows real context
 * under the event line the subtitle already carries.
 *
 * Fail-open by contract: any read/parse error, an unsupported agent, or a
 * missing source returns `null`, and the caller keeps the base body. The
 * text is agent-derived and travels through the argv-safe delivery path, so
 * this module normalizes control characters (keeping only `\n`) and caps the
 * length — the notifier renders `\n` verbatim.
 *
 * Both permission and question read the pane first on Claude: it does NOT
 * flush the gated `tool_use` (permission or AskUserQuestion) to its JSONL
 * until AFTER the user responds, so during the wait the transcript knows
 * nothing about the pending tool — for a question its tail still holds the
 * PREVIOUS turn's assistant text, confidently-wrong if trusted. The rendered
 * pane prompt is the only live source (and for permission it also reflects
 * post-hook rewrites of the command, which the transcript would not). The
 * transcript tail is used only for a plain-text question with no picker,
 * whose assistant message IS flushed and current.
 */

import { parseLogEntries } from "./parser";
import { readTranscriptTail, claudeEntryTexts } from "./transcript-search";
import { stripControlChars } from "./notify-text";
import { capturePane } from "./pane-io";
import { isPlanApprovalWait } from "./notification-action";
import type { AssistantLogEntry, LogEntry, ToolUseBlock } from "../types/log";

/** Minimal shape this module reads off a session (keeps it testable without
 *  the full `Session` type). */
export interface NotifyContextSession {
  agentType: string;
  logPath: string | null;
  attentionType: "permission" | "question" | "plan_approval" | null;
  /** Tool the pending permission is for; feeds the caller's base
   *  "Needs permission: <tool>" line (the context body reads the pane). */
  pendingTool: string | null;
  /** tmux pane id (e.g. `%418`) the session runs in. The permission-context
   *  path captures this pane; null means we can't read the prompt. */
  tmuxPane: string | null;
  /** The session's last submitted prompt, the finished-context fallback when
   *  no assistant closing words can be read from the transcript. */
  lastPrompt: string | null;
}

/** Injected so tests can stub the tmux read. */
export interface NotifyContextDeps {
  capturePane?: (paneId: string, lines?: number) => Promise<string>;
}

/**
 * `body` is the enrichment appended to the base line (null keeps the base).
 * `reclassifyAs` is a delivery-time correction of a stored `permission` wait
 * into its true type, so the notifier renders the right actions for that one
 * delivery (before the next scan's reconciler correction lands). Two cases both
 * arrive stored as `permission`: Claude's AskUserQuestion picker (the pane
 * reveals it is really a `question`), and an ExitPlanMode wait (the marker wins
 * the cascade as `waiting_permission`, so the plan wait is really a
 * `plan_approval`; see `isPlanApprovalWait`).
 */
export interface NotificationContext {
  body: string | null;
  reclassifyAs?: "question" | "plan_approval";
}

/** Only the last slice of the transcript is scanned — the last assistant
 *  turn is always at the very tail. */
const CONTEXT_TAIL_BYTES = 128 * 1024;
/** How many trailing pane lines to capture for the permission prompt. The
 *  prompt box (header + command + description + options) fits comfortably. */
const PANE_CAPTURE_LINES = 30;
/** Waiting-context caps: multi-line is fine (macOS renders `\n`), but keep it
 *  glanceable. The finished context (closing words) clamps tighter, below. */
const MAX_CONTEXT_LINES = 4;
const MAX_CONTEXT_CHARS = 300;
/** Finished-context caps: an assistant turn's closing words can run long, so
 *  clamp it tighter than the waiting command/question block. */
const MAX_FINISHED_LINES = 2;
const MAX_FINISHED_CHARS = 200;
/** Upper bound on lines pulled from the prompt's command block, before the
 *  final clamp — guards against grabbing an unbounded run if the shape is off. */
const MAX_BLOCK_LINES = 8;

/**
 * Strip control characters (keeping `\n`) and clamp to `maxLines` / `maxChars`
 * with an ellipsis. Null when nothing printable survives.
 */
function clampBody(
  raw: string,
  maxLines: number,
  maxChars: number,
): string | null {
  const normalized = stripControlChars(raw.replace(/\r\n?/g, "\n"), {
    keepNewlines: true,
  });
  const lines = normalized.split("\n");
  let clipped = false;

  let kept = lines;
  if (kept.length > maxLines) {
    kept = kept.slice(0, maxLines);
    clipped = true;
  }
  let text = kept.join("\n").trimEnd();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd();
    clipped = true;
  }
  if (text.trim().length === 0) return null;
  return clipped ? `${text}…` : text;
}

/**
 * Strip box-drawing borders and the selection caret from one captured pane
 * line, then trim. Claude renders the permission prompt inside a rounded box,
 * so raw lines look like `│ Bash command        │`; a border-only line
 * collapses to "" and acts as a block boundary in the extractor.
 */
function cleanPromptLine(line: string): string {
  return line
    .replace(/[─-╿❯]/g, " ")
    .replace(/｜/g, " ")
    .trim();
}

/** Lines that mark the END of the command block (everything above them, up to
 *  the first blank line, is the block). Kept in sync with Claude's permission
 *  prompt chrome and the `terminalRules` anchors in `src/lib/agents.ts`. */
const TERMINATOR_RE =
  /(requires approval|do you want to proceed|would you like to proceed|do you want to make this edit|do you want to create)/i;

/**
 * A full-width separator rule row (the divider Claude renders around an Edit /
 * Write diff, and the rounded-box borders): the RAW line holds a horizontal
 * box-drawing dash and collapses to "" once box chrome is stripped. Dropped
 * entirely before block collection — unlike a real interior blank ("│   │"),
 * a rule must NOT split the command block, so the Edit body keeps
 * "Edit file / <path> / <diff>" across its dividers.
 */
const RULE_CHARS = /[─━┄┅┈┉╌╍═╾╼]/;
function isSeparatorRule(raw: string): boolean {
  return RULE_CHARS.test(raw) && cleanPromptLine(raw) === "";
}

/**
 * Extract the command block from a captured Claude permission prompt. The
 * shape is: a header line (e.g. "Bash command"), the indented command and
 * one-line description, a terminator ("Do you want to proceed?"), then the
 * numbered options. Anchor on the terminator and collect the non-blank lines
 * directly above it — the command block without the redundant options.
 * Returns null on any shape mismatch so the caller keeps the bare
 * "Needs permission: <tool>" line.
 */
export function extractPermissionPrompt(paneText: string): string | null {
  // Drop separator rules first (see RULE_CHARS); real interior blanks
  // survive as "" and still bound the block.
  const lines = paneText
    .split("\n")
    .filter((raw) => !isSeparatorRule(raw))
    .map(cleanPromptLine);

  let termIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TERMINATOR_RE.test(lines[i])) {
      termIdx = i;
      break;
    }
  }
  if (termIdx < 0) return null;

  // Skip blank/stacked-terminator lines directly above the anchor ("This
  // command requires approval" sits right above "Do you want to proceed?"),
  // then collect the contiguous command block. Anchoring on the LAST
  // terminator ignores a stale earlier prompt in scrollback.
  const isBoundary = (line: string): boolean =>
    line === "" || TERMINATOR_RE.test(line);
  let i = termIdx - 1;
  while (i >= 0 && isBoundary(lines[i])) i--;
  const block: string[] = [];
  while (i >= 0 && !isBoundary(lines[i]) && block.length < MAX_BLOCK_LINES) {
    block.unshift(lines[i]);
    i--;
  }
  if (block.length === 0) return null;

  return clampBody(block.join("\n"), MAX_CONTEXT_LINES, MAX_CONTEXT_CHARS);
}

/** A captured Claude AskUserQuestion option-picker line, e.g. "1. Blue" (after
 *  `cleanPromptLine` strips the leading `❯` caret). The captured group is the
 *  option number; the picker always numbers its first real option "1.". */
const OPTION_LINE_RE = /^(\d+)\.\s/;
/** Header chip line the picker renders above the question (e.g. "☐ Fav color");
 *  a checkbox glyph, not the question itself, so it's skipped. */
const CHECKBOX_LINE_RE = /^[☐☑☒]/;

/**
 * True when a captured pane looks like Claude's AskUserQuestion option picker:
 * a "Type something." choice plus the "Enter to select" footer. Mirrors the
 * `terminalRules` question anchors in `src/lib/agents.ts`; used delivery-time
 * to disambiguate the shared `permission_prompt` marker (see
 * docs/agent-adapters.md).
 */
export function matchesQuestionPickerSignature(paneText: string): boolean {
  const lower = paneText.toLowerCase();
  return lower.includes("type something.") && lower.includes("enter to select");
}

/**
 * Extract the question text from a captured AskUserQuestion picker: a header
 * (an optional "☐ <title>" chip then the question line) above a numbered
 * option list. Anchors on the LAST line rendering as option "1." — the start
 * of the bottom-most option block — which isolates the live picker from a
 * stale scrollback picker AND from a prose numbered list in Claude's own
 * output (the same stale-scrollback reason `extractPermissionPrompt` anchors
 * on the LAST terminator). Collects the non-chip header lines above it,
 * stopping at an option line (a prose list), and prefers the nearest
 * "?"-terminated line, else the nearest header line. Returns null on any
 * shape mismatch so the caller falls back to the base body.
 */
export function extractQuestionPrompt(paneText: string): string | null {
  const lines = paneText.split("\n").map(cleanPromptLine);

  let blockStartIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = OPTION_LINE_RE.exec(lines[i]);
    if (match && match[1] === "1") {
      blockStartIdx = i;
      break;
    }
  }
  if (blockStartIdx <= 0) return null;

  // Walk up from the block, keeping header lines closest-first. Stop at an
  // option line so a prose numbered list above the header is excluded.
  const header: string[] = [];
  for (let i = blockStartIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === "") continue;
    if (CHECKBOX_LINE_RE.test(line)) continue;
    if (OPTION_LINE_RE.test(line)) break;
    header.push(line);
  }
  if (header.length === 0) return null;

  const question = header.find((line) => line.endsWith("?")) ?? header[0];
  return clampBody(question, MAX_CONTEXT_LINES, MAX_CONTEXT_CHARS);
}

/**
 * The newest assistant text in the tail, but ONLY when it is still the last
 * conversational text there. Walking back to the most recent text-bearing entry
 * (each entry's texts are single-role: user string, or assistant text blocks),
 * a user-role newest text means the assistant turn we'd otherwise quote is stale
 * (an interrupted/denied turn's "[Request interrupted by user]" marker, or a
 * fresh prompt), so return null. Guards both the finished body and the
 * question-tail fallback against quoting a superseded turn.
 */
function lastAssistantTextIfCurrent(entries: LogEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const texts = claudeEntryTexts(entries[i]);
    if (texts.length === 0) continue;
    const newest = texts[texts.length - 1];
    return newest.role === "assistant" ? newest.text : null;
  }
  return null;
}

/**
 * Shared transcript-tail pipeline: read the tail, parse it, and return the
 * newest assistant text clamped to `maxLines` / `maxChars` (via
 * {@link lastAssistantTextIfCurrent}, so a stale tail returns null). Fail-open:
 * a read/parse error returns null so the caller can fall through.
 */
async function assistantTextFromTranscript(
  logPath: string,
  maxLines: number,
  maxChars: number,
): Promise<string | null> {
  try {
    const content = await readTranscriptTail(logPath, CONTEXT_TAIL_BYTES);
    const text = lastAssistantTextIfCurrent(parseLogEntries(content));
    if (text === null) return null;
    return clampBody(text, maxLines, maxChars);
  } catch {
    return null;
  }
}

/**
 * Permission context: read the live prompt off the pane (captured ONCE). If
 * no terminator is found but the pane shows the AskUserQuestion picker
 * signature, the wait is really a question wearing the shared
 * `permission_prompt` marker — return the question body plus
 * `reclassifyAs: "question"` so the notifier renders the Reply variant.
 * Otherwise fail open to a null body.
 */
async function buildPermissionContext(
  session: NotifyContextSession,
  capture: (paneId: string, lines?: number) => Promise<string>,
): Promise<NotificationContext> {
  if (!session.tmuxPane) return { body: null };
  let text: string;
  try {
    text = await capture(session.tmuxPane, PANE_CAPTURE_LINES);
  } catch {
    return { body: null };
  }
  const permission = extractPermissionPrompt(text);
  if (permission !== null) return { body: permission };
  if (matchesQuestionPickerSignature(text)) {
    return { body: extractQuestionPrompt(text), reclassifyAs: "question" };
  }
  return { body: null };
}

/**
 * Question context: the rendered option picker on the pane, falling back to
 * the transcript tail only when the pane shows no picker (a plain-text
 * question). See the module doc for why the transcript can't be trusted
 * during a picker wait.
 */
async function buildQuestionContext(
  session: NotifyContextSession,
  capture: (paneId: string, lines?: number) => Promise<string>,
): Promise<string | null> {
  if (session.tmuxPane) {
    try {
      const fromPane = extractQuestionPrompt(
        await capture(session.tmuxPane, PANE_CAPTURE_LINES),
      );
      if (fromPane !== null) return fromPane;
    } catch {
      // Pane unreadable — fall through to the transcript tail.
    }
  }
  return questionFromTranscript(session);
}

/** The transcript-tail half of {@link buildQuestionContext}: a plain-text
 *  question IS the tail's last assistant text, so the shared pipeline's
 *  stale-tail guard leaves it intact while rejecting a superseded turn. */
async function questionFromTranscript(
  session: NotifyContextSession,
): Promise<string | null> {
  if (!session.logPath) return null;
  return assistantTextFromTranscript(
    session.logPath,
    MAX_CONTEXT_LINES,
    MAX_CONTEXT_CHARS,
  );
}

/**
 * The `input.plan` markdown of the LAST `ExitPlanMode` tool_use in the tail, or
 * null. Unlike a permission-gated tool_use (backdated to AFTER the user
 * responds), ExitPlanMode's tool_use IS flushed to the JSONL DURING the wait
 * with `input.plan` populated (verified on Claude Code 2.1.211), so the tail is
 * the live plan. Shape-guarded so a schema-invalid line yields null, not a throw.
 */
function lastExitPlanModePlan(entries: LogEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object" || entry.type !== "assistant") {
      continue;
    }
    const content = (entry as AssistantLogEntry).message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block && block.type === "tool_use") {
        const toolUse = block as ToolUseBlock;
        if (toolUse.name === "ExitPlanMode") {
          const plan = toolUse.input?.plan;
          return typeof plan === "string" && plan.length > 0 ? plan : null;
        }
      }
    }
  }
  return null;
}

/** The transcript-tail plan body for a plan_approval wait. Fail-open to null. */
async function planTextFromTranscript(logPath: string): Promise<string | null> {
  try {
    const content = await readTranscriptTail(logPath, CONTEXT_TAIL_BYTES);
    const plan = lastExitPlanModePlan(parseLogEntries(content));
    if (plan === null) return null;
    return clampBody(plan, MAX_CONTEXT_LINES, MAX_CONTEXT_CHARS);
  } catch {
    return null;
  }
}

/**
 * Plan-approval context: transcript-first, with NO pane extractor. Claude's plan
 * box is fixed-height and pads ~10 blank lines between the plan body and the
 * terminator, and the body sits above `PANE_CAPTURE_LINES`, so a pane walk-up
 * grabs only padding (verified on Claude Code 2.1.211). The transcript is the
 * reliable source instead (see `lastExitPlanModePlan`). Returns
 * `reclassifyAs: "plan_approval"` only when the wait was STORED as a permission
 * (the marker-fresher window, see `isPlanApprovalWait`), so the subtitle
 * rebuilds from "Needs permission" to "Plan ready for review".
 */
async function buildPlanContext(
  session: NotifyContextSession,
): Promise<NotificationContext> {
  const body = session.logPath
    ? await planTextFromTranscript(session.logPath)
    : null;
  return session.attentionType === "permission"
    ? { body, reclassifyAs: "plan_approval" }
    : { body };
}

/**
 * Build the context for a waiting `session`: an enrichment `body` plus an
 * optional delivery-time `reclassifyAs`. Claude only; other agents return an
 * empty body. See `buildPlanContext` / `buildPermissionContext` /
 * `buildQuestionContext` for the per-type sourcing.
 */
export async function buildNotificationContext(
  session: NotifyContextSession,
  deps: NotifyContextDeps = {},
): Promise<NotificationContext> {
  if (session.agentType !== "claude") return { body: null };
  const capture = deps.capturePane ?? capturePane;
  // Plan waits are routed FIRST: a live ExitPlanMode wait is stored as a
  // permission (see `isPlanApprovalWait`), so this must precede the permission
  // branch or the plan body would be sought (and missed) on the pane.
  if (isPlanApprovalWait(session)) {
    return buildPlanContext(session);
  }
  if (session.attentionType === "permission") {
    return buildPermissionContext(session, capture);
  }
  if (session.attentionType === "question") {
    return { body: await buildQuestionContext(session, capture) };
  }
  return { body: null };
}

/**
 * Build the context body for a FINISHED session: what the agent last said, so a
 * "Finished" notification shows the turn's closing words instead of just the
 * bare event line. The ladder:
 *   1. Claude with a `logPath`: the last assistant text off the transcript
 *      tail. Unlike a wait, a finished turn IS flushed to the JSONL, so the
 *      tail is current (see the module doc for why a wait can't trust it).
 *      Skipped when the tail's newest text is a user turn (interrupted/denied,
 *      or a fresh prompt): the shared pipeline returns null and we fall through
 *      rather than quoting the previous turn's answer.
 *   2. Any agent: the session's `lastPrompt` (what the user asked for). The
 *      transcript read is fail-open on its own, so a deleted/unreadable logPath
 *      reaches this step instead of skipping the rest of the ladder.
 *   3. Else null (the caller keeps a bare payload; the subtitle carries the
 *      event).
 * Clamped tighter than the waiting context. Fail-open: any error returns null.
 */
export async function buildFinishedContext(
  session: NotifyContextSession,
): Promise<string | null> {
  try {
    if (session.agentType === "claude" && session.logPath) {
      const fromTranscript = await assistantTextFromTranscript(
        session.logPath,
        MAX_FINISHED_LINES,
        MAX_FINISHED_CHARS,
      );
      if (fromTranscript !== null) return fromTranscript;
    }
    if (session.lastPrompt) {
      return clampBody(
        session.lastPrompt,
        MAX_FINISHED_LINES,
        MAX_FINISHED_CHARS,
      );
    }
    return null;
  } catch {
    return null;
  }
}
