/**
 * OSC-escape notification backend: delivers a desktop notification by writing a
 * terminal escape sequence into a tmux pane, so it rides the pane's normal
 * output stream out to whatever terminal is attached — including one on the far
 * side of an SSH connection, with no extra transport. This is the whole point
 * of the backend: notifications that cross SSH for free.
 *
 * Dependency-free (like `src/lib/notify.ts`) so both the daemon delivery layer
 * and `ccmux notify` share the exact builders. Every I/O boundary (the tmux
 * runner, the tty write) is injectable so tests never touch a real tty.
 *
 * Two wire formats, chosen by the attached client's terminfo name:
 *   - kitty (termname contains "kitty") -> OSC 99, kitty's structured
 *     desktop-notification protocol (separate title/body, base64 payloads).
 *   - everything else -> OSC 9, iTerm2's single-string notification (supported
 *     by Ghostty, iTerm2, WezTerm; a no-op on emulators that don't implement it).
 *
 * The sequence is wrapped in tmux's passthrough framing (`ESC Ptmux; ... ESC \`
 * with every inner ESC doubled), which requires `allow-passthrough on|all` in
 * tmux; without it tmux swallows the escape and the pane shows nothing. The
 * probe for that option lives in the delivery layer (`notify-delivery.ts`),
 * which owns the once-per-daemon warning.
 *
 * This is the informational rung: `payload.actions`/`payload.reply`/`sound` are
 * never read (there is no back-channel from a written escape), retraction is a
 * no-op, and delivery is fire-and-forget with no success signal.
 */

import { openSync, writeSync, closeSync, constants } from "fs";
import { foldSubtitleIntoBody, type NotificationPayload } from "./notify";

const ESC = "\x1b";
const BEL = "\x07";
/** String Terminator: `ESC \`. */
const ST = `${ESC}\\`;
/** Operating System Command introducer: `ESC ]`. */
const OSC = `${ESC}]`;

/**
 * Removes C0 controls, DEL, and C1 controls from a text field before it is
 * embedded in an escape sequence. Attacker-influenceable text (the title
 * starts with a project directory basename; the body is agent output) could
 * otherwise carry a raw ESC/BEL/ST that breaks out of the OSC string and
 * injects arbitrary terminal escapes. Printable Unicode (anything >= U+00A0)
 * is untouched.
 */
export function stripControlBytes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** Like {@link stripControlBytes} but keeps `\n`, for a base64-encoded OSC 99
 * body where a real line break renders as a multi-line notification and the
 * encoding already neutralizes any injection risk. */
function stripControlBytesKeepNewlines(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Kitty groups a notification's title/body chunks by a shared identifier, and
 * a later notification reusing it replaces the earlier one in place (parity
 * with the macOS helper's `--group` and D-Bus `replaces_id`). Derive it from
 * the session id, reduced to kitty's allowed identifier charset. */
function kittyIdentifier(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "ccmux";
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Builds the raw (un-wrapped) OSC 9 notification: a single `title: body`
 * string terminated by BEL. `body` is the event line and context folded
 * together; any embedded newlines are flattened to spaces so the final
 * sequence stays single-line (a bare LF written through a pane tty would be
 * mangled by the line discipline's output processing, and OSC 9 is a
 * one-line format anyway). Inputs are control-stripped.
 */
export function buildOsc9Sequence(title: string, body: string): string {
  const safeTitle = stripControlBytes(title);
  // Flatten newlines to spaces BEFORE stripping so the fold separator survives
  // as a space rather than vanishing and gluing the two lines together.
  const safeBody = stripControlBytes(body.replace(/\n/g, " ")).trim();
  const message = safeBody ? `${safeTitle}: ${safeBody}` : safeTitle;
  return `${OSC}9;${message}${BEL}`;
}

/**
 * Builds the raw (un-wrapped) kitty OSC 99 notification. Title and body are
 * base64-encoded (`e=1`), which sidesteps every payload-escaping question and
 * keeps the sequence newline-free even when the body spans multiple lines.
 * When there's no body the title chunk is marked done (`d=1`); otherwise the
 * title chunk is `d=0` and a `d=1` body chunk follows, both sharing an `i`
 * identifier so kitty groups them into one notification.
 */
export function buildOsc99Sequence(
  sessionId: string,
  title: string,
  body: string,
): string {
  const id = kittyIdentifier(sessionId);
  const encodedTitle = base64(stripControlBytes(title));
  const safeBody = stripControlBytesKeepNewlines(body);

  if (!safeBody) {
    return `${OSC}99;i=${id}:d=1:e=1:p=title;${encodedTitle}${ST}`;
  }
  return (
    `${OSC}99;i=${id}:d=0:e=1:p=title;${encodedTitle}${ST}` +
    `${OSC}99;i=${id}:d=1:e=1:p=body;${base64(safeBody)}${ST}`
  );
}

/**
 * Wraps a raw escape sequence in tmux's passthrough framing so tmux forwards
 * it to the attached client instead of interpreting it: `ESC Ptmux;` + the
 * sequence with every ESC byte doubled + `ESC \`. Requires `allow-passthrough`
 * to be on in the target tmux.
 */
export function wrapTmuxPassthrough(sequence: string): string {
  // eslint-disable-next-line no-control-regex
  const doubled = sequence.replace(/\x1b/g, ESC + ESC);
  return `${ESC}Ptmux;${doubled}${ST}`;
}

/** True when any attached client's terminfo name marks a kitty terminal (so it
 * speaks OSC 99). `termnames` is the raw stdout of
 * `tmux list-clients -F '#{client_termname}'` (one per line). */
export function isKittyTermnames(termnames: string): boolean {
  return termnames
    .split("\n")
    .some((name) => name.toLowerCase().includes("kitty"));
}

/**
 * Composes the final, passthrough-wrapped sequence for a payload. The subtitle
 * (event line) is folded into the body via {@link foldSubtitleIntoBody}: OSC 99
 * carries it as the structured body chunk, OSC 9 flattens it into the single
 * message string.
 */
export function buildPassthroughSequence(
  payload: NotificationPayload,
  isKitty: boolean,
): string {
  const body = foldSubtitleIntoBody(payload);
  const raw = isKitty
    ? buildOsc99Sequence(payload.sessionId, payload.title, body)
    : buildOsc9Sequence(payload.title, body);
  return wrapTmuxPassthrough(raw);
}

/** Default tty writer: opens the pane device write-only and non-blocking (so a
 * flow-controlled or wedged pane can never hang the daemon — a full buffer
 * throws EAGAIN, which the caller swallows) and writes the sequence once. */
function defaultWriteToTty(tty: string, data: string): void {
  const fd = openSync(tty, constants.O_WRONLY | constants.O_NONBLOCK);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export interface OscDeliverDeps {
  /** Runs tmux and returns stdout, or null on failure. Used for the
   * `list-clients` termname sniff. */
  runTmux: (args: string[]) => string | null;
  /** Writes the wrapped sequence to the pane tty device. Defaults to a
   * non-blocking `fs` write; injectable so tests never touch a real tty. */
  writeToTty?: (tty: string, data: string) => void;
  log?: (message: string, error?: unknown) => void;
}

/**
 * Delivers one notification by writing the passthrough-wrapped OSC sequence to
 * `tty` (the bound pane's device). Sniffs the attached client's termname to
 * pick OSC 9 vs OSC 99. Fire-and-forget: a failed tty write (device gone,
 * EACCES, EAGAIN) is logged at debug level and dropped, never thrown.
 */
export function deliverOscNotification(
  payload: NotificationPayload,
  tty: string,
  deps: OscDeliverDeps,
): void {
  // Scope the termname sniff to the notification's own session: tmux resolves a
  // pane target (`-t %N`) to its session, so a kitty client on one session and
  // a Ghostty client on another don't cross-contaminate the OSC 9-vs-99 choice
  // (a server-wide sniff would misroute and silently drop the notification).
  const termnames = deps.runTmux(
    payload.pane
      ? ["list-clients", "-t", payload.pane, "-F", "#{client_termname}"]
      : ["list-clients", "-F", "#{client_termname}"],
  );
  const isKitty = termnames ? isKittyTermnames(termnames) : false;
  const sequence = buildPassthroughSequence(payload, isKitty);
  const write = deps.writeToTty ?? defaultWriteToTty;
  try {
    write(tty, sequence);
  } catch (error) {
    deps.log?.("Notifier: osc tty write failed, dropping notification", error);
  }
}

/**
 * The pane-tty-independent probe: reads tmux's global `allow-passthrough` and
 * reports whether it's on. `allow-passthrough` became a pane option in tmux
 * 3.3, but a global `set -g allow-passthrough on` is the documented, common
 * way to enable it and is inherited by every pane, so a global read
 * (`show-options -gv`) is the simplest sufficient check; a user who set it only
 * on specific panes would read as off here and see the one-time warning, which
 * is an acceptable false negative for a niche configuration.
 */
export function probeAllowPassthrough(
  runTmux: (args: string[]) => string | null,
): boolean {
  const value = runTmux(["show-options", "-gv", "allow-passthrough"]);
  if (value === null) return false;
  const trimmed = value.trim();
  return trimmed === "on" || trimmed === "all";
}
