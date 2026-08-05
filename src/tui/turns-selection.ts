/**
 * The turns selector: how many turns of a conversation a dialog is asking for,
 * and what a keypress does to that count.
 *
 * Two dialogs ask the same question — Copy (how much to put on the clipboard)
 * and Hand off (how much to give a peer) — and they have to answer the keyboard
 * identically, because they look identical: one row, a count, j/k, digits. This
 * module is that count's ONE home, so a fix to the digit rules cannot land in
 * one dialog and miss the other.
 *
 * What is NOT here: Enter, Escape, and what a key that belongs to neither
 * means. Those are the dialog's own, and the two deliberately differ (the Copy
 * dialog is dismissed by any stray key; the handoff dialog swallows it, having
 * a text field one Tab away that a user could plausibly be aiming at).
 */

import { MAX_TURNS } from "../daemon/transcript-read";

/** A turns selector's whole state. */
export interface TurnsSelection {
  turns: number;
  /**
   * True while a leading `1` or `2` waits to see whether a second digit
   * follows. Part of what the number keys MEAN, so it travels with the count
   * rather than living beside it: a half-typed count that outlived its dialog
   * is not a state either surface can be in.
   */
  pendingDigit: boolean;
}

/**
 * How much of the conversation the current count would take, in words.
 *
 * One turn is the last response on its own, which is what both menu items
 * promised before either grew a dialog. Past one the payload stops being a
 * response and becomes an exchange, so the parenthetical says the thing a user
 * would otherwise discover only after pasting: their own prompts come too.
 */
export function turnsLabel(turns: number): string {
  if (turns <= 1) return "Last response";
  return `Last ${turns} turns (with your prompts)`;
}

/**
 * The selector's answer to a key, or null when the key is not its.
 *
 * `j`/`k` and the arrows step by one, clamped. Digits jump straight to a
 * count: a leading `1` or `2` is the only ambiguous one (11-20 exist), so it
 * takes effect immediately AND waits for one more digit — a second digit that
 * lands inside the range replaces it (`1` `2` -> 12), one that would overshoot
 * starts a fresh count (`2` `5` -> 5), and anything else just goes on meaning
 * what it means with the leading digit already applied. There is no timer, so
 * the same keys always produce the same count.
 */
export function applyTurnsKey(
  key: string,
  current: TurnsSelection,
): TurnsSelection | null {
  if (key === "j" || key === "down") return step(current.turns + 1);
  if (key === "k" || key === "up") return step(current.turns - 1);
  if (key < "0" || key > "9") return null;

  const digit = parseInt(key, 10);
  if (current.pendingDigit) {
    const combined = current.turns * 10 + digit;
    if (combined <= MAX_TURNS) {
      return { turns: combined, pendingDigit: false };
    }
  }
  // A bare 0 is not a count and nothing here can start with one, so it is the
  // selector's key (swallowed) without being a change.
  if (digit === 0) return { ...current };
  return { turns: digit, pendingDigit: digit * 10 <= MAX_TURNS };
}

function step(turns: number): TurnsSelection {
  return {
    turns: Math.min(MAX_TURNS, Math.max(1, turns)),
    pendingDigit: false,
  };
}
