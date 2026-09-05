/**
 * tmux *client* (not pane) queries, shared by consumers that need to act on
 * behalf of "whatever terminal the user is attached with" rather than a
 * specific pane:
 *
 * - `ccmux switch` (`src/commands/switch.ts`) falls back to these when
 *   invoked outside tmux (no `$TMUX`, so no implicit current client) - e.g.
 *   a notification click from Notification Center.
 * - The daemon's notification delivery wrapper (`src/daemon/notify-delivery.ts`)
 *   reuses the same client for background-session click targets
 *   (`display-popup -c`) and for resolving the frontmost-terminal bundle id.
 * - The TUI's switch and background-window paths (`src/tui/utils/`) resolve the
 *   client they were launched by, and the session it is attached to.
 *
 * No dependency injection (bare `Bun.spawn`, argv from the shared builder) to
 * match this file's sibling `tmux-server.ts` and the daemon's `pane-io.ts`;
 * tests stub `Bun.spawn` globally instead.
 */

import {
  defaultLegacyPopupDeps,
  detectLegacyPopupLaunch,
} from "./legacy-popup";
import { tmuxArgv } from "./tmux-exec";
import { PANE_FIELD_SEP } from "./tmux-format";

/**
 * The only accepted shape for a tmux client tty. tmux reports
 * `#{client_tty}` as an absolute device path (`/dev/ttys004` on macOS,
 * `/dev/pts/3` on Linux), and callers may pass it straight into a tmux argv.
 */
export const CLIENT_TTY_PATTERN = /^\/dev\/[A-Za-z0-9._/-]{1,64}$/;

/**
 * The pid of the tmux client attached to the current session context (i.e.
 * `$TMUX`'s session, or - when invoked from inside a pane - the one
 * `display-message` resolves by default). Returns null on any query failure
 * or when no client is present.
 */
export async function getActiveTmuxClientPid(): Promise<number | null> {
  try {
    const proc = Bun.spawn(tmuxArgv("display-message", "-p", "#{client_pid}"), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const pid = parseInt(output.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * A tmux client tty for the CURRENT context, from `#{client_tty}`. Only
 * meaningful with `$TMUX` set; outside tmux there is no current context and
 * {@link resolveActiveTmuxClientTty} is the right fallback.
 *
 * Deliberately not the pane's own tty: `#{client_tty}` is a CLIENT's device
 * (`/dev/ttys085`), while the pane runs on its own pty (`/dev/ttys079`), and
 * only the former is a valid `switch-client -c` target.
 *
 * NOT a promise that the answer belongs to the caller's session. tmux resolves
 * the current client with `cmd_find_best_client`, which prefers a client of
 * the resolved session but FALLS BACK to the most-recently-active client of
 * any session when that session has none attached. So a pane in a detached
 * session yields some other session's terminal, and anything that would MOVE
 * the returned client (`ccmux spawn`'s cross-session switch) has to verify
 * membership itself with {@link listTmuxClientTtys} — otherwise it yanks a
 * client that was never involved. Verified live on tmux 3.6a.
 */
export async function resolveCurrentTmuxClientTty(): Promise<string | null> {
  try {
    const proc = Bun.spawn(tmuxArgv("display-message", "-p", "#{client_tty}"), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const tty = output.trim();
    return tty || null;
  } catch {
    return null;
  }
}

/**
 * The ttys of the clients attached to one session, for callers that must know
 * whether a given client is actually looking at it. An empty array is a real
 * answer (nobody is attached); `null` means the query failed and nothing
 * should be concluded from it.
 *
 * `-t` is what makes this a membership test rather than a popularity contest:
 * unlike `#{client_tty}`, `list-clients -t` has no best-effort fallback, so a
 * detached session returns nothing at all.
 */
export async function listTmuxClientTtys(
  sessionId: string,
): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(
      tmuxArgv("list-clients", "-t", sessionId, "-F", "#{client_tty}"),
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

/**
 * The tty of the most-recently-active attached tmux client (highest
 * `#{client_activity}` wins), for callers with no implicit current client
 * (invoked outside tmux entirely, e.g. a notification click). Returns null
 * when no client is attached or the query fails.
 */
export async function resolveActiveTmuxClientTty(): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      tmuxArgv("list-clients", "-F", "#{client_activity} #{client_tty}"),
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    let bestActivity = -Infinity;
    let bestTty: string | null = null;
    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) continue;
      const activity = Number(line.slice(0, spaceIdx));
      const tty = line.slice(spaceIdx + 1).trim();
      if (!tty || Number.isNaN(activity)) continue;
      if (activity > bestActivity) {
        bestActivity = activity;
        bestTty = tty;
      }
    }
    return bestTty;
  } catch {
    return null;
  }
}

/** Which session a client is attached to, so a `new-window` can be aimed at
 *  it. Returns null on any failure, which the caller turns into a REFUSAL
 *  rather than an untargeted window: see `openDedupedCommandWindow`.
 *
 *  The placement matters because a popup's command client has no pane of its
 *  own, so an untargeted `new-window` falls through to tmux's
 *  `cmd_find_best_session`: the session with the newest activity time, which
 *  every keypress bumps. With two clients attached and the OTHER one typing
 *  last, the window is born in a session its owner never asked for, and the
 *  pinned `switch-client` then drags our client into someone else's session
 *  (where the next dedupe pass also finds the window). Same wrong guess the
 *  client pinning exists to avoid, one level up.
 *
 *  It has to be an UNTARGETED listing matched on the tty here, because the two
 *  obvious shortcuts both answer the wrong question:
 *   - `display-message -c <tty> "#{session_id}"` names the client only for
 *     DELIVERY. The format is still expanded against the default target
 *     session, which is that same most-recently-active session, so under the
 *     exact two-client split this exists to fix it hands back the OTHER
 *     client's session (measured on 3.6a: `-c` A answers B's `$1`).
 *   - `-t` on `list-clients` is a target SESSION, not a client. A tty there
 *     fails outright on our documented 3.2 floor, and even where a later tmux
 *     resolves one it lists every client of THAT SESSION, so the tty match has
 *     to happen here regardless. */
export async function resolveTmuxClientSessionId(
  clientTty: string,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      tmuxArgv(
        "list-clients",
        "-F",
        ["#{client_tty}", "#{session_id}"].join(PANE_FIELD_SEP),
      ),
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    for (const line of out.split("\n")) {
      const [tty, sessionId] = line.split(PANE_FIELD_SEP);
      if (tty !== clientTty) continue;
      return sessionId && /^\$\d+$/.test(sessionId) ? sessionId : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The client tty captured by the tmux binding that launched us, set from
 * `ccmux --client-tty <tty>` before the TUI mounts. Module-level rather than
 * threaded through every caller because it is a process-wide fact about how
 * this ccmux was invoked, exactly like `CCMUX_CLIENT_TTY` is. Pass `undefined`
 * to clear it (tests).
 */
let pinnedClientTty: string | undefined;

export function setPinnedTmuxClientTty(value: string | undefined): void {
  pinnedClientTty = value;
}

/** Why a resolve produced no client tty. Each one wants its own message: they
 *  blame different things, and only two of them blame a tmux binding. */
export type ClientTtyRefusal =
  /** A tty was captured, but it is not a device path (broken binding). */
  | "malformed-capture"
  /** A popup with no captured tty, several clients attached (old binding). */
  | "legacy-popup"
  /** Nothing captured and tmux names no current client (no binding to blame). */
  | "no-client";

/** A validated tty safe to pass as `switch-client -c`, or the reason there is
 *  none. Refusals are a closed set so callers cannot collapse them into one
 *  message. */
export type ResolvedClientTty =
  | { tty: string; refusal?: undefined }
  | { tty: null; refusal: ClientTtyRefusal };

/**
 * The one client tty every ccmux surface should act on behalf of:
 * `--client-tty` first, then `CCMUX_CLIENT_TTY`, then whatever tmux calls the
 * current client.
 *
 * A captured value is never fallen through on. `#{client_tty}` inside a popup
 * resolves to whichever OTHER attached client typed last (a popup's own
 * keystrokes do not advance its client's activity time), so silently
 * substituting the guess for a malformed capture would move a client the user
 * never touched. A capture that fails {@link CLIENT_TTY_PATTERN} means the
 * user's tmux binding is broken, and they should hear about it.
 *
 * With nothing captured the guess is only usable when it cannot be that same
 * wrong client, so {@link detectLegacyPopupLaunch} runs alongside it and
 * outranks it. The two are concurrent because the probes cost nothing next to
 * the round trip, and this runs on the keypress rather than at launch so that
 * a client attaching or detaching mid-session is seen.
 */
export async function resolvePinnedTmuxClientTty(): Promise<ResolvedClientTty> {
  const captured = pinnedClientTty ?? process.env.CCMUX_CLIENT_TTY;
  if (captured !== undefined) {
    if (CLIENT_TTY_PATTERN.test(captured)) return { tty: captured };
    return { tty: null, refusal: "malformed-capture" };
  }
  const [current, legacyPopup] = await Promise.all([
    resolveCurrentTmuxClientTty(),
    detectLegacyPopupLaunch(defaultLegacyPopupDeps()),
  ]);
  if (legacyPopup) return { tty: null, refusal: "legacy-popup" };
  if (current && CLIENT_TTY_PATTERN.test(current)) return { tty: current };
  return { tty: null, refusal: "no-client" };
}
