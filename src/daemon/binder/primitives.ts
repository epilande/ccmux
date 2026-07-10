import { join } from "path";
import type { ProcessInfo, TmuxPane } from "../../types/session";
import { normalizeTty } from "../pane-discovery";
import type { ProcPaneMatch } from "./types";

/**
 * Encode a path the same way Claude names its `~/.claude/projects/<dir>`
 * directories: every character that is NOT ASCII alphanumeric is replaced with
 * a single `-` (no collapsing of runs). This must match Claude byte-for-byte or
 * the cwd<->log-directory comparisons in matching/cleanup silently miss.
 *
 * Crucially this includes `.` (and space, etc.), not just `/` and `_`:
 *   "/Users/name/project_name" -> "-Users-name-project-name"
 *   "/Users/name/.dotfiles"    -> "-Users-name--dotfiles"   (the `/` and `.` each map to a dash)
 *   "/Users/name/app.v2"       -> "-Users-name-app-v2"
 * Verified against real on-disk dirs (e.g. `~/.claude/projects/-Users-...--dotfiles`).
 * Encoding is many-to-one (Claude's own collision); it is a grouping
 * pre-filter, never an authoritative identity key.
 */
export function encodeProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Locate a Claude session's transcript across one or more `projects` trees.
 *
 * A session started under a non-default `CLAUDE_CONFIG_DIR` writes its
 * transcript to that account's `projects` tree, so probe each dir in order and
 * return the first whose `<encoded-cwd>/<sessionId>.jsonl` exists. Falls back to
 * the first (primary) dir's path when none exists yet — the transcript may not
 * be written until the first turn — preserving single-dir behavior.
 *
 * Pure: `fileExists` is injected so it can be unit-tested without a filesystem.
 */
export function resolveExistingLogPath(
  projectDirs: string[],
  cwd: string,
  sessionId: string,
  fileExists: (path: string) => boolean,
): string {
  const rel = join(encodeProjectPath(cwd), `${sessionId}.jsonl`);
  for (const dir of projectDirs) {
    const candidate = join(dir, rel);
    if (fileExists(candidate)) return candidate;
  }
  return join(projectDirs[0] ?? "", rel);
}

/**
 * The soft-evict rule, defined once: when `claimant` takes `paneId`, any OTHER session with the same
 * agentType currently holding that pane loses its claim. Returns the
 * sessions to evict; each caller applies its own mutation
 * (`SessionManager.setTmuxPane` clears pane+pid and emits events; the
 * binder's working models clear their local copies). Keeping the *rule*
 * here and the *mutation* at the call sites is what lets the pure binder
 * and the stateful manager share one definition instead of three drifting
 * copies.
 *
 * Scope: a pane can host at most one process of a given agent,
 * so any same-agent claim on the pane yields to the new evidence-backed
 * claimant regardless of cwd — a stale claim from a *different* cwd must
 * not keep two rows pointing at one pane or block the pane's real session.
 * Cross-AGENT claims are deliberately spared: a pane can legitimately host
 * nested agents (e.g. codex launched from inside a claude session), and
 * evicting across agent types would make their rows thrash every scan.
 */
export function findSoftEvictTargets<
  S extends {
    id: string;
    agentType: string;
    cwd: string | null;
    tmuxPane: string | null;
  },
>(sessions: Iterable<S>, claimant: S, paneId: string): S[] {
  const evicted: S[] = [];
  for (const other of sessions) {
    if (
      other.id !== claimant.id &&
      other.agentType === claimant.agentType &&
      other.tmuxPane === paneId
    ) {
      evicted.push(other);
    }
  }
  return evicted;
}

/**
 * Pair each process with the pane whose tty it owns. Processes without
 * cwd/tty, or whose tty matches no pane, are dropped. The flat form feeds
 * raw-cwd candidate selection; the encoded map below is the
 * pre-filter for sessions whose raw cwd is not yet known.
 */
export function pairProcsWithPanes(
  processes: readonly ProcessInfo[],
  panes: readonly TmuxPane[],
): ProcPaneMatch[] {
  const matches: ProcPaneMatch[] = [];
  for (const proc of processes) {
    if (!proc.cwd || !proc.tty) continue;
    const procTty = normalizeTty(proc.tty);
    const matchingPane = panes.find((p) => normalizeTty(p.tty) === procTty);
    if (matchingPane) {
      matches.push({ proc, pane: matchingPane });
    }
  }
  return matches;
}

/**
 * Group tty-paired processes by encoded project path. This is the shared
 * cwd→(proc,pane) index behind ladders 2 and 3 for sessions whose raw cwd
 * is unknown (no transcript entries yet); when the raw cwd IS known,
 * candidates come from `pairProcsWithPanes` filtered on exact raw cwd
 * instead (encoding is many-to-one, so the encoded key can both
 * collide siblings and, under Claude-side encoding drift, miss entirely).
 */
export function buildProcPaneMapByEncodedCwd(
  processes: readonly ProcessInfo[],
  panes: readonly TmuxPane[],
): Map<string, ProcPaneMatch[]> {
  const cwdToProcsMap = new Map<string, ProcPaneMatch[]>();
  for (const match of pairProcsWithPanes(processes, panes)) {
    const encodedCwd = encodeProjectPath(match.proc.cwd!);
    const existing = cwdToProcsMap.get(encodedCwd) || [];
    existing.push(match);
    cwdToProcsMap.set(encodedCwd, existing);
  }

  return cwdToProcsMap;
}
