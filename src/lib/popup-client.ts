/**
 * Working out which tmux client opened the `display-popup` a ccmux surface is
 * running in, without the binding having to say.
 *
 * Inside a popup, `#{client_tty}` is not the client that opened it: a popup
 * client's activity time does not advance while the popup is up (not even for
 * keys typed INTO the popup), so tmux's "current client" is whichever OTHER
 * attached client typed last. Acting on that guess moves a terminal the user
 * never touched.
 *
 * `$TMUX` knows more. tmux sets it per popup as
 * `<socket path>,<server pid>,<session id number>`, and the third field is the
 * session the popup command TARGETS. For a binding with no `-t` (the one the
 * README documents) that is the session the pressing client was looking at, so
 * the clients of that one session, `list-clients -t $<n>`, are the candidates,
 * and when the session has exactly one attached client that client is the
 * launcher. Measured on 3.6a, popup opened from the less recently active of two
 * clients.
 *
 * A binding that DOES name another session with `-t` is the limit of this: the
 * third field then names that target, and the client we resolve belongs to it
 * rather than to whoever pressed the key. Such a binding has to pass
 * `--client-tty` to be pinned.
 *
 * This module reports facts and never decides: it says whether the launch is a
 * popup and, if so, which clients the launching session has. What to do with
 * one, several or none of them lives with the refusals, in
 * {@link resolvePinnedTmuxClientTty} (`tmux-client.ts`).
 *
 * Evaluated at switch time, not at startup: clients attach and detach while a
 * picker is open, and a snapshot taken at mount is wrong in both directions by
 * the time Enter is pressed.
 */

import { readOwnTty } from "./tty";
import { tmuxArgv } from "./tmux-exec";
import { currentTmuxSocket } from "./tmux-server";

/**
 * How long any one probe may take before it is treated as unanswered. They sit
 * in front of every uncaptured switch, so a wedged tmux server must not wedge
 * the key that gets the user out of the picker.
 *
 * Exported because the resolver in `tmux-client.ts` puts its own
 * `#{client_tty}` guess on the same clock. That query runs alongside these and
 * is just as capable of hanging, so a budget that covered only the three
 * probes would leave the claim above untrue.
 */
export const PROBE_TIMEOUT_MS = 500;

export interface PopupLaunchInputs {
  /** `$TMUX` is set, so this process was launched by tmux itself. */
  insideTmux: boolean;
  /** Our own controlling terminal, or null when we have none. */
  ownTty: string | null;
  /** `#{pane_tty}` of every pane on the server, or null when the query failed. */
  paneTtys: string[] | null;
}

/**
 * Pure predicate, so the conditions are testable without tmux.
 *
 * A failed query answers "no": an unreadable tmux is not evidence of a popup,
 * and the caller's fallback (tmux's own current client) is right far more often
 * than it is wrong outside one. Membership of `ownTty` in the pane list is the
 * same test tmux's own `cmd_find_inside_pane` runs, and its absence is what
 * identifies a popup: a popup's job pty belongs to no `window_pane`.
 *
 * `insideTmux` is what keeps a plain terminal out of it. A ccmux started
 * outside tmux has no pane either, and `list-panes` answers from anywhere on
 * the machine, so without this test a bare `ccmux` in a second terminal would
 * look exactly like a popup.
 */
export function isPopupLaunch(inputs: PopupLaunchInputs): boolean {
  if (!inputs.insideTmux) return false;
  if (!inputs.ownTty || !inputs.paneTtys) return false;
  return !inputs.paneTtys.includes(inputs.ownTty);
}

/**
 * The session id `$TMUX` names, as a tmux target (`$0`), or null when there is
 * no `$TMUX` or its third field is not a session number.
 *
 * Strict about digits because the value goes on to be a tmux target: `$` plus
 * whatever the environment happened to hold is not something to hand a command
 * line, and a shape we do not recognize is a reason to know nothing rather than
 * to guess.
 */
export function parsePopupSessionId(
  tmuxEnv: string | undefined,
): string | null {
  if (!tmuxEnv) return null;
  const field = tmuxEnv.split(",")[2]?.trim();
  if (!field || !/^\d+$/.test(field)) return null;
  return `$${field}`;
}

/**
 * Is the server our tmux calls go to the same one that set `$TMUX`?
 *
 * The popup's identity comes out of `$TMUX`, but the queries go to the server
 * named by {@link currentTmuxSocket} (a configured socket override, else the
 * ambient one). When those differ, the client listing would describe a server
 * this process is not running inside, and nothing it said about a popup would
 * mean anything.
 *
 * In practice a client inside tmux ignores the override (see
 * `activeTmuxSocketOverride`), so the two agree; this is the guard for the
 * cases where they cannot, not a routine branch.
 */
function popupServerMatchesOwn(tmuxEnv: string): boolean {
  const own = currentTmuxSocket();
  const popup = tmuxEnv.split(",")[0]?.trim();
  return Boolean(own && popup && own === popup);
}

export interface PopupClientDeps {
  /** `#{pane_tty}` of every pane on the server, or null when the query failed. */
  listPaneTtys: () => Promise<string[] | null>;
  /** Our own controlling terminal, or null when we have none. */
  readTty: () => Promise<string | null>;
  /** Ttys of the clients attached to one session, null when the query failed. */
  listSessionClientTtys: (sessionId: string) => Promise<string[] | null>;
}

/** What the probes could establish about this launch. */
export type PopupClientLookup =
  /** Not a popup (a real pane, or not inside tmux at all). */
  | { kind: "not-popup" }
  /**
   * A popup, and these are the clients attached to the session that launched
   * it. May be empty; the caller decides what one, several or none mean.
   */
  | { kind: "clients"; ttys: string[] }
  /**
   * A popup we can say nothing useful about: `$TMUX` in a shape we do not
   * recognize, a server that is not the one we query, or a query that failed
   * or never answered.
   */
  | { kind: "unknown" };

/** Give up on a probe rather than hold up the switch behind it. A timed-out
 *  query reads as unanswered, the same as one that failed, and every caller
 *  already has an arm for that. Exported for the resolver's current-client
 *  guess, which shares this budget. */
export async function withTimeout<T>(
  probe: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Gather the facts and report them. Nothing is spawned outside tmux, which is
 * both the cheap answer and the correct one.
 *
 * The probes run concurrently, including the client listing that only matters
 * if this turns out to be a popup: the session id comes from the environment,
 * so the query needs nothing the other two produce, and one round trip on a
 * keypress is the whole budget. A server mismatch skips that one query, since
 * the session it would name is not on the server we would ask.
 *
 * "Not a popup" is decided BEFORE the server mismatch: a plain pane keeps the
 * caller's ordinary fallback even when the two servers disagree, because the
 * current client is unambiguous there whichever server answers. Only a launch
 * that looks like a popup turns a mismatch into "we know nothing", which is the
 * arm that must not become a guess.
 */
export async function resolvePopupClient(
  deps: PopupClientDeps,
): Promise<PopupClientLookup> {
  const tmuxEnv = process.env.TMUX;
  if (tmuxEnv === undefined) return { kind: "not-popup" };

  const sameServer = popupServerMatchesOwn(tmuxEnv);
  const sessionId = sameServer ? parsePopupSessionId(tmuxEnv) : null;
  const [paneTtys, ownTty, sessionClients] = await Promise.all([
    withTimeout(deps.listPaneTtys(), PROBE_TIMEOUT_MS),
    withTimeout(deps.readTty(), PROBE_TIMEOUT_MS),
    sessionId
      ? withTimeout(deps.listSessionClientTtys(sessionId), PROBE_TIMEOUT_MS)
      : Promise.resolve(null),
  ]);

  if (!isPopupLaunch({ insideTmux: true, ownTty, paneTtys })) {
    return { kind: "not-popup" };
  }
  if (!sameServer) return { kind: "unknown" };
  if (!sessionClients) return { kind: "unknown" };
  return { kind: "clients", ttys: sessionClients };
}

/** Split a tmux `-F` listing into non-empty trimmed lines. */
function ttyLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function listTmuxTtys(args: string[]): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(tmuxArgv(...args), {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return ttyLines(output);
  } catch {
    return null;
  }
}

/**
 * The two probes this module owns. The third, the per-session client listing,
 * is injected by the caller: it is `listTmuxClientTtys` from `tmux-client.ts`,
 * and passing it in keeps these two modules pointing one way.
 */
export function defaultPopupProbeDeps(): Omit<
  PopupClientDeps,
  "listSessionClientTtys"
> {
  return {
    listPaneTtys: () => listTmuxTtys(["list-panes", "-a", "-F", "#{pane_tty}"]),
    readTty: () => readOwnTty(),
  };
}
