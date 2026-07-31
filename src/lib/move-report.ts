import {
  dropStashCommand,
  type UntrackedMode,
} from "../daemon/worktree-move-changes";

/**
 * What a `withChanges` spawn relocated, as the daemon reports it.
 *
 * Every field but `moved` and `untracked` is optional because a daemon older
 * than this build answers without them; see `src/daemon/server.ts`.
 */
export interface MoveReport {
  moved: number;
  untracked: { mode: UntrackedMode; files: string[] };
  /**
   * The checkout the work came OUT of, absolute. Reported rather than assumed
   * to be the caller's directory: under `--fork` the daemon resolves it from
   * the forked session, so the two differ.
   */
  source?: string;
  leftoverStash?: string;
  /** The staged/unstaged split could not be preserved. */
  flattenedIndex?: boolean;
}

/** A failed move's recoverable leftovers, as the daemon reports them. */
export interface MoveFailure {
  /** The stash entry holding the user's work, when one was left in place. */
  stashSha?: string;
  sourceRestored?: boolean;
}

/**
 * What a completed move did, as lines.
 *
 * Shared by the CLI and the picker, and by the success path and a failure that
 * happened AFTER the move, because all four owe the user the same accounting:
 * the work has left their checkout either way, and a spawn that failed later
 * is exactly when they most need to be told where it went.
 *
 * The wording lives here rather than at each call site so the two surfaces
 * cannot drift into describing the same operation differently — the picker's
 * dialog and `ccmux spawn`'s stdout are read by the same people.
 */
export function moveReportLines(
  move: MoveReport,
  fallbackSource: string,
): string[] {
  const { moved, untracked, source, leftoverStash, flattenedIndex } = move;
  // Both halves are named even at zero, because "0 untracked files" is the
  // answer to "did it take my new files too" — the question `--untracked`
  // exists for.
  const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  const verb = untracked.mode === "copy" ? "copied" : "moved";
  const untrackedNote =
    untracked.mode === "leave"
      ? "untracked files left behind"
      : `${files(untracked.files.length)} untracked ${verb}`;
  const lines = [
    // The daemon's source, not the caller's directory: `--fork` resolves it
    // from the forked session, so naming the local one there would point at a
    // checkout nothing happened in.
    `Moved ${files(moved)} changed, ${untrackedNote}, out of ${source ?? fallbackSource}`,
  ];
  // A note, not an error: every edit is in the new worktree, but the staged
  // half arrived unstaged, and finding that out at commit time is worse than
  // reading one line here.
  if (flattenedIndex) {
    lines.push(
      "Everything moved, but not the staged/unstaged split: re-run 'git add' in the worktree for what you had staged.",
    );
  }
  // A successful move that could not drop its own backup. Harmless, but
  // silence would leave it to be found later as a stash entry nobody
  // remembers making.
  if (leftoverStash) {
    lines.push(
      `Left a redundant stash entry behind (${leftoverStash}); drop it with:`,
      `  ${dropStashCommand(leftoverStash)}`,
    );
  }
  return lines;
}

/**
 * The same accounting as {@link moveReportLines}' first line, minus the
 * directory, for somewhere a single short line is all there is.
 *
 * The source is what goes, because it is the longest part and the least
 * surprising: whoever is reading this asked for the move from that checkout a
 * moment ago. Everything the caveats cover (a leftover stash, a flattened
 * index) is deliberately absent — those need acknowledging, not summarizing.
 */
export function moveSummary(move: MoveReport): string {
  const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  const verb = move.untracked.mode === "copy" ? "copied" : "moved";
  const untracked =
    move.untracked.mode === "leave"
      ? "untracked left behind"
      : `${files(move.untracked.files.length)} untracked ${verb}`;
  return `moved ${files(move.moved)}, ${untracked}`;
}

/**
 * How to get the work back after a REFUSED move, as lines. Empty when the
 * failure left nothing behind to recover from.
 *
 * Which sentence applies turns on whether the source was restored: with the
 * changes back in the checkout the stash entry is a redundant copy, without
 * them it is the only one.
 */
export function stashRecoveryLines(failure: MoveFailure): string[] {
  if (!failure.stashSha) return [];
  if (failure.sourceRestored) {
    return [
      `Your changes are back in the checkout; stash entry ${failure.stashSha} still holds a copy. Drop it with:`,
      `  ${dropStashCommand(failure.stashSha)}`,
    ];
  }
  // `apply` takes a sha directly, unlike `drop`.
  return [
    `Your changes are in stash entry ${failure.stashSha}; recover them with 'git stash apply ${failure.stashSha}'.`,
  ];
}

/**
 * Whether a failed spawn left state the user now owns: work parked in a stash,
 * a source checkout that could not be put back, or a move that had already
 * completed when the spawn failed later.
 *
 * This is the difference between a message worth interrupting someone for and
 * an ordinary validation refusal they can act on in place.
 */
export function failureNeedsAcknowledgement(
  failure: MoveFailure & { move?: MoveReport },
): boolean {
  return (
    failure.stashSha !== undefined ||
    failure.sourceRestored === false ||
    failure.move !== undefined
  );
}

/**
 * Whether a COMPLETED move left something the user still has to act on: a
 * stash entry to drop, or a staged/unstaged split to rebuild. Both outlive the
 * spawn, so neither may be reported in a message that disappears on a timer.
 */
export function moveNeedsAcknowledgement(move: MoveReport): boolean {
  return move.leftoverStash !== undefined || move.flattenedIndex === true;
}
