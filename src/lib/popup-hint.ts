/**
 * Detecting the one case where ccmux should tell the user their tmux binding
 * is out of date: a picker running inside a `display-popup` that was given no
 * client tty, on a server with more than one client attached.
 *
 * That combination is exactly when a switch moves the wrong terminal. A popup
 * client's activity time does not advance while the popup is up (not even for
 * keys typed INTO the popup), so tmux's "current client" is whichever OTHER
 * attached client typed last. One client attached: harmless, tmux can only
 * pick that one. A captured tty: already fixed, nothing to say.
 */

import { readOwnTty } from "./tty";
import { hasCapturedTmuxClientTty } from "./tmux-client";
import { tmuxArgv } from "./tmux-exec";

export interface PopupHintInputs {
  /** A client tty arrived via `--client-tty` or `CCMUX_CLIENT_TTY`. */
  captured: boolean;
  /** Ttys of every attached client, or null when the query failed. */
  clientTtys: string[] | null;
  /** Our own controlling terminal, or null when we have none. */
  ownTty: string | null;
  /** `#{pane_tty}` of every pane on the server, or null when the query failed. */
  paneTtys: string[] | null;
}

/**
 * Pure predicate, so the three conditions are testable without tmux.
 *
 * A failed query answers "no": an unreadable tmux is not evidence the user's
 * binding is broken, and a hint that fires on noise is worse than one that
 * misses. Membership of `ownTty` in the pane list is the same test tmux's own
 * `cmd_find_inside_pane` runs, and its absence is what identifies a popup: a
 * popup's job pty belongs to no `window_pane`.
 */
export function shouldHintLegacyPopupBinding(inputs: PopupHintInputs): boolean {
  if (inputs.captured) return false;
  if (!inputs.clientTtys || inputs.clientTtys.length <= 1) return false;
  if (!inputs.ownTty || !inputs.paneTtys) return false;
  return !inputs.paneTtys.includes(inputs.ownTty);
}

export interface PopupHintDeps {
  listClientTtys: () => Promise<string[] | null>;
  listPaneTtys: () => Promise<string[] | null>;
  readTty: () => Promise<string | null>;
  hasCaptured: () => boolean;
}

/**
 * Gather the inputs and answer. The two tmux queries run ONLY when nothing was
 * captured, so a correctly bound picker pays nothing for this at startup.
 */
export async function detectLegacyPopupBinding(
  deps: PopupHintDeps,
): Promise<boolean> {
  if (deps.hasCaptured()) return false;
  const [clientTtys, paneTtys, ownTty] = await Promise.all([
    deps.listClientTtys(),
    deps.listPaneTtys(),
    deps.readTty(),
  ]);
  return shouldHintLegacyPopupBinding({
    captured: false,
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

export function defaultPopupHintDeps(): PopupHintDeps {
  return {
    listClientTtys: () => listTmuxTtys(["list-clients", "-F", "#{client_tty}"]),
    listPaneTtys: () => listTmuxTtys(["list-panes", "-a", "-F", "#{pane_tty}"]),
    readTty: () => readOwnTty(),
    hasCaptured: hasCapturedTmuxClientTty,
  };
}
