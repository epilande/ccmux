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
