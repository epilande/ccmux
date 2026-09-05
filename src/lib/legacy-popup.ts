/**
 * Detecting the one case where ccmux must refuse to switch a client rather
 * than guess one: a picker running inside a `display-popup` that was given no
 * client tty, on a server with more than one client attached.
 *
 * That combination is exactly when a switch moves the wrong terminal. A popup
 * client's activity time does not advance while the popup is up (not even for
 * keys typed INTO the popup), so tmux's "current client" is whichever OTHER
 * attached client typed last. One client attached: harmless, tmux can only
 * pick that one. A captured tty: already fixed, so the resolver never asks.
 *
 * Evaluated at switch time by {@link resolvePinnedTmuxClientTty}, not at
 * startup: clients attach and detach while a picker is open, and a snapshot
 * taken at mount is wrong in both directions by the time Enter is pressed.
 */

import { readOwnTty } from "./tty";
import { tmuxArgv } from "./tmux-exec";

/**
 * How long any one of the three probes may take before it is treated as
 * unanswered. They sit in front of every uncaptured switch, so a wedged tmux
 * server must not wedge the key that gets the user out of the picker.
 */
const PROBE_TIMEOUT_MS = 500;

export interface LegacyPopupInputs {
  /** `$TMUX` is set, so this process was launched by tmux itself. */
  insideTmux: boolean;
  /** Ttys of every attached client, or null when the query failed. */
  clientTtys: string[] | null;
  /** Our own controlling terminal, or null when we have none. */
  ownTty: string | null;
  /** `#{pane_tty}` of every pane on the server, or null when the query failed. */
  paneTtys: string[] | null;
}

/**
 * Pure predicate, so the four conditions are testable without tmux.
 *
 * A failed query answers "no": an unreadable tmux is not evidence the user's
 * binding is broken, and refusing on noise is worse than the guess. Membership
 * of `ownTty` in the pane list is the same test tmux's own
 * `cmd_find_inside_pane` runs, and its absence is what identifies a popup: a
 * popup's job pty belongs to no `window_pane`.
 *
 * `insideTmux` is what keeps a plain terminal out of it. A ccmux started
 * outside tmux has no pane either, and `list-clients` answers from anywhere on
 * the machine, so without this test a bare `ccmux` in a second terminal would
 * look exactly like a legacy popup and lose its switch entirely.
 */
export function isLegacyPopupLaunch(inputs: LegacyPopupInputs): boolean {
  if (!inputs.insideTmux) return false;
  if (!inputs.clientTtys || inputs.clientTtys.length <= 1) return false;
  if (!inputs.ownTty || !inputs.paneTtys) return false;
  return !inputs.paneTtys.includes(inputs.ownTty);
}

export interface LegacyPopupDeps {
  listClientTtys: () => Promise<string[] | null>;
  listPaneTtys: () => Promise<string[] | null>;
  readTty: () => Promise<string | null>;
}

/** Give up on a probe rather than hold up the switch behind it. A timed-out
 *  query reads as unanswered, which the predicate already treats as "not
 *  evidence of a legacy popup". */
async function withTimeout<T>(
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
 * Gather the inputs and answer. Nothing is spawned outside tmux, which is both
 * the cheap answer and the correct one.
 */
export async function detectLegacyPopupLaunch(
  deps: LegacyPopupDeps,
): Promise<boolean> {
  if (process.env.TMUX === undefined) return false;
  const [clientTtys, paneTtys, ownTty] = await Promise.all([
    withTimeout(deps.listClientTtys(), PROBE_TIMEOUT_MS),
    withTimeout(deps.listPaneTtys(), PROBE_TIMEOUT_MS),
    withTimeout(deps.readTty(), PROBE_TIMEOUT_MS),
  ]);
  return isLegacyPopupLaunch({
    insideTmux: true,
    clientTtys,
    ownTty,
    paneTtys,
  });
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

export function defaultLegacyPopupDeps(): LegacyPopupDeps {
  return {
    listClientTtys: () => listTmuxTtys(["list-clients", "-F", "#{client_tty}"]),
    listPaneTtys: () => listTmuxTtys(["list-panes", "-a", "-F", "#{pane_tty}"]),
    readTty: () => readOwnTty(),
  };
}
