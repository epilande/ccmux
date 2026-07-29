/**
 * Worktree pruning: which of a repo's worktrees are finished, and the
 * removal that cleans one up completely (directory, local branch, leftover
 * pane, per-directory agent state).
 *
 * The two halves are deliberately separate. {@link scanRepos} only reads —
 * it can run on every prune surface open, and its output is the ONLY input
 * {@link runPrune} accepts, so a client cannot hand the destructive half an
 * arbitrary path. Everything that mutates is gated on a candidate this module
 * itself classified in the same process.
 *
 * There is no automatic mode and no caller-supplied "prune everything": both
 * surfaces select explicitly, and dirty rows require their own opt-in on top
 * of that.
 */

import { existsSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionStatus } from "../types/session";
import {
  builtinStateFiles,
  cleanStateEntries,
  findOrphanEntries,
  type AgentStateFile,
  type StateCleanupResult,
} from "./agent-state";
import {
  fetchPrune,
  isMergedInto,
  listWorktrees,
  readAdminDir,
  readDirtyState,
  readUpstreamStates,
  resolveBaseRefs,
  runGit,
  type GitRun,
  type WorktreeEntry,
} from "./worktree-git";

/**
 * Why a worktree is removable, strongest evidence first — this is also the
 * precedence order when several apply:
 *
 * - `pr-merged`: GitHub says the branch's PR was merged. Survives squash and
 *   rebase merges, which no local check can see.
 * - `merged-locally`: the branch tip is an ancestor of the default branch.
 *   Locally provable, so it is the one reason that never needs a force.
 * - `upstream-gone`: the branch had an upstream and it is gone after a
 *   `fetch --prune` — the shape a merge with auto-delete leaves behind, but
 *   NOT proof of a merge (someone may simply have deleted the remote branch).
 * - `pr-closed`: the PR was closed without merging. The work was rejected,
 *   so the worktree is finished, but the branch is kept.
 */
export const PRUNE_REASONS = [
  "pr-merged",
  "merged-locally",
  "upstream-gone",
  "pr-closed",
] as const;
export type PruneReason = (typeof PRUNE_REASONS)[number];

/** How a reason justifies deleting the local branch. */
export type BranchDeletion = "safe" | "force" | "none";

export interface PRState {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
}

/** Resolves the PR (if any) for a branch, including merged/closed ones. */
export type PRStateLookup = (
  cwd: string,
  branch: string,
) => Promise<PRState | null>;

/** A session living in a worktree, as the prune surfaces need to see it. */
export interface WorktreeSession {
  id: string;
  agentType: string;
  status: SessionStatus;
  tmuxPane: string | null;
  tmuxTarget: string | null;
  pid: number | null;
}

export interface PruneCandidate {
  /** Absolute worktree root, as git records it. */
  path: string;
  /** Main checkout this worktree hangs off. */
  repoRoot: string;
  repoName: string;
  /** Display name: the worktree directory's own basename. */
  name: string;
  branch: string | null;
  reason: PruneReason;
  /** One-line human explanation, e.g. `PR #68 merged`. */
  detail: string;
  pr: PRState | null;
  dirty: boolean;
  modified: number;
  untracked: number;
  branchDeletion: BranchDeletion;
  /** `.git/worktrees/<name>`, captured while the worktree still exists. */
  adminDir: string | null;
  /** Idle/finished sessions in this worktree; removal takes them down. */
  sessions: WorktreeSession[];
}

/** A worktree that has been deliberately withheld from the candidate list. */
export interface PruneSkip {
  path: string;
  repoRoot: string;
  branch: string | null;
  reason: string;
}

export interface PruneScan {
  candidates: PruneCandidate[];
  skipped: PruneSkip[];
}

/**
 * Default PR lookup. `--state all` is what separates this from the daemon's
 * open-PR resolver: a merged or closed PR is precisely the state that
 * resolver filters out, and precisely the state that makes a worktree
 * removable. Returns the most conclusive PR when a branch has several
 * (reopened, re-pushed): merged beats open beats closed.
 */
export const ghPRStateLookup: PRStateLookup = async (cwd, branch) => {
  try {
    const proc = Bun.spawn(
      [
        "gh",
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,url,state",
        "--limit",
        "10",
      ],
      { cwd, stdout: "pipe", stderr: "ignore" },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const rows = (await new Response(proc.stdout).json()) as Array<{
      number: number;
      url: string;
      state: string;
    }>;
    const rank = (state: string): number =>
      state === "MERGED" ? 0 : state === "OPEN" ? 1 : 2;
    const best = rows
      .filter(
        (r) =>
          r.state === "MERGED" || r.state === "OPEN" || r.state === "CLOSED",
      )
      .sort((a, b) => rank(a.state) - rank(b.state))[0];
    if (!best) return null;
    return {
      number: best.number,
      url: best.url,
      state: best.state as PRState["state"],
    };
  } catch {
    return null;
  }
};

export interface ScanDeps {
  git?: GitRun;
  lookupPR?: PRStateLookup;
  /**
   * Sessions living in a worktree, keyed by its (realpath-normalized) root.
   * Supplied by the daemon, which is the only thing that knows.
   */
  sessionsFor?: (worktreePath: string) => WorktreeSession[];
  /**
   * Fast "there is already an open PR" read off the daemon's existing
   * `branchPRs` cache. Lets the common busy-branch case skip the gh call
   * entirely; returning false only costs a lookup that would have happened.
   */
  hasOpenPR?: (cwd: string, branch: string) => boolean;
  /** Skip the per-repo `git fetch --prune` (tests, offline runs). */
  skipFetch?: boolean;
}

/**
 * Resolve a path through symlinks so git's recorded worktree path and the
 * daemon's `--show-toplevel` answer compare equal (on macOS, `/tmp` and
 * `/private/tmp` otherwise make every match fail). Falls back to the input
 * for a path that no longer exists.
 */
export function normalizePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function detailFor(
  reason: PruneReason,
  pr: PRState | null,
  upstream: string | null,
  baseRefs: string[],
): string {
  switch (reason) {
    case "pr-merged":
      return pr ? `PR #${pr.number} merged` : "PR merged";
    case "pr-closed":
      return pr ? `PR #${pr.number} closed without merging` : "PR closed";
    case "merged-locally":
      return `merged into ${baseRefs[0] ?? "the default branch"}`;
    case "upstream-gone":
      return `upstream ${upstream ?? "branch"} is gone`;
  }
}

/**
 * Branch deletion policy. `merged-locally` is the only reason git itself can
 * verify, so it is the only one that uses a plain `-d`; `pr-merged` needs a
 * force because a squash merge leaves the local tip unmerged by git's
 * definition even though GitHub has the work. `upstream-gone` deliberately
 * stays on the safe `-d` — a deleted remote branch is a strong hint, not
 * proof, so an unmerged branch survives with a reported failure instead of
 * being force-deleted on a guess. `pr-closed` keeps the branch entirely.
 */
export function branchDeletionFor(reason: PruneReason): BranchDeletion {
  switch (reason) {
    case "pr-merged":
      return "force";
    case "merged-locally":
    case "upstream-gone":
      return "safe";
    case "pr-closed":
      return "none";
  }
}

/**
 * Classify every linked worktree of one repo.
 *
 * Ordering matters for cost as much as for safety: the session gate and the
 * cheap local checks run before any network call, so a repo full of active
 * worktrees costs no gh round-trips.
 */
export async function scanRepo(
  repoRoot: string,
  deps: ScanDeps = {},
): Promise<PruneScan> {
  const git = deps.git ?? runGit;
  const candidates: PruneCandidate[] = [];
  const skipped: PruneSkip[] = [];

  const entries = await listWorktrees(repoRoot, git);
  const linked = entries.filter((e) => !e.isMain && !e.bare);
  if (linked.length === 0) return { candidates, skipped };

  // One network call per repo, not per worktree: this is what turns a branch
  // deleted on GitHub into a locally visible `[gone]`.
  if (!deps.skipFetch) await fetchPrune(repoRoot, git);

  const [baseRefs, upstreams] = await Promise.all([
    resolveBaseRefs(repoRoot, git),
    readUpstreamStates(repoRoot, git),
  ]);
  const repoName = basename(repoRoot);

  for (const entry of linked) {
    const skip = await classifyOne(entry, {
      repoRoot,
      repoName,
      baseRefs,
      upstreams,
      git,
      deps,
      candidates,
    });
    if (skip) skipped.push(skip);
  }

  return { candidates, skipped };
}

interface ClassifyContext {
  repoRoot: string;
  repoName: string;
  baseRefs: string[];
  upstreams: Map<string, { upstream: string | null; gone: boolean }>;
  git: GitRun;
  deps: ScanDeps;
  candidates: PruneCandidate[];
}

/**
 * Classify one worktree, pushing a candidate onto `ctx.candidates` or
 * returning the skip to report. Returns null for a worktree that is simply
 * still in use, which is the uninteresting majority and stays silent.
 */
async function classifyOne(
  entry: WorktreeEntry,
  ctx: ClassifyContext,
): Promise<PruneSkip | null> {
  const { repoRoot, git, deps } = ctx;
  const path = entry.path;
  const branch = entry.branch;
  const skip = (reason: string): PruneSkip => ({
    path,
    repoRoot,
    branch,
    reason,
  });

  // An entry git already considers stale has no working tree left to remove;
  // `git worktree prune` reclaims it, and the prune run does that anyway.
  if (entry.prunable || !existsSync(path)) return null;

  // A lock on a LIVE worktree is a user decision ("don't touch this"), and
  // outranks every removal reason. Stale locks — the ones an interrupted
  // `worktree add` leaves on a directory that no longer exists — are cleared
  // during the run instead; they are `prunable` above, not here.
  if (entry.locked) return skip("locked");

  // Detached HEAD: no branch means no PR, no upstream and no merge to prove.
  if (!branch) return null;

  const sessions = deps.sessionsFor?.(normalizePath(path)) ?? [];
  // A live agent outranks every removal reason: pulling the directory out
  // from under a working agent loses whatever it has not written yet.
  if (sessions.some((s) => s.status === "working")) {
    return skip("an agent is working here");
  }

  const upstream = ctx.upstreams.get(branch) ?? { upstream: null, gone: false };

  // An open PR means the work is still in flight, whatever the local refs
  // look like. Checked against the daemon's existing cache first so the
  // common case costs nothing.
  if (deps.hasOpenPR?.(path, branch)) return null;

  const mergedLocally = await isMergedInto(repoRoot, branch, ctx.baseRefs, git);
  const lookupPR = deps.lookupPR ?? ghPRStateLookup;
  const pr = await lookupPR(path, branch);
  if (pr?.state === "OPEN") return null;

  const reason: PruneReason | null =
    pr?.state === "MERGED"
      ? "pr-merged"
      : mergedLocally
        ? "merged-locally"
        : upstream.gone
          ? "upstream-gone"
          : pr?.state === "CLOSED"
            ? "pr-closed"
            : null;
  if (!reason) return null;

  const dirtyState = await readDirtyState(path, git);
  ctx.candidates.push({
    path,
    repoRoot,
    repoName: ctx.repoName,
    name: basename(path),
    branch,
    reason,
    detail: detailFor(reason, pr, upstream.upstream, ctx.baseRefs),
    pr,
    dirty: dirtyState.dirty,
    modified: dirtyState.modified,
    untracked: dirtyState.untracked,
    branchDeletion: branchDeletionFor(reason),
    adminDir: readAdminDir(path),
    sessions,
  });
  return null;
}

/** Scan several repos, de-duplicating repeated roots. */
export async function scanRepos(
  repoRoots: string[],
  deps: ScanDeps = {},
): Promise<PruneScan> {
  const seen = new Set<string>();
  const candidates: PruneCandidate[] = [];
  const skipped: PruneSkip[] = [];
  for (const root of repoRoots) {
    const key = normalizePath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const scan = await scanRepo(root, deps);
    candidates.push(...scan.candidates);
    skipped.push(...scan.skipped);
  }
  candidates.sort(
    (a, b) =>
      a.repoName.localeCompare(b.repoName) || a.name.localeCompare(b.name),
  );
  return { candidates, skipped };
}

/** One recorded action, for the run log both surfaces print. */
export interface PruneStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface PruneOutcome {
  path: string;
  repoRoot: string;
  branch: string | null;
  reason: PruneReason;
  /** The working tree is gone (or would be, under `dryRun`). */
  removed: boolean;
  /** Where the directory was moved before deletion. */
  trashPath: string | null;
  branchDeleted: boolean;
  /** Pane ids closed for this worktree's sessions. */
  panesClosed: string[];
  steps: PruneStep[];
  error?: string;
}

export interface PruneRunResult {
  outcomes: PruneOutcome[];
  /** Per-agent state-file cleanup, including the `--state` backlog sweep. */
  state: StateCleanupResult[];
  dryRun: boolean;
}

export interface PruneDeps {
  git?: GitRun;
  /** Injectable for tests; defaults to `process.kill`. */
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  closePane?: (paneId: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  stateFiles?: AgentStateFile[];
  now?: () => Date;
  /** Surface tag for the run log (`picker`, `cli`). */
  source?: string;
  log?: (message: string) => void;
}

export interface PruneOptions extends PruneDeps {
  dryRun?: boolean;
  /** Also drop state entries for directories deleted outside ccmux. */
  cleanOrphanState?: boolean;
  /**
   * Worktree paths the user separately opted in to removing despite
   * uncommitted or untracked changes. A dirty candidate that is not listed
   * here is refused, even though it was selected — losing uncommitted work is
   * the one outcome no amount of "I confirmed the list" should authorize by
   * itself. Enforced here, in the destructive core, so every surface inherits
   * it rather than each one re-implementing the gate.
   */
  allowDirtyPaths?: string[];
}

const PROCESS_EXIT_TIMEOUT_MS = 3000;

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

async function defaultClosePane(paneId: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "kill-pane", "-t", paneId], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Stop a worktree's agents and close their panes.
 *
 * The pane is closed only after the process is confirmed gone (or the wait
 * times out and is reported): closing first would leave the agent orphaned
 * mid-write against a directory that is about to be renamed out from under
 * it, which is exactly the shutdown this is trying to avoid.
 */
async function stopSessions(
  candidate: PruneCandidate,
  deps: PruneDeps,
  steps: PruneStep[],
): Promise<string[]> {
  const kill = deps.killProcess ?? defaultKill;
  const closePane = deps.closePane ?? defaultClosePane;
  const sleep = deps.sleep ?? defaultSleep;
  const closed: string[] = [];

  for (const session of candidate.sessions) {
    if (session.pid) {
      let alive = true;
      try {
        kill(session.pid, "SIGTERM");
      } catch {
        alive = false; // already gone
      }
      const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS;
      while (alive && Date.now() < deadline) {
        try {
          kill(session.pid, 0);
          await sleep(50);
        } catch {
          alive = false;
        }
      }
      steps.push({
        step: "stop agent",
        ok: !alive,
        detail: alive
          ? `${session.agentType} pid ${session.pid} did not exit in ${PROCESS_EXIT_TIMEOUT_MS}ms; closing its pane anyway`
          : `${session.agentType} pid ${session.pid} exited`,
      });
    }

    if (session.tmuxPane) {
      const ok = await closePane(session.tmuxPane);
      if (ok) closed.push(session.tmuxPane);
      steps.push({
        step: "close pane",
        ok,
        detail: `${session.tmuxTarget ?? session.tmuxPane}`,
      });
    }
  }
  return closed;
}

/**
 * Trash sibling for a worktree directory: same parent, dot-prefixed, stamped.
 * Same parent because a rename within one directory is atomic and cannot fail
 * on a cross-device boundary, which is what makes freeing the path reliable
 * even while a shell still has it as its cwd.
 */
export function trashPathFor(worktreePath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(
    dirname(worktreePath),
    `.ccmux-trash-${basename(worktreePath)}-${stamp}`,
  );
}

/**
 * Execute a prune run over candidates this process classified.
 *
 * Phased on purpose. Every directory is renamed aside first and only deleted
 * at the very end, so for the length of the run the contents still exist
 * under their trash path and a mistake is recoverable by hand. Repo-level
 * metadata (`git worktree prune`, stale lock files) is reclaimed once per
 * repo rather than once per worktree.
 */
export async function runPrune(
  candidates: PruneCandidate[],
  options: PruneOptions = {},
): Promise<PruneRunResult> {
  const git = options.git ?? runGit;
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((m: string) => console.log(m));
  const allowDirty = new Set(options.allowDirtyPaths ?? []);
  const outcomes: PruneOutcome[] = [];
  const trashToDelete: string[] = [];

  for (const candidate of candidates) {
    const steps: PruneStep[] = [];
    const outcome: PruneOutcome = {
      path: candidate.path,
      repoRoot: candidate.repoRoot,
      branch: candidate.branch,
      reason: candidate.reason,
      removed: false,
      trashPath: null,
      branchDeleted: false,
      panesClosed: [],
      steps,
    };
    outcomes.push(outcome);

    if (candidate.dirty && !allowDirty.has(candidate.path)) {
      outcome.error =
        "has uncommitted or untracked changes and was not opted in";
      steps.push({
        step: "refused",
        ok: false,
        detail: `${candidate.modified} modified, ${candidate.untracked} untracked — needs an explicit dirty opt-in`,
      });
      continue;
    }

    if (dryRun) {
      outcome.removed = true;
      for (const session of candidate.sessions) {
        if (session.tmuxPane) outcome.panesClosed.push(session.tmuxPane);
      }
      steps.push({
        step: "would remove",
        ok: true,
        detail:
          `${candidate.path} (${candidate.detail})` +
          (candidate.dirty
            ? ` — DIRTY: ${candidate.modified} modified, ${candidate.untracked} untracked`
            : ""),
      });
      if (candidate.branch && candidate.branchDeletion !== "none") {
        steps.push({
          step: "would delete branch",
          ok: true,
          detail: candidate.branch,
        });
      }
      continue;
    }

    outcome.panesClosed = await stopSessions(candidate, options, steps);

    const trash = trashPathFor(candidate.path, now());
    try {
      renameSync(candidate.path, trash);
      outcome.trashPath = trash;
      outcome.removed = true;
      trashToDelete.push(trash);
      steps.push({ step: "move aside", ok: true, detail: trash });
    } catch (err) {
      // The rename is a convenience (it frees the path instantly and gives an
      // undo window), not the goal. If it fails, delete in place rather than
      // abandoning a removal the user explicitly confirmed.
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ step: "move aside", ok: false, detail: message });
      try {
        rmSync(candidate.path, { recursive: true, force: true });
        outcome.removed = true;
        steps.push({
          step: "remove in place",
          ok: true,
          detail: candidate.path,
        });
      } catch (rmErr) {
        outcome.error = rmErr instanceof Error ? rmErr.message : String(rmErr);
        steps.push({
          step: "remove in place",
          ok: false,
          detail: outcome.error,
        });
        continue;
      }
    }

    log(
      `ccmux: pruned worktree ${candidate.path} (${candidate.detail})` +
        (outcome.trashPath
          ? ` -> ${outcome.trashPath}`
          : " (deleted in place)"),
    );
  }

  // Metadata before branches, not after: until `git worktree prune` drops the
  // admin entry, git still considers the branch checked out in a worktree and
  // refuses to delete it — with or without `-D`.
  if (!dryRun) {
    await reclaimRepoMetadata(candidates, git, outcomes);
    await deleteBranches(candidates, outcomes, git, log);
  }

  const removedPaths = outcomes.filter((o) => o.removed).map((o) => o.path);
  const state = cleanState(removedPaths, options, dryRun);

  // Deleted last, so the contents survive for the whole run.
  for (const trash of trashToDelete) {
    try {
      rmSync(trash, { recursive: true, force: true });
    } catch (err) {
      log(
        `ccmux: failed to delete ${trash}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { outcomes, state, dryRun };
}

/**
 * Delete the local branches of worktrees that were actually removed, per each
 * candidate's {@link BranchDeletion} policy. A refused delete (unmerged
 * branch, `-d` without proof) is reported and the branch survives — the
 * worktree is still gone, which is what the user asked for.
 */
async function deleteBranches(
  candidates: PruneCandidate[],
  outcomes: PruneOutcome[],
  git: GitRun,
  log: (message: string) => void,
): Promise<void> {
  for (const candidate of candidates) {
    const outcome = outcomes.find((o) => o.path === candidate.path);
    if (!outcome?.removed) continue;
    if (!candidate.branch || candidate.branchDeletion === "none") continue;

    const flag = candidate.branchDeletion === "force" ? "-D" : "-d";
    const res = await git(candidate.repoRoot, [
      "branch",
      flag,
      candidate.branch,
    ]);
    outcome.branchDeleted = res.exitCode === 0;
    outcome.steps.push({
      step: "delete branch",
      ok: outcome.branchDeleted,
      detail: outcome.branchDeleted
        ? `${candidate.branch} (git branch ${flag})`
        : `${candidate.branch} kept: ${res.stderr.trim() || `git branch ${flag} exited ${res.exitCode}`}`,
    });
    if (outcome.branchDeleted) {
      log(`ccmux: deleted branch ${candidate.branch} in ${candidate.repoRoot}`);
    }
  }
}

/**
 * Per-repo metadata reclaim: drop the stale `locked` markers that stop
 * `git worktree prune` from doing its job, then prune.
 *
 * An interrupted `git worktree add` leaves a locked admin entry behind whose
 * working tree never materialized; `git worktree prune` skips locked entries
 * by design, so those accumulate forever and keep re-registering their branch
 * as "checked out elsewhere". Only entries whose working tree is confirmed
 * gone are unlocked — a lock on a live worktree is never touched.
 */
async function reclaimRepoMetadata(
  candidates: PruneCandidate[],
  git: GitRun,
  outcomes: PruneOutcome[],
): Promise<void> {
  const byRepo = new Map<string, PruneOutcome[]>();
  for (const outcome of outcomes) {
    const list = byRepo.get(outcome.repoRoot) ?? [];
    list.push(outcome);
    byRepo.set(outcome.repoRoot, list);
  }

  for (const [repoRoot, repoOutcomes] of byRepo) {
    const entries = await listWorktrees(repoRoot, git);
    for (const entry of entries) {
      if (!entry.locked || existsSync(entry.path)) continue;
      const adminDir =
        candidates.find((c) => c.path === entry.path)?.adminDir ?? null;
      let cleared = false;
      if (adminDir) {
        try {
          rmSync(join(adminDir, "locked"), { force: true });
          cleared = true;
        } catch {
          cleared = false;
        }
      }
      if (!cleared) {
        const res = await git(repoRoot, ["worktree", "unlock", entry.path]);
        cleared = res.exitCode === 0;
      }
      if (cleared) {
        repoOutcomes[0]?.steps.push({
          step: "clear stale lock",
          ok: true,
          detail: entry.path,
        });
      }
    }

    const res = await git(repoRoot, ["worktree", "prune"]);
    repoOutcomes[0]?.steps.push({
      step: "git worktree prune",
      ok: res.exitCode === 0,
      detail:
        res.exitCode === 0
          ? repoRoot
          : res.stderr.trim() || `exited ${res.exitCode}`,
    });
  }
}

function cleanState(
  removedPaths: string[],
  options: PruneOptions,
  dryRun: boolean,
): StateCleanupResult[] {
  const files = options.stateFiles ?? builtinStateFiles();
  const results: StateCleanupResult[] = [];
  for (const file of files) {
    const paths = [...removedPaths];
    if (options.cleanOrphanState) {
      for (const orphan of findOrphanEntries(file)) {
        if (!paths.includes(orphan)) paths.push(orphan);
      }
    }
    const result = cleanStateEntries(file, paths, {
      dryRun,
      now: options.now,
    });
    if (result.removed.length > 0 || result.error) results.push(result);
  }
  return results;
}

/**
 * The `--state`-only path: drop state entries for directories that no longer
 * exist, without touching any repo. This is the accumulated backlog from
 * worktrees deleted outside ccmux, which no other step would ever reach.
 */
export function pruneOrphanState(
  options: {
    dryRun?: boolean;
    stateFiles?: AgentStateFile[];
    now?: () => Date;
  } = {},
): StateCleanupResult[] {
  const files = options.stateFiles ?? builtinStateFiles();
  return files.map((file) =>
    cleanStateEntries(file, findOrphanEntries(file), {
      dryRun: options.dryRun,
      now: options.now,
    }),
  );
}
