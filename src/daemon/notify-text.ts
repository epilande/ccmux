/**
 * Shared control-character sanitizer for notification text. Callers need it
 * with different newline/tab policy: the context body (`notify-context.ts`)
 * keeps `\n` (macOS/D-Bus render multi-line bodies); an inline reply
 * (`notification-action.ts`) must collapse to a single line so no
 * Enter/escape sequence is ever typed into a pane; the `/send` route
 * (`server.ts`, via `send-guards.ts`) keeps both `\n` and `\t` since its
 * payload can be a legitimate multiline paste. One helper so the stripping
 * rule can't drift between call sites.
 */

const NEWLINE = 0x0a;
const TAB = 0x09;

/** True for C0 controls (0x00-0x1f), DEL (0x7f), and C1 controls (0x80-0x9f). */
function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Strip C0 controls, DEL, and C1 controls from `raw`, replacing each with
 * `replacement`. With `keepNewlines`, `\n` (0x0A) is preserved; with
 * `keepTabs`, `\t` (0x09) is preserved; without either, they're stripped
 * like any other control char. Coded as a codepoint scan rather than a
 * regex literal so the control ranges stay readable and escape-free.
 */
export function stripControlChars(
  raw: string,
  opts: {
    keepNewlines?: boolean;
    keepTabs?: boolean;
    replacement?: string;
  } = {},
): string {
  const { keepNewlines = false, keepTabs = false, replacement = "" } = opts;
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const exempt =
      (keepNewlines && code === NEWLINE) || (keepTabs && code === TAB);
    const strip = isControlCode(code) && !exempt;
    out += strip ? replacement : ch;
  }
  return out;
}
