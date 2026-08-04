/**
 * Recognizing an agent worktree by its PATH.
 *
 * Both conventions live under the same parent directory: Claude Code's Agent
 * tool isolates a teammate into `<repo>/.claude/worktrees/agent-<id>`, and
 * ccmux's own `--worktree` spawns write `<repo>/.claude/worktrees/<slug>`.
 *
 * Path shape is a heuristic, and it is used here only where the alternative
 * is nothing at all: git cannot be consulted synchronously on a hot update
 * path, and the transcript entries these rules exist to recognize carry no
 * marker of their own (verified against a live transcript: the parent's
 * entries that name an agent worktree have `isSidechain: false` and no
 * `agentId`, so there is nothing structural to key on).
 *
 * In `src/lib` rather than beside either caller because `sessions.ts` and the
 * Claude log adapter both need it, and the adapter already imports
 * `sessions.ts` — putting it in either would make that a cycle.
 */

/**
 * The worktree checkout a path belongs to (`…/.claude/worktrees/<name>`),
 * or null when it is not inside one. A path that IS the checkout root
 * answers itself.
 */
export function worktreeCheckoutRoot(path: string | null): string | null {
  if (!path) return null;
  const match = path.match(/^(.*\/\.claude\/worktrees\/[^/]+)(?:\/|$)/);
  return match ? match[1] : null;
}

/** Whether a path is inside (or is) an agent worktree checkout. */
export function isWorktreeCheckoutPath(path: string | null): boolean {
  return worktreeCheckoutRoot(path) !== null;
}
