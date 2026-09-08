/**
 * One escape sequence, in the two shapes a real terminal actually sends into
 * the text we render: a CSI (`ESC [`, private-parameter bytes and
 * intermediates included, so `ESC [ ? 2 5 l` is one) and a string sequence
 * (`ESC ]` OSC and its DCS/SOS/PM/APC siblings, closed by BEL or ST, which is
 * how a hyperlink or a title-set arrives).
 *
 * This used to match CSI with numeric parameters only, which left the other
 * shapes behind as PRINTABLE text: `\x1b[?25l` rendered as `[?25l` and an
 * OSC 8 hyperlink as `]8;;https://…`. Sweeping control bytes does not help,
 * because everything after the ESC is ordinary ASCII.
 *
 * Deliberately NOT matched: the two-byte `ESC <char>` forms. A lone ESC in
 * free text is far commoner here than a real `ESC c`, and consuming the byte
 * after it welds two words together (`pane-summary` has the regression test).
 * A lone ESC is left for the caller's control sweep, which turns it into a
 * separator instead.
 *
 * A string sequence's body excludes ESC and BEL, and there is no fallback to
 * end-of-input, so an UNTERMINATED one matches nothing and survives whole.
 * Bounded on purpose: the alternative eats every remaining character on the
 * strength of one stray introducer.
 */
const ANSI_PATTERN =
  /\x1B(?:\[[0-?]*[ -\/]*[@-~]|[\]P^_X][^\x07\x1B]*(?:\x07|\x1B\\))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Text that came off a terminal, reduced to what a single-line cell can
 * paint: no escape sequences, no control bytes, no runs of whitespace, no
 * surrounding space.
 *
 * `stripAnsi` takes out the well-formed sequences. The sweep behind it is
 * for the residue a real pane still carries, a lone ESC, a BEL, a DEL, or a
 * C1 byte (U+0080-U+009F), none of which belong to a sequence the pattern
 * can recognize. Each becomes a SPACE rather than nothing, so two words a
 * stray byte sat between never weld into one, and the collapse behind THAT
 * is what turns the spaces it just introduced back into single separators.
 * `\n` and `\t` fall under both rules for the same reason.
 *
 * The sweep is a regex here rather than `daemon/notify-text.ts`'s
 * `stripControlChars`, which does the same job by codepoint scan: `lib` must
 * not import from `daemon`. The two are deliberately independent; that one
 * has newline and tab policy this has no use for.
 */
export function stripTerminalNoise(text: string): string {
  return stripAnsi(text)
    .replace(/[\x00-\x1F\x7F-\x9F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
