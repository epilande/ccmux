/**
 * OSC-escape notification backend: writes a terminal escape sequence into a
 * tmux pane, so the notification rides the pane's output stream to the
 * attached terminal, including across SSH, with no extra transport.
 *
 * Dependency-free (like `src/lib/notify.ts`) so the daemon and `ccmux notify`
 * share the builders; every I/O boundary is injectable for tests. Kitty
 * clients get OSC 99, everything else OSC 9, wrapped in tmux passthrough
 * framing, which requires `allow-passthrough on|all` (probed with a
 * once-per-daemon warning in `notify-delivery.ts`).
 *
 * Informational rung: `actions`/`reply`/`sound` are never read (a written
 * escape has no back-channel), retraction is a no-op, delivery is
 * fire-and-forget.
 */

import { openSync, writeSync, closeSync, constants } from "fs";
import { foldSubtitleIntoBody, type NotificationPayload } from "./notify";

const ESC = "\x1b";
const BEL = "\x07";
/** String Terminator: `ESC \`. */
const ST = `${ESC}\\`;
/** Operating System Command introducer: `ESC ]`. */
const OSC = `${ESC}]`;

/** Removes C0 controls, DEL, and C1 controls before embedding text in an
 * escape sequence: agent-influenced fields (project basename in the title,
 * agent output in the body) could otherwise carry an ESC/BEL/ST that breaks
 * out of the OSC string and injects arbitrary terminal escapes. */
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

/** Per-session kitty identifier: groups a notification's chunks, and a later
 * notification reusing it replaces the earlier one (parity with the macOS
 * helper's `--group` and D-Bus `replaces_id`). */
function kittyIdentifier(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "ccmux";
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Builds the raw (un-wrapped) OSC 9 notification: a single control-stripped
 * `title: body` string terminated by BEL. Newlines are flattened to spaces:
 * OSC 9 is a one-line format, and a bare LF through the pane tty would be
 * mangled by the line discipline anyway.
 */
export function buildOsc9Sequence(title: string, body: string): string {
  const safeTitle = stripControlBytes(title);
  // Flatten before stripping so the fold separator survives as a space rather
  // than vanishing and gluing the two lines together.
  const safeBody = stripControlBytes(body.replace(/\n/g, " ")).trim();
  const message = safeBody ? `${safeTitle}: ${safeBody}` : safeTitle;
  return `${OSC}9;${message}${BEL}`;
}

/**
 * Builds the raw (un-wrapped) kitty OSC 99 notification: a title chunk and a
 * body chunk (skipped when empty) sharing an `i` identifier so kitty groups
 * them. Payloads are base64 (`e=1`), which sidesteps payload escaping and
 * keeps the sequence newline-free even for a multi-line body.
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

/** Wraps a raw escape in tmux's passthrough framing (`ESC Ptmux;` + sequence
 * with every ESC doubled + `ESC \`) so tmux forwards it to the attached client
 * instead of interpreting it. Requires `allow-passthrough`. */
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

/** Composes the final, passthrough-wrapped sequence for a payload, folding the
 * subtitle (event line) into the body via {@link foldSubtitleIntoBody}. */
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

/** Default tty writer: write-only and non-blocking, so a flow-controlled or
 * wedged pane can never hang the daemon (a full buffer throws EAGAIN, which
 * the caller swallows). */
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
 * `tty` (the bound pane's device). Fire-and-forget: a failed write (device
 * gone, EACCES, EAGAIN) is logged and dropped, never thrown.
 */
export function deliverOscNotification(
  payload: NotificationPayload,
  tty: string,
  deps: OscDeliverDeps,
): void {
  // Scope the sniff to the pane's own session (tmux resolves `-t %N` to its
  // session): a kitty client elsewhere on the server must not flip the format
  // for a session attached from a non-kitty terminal, which would drop it.
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
 * Reads tmux's global `allow-passthrough`. It's technically a pane option
 * (tmux 3.3+), but the documented way to enable it is `set -g`, inherited by
 * every pane; a pane-only setter reads as off here and gets the one-time
 * warning, an acceptable false negative.
 */
export function probeAllowPassthrough(
  runTmux: (args: string[]) => string | null,
): boolean {
  const value = runTmux(["show-options", "-gv", "allow-passthrough"]);
  if (value === null) return false;
  const trimmed = value.trim();
  return trimmed === "on" || trimmed === "all";
}
