/**
 * Shared fixtures for building canned `ps -axo pid,ppid,comm` output to feed
 * `ProcessTree.fromPsOutput()` in tests, without spawning a real `ps`.
 *
 * Used by process-tree.test.ts and state-reconciler.test.ts.
 */

/** Header row `fromPsOutput` discards (mirrors real `ps -axo pid,ppid,comm`). */
export const PS_HEADER = "  PID  PPID COMM";

/** One `ps` output line for the given pid/ppid/comm. */
export function psLine(pid: number, ppid: number, comm: string): string {
  return `${pid} ${ppid} ${comm}`;
}
