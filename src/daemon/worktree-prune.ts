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

import { existsSync, realpathSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
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
  type UpstreamState,
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
  /**
   * A paneless Claude background-agent row. Its pid belongs to Claude's own
   * supervisor rather than to ccmux, so it must never be signalled directly
   * (the same rule `handleKillSession` follows). It still counts for the
   * working-session gate.
   */
  background?: boolean;
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
  /**
   * Ignored files that would be deleted with the directory (`.env` and
   * friends). Not part of `dirty` — surfaced so the user can see them, since
   * nothing else in git or in a backup would bring them back.
   */
  ignoredFiles: string[];
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

/** One `gh pr list --json` row, with the fields that establish identity. */
export interface GhPRRow {
  number: number;
  url: string;
  state: string;
  /**
   * PR head lives in a fork. Informational only: this is deliberately NOT
   * part of the identity rule, because a fork-to-upstream PR is an ordinary
   * workflow and `headRefOid` already proves identity on its own. Do not
   * "restore" it as a filter.
   */
  isCrossRepository?: boolean;
  /** SHA of the PR's head commit — the only reliable branch identity. */
  headRefOid?: string;
}

/**
 * Pick the PR that describes THIS worktree's branch, from everything `gh`
 * returned for the branch NAME.
 *
 * `gh pr list --head <branch>` matches on the name alone — it has no syntax
 * for qualifying an owner ("<owner>:<branch>" is explicitly unsupported) — so
 * the reply mixes in every fork's PR and every earlier reuse of that name. On
 * `cli/cli`, `--head patch-1` returns 25 PRs from 25 different forks, three of
 * them MERGED. Taking any of those as proof would classify a local `patch-1`
 * as `pr-merged`, which is the one reason that force-deletes the branch.
 *
 * Two asymmetric rules, because the two directions have opposite costs:
 *
 * - OPEN wins over everything, from ANY repo, without an identity check. An
 *   open PR is the state that makes a worktree NOT removable, so a false
 *   positive here only skips a cleanup, while a false negative deletes live
 *   work. This is also why it is checked before merged and closed: a branch
 *   with both a merged PR and a currently open one is being worked on.
 * - MERGED and CLOSED justify removal, so they must be PROVEN to be about
 *   this branch, and the proof is one thing: a head SHA equal to the local
 *   branch tip. That defeats name reuse (a new `feat/x` sharing a name with a
 *   long-merged `feat/x` has a different tip) and it defeats the fork noise
 *   above (25 unrelated `patch-1` PRs, none of them at this tip).
 *
 * Note what is deliberately NOT required: that the PR live in this
 * repository. A `headRefOid` equal to the local tip IS the identity — that
 * exact commit is the PR's head, whichever repository the PR was opened
 * from — so a same-repo check adds nothing on top of it while breaking the
 * entirely ordinary fork-to-upstream workflow, where every one of your own
 * PRs is cross-repository.
 *
 * `localTip` null (git could not resolve the branch) fails closed: no PR can
 * be proven to match, so nothing merged or closed is reported.
 */
export function selectPRForBranch(
  rows: GhPRRow[],
  localTip: string | null,
): PRState | null {
  const asState = (row: GhPRRow): PRState => ({
    number: row.number,
    url: row.url,
    state: row.state as PRState["state"],
  });

  const open = rows.find((r) => r.state === "OPEN");
  if (open) return asState(open);

  if (!localTip) return null;
  const mine = rows.filter((r) => r.headRefOid === localTip);
  const merged = mine.find((r) => r.state === "MERGED");
  if (merged) return asState(merged);
  const closed = mine.find((r) => r.state === "CLOSED");
  return closed ? asState(closed) : null;
}

/**
 * Default PR lookup. `--state all` is what separates this from the daemon's
 * open-PR resolver: a merged or closed PR is precisely the state that
 * resolver filters out, and precisely the state that makes a worktree
 * removable. See {@link selectPRForBranch} for how one of the returned PRs is
 * proven to be about this branch rather than a namesake.
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
        "number,url,state,isCrossRepository,headRefOid",
        // Generous, because the identity filter runs client-side: a popular
        // branch name can bury this repo's own PR under dozens of fork PRs,
        // and a truncated page would read as "no PR" or, worse, surface only
        // a namesake.
        "--limit",
        "100",
      ],
      // `env` passed explicitly rather than inherited: Bun resolves the
      // binary against the env it is GIVEN, so without this a test cannot put
      // a stub `gh` on PATH and this function stays untestable.
      { cwd, stdout: "pipe", stderr: "ignore", env: { ...process.env } },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const rows = (await new Response(proc.stdout).json()) as GhPRRow[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    // `refs/heads/` qualified for the same reason as `isMergedInto`: a tag
    // sharing the branch name outranks the branch in git's disambiguation,
    // and this SHA is what proves the PR belongs to this branch.
    const tip = await runGit(cwd, [
      "rev-parse",
      "--verify",
      `refs/heads/${branch}^{commit}`,
    ]);
    const localTip = tip.exitCode === 0 ? tip.stdout.trim() : null;
    return selectPRForBranch(rows, localTip);
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

/**
 * One-line summary of the ignored files a removal would take with it, or ""
 * when there are none. Shared by every surface so the truncation rule — and
 * therefore what a user is shown before confirming — is defined once.
 */
export function describeIgnoredFiles(files: string[], max = 3): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, max);
  const rest = files.length - shown.length;
  const names = shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
  return `${files.length} ignored file${files.length === 1 ? "" : "s"} (${names})`;
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
 *
 * What stops `pr-merged`'s force from destroying unpublished work is the
 * identity rule in {@link selectPRForBranch}, not a check here: the reason
 * only applies when the PR's head SHA equals the local tip, so a branch that
 * has moved on since the merge no longer matches and falls through to a
 * reason that uses `-d`.
 *
 * Do NOT add a `git rev-list --count <branch> --not --remotes` gate on the
 * force. It reads like the obvious safety net and has been proposed several
 * times, but a squash merge never puts the branch's own commits on any
 * remote, so that count is greater than zero for EVERY correctly
 * squash-merged branch. Gating on it downgrades every `pr-merged` to `-d`,
 * which then refuses, leaving behind exactly the branches this feature exists
 * to clean up.
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
 * Ordering matters for safety: the session gate and the lock check run before
 * anything else, so a live worktree is never classified at all.
 *
 * It buys less than it looks like on cost. An ordinary active worktree — a
 * branch pushed with a PR still open — reaches the `gh` call, because
 * "is there an open PR" is exactly what the network is being asked. Measured:
 * 15 active worktrees still made 15 gh calls. What genuinely avoids the call
 * is a branch with no upstream, a branch already merged locally, or a hit in
 * the daemon's open-PR cache (`hasOpenPR`); everything else pays for it, which
 * is why the calls run concurrently rather than one at a time.
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

  // Bounded concurrency, not a serial loop: the expensive step is one
  // `gh pr list` per branch at ~0.5s of network latency each, so 15 worktrees
  // took 8.3s serially against 1.6s at this width. The cap keeps a repo with
  // dozens of worktrees from opening dozens of simultaneous gh processes.
  const results = await mapWithConcurrency(
    linked,
    CLASSIFY_CONCURRENCY,
    (entry) =>
      classifyOne(entry, {
        repoRoot,
        repoName,
        baseRefs,
        upstreams,
        git,
        deps,
      }),
  );
  for (const { candidate, skip } of results) {
    if (candidate) candidates.push(candidate);
    if (skip) skipped.push(skip);
  }

  return { candidates, skipped };
}

/** Concurrent `gh pr list` calls per repo during classification. */
const CLASSIFY_CONCURRENCY = 6;

/**
 * `Promise.all` with a ceiling on how many run at once, preserving input
 * order in the result.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface ClassifyContext {
  repoRoot: string;
  repoName: string;
  baseRefs: string[];
  upstreams: Map<string, UpstreamState>;
  git: GitRun;
  deps: ScanDeps;
}

/** What one worktree contributed to the scan. */
interface Classification {
  candidate?: PruneCandidate;
  skip?: PruneSkip;
}

/**
 * The strongest applicable removal reason, in {@link PRUNE_REASONS}
 * precedence order. Null means nothing proves this worktree is finished.
 */
function reasonFor(
  pr: PRState | null,
  mergedLocally: boolean,
  upstreamGone: boolean,
): PruneReason | null {
  if (pr?.state === "MERGED") return "pr-merged";
  if (mergedLocally) return "merged-locally";
  if (upstreamGone) return "upstream-gone";
  if (pr?.state === "CLOSED") return "pr-closed";
  return null;
}

/**
 * Classify one worktree into a candidate or a skip to report. Neither means
 * the worktree is simply still in use, which is the uninteresting majority
 * and stays silent.
 */
async function classifyOne(
  entry: WorktreeEntry,
  ctx: ClassifyContext,
): Promise<Classification> {
  const { repoRoot, git, deps } = ctx;
  const path = entry.path;
  const branch = entry.branch;
  const skip = (reason: string): Classification => ({
    skip: { path, repoRoot, branch, reason },
  });

  // An entry git already considers stale has no working tree left to remove;
  // `git worktree prune` reclaims it, and the prune run does that anyway.
  if (entry.prunable || !existsSync(path)) return {};

  // A lock on a LIVE worktree is a user decision ("don't touch this"), and
  // outranks every removal reason. Stale locks — the ones an interrupted
  // `worktree add` leaves on a directory that no longer exists — are cleared
  // during the run instead; they are `prunable` above, not here.
  if (entry.locked) return skip("locked");

  // Detached HEAD: no branch means no PR, no upstream and no merge to prove.
  if (!branch) return {};

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
  if (deps.hasOpenPR?.(path, branch)) return {};

  const mergedLocally = await isMergedInto(repoRoot, branch, ctx.baseRefs, git);

  // The gh call is NOT skipped for a locally-merged branch, and NOT skipped
  // for a branch with no configured upstream, even though both look like free
  // wins. Tests pinned both as regressions:
  //
  // - Skipping when `mergedLocally` loses the OPEN suppression. The lookup
  //   does not only decide between `-d` and `-D`; it is also how an open PR
  //   is discovered, and a branch merged into a local integration branch
  //   while its PR is still open would then be offered for deletion.
  // - Skipping when no upstream is configured assumes "never pushed", but
  //   `git push origin HEAD` (without `-u`) sets no upstream at all, so a
  //   perfectly ordinary merged PR would go unseen.
  //
  // Concurrency across worktrees is where the time comes back instead.
  const lookupPR = deps.lookupPR ?? ghPRStateLookup;
  const pr = await lookupPR(path, branch);
  if (pr?.state === "OPEN") return {};

  const reason = reasonFor(pr, mergedLocally, upstream.gone);
  if (!reason) return {};

  const dirtyState = await readDirtyState(path, git);
  return {
    candidate: {
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
      ignoredFiles: dirtyState.ignoredFiles,
      branchDeletion: branchDeletionFor(reason),
      adminDir: readAdminDir(path),
      sessions,
    },
  };
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

/**
 * Outcome of closing one pane. `already-gone` is a success: the pane closed
 * along with the agent that owned it.
 */
export type PaneCloseResult = "closed" | "already-gone" | "failed";

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
  closePane?: (paneId: string) => Promise<PaneCloseResult>;
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

async function tmuxOk(args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether a pane id is still live, by membership in the pane list.
 *
 * Deliberately not `display-message -t <id>`: for a pane that no longer
 * exists tmux prints an empty line and exits ZERO, so an exit-code probe
 * reports every dead pane as alive. Listing and matching is unambiguous.
 */
async function paneExists(paneId: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "list-panes", "-a", "-F", "#{pane_id}"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    // A tmux that cannot be reached at all tells us nothing; assume the pane
    // is gone rather than reporting a failure we can't substantiate.
    if (exitCode !== 0) return false;
    return paneListIncludes(out, paneId);
  } catch {
    return false;
  }
}

/**
 * Whether a parsed admin dir really is one of this repo's worktree admin
 * entries. `readAdminDir` reads it out of a `.git` file inside the worktree,
 * which is content ccmux does not own, and the value is used to unlink a
 * file — so it is confirmed to sit under `<repoRoot>/.git/worktrees/` before
 * anything is removed.
 */
export function isRepoAdminDir(adminDir: string, repoRoot: string): boolean {
  const expected = join(normalizePath(repoRoot), ".git", "worktrees") + sep;
  return normalizePath(adminDir).startsWith(expected);
}

/** Membership test over `tmux list-panes -F '#{pane_id}'` output. */
export function paneListIncludes(output: string, paneId: string): boolean {
  return output.split("\n").some((line) => line.trim() === paneId);
}

/**
 * Close a pane, treating a pane that is already gone as success.
 *
 * Stopping the agent very often closes its own pane — that is what happens
 * whenever the agent is the pane's process rather than a child of a surviving
 * shell — so `kill-pane` failing with "can't find pane" is the SUCCESS path,
 * not an error. Reporting it as a failure made a clean run look broken.
 */
async function defaultClosePane(paneId: string): Promise<PaneCloseResult> {
  if (await tmuxOk(["kill-pane", "-t", paneId])) return "closed";
  return (await paneExists(paneId)) ? "failed" : "already-gone";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    if (session.background) {
      // Read-only here by design. Its worker is supervisor-owned, and it has
      // no pane to close, so there is nothing this run may safely do to it.
      steps.push({
        step: "skip background agent",
        ok: true,
        detail: `${session.agentType} ${session.id} is supervisor-owned; not signalled`,
      });
      continue;
    }
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
      const result = await closePane(session.tmuxPane);
      if (result !== "failed") closed.push(session.tmuxPane);
      steps.push({
        step: "close pane",
        ok: result !== "failed",
        detail:
          `${session.tmuxTarget ?? session.tmuxPane}` +
          (result === "already-gone" ? " (closed with its agent)" : ""),
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
        detail: `${candidate.modified} modified, ${candidate.untracked} untracked; needs an explicit dirty opt-in`,
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
            ? ` (DIRTY: ${candidate.modified} modified, ${candidate.untracked} untracked)`
            : ""),
      });
      if (candidate.ignoredFiles.length > 0) {
        steps.push({
          step: "would delete ignored",
          ok: true,
          detail: describeIgnoredFiles(candidate.ignoredFiles, 10),
        });
      }
      if (candidate.branch && candidate.branchDeletion !== "none") {
        steps.push({
          step: "would delete branch",
          ok: true,
          detail: candidate.branch,
        });
      }
      continue;
    }

    // Recorded before the directory moves: once it is gone, nothing else in
    // the log says these files ever existed, and they are the ones no git
    // history can bring back.
    if (candidate.ignoredFiles.length > 0) {
      steps.push({
        step: "deleting ignored",
        ok: true,
        detail: describeIgnoredFiles(candidate.ignoredFiles, 10),
      });
    }

    // Re-check at the point of no return. The scan-time answer can be tens of
    // seconds old by now — a `gh pr list` per worktree, plus up to 3s per
    // session waiting for an agent to exit — and someone editing in a shell in
    // this worktree during that window would otherwise lose the work with no
    // opt-in. One `git status`, immediately before the directory moves.
    if (!allowDirty.has(candidate.path)) {
      const fresh = await readDirtyState(candidate.path, git);
      if (fresh.dirty) {
        outcome.error = "became dirty after it was listed; nothing was deleted";
        steps.push({
          step: "refused",
          ok: false,
          detail: `${fresh.modified} modified, ${fresh.untracked} untracked appeared since the scan`,
        });
        continue;
      }
    }

    outcome.panesClosed = await stopSessions(candidate, options, steps);

    const trash = trashPathFor(candidate.path, now());
    try {
      renameSync(candidate.path, trash);
      outcome.trashPath = trash;
      outcome.removed = true;
      trashToDelete.push(trash);
      // Says "and deleted" because by the time anyone reads this the trash is
      // gone: it is removed at the end of the same run. A bare path invited
      // users to go looking for a directory that no longer exists. If the
      // delete DOES fail, a later "delete trash" step reports the survivor.
      steps.push({
        step: "move aside",
        ok: true,
        detail: `${trash} (deleted at the end of the run)`,
      });
    } catch (err) {
      // The rename is a convenience (it frees the path instantly and gives an
      // undo window), not the goal. If it fails, delete in place rather than
      // abandoning a removal the user explicitly confirmed.
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ step: "move aside", ok: false, detail: message });
      // A rename that failed on PERMISSIONS will not be rescued by deleting in
      // place — `rm -r` walks into the tree, destroys what it can reach, and
      // only then fails on the entry it could not unlink. That reported
      // "removal failed" while the working tree had already been emptied,
      // which points the user away from the truth. Refuse instead.
      if (isPermissionError(err)) {
        outcome.error = `${message} (nothing was deleted)`;
        steps.push({
          step: "refused",
          ok: false,
          detail:
            "the directory could not be moved aside for permission reasons; " +
            "deleting in place would destroy part of the tree before failing",
        });
        continue;
      }
      try {
        await rm(candidate.path, { recursive: true, force: true });
        outcome.removed = true;
        steps.push({
          step: "remove in place",
          ok: true,
          detail: candidate.path,
        });
      } catch (rmErr) {
        const rmMessage =
          rmErr instanceof Error ? rmErr.message : String(rmErr);
        // Report what is actually on disk. A partial delete leaves a
        // half-emptied working tree, and saying only "failed" invites the
        // reader to assume their files are intact.
        const partial = existsSync(candidate.path)
          ? " (the directory still exists but its contents may be partially deleted)"
          : " (the directory is gone despite the error)";
        outcome.error = rmMessage + partial;
        steps.push({
          step: "remove in place",
          ok: false,
          detail: outcome.error,
        });
        continue;
      }
    }

    log(
      `ccmux: [${options.source ?? "api"}] pruned worktree ${candidate.path} ` +
        `(${candidate.detail})` +
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
  //
  // Asynchronously, because this is the daemon's thread: a synchronous
  // recursive delete of a worktree carrying a `node_modules` (20k files here)
  // stalls the scan loop, SSE and every queued request for most of a second,
  // and a multi-worktree run turns that into one continuous freeze for every
  // unrelated session. The rename already freed the path, so nothing waits on
  // this finishing quickly.
  for (const trash of trashToDelete) {
    const outcome = outcomes.find((o) => o.trashPath === trash);
    try {
      await rm(trash, { recursive: true, force: true });
    } catch (err) {
      // Surfaced, not just logged. A user who opted in to losing uncommitted
      // work was told it was deleted; if the copy actually survives in a
      // hidden sibling directory, that promise was false and they need the
      // path to finish the job by hand.
      const message = err instanceof Error ? err.message : String(err);
      log(`ccmux: failed to delete ${trash}: ${message}`);
      outcome?.steps.push({
        step: "delete trash",
        ok: false,
        detail: `${trash} still exists: ${message}`,
      });
    }
  }

  return { outcomes, state, dryRun };
}

/** EACCES/EPERM/EROFS — the errors where deleting in place would destroy
 *  part of the tree before failing, rather than failing cleanly. */
function isPermissionError(err: unknown): boolean {
  const code =
    err instanceof Error && "code" in err ? String(err.code) : String(err);
  return (
    code.includes("EACCES") || code.includes("EPERM") || code.includes("EROFS")
  );
}

/**
 * git's refusals come with multi-line `hint:` advice aimed at a terminal; a
 * step detail wants the one line that says what happened.
 */
function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
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
        : `${candidate.branch} kept: ${firstLine(res.stderr) || `git branch ${flag} exited ${res.exitCode}`}`,
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
  // Keyed off outcomes that actually REMOVED something. A run where every
  // candidate was refused (all dirty, no opt-in) has reclaimed nothing, so it
  // must not go on to unlock and prune the repo anyway.
  const byRepo = new Map<string, PruneOutcome[]>();
  for (const outcome of outcomes) {
    if (!outcome.removed) continue;
    const list = byRepo.get(outcome.repoRoot) ?? [];
    list.push(outcome);
    byRepo.set(outcome.repoRoot, list);
  }

  for (const [repoRoot, repoOutcomes] of byRepo) {
    const removedHere = new Set(repoOutcomes.map((o) => o.path));
    const entries = await listWorktrees(repoRoot, git);
    for (const entry of entries) {
      if (!entry.locked || existsSync(entry.path)) continue;
      // ONLY worktrees this run removed. A lock on any other entry is the
      // user's own `git worktree lock`, and git's documented reason for it is
      // a path that is legitimately absent right now — an external drive or a
      // network share. Unlocking and pruning those destroyed a registration
      // the user never selected.
      if (!removedHere.has(entry.path)) continue;
      const candidate = candidates.find((c) => c.path === entry.path);
      if (!candidate) continue;

      let cleared = false;
      const adminDir = candidate.adminDir;
      // The admin dir is parsed out of the worktree's own `.git` file, so it
      // is only trusted once it is confirmed to live under this repo's
      // `.git/worktrees/`; otherwise fall through to git's own unlock.
      if (adminDir && isRepoAdminDir(adminDir, repoRoot)) {
        try {
          await rm(join(adminDir, "locked"), { force: true });
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

/**
 * Drop per-directory agent state for the worktrees this run removed and,
 * under `cleanOrphanState`, the accumulated backlog of entries whose
 * directory no longer exists — worktrees deleted outside ccmux, which no
 * other step would ever reach.
 */
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
