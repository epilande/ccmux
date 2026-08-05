/**
 * Shared delivery-safety guards for typing text into a live agent pane.
 * Extracted (behavior-preserving) from `notification-action.ts` so
 * `POST /sessions/:id/send` and the forthcoming `POST /handoff` route can
 * apply the same checks a notification reply already enforces, without
 * re-deriving them per call site and risking drift.
 *
 * Pure/injectable in the style of the rest of the daemon: the only effectful
 * dependency (`getPaneCommand`) is passed in, never imported directly.
 */

import { isNonAgentCommand } from "./pane-classify";

// Re-exported so every delivery-guard consumer (`/send`, notification-action,
// and later `/handoff`) imports the control-char sanitizer from ONE place,
// even though the canonical implementation still lives in `notify-text.ts`
// (also used by `notify-context.ts`, which has nothing to do with delivery).
export { stripControlChars } from "./notify-text";

/**
 * Foreground liveness: a pane whose foreground process isn't a running agent
 * (a bare shell, where typed text would EXECUTE as a command; a terminal
 * editor, where keystrokes land as normal-mode commands) must never receive
 * a send. Fails CLOSED when the query itself errors (`getPaneCommand`
 * returns null): a dropped send is recoverable, a command landing in a
 * live shell is not.
 *
 * Returns the raw foreground value alongside the verdict so callers that
 * want to log/echo it (as the notification-action handler does) don't have
 * to re-query.
 */
export async function checkForegroundLiveness(
  pane: string,
  getPaneCommand: (paneId: string) => Promise<string | null>,
): Promise<{ live: boolean; foreground: string | null }> {
  const foreground = await getPaneCommand(pane);
  const live = foreground !== null && !isNonAgentCommand(foreground);
  return { live, foreground };
}

/**
 * True when `text` matches the agent's `unsafeReplyPattern`: a shape its
 * composer cannot receive safely (most composers strip leading whitespace
 * BEFORE trigger detection, or fuzzy-match a command token anywhere), so the
 * leading-trigger defuse below cannot neutralize it and the send must be
 * refused outright instead. Resets `lastIndex` first: a `/g`-flagged
 * user-override regex is stateful across calls otherwise.
 */
export function matchesUnsafeReplyPattern(
  text: string,
  unsafePattern: RegExp | undefined,
): boolean {
  if (!unsafePattern) return false;
  unsafePattern.lastIndex = 0;
  return unsafePattern.test(text);
}

/**
 * Neutralize a leading `/` or `!`: unprefixed, `/text` opens an agent's
 * slash-command palette and `!text` trips Claude's shell mode, so neither
 * reaches the agent as a plain message (verified live: a defused ` /new`
 * destroyed an omp session before this guard existed). One leading space
 * defuses both agent-agnostically without changing the visible content.
 */
export function defuseLeadingTrigger(text: string): string {
  return /^[/!]/.test(text) ? ` ${text}` : text;
}

/** Error message for a press/send refused because the target session is an
 *  aggregating agent's row with more than one concurrent wait (OpenCode):
 *  see {@link isAmbiguousWait}. */
export const AMBIGUOUS_WAIT_ERROR =
  "Multiple sessions are waiting; press is ambiguous";

/**
 * True when the session is an aggregated row with more than one concurrent
 * wait (OpenCode's multi-session-per-pane shape). A keystroke or paste would
 * land on whichever dialog the shared pane renders, possibly the wrong
 * session's tool, so delivery must be refused rather than guessed.
 */
export function isAmbiguousWait(session: { ambiguousWait?: boolean }): boolean {
  return !!session.ambiguousWait;
}
