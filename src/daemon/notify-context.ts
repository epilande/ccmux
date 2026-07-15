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
 * Both permission and question read the pane first on Claude, because Claude
 * defers the same JSONL write in both cases:
 * - `permission`: the pane itself. Claude does NOT flush the permission-gated
 *   `tool_use` to its JSONL until AFTER the user approves, so the transcript
 *   is empty about the pending tool during the wait. The rendered permission
 *   prompt is the only live source of the command, and (bonus) it reflects
 *   post-hook rewrites of the command, which the transcript would not.
 * - `question`: the rendered option picker on the pane. Claude does NOT flush
 *   the AskUserQuestion `tool_use` to its JSONL during the wait either (same
 *   deferred write), so the transcript tail holds only the PREVIOUS turn's
 *   assistant text at fire time — confidently-wrong if trusted. We read the
 *   picker off the pane and fall back to the transcript tail only when the
 *   pane shows no picker (a plain-text question, whose assistant message IS
 *   flushed and current).
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

/**
 * Result of building a waiting notification's context. `body` is the enrichment
 * appended to the base line (null keeps the base). `reclassifyAs` is a
 * delivery-time correction: for an agent whose permission marker is ambiguous
 * (Claude's AskUserQuestion picker wears the same `permission_prompt` marker as
 * a real permission prompt), the freshly-captured pane can reveal the wait is
 * actually a `question` even though the store still says `permission` (the next
 * scan's reconciler correction hasn't landed yet). It tells the notifier to
 * render the Reply variant instead of Approve/Deny for that one delivery.
 */
export interface NotificationContext {
  body: string | null;
  reclassifyAs?: "question";
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
  /(requires approval|do you want to proceed|would you like to proceed|do you want to make this edit|do you want to create)/i;

/**
 * A full-width separator rule row (the divider Claude renders around an Edit /
 * Write diff, and the rounded-box borders). Detected on the RAW line: it holds
 * at least one horizontal box-drawing dash and collapses to "" once box chrome
 * is stripped. These are dropped entirely before block collection — unlike a
 * real interior blank (e.g. "│   │", only verticals + spaces), a rule must NOT
 * split the command block, so the Edit body keeps "Edit file / <path> / <diff>"
 * across its dividers.
 */
const RULE_CHARS = /[─━┄┅┈┉╌╍═╾╼]/;
function isSeparatorRule(raw: string): boolean {
  return RULE_CHARS.test(raw) && cleanPromptLine(raw) === "";
}

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
  // Drop separator rules first so a divider inside the block (the Edit/Write
  // diff dividers) doesn't act as a boundary; real interior blanks survive as
  // "" and still bound the block.
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
 * Extract the question text from a captured AskUserQuestion picker. The shape
 * is a header (an optional "☐ <title>" chip then the question line) above a
 * numbered option list. We anchor on the START of the bottom-most option block
 * — the LAST line that renders as option "1." — which isolates the live picker
 * from a stale scrollback picker AND from a prose numbered list in Claude's own
 * output above it (the sibling `extractPermissionPrompt` anchors on the LAST
 * terminator for the same stale-scrollback reason). The header sits directly
 * above that block; we collect the non-chip lines above it, stopping at the
 * first option line (a prose list), and prefer the nearest question-shaped line
 * (ends with "?"), failing that the nearest header line. Returns null on any
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
  return clampBody(question);
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

/**
 * Permission context: read the live prompt off the pane. Captures the pane
 * ONCE. If the permission-prompt extraction finds no terminator (returns null)
 * but the same pane shows the AskUserQuestion picker signature, the wait is
 * really a question wearing the shared `permission_prompt` marker — return the
 * question body and a `reclassifyAs: "question"` signal so the notifier renders
 * the Reply variant. Otherwise fail open to a null body.
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
 * Question context: the rendered option picker on the pane. During an
 * AskUserQuestion wait the picker's `tool_use` is not flushed until after the
 * answer, so the transcript tail holds the PREVIOUS turn's assistant text and
 * trusting it would render confidently-wrong stale text. We read the picker off
 * the pane first and fall back to the transcript tail only when the pane shows
 * no picker — a plain-text question, whose assistant message IS flushed.
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

/** The transcript-tail half of {@link buildQuestionContext}. */
async function questionFromTranscript(
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
 * Build the context for a waiting `session`: an enrichment `body` and an
 * optional delivery-time `reclassifyAs`. Claude only (others return an empty
 * body); `permission` waits render the pending command captured from the pane
 * (and may reclassify to a question — see `buildPermissionContext`), `question`
 * waits render the pane's question picker, falling back to the last assistant
 * message from the transcript only when no picker is on the pane.
 */
export async function buildNotificationContext(
  session: NotifyContextSession,
  deps: NotifyContextDeps = {},
): Promise<NotificationContext> {
  if (session.agentType !== "claude") return { body: null };
  const capture = deps.capturePane ?? capturePane;
  if (session.attentionType === "permission") {
    return buildPermissionContext(session, capture);
  }
  if (session.attentionType === "question") {
    return { body: await buildQuestionContext(session, capture) };
  }
  return { body: null };
}
