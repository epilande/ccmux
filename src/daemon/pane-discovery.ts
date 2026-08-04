import type { TmuxPane } from "../types/session";
import type { ProcessTree } from "./process-tree";
import { DaemonPerf } from "./perf";
import { PANE_FIELD_SEP } from "../lib/tmux-format";
import { tmuxArgv } from "../lib/tmux-exec";
import { attemptedTmuxSocketPath } from "../lib/tmux-socket";

/**
 * Thrown by {@link scanTmuxPanesOrThrow} when `tmux list-panes` itself fails
 * (spawn threw, or non-zero exit that is not the genuine "no server running"
 * condition). The tmux-side analogue of `ProcessDiscoveryError`.
 */
export class PaneDiscoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PaneDiscoveryError";
  }
}

/**
 * tmux's "there is no server, hence no panes" stderr shapes. These are the
 * one legitimately-empty non-zero exit: the user simply has no tmux running.
 * Anything else non-zero is a discovery failure.
 */
const TMUX_NO_SERVER_RE = /no server running|error connecting to/;

/**
 * One pane listing: the panes, plus tmux's own words when there was no server
 * to list them from.
 *
 * `noServer` is a REASON, not an alternative outcome. "No server running" is a
 * legitimately-empty scan, so `panes` is `[]` and callers proceed exactly as
 * they would for a server with no panes — reaping dead sessions depends on
 * that. It is carried out separately only because a server that dies AFTER the
 * daemon resolved its socket never throws, so nothing else tells `/server-info`
 * the socket it is serving is dead.
 */
export type PaneScan = {
  panes: TmuxPane[];
  noServer: string | null;
};

/**
 * List all tmux panes.
 *
 * THROWS {@link PaneDiscoveryError} on a hard `tmux` failure (spawn threw, or
 * a non-zero exit whose stderr is not the "no server running" condition). A
 * genuinely-empty result (no tmux server) still returns no panes, reported as
 * a {@link PaneScan} with `noServer` set. The scan loop uses this variant so a
 * transient tmux hiccup skips the cycle rather than being read as "every pane
 * vanished", which would let cleanup unbind or remove every pane-bound session
 * in one pass (this exact gap; the two-scan hysteresis is the backstop, this
 * is the observation-layer guard). Callers that prefer fail-soft behavior use
 * {@link listTmuxPanes}.
 */
export async function scanTmuxPanesOrThrow(): Promise<PaneScan> {
  let output: string;
  let stderr: string;
  let exitCode: number;
  try {
    DaemonPerf.incSubprocessSpawn("tmux-list-panes");
    const proc = Bun.spawn(
      tmuxArgv(
        "list-panes",
        "-a",
        "-F",
        // tmux exposes activity timestamps at window scope, not pane scope:
        // `#{window_activity}` is documented; `#{pane_activity}` is not a
        // tmux format variable (verified against tmux 3.6a man page) and
        // expands to an empty string. Window-level granularity means a
        // window with N panes will re-trigger the gate in state-reconciler
        // when ANY of those panes update; for the common case of one
        // full-screen agent per window that's exact.
        //
        // Fields are joined with PANE_FIELD_SEP (not a tab): under a non-UTF-8
        // locale tmux rewrites tab/control bytes in format output, which would
        // corrupt the positional split below. See src/lib/tmux-format.ts.
        [
          "#{pane_id}",
          "#{pane_pid}",
          "#{session_name}",
          "#{window_index}",
          "#{pane_index}",
          "#{pane_tty}",
          "#{pane_start_time}",
          "#{window_activity}",
          "#{pane_title}",
          "#{pane_current_command}",
          "#{pane_current_path}",
        ].join(PANE_FIELD_SEP),
      ),
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    exitCode = await proc.exited;
  } catch (error) {
    throw new PaneDiscoveryError(
      `tmux list-panes failed to run: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (exitCode !== 0) {
    if (TMUX_NO_SERVER_RE.test(stderr)) {
      return { panes: [], noServer: stderr.trim() || "no server running" };
    }
    // Name the server: with a socket override in play, "exited 1" alone leaves
    // the user unable to tell a broken tmux from a misaimed one.
    throw new PaneDiscoveryError(
      `tmux list-panes on ${attemptedTmuxSocketPath()} exited ${exitCode}: ` +
        `${stderr.trim() || "(no stderr)"}`,
    );
  }

  if (!output.trim()) {
    return { panes: [], noServer: null };
  }

  const panes: TmuxPane[] = [];

  for (const line of output.trim().split("\n")) {
    const [
      paneId,
      panePidStr,
      sessionName,
      windowIndexStr,
      paneIndexStr,
      paneTty,
      startTimeStr,
      windowActivityStr,
      paneTitle,
      currentCommand,
      currentPath,
    ] = line.split(PANE_FIELD_SEP);

    const panePid = parseInt(panePidStr, 10);
    const windowIndex = parseInt(windowIndexStr, 10);
    const paneIndex = parseInt(paneIndexStr, 10);
    const startTime = parseInt(startTimeStr, 10);
    const windowActivity = parseInt(windowActivityStr, 10);

    // Single-server invariant: `list-panes -a` yields `%N` ids from the one
    // server this daemon targets (its configured socket override, else the one
    // its env points at). `%N` collides across servers, so consumers refuse a
    // cross-server target by comparing the socket from `GET /server-info`
    // (src/lib/tmux-server.ts). Server-qualified ids are a non-goal until
    // multi-server support.
    if (!isNaN(panePid) && paneId) {
      panes.push({
        paneId,
        panePid,
        sessionName,
        windowIndex,
        paneIndex,
        target: `${sessionName}:${windowIndex}.${paneIndex}`,
        tty: paneTty || null,
        startTime: isNaN(startTime) ? null : startTime,
        windowActivity: isNaN(windowActivity) ? null : windowActivity,
        paneTitle: paneTitle || null,
        currentCommand: currentCommand || null,
        currentPath: currentPath || null,
      });
    }
  }

  return { panes, noServer: null };
}

/**
 * Fail-soft pane listing: any discovery failure reads as "no panes".
 * Appropriate for one-shot CLI paths and boot fallbacks; the scan loop must
 * use {@link scanTmuxPanesOrThrow} instead (see its doc for why).
 */
export async function listTmuxPanes(): Promise<TmuxPane[]> {
  try {
    return (await scanTmuxPanesOrThrow()).panes;
  } catch {
    return [];
  }
}

/**
 * Normalize TTY for comparison
 * Converts "/dev/ttys061" to "ttys061" and handles various formats
 */
export function normalizeTty(tty: string | null | undefined): string | null {
  if (!tty) return null;
  return tty.replace(/^\/dev\//, "");
}

/**
 * Walk `pid`'s ancestry, return the first pane whose `panePid` is an
 * ancestor, or null if the PID isn't hosted by any pane. Pure so the
 * caller can supply a pre-built `ProcessTree` and test without spawning
 * `ps`.
 */
export function findPaneHostingPid(
  pid: number,
  panes: readonly TmuxPane[],
  processTree: ProcessTree,
): TmuxPane | null {
  if (panes.length === 0) return null;

  const paneByPid = new Map<number, TmuxPane>();
  for (const pane of panes) paneByPid.set(pane.panePid, pane);

  const visited = new Set<number>();
  let current: number | undefined = pid;
  while (current != null && current > 1 && !visited.has(current)) {
    visited.add(current);
    const pane = paneByPid.get(current);
    if (pane) return pane;
    current = processTree.getProcess(current)?.ppid;
  }
  return null;
}
