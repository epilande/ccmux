/**
 * Shared control-character sanitizer for notification text. Two callers need
 * it with different newline policy: the context body (`notify-context.ts`)
 * keeps `\n` (macOS/D-Bus render multi-line bodies), while an inline reply
 * (`notification-action.ts`) must collapse to a single line so no Enter/escape
 * sequence is ever typed into a pane. One helper so the stripping rule can't
 * drift between the two.
 */

const NEWLINE = 0x0a;

/** True for C0 controls (0x00-0x1f), DEL (0x7f), and C1 controls (0x80-0x9f). */
function isControlCode(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Strip C0 controls, DEL, and C1 controls from `raw`, replacing each with
 * `replacement`. With `keepNewlines`, `\n` (0x0A) is preserved; without it,
 * newlines are stripped like any other control char. Coded as a codepoint
 * scan rather than a regex literal so the control ranges stay readable and
 * escape-free.
 */
export function stripControlChars(
  raw: string,
  opts: { keepNewlines?: boolean; replacement?: string } = {},
): string {
  const { keepNewlines = false, replacement = "" } = opts;
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const strip = isControlCode(code) && !(keepNewlines && code === NEWLINE);
    out += strip ? replacement : ch;
  }
  return out;
}
