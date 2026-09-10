import { join } from "path";
import type { ProcessInfo, TmuxPane } from "../../types/session";
import { normalizeTty } from "../pane-discovery";
import type { ProcPaneMatch, ProcessTreeLike } from "./types";

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
 * The ancestry half of the pairing options, on its own so a consumer that
 * REQUIRES a cwd on every match cannot be handed `requireCwd: false`.
 */
export interface AncestryPairOptions {
  /**
   * When supplied, processes whose tty matches NO pane get a second chance:
   * the pane whose `panePid` is their ancestor claims them. Omit it and the
   * pairing is tty-only (the historical behavior).
   */
  processTree?: ProcessTreeLike;
}

/** Options for {@link pairProcsWithPanes}. */
export interface PairProcsOptions extends AncestryPairOptions {
  /**
   * Drop processes with no cwd (default `true`). The Claude ladders key
   * everything off `proc.cwd` and dereference it non-null, so they keep the
   * default; pane-tracked creation, which falls back to the pane's own
   * `currentPath`, passes `false`.
   */
  requireCwd?: boolean;
}

/**
 * Pair each process with the pane that hosts it. THE single process<->pane
 * join: every creation site and the per-scan re-bind go through it, so they
 * cannot resolve the same process to different panes on alternating scans
 * (a pane whose pid flip-flops trips the pane-reuse identity reset every
 * cycle — see `processes.ts:dropWrapperParents`).
 *
 * Two passes, the second strictly subordinate to the first:
 *
 * 1. **tty** — the process owns the pane's terminal. Unchanged, and still
 *    many-to-one: nested agents legitimately share one pane's tty.
 * 2. **ancestry** — only for processes whose tty matched no pane at all, and
 *    only onto panes pass 1 left unclaimed. A pty-allocating wrapper
 *    (`script -q /dev/null claude`, `nono run -- claude`, `fence`) forks,
 *    keeps the pane's tty for itself, and setsid's the agent onto a fresh
 *    pty no pane owns; the agent is then discovered but joined to nothing.
 *    Walking down from `pane.panePid` finds it (issue #193).
 *
 * Processes with NO tty never reach pass 2. Those are the pipe-stdio
 * subprocesses (`codex exec`, MCP servers) that discovery drops on purpose;
 * ancestry would happily bind them to whichever pane spawned them.
 *
 * Tty ownership is reserved even when the owner has no cwd. Callers should
 * pass every process that can own a pane before filtering emitted matches;
 * the tty-claimed set cannot account for processes absent from the input.
 */
export function pairProcsWithPanes(
  processes: readonly ProcessInfo[],
  panes: readonly TmuxPane[],
  options: PairProcsOptions = {},
): ProcPaneMatch[] {
  const { processTree, requireCwd = true } = options;
  const withTty = processes.filter((proc) => proc.tty);

  const matches: ProcPaneMatch[] = [];
  const ttyClaimedPanes = new Set<string>();
  const ttyPairedPids = new Set<number>();

  // Pre-index panes by normalized tty: this runs on every scan tick, and the
  // pane-order tie-break below only matters for the ancestry pass.
  const paneByTty = new Map<string, TmuxPane>();
  for (const pane of panes) {
    const tty = normalizeTty(pane.tty);
    // First pane wins, matching the old `panes.find` scan.
    if (tty && !paneByTty.has(tty)) paneByTty.set(tty, pane);
  }

  for (const proc of withTty) {
    const procTty = normalizeTty(proc.tty);
    const matchingPane = procTty ? paneByTty.get(procTty) : undefined;
    if (matchingPane) {
      ttyClaimedPanes.add(matchingPane.paneId);
      ttyPairedPids.add(proc.pid);
      if (!requireCwd || proc.cwd) {
        matches.push({ proc, pane: matchingPane, provenance: "tty" });
      }
    }
  }

  if (!processTree) return matches;

  const orphans = withTty.filter(
    (proc) => !ttyPairedPids.has(proc.pid) && (!requireCwd || proc.cwd),
  );
  if (orphans.length === 0) return matches;
  const orphanPids = new Set(orphans.map((proc) => proc.pid));

  for (const pane of panes) {
    if (orphanPids.size === 0) break;
    if (ttyClaimedPanes.has(pane.paneId)) continue;
    const foundPid = processTree.findAgentDescendant(pane.panePid, orphanPids);
    if (foundPid === null) continue;
    const proc = orphans.find((p) => p.pid === foundPid);
    if (!proc) continue;
    matches.push({ proc, pane, provenance: "ancestry" });
    // One pane, one ancestry-resolved process, and one pane per process:
    // without this a second pane deeper in the same tree would re-claim it.
    orphanPids.delete(foundPid);
  }

  return matches;
}

/**
 * Group pane-paired processes (tty, then ancestry) by encoded project path. This is the shared
 * cwd→(proc,pane) index behind ladders 2 and 3 for sessions whose raw cwd
 * is unknown (no transcript entries yet); when the raw cwd IS known,
 * candidates come from `pairProcsWithPanes` filtered on exact raw cwd
 * instead (encoding is many-to-one, so the encoded key can both
 * collide siblings and, under Claude-side encoding drift, miss entirely).
 */
export function buildProcPaneMapByEncodedCwd(
  processes: readonly ProcessInfo[],
  panes: readonly TmuxPane[],
  options: AncestryPairOptions = {},
): Map<string, ProcPaneMatch[]> {
  const cwdToProcsMap = new Map<string, ProcPaneMatch[]>();
  // `requireCwd` is forced, not defaulted: the encode below dereferences
  // `proc.cwd` non-null, and a structurally-compatible caller could otherwise
  // widen its way to `false` and crash here. The narrowed option type makes
  // the mistake unspellable; this makes it unreachable.
  for (const match of pairProcsWithPanes(processes, panes, {
    ...options,
    requireCwd: true,
  })) {
    const encodedCwd = encodeProjectPath(match.proc.cwd!);
    const existing = cwdToProcsMap.get(encodedCwd) || [];
    existing.push(match);
    cwdToProcsMap.set(encodedCwd, existing);
  }

  return cwdToProcsMap;
}
