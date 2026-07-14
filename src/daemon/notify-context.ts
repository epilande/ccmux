/**
 * Notification body enrichment: given a waiting session, extract a short
 * plain-text description of WHAT it is waiting on, so an actionable
 * notification can show the pending command / question instead of a bare
 * "Needs permission: Bash".
 *
 * Fail-open by contract: any read/parse error, an unsupported agent, or a
 * missing source returns `null`, and the caller keeps the base body. The
 * text is agent-derived and travels through the argv-safe delivery path, so
 * this module normalizes control characters (keeping only `\n`) and caps the
 * length — the notifier renders `\n` verbatim.
 *
 * Permission vs. question take different sources on Claude:
 * - `permission`: the pane itself. Claude does NOT flush the permission-gated
 *   `tool_use` to its JSONL until AFTER the user approves, so the transcript
 *   is empty about the pending tool during the wait. The rendered permission
 *   prompt is the only live source of the command, and (bonus) it reflects
 *   post-hook rewrites of the command, which the transcript would not.
 * - `question`: the transcript tail (the last assistant text), which IS
 *   present at fire time.
 */

import { parseLogEntries } from "./parser";
import { readTranscriptTail, claudeEntryTexts } from "./transcript-search";
import { stripControlChars } from "./notify-text";
import { capturePane } from "./pane-io";
import type { LogEntry } from "../types/log";

/** Minimal shape this module reads off a session (keeps it testable without
 *  the full `Session` type). */
export interface NotifyContextSession {
  agentType: string;
  logPath: string | null;
  attentionType: "permission" | "question" | "plan_approval" | null;
  /** Name of the tool the pending permission is actually for. Retained for
   *  the base "Needs permission: <tool>" line the caller builds; the context
   *  body itself is now read from the pane, not keyed off this field. */
  pendingTool: string | null;
  /** tmux pane id (e.g. `%418`) the session runs in. The permission-context
   *  path captures this pane; null means we can't read the prompt. */
  tmuxPane: string | null;
}

/** Injected so tests can stub the tmux read. */
export interface NotifyContextDeps {
  capturePane?: (paneId: string, lines?: number) => Promise<string>;
}

/** Only the last slice of the transcript is scanned — the last assistant
 *  turn is always at the very tail. */
const CONTEXT_TAIL_BYTES = 128 * 1024;
/** How many trailing pane lines to capture for the permission prompt. The
 *  prompt box (header + command + description + options) fits comfortably. */
const PANE_CAPTURE_LINES = 30;
/** Body caps: multi-line is fine (macOS renders `\n`), but keep it glanceable. */
const MAX_CONTEXT_LINES = 4;
const MAX_CONTEXT_CHARS = 300;
/** Upper bound on lines pulled from the prompt's command block, before the
 *  final clamp — guards against grabbing an unbounded run if the shape is off. */
const MAX_BLOCK_LINES = 8;

/**
 * Strip control characters other than newline and collapse the result to at
 * most `MAX_CONTEXT_LINES` lines / `MAX_CONTEXT_CHARS` chars with an ellipsis.
 * Returns null when nothing printable survives.
 */
function clampBody(raw: string): string | null {
  const normalized = stripControlChars(raw.replace(/\r\n?/g, "\n"), {
    keepNewlines: true,
  });
  const lines = normalized.split("\n");
  let clipped = false;

  let kept = lines;
  if (kept.length > MAX_CONTEXT_LINES) {
    kept = kept.slice(0, MAX_CONTEXT_LINES);
    clipped = true;
  }
  let text = kept.join("\n").trimEnd();
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS).trimEnd();
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
  /(requires approval|do you want to proceed|would you like to proceed)/i;

/**
 * Extract the command block from a captured Claude permission prompt.
 *
 * The prompt shape is: a header line (e.g. "Bash command"), the indented
 * command and Claude's one-line description, then a terminator line
 * ("This command requires approval" / "Do you want to proceed?") followed by
 * the numbered options. We anchor on the terminator and collect the non-blank
 * lines directly above it (skipping any blank gap), which yields the command
 * block without the redundant options. Returns null on any shape mismatch so
 * the caller keeps the bare "Needs permission: <tool>" line.
 */
export function extractPermissionPrompt(paneText: string): string | null {
  const lines = paneText.split("\n").map(cleanPromptLine);

  let termIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TERMINATOR_RE.test(lines[i])) {
      termIdx = i;
      break;
    }
  }
  if (termIdx < 0) return null;

  // Skip a blank gap and any stacked terminator/chrome lines directly above
  // the anchor (e.g. "This command requires approval" sits right above "Do you
  // want to proceed?"), then collect the contiguous command block above it.
  // Anchoring on the LAST terminator means a stale earlier prompt in
  // scrollback is ignored.
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

  return clampBody(block.join("\n"));
}

/** Find the last assistant text block across parsed entries. */
function lastAssistantText(entries: LogEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const texts = claudeEntryTexts(entries[i]);
    if (texts.length === 0) continue;
    for (let j = texts.length - 1; j >= 0; j--) {
      if (texts[j].role === "assistant") return texts[j].text;
    }
  }
  return null;
}

/** Permission context: read the live prompt off the pane. */
async function buildPermissionContext(
  session: NotifyContextSession,
  capture: (paneId: string, lines?: number) => Promise<string>,
): Promise<string | null> {
  if (!session.tmuxPane) return null;
  try {
    const text = await capture(session.tmuxPane, PANE_CAPTURE_LINES);
    return extractPermissionPrompt(text);
  } catch {
    return null;
  }
}

/** Question context: the last assistant text from the transcript tail. */
async function buildQuestionContext(
  session: NotifyContextSession,
): Promise<string | null> {
  if (!session.logPath) return null;
  try {
    const content = await readTranscriptTail(
      session.logPath,
      CONTEXT_TAIL_BYTES,
    );
    const entries = parseLogEntries(content);
    const text = lastAssistantText(entries);
    if (text === null) return null;
    return clampBody(text);
  } catch {
    return null;
  }
}

/**
 * Build a plain-text body enrichment for a waiting `session`, or null when
 * there's nothing to add. Claude only (others return null); `permission` waits
 * render the pending command captured from the pane, `question` waits render
 * the last assistant message from the transcript.
 */
export async function buildNotificationContext(
  session: NotifyContextSession,
  deps: NotifyContextDeps = {},
): Promise<string | null> {
  if (session.agentType !== "claude") return null;
  if (session.attentionType === "permission") {
    return buildPermissionContext(session, deps.capturePane ?? capturePane);
  }
  if (session.attentionType === "question") {
    return buildQuestionContext(session);
  }
  return null;
}
