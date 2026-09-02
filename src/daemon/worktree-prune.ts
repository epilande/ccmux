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
 * surfaces select explicitly, and each destructive edge carries its own
 * opt-in on top of that. Dirty rows need `allowDirtyPaths`; a worktree whose
 * bound agent sessions are all idle needs `allowEndIdlePaths`, because
 * removing it ENDS those sessions. The two are independent axes, and a
 * worktree that is both needs both.
 */

import { existsSync, renameSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { SessionStatus } from "../types/session";
import { mapWithConcurrency } from "../lib/concurrency";
import { isCcmuxPane } from "../lib/config";
import { isShellCommand } from "./pane-classify";
import { scanTmuxPanesOrThrow } from "./pane-discovery";
import { tmuxArgv } from "../lib/tmux-exec";
import {
  builtinStateFiles,
  cleanStateEntries,
  findOrphanEntries,
  type AgentStateFile,
  type StateCleanupResult,
} from "./agent-state";

import {
  classifyRemoteHosting,
  fetchPrune,
  isMergedInto,
  listWorktrees,
  normalizePath,
  readAdminDir,
  readSymlinkDirectories,
  readDirtyState,
  readUpstreamStates,
  resolveBaseRefs,
  runGit,
  type GitRun,
  type RemoteHosting,
  type UpstreamState,
  type WorktreeEntry,
} from "./worktree-git";

/**
 * Why a worktree is removable, strongest evidence first — this is also the
 * precedence order when several apply:
 *
 * - `pr-merged`: GitHub says the branch's PR was merged. Survives squash and
 *   rebase merges, which no local check can see.
 * - `merged-locally`: the branch tip is an ancestor of the default branch, and
 *   is not the default branch's own tip (see {@link isMergedInto} for why that
 *   exclusion is what keeps a just-created worktree out of this list).
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

/**
 * Outcome of one PR lookup, discriminated on purpose.
 *
 * "This branch has no PR" and "the PR state could not be established" are
 * opposite facts for a feature that deletes directories, and they used to be
 * the same `null`: gh missing, unauthenticated, rate-limited, offline or
 * returning garbage all read as "no PR", which is precisely how an OPEN PR
 * goes undetected. See {@link classifyOne} for what a failure does instead.
 */
export type PRLookupResult =
  | { ok: true; pr: PRState | null }
  | { ok: false; error: string };

/**
 * What the REPO's remotes say about whether a PR could exist, resolved at most
 * once for the whole scan. Remotes are repo-level config that every linked
 * worktree shares, and the answer is only read on the lookup FAILURE path, so
 * probing git per worktree would repeat an identical pair of calls for every
 * worktree of a repo on exactly the machine where `gh` is already broken.
 */
export type RemoteHostingLookup = () => Promise<RemoteHosting>;

/**
 * Resolves the PR (if any) for a branch, including merged/closed ones.
 *
 * `hosting` is the scan's shared remote classification. It is optional so a
 * one-off call (`ghPRStateLookup(cwd, branch)`) still classifies for itself.
 */
export type PRStateLookup = (
  cwd: string,
  branch: string,
  hosting?: RemoteHostingLookup,
) => Promise<PRLookupResult>;

/** A session living in a worktree, as the prune surfaces need to see it. */
export interface WorktreeSession {
  id: string;
  agentType: string;
  status: SessionStatus;
  tmuxPane: string | null;
  tmuxTarget: string | null;
  pid: number | null;
  /**
   * A paneless Claude background-agent row, or an Agent-tool subagent folded
   * in under its parent. Its pid belongs to Claude's own supervisor rather
   * than to ccmux, so it must never be signalled directly (the same rule
   * `handleKillSession` follows).
   *
   * That is also why it HOLDS the worktree whatever its status: the end-idle
   * gate offers a worktree on the promise that ccmux can stop what lives
   * there, and this is the one kind of session it cannot.
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
  /**
   * Ignored directories that would be deleted with it (`node_modules/`, but
   * also a gitignored `notes/`). Named in the run log ONLY — not on the row
   * and not at either confirmation step, where a `node_modules/` on every
   * worktree would train reflex approval. Log-only still means the deletion
   * is recorded somewhere the user can read it afterwards, which is the whole
   * of what it was missing.
   */
  ignoredDirs: string[];
  branchDeletion: BranchDeletion;
  /** `.git/worktrees/<name>`, captured while the worktree still exists. */
  adminDir: string | null;
  /**
   * Sessions in this worktree; removal ENDS them.
   *
   * Non-empty only on an end-idle candidate ({@link classifyEndIdle}): every
   * session on it is `idle` and is ccmux's own to stop, and the only reason
   * allowed to offer such a worktree is `pr-merged`, proven by `gh`. A
   * `working`, `waiting` or background session skips the worktree at
   * classification instead, so it never reaches a candidate at all.
   *
   * Removing one of these takes a second opt-in, `allowEndIdlePaths`
   * ({@link PruneOptions}): {@link runPrune} refuses the candidate without
   * it, and re-checks every session's LIVE status before it signals anything,
   * since consent is not a claim about the present.
   */
  sessions: WorktreeSession[];
}

/** A worktree that has been deliberately withheld from the candidate list. */
export interface PruneSkip {
  path: string;
  repoRoot: string;
  branch: string | null;
  reason: string;
}

/**
 * A worktree the scan dropped because its pull request is still OPEN — the
 * healthy in-flight state, not a problem.
 *
 * Reported rather than silently dropped because the Worktrees panel shows a PR
 * badge, and an open PR is the single most useful thing it can say about a
 * worktree. It stays out of {@link PruneScan.candidates} for the same reason
 * as before: an open PR means the work is still in flight, whatever the local
 * refs look like.
 *
 * `branch` is a plain string, not nullable: a detached worktree is dropped
 * before any PR question is asked, so an open row always has one. `pr` is
 * likewise always present — both paths that produce this row (the daemon's
 * open-PR cache and the `gh` lookup) carry the PR itself, and a cache entry
 * too damaged to yield one falls through to the lookup rather than reporting a
 * PR-less row.
 */
export interface PruneOpen {
  path: string;
  repoRoot: string;
  branch: string;
  pr: PRState;
}

export interface PruneScan {
  candidates: PruneCandidate[];
  skipped: PruneSkip[];
  /** Worktrees withheld because their PR is still open. @see PruneOpen */
  open: PruneOpen[];
}

/**
 * `GET /worktrees/prune-candidates` as it may ARRIVE at a client.
 *
 * Every array {@link PruneScan} declares required is optional here, because
 * the daemon answering is a long-lived background process that can predate the
 * build talking to it: `open` (the healthy in-flight-PR rows) is simply absent
 * from an older one, and `data.open.map` on undefined would throw in the middle
 * of a merge that had nothing else wrong with it.
 */
export type ScanResponse = Partial<PruneScan>;

/**
 * The single place that knows an older daemon exists. Everything downstream —
 * the picker's Worktrees panel and `ccmux worktree prune` alike — reads a whole
 * {@link PruneScan}, so the guard lives at the boundary instead of at each of
 * the reads.
 *
 * It lives beside the scan it normalizes rather than in either client, so the
 * two cannot drift apart as the scan gains buckets.
 */
export function normalizeScan(data: ScanResponse): PruneScan {
  return {
    candidates: data.candidates ?? [],
    skipped: data.skipped ?? [],
    open: data.open ?? [],
  };
}

/**
 * Turn an HTTP status into something that names a cause the user can act on.
 *
 * 404 gets its own wording because it is not an exotic failure for the
 * worktree endpoints: the daemon is a long-lived background process,
 * `GET /worktrees` is new, and a daemon started before this build answers 404
 * for it — which is the guaranteed first result of upgrading without a restart.
 * "HTTP 404" describes that as a mystery; the restart command is the whole fix.
 */
export function describeHttpFailure(status: number): string {
  if (status === 404) {
    return "daemon is out of date (restart it: ccmux daemon restart)";
  }
  return `HTTP ${status}`;
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
 *
 * Every way this can fail to reach an answer — gh absent, unauthenticated,
 * rate-limited, offline, or replying with something that is not the requested
 * JSON — reports `ok: false` rather than "no PR", because the caller deletes
 * directories on the difference. The one exception is a repo that has no
 * remotes at all ({@link classifyRemoteHosting}), where a refusal IS the
 * answer.
 */
export const ghPRStateLookup: PRStateLookup = async (
  cwd,
  branch,
  hostingLookup,
) => {
  /**
   * A gh failure in a repo with NO remotes is not a missing answer: a PR has
   * nowhere to live there, so the worktree stays classifiable. Every other
   * repo, including one whose remotes are simply not recognizable as
   * github.com, reports the failure as-is.
   */
  const failed = async (error: string): Promise<PRLookupResult> => {
    const hosting = await (hostingLookup
      ? hostingLookup()
      : classifyRemoteHosting(cwd));
    if (hosting === "none") return { ok: true, pr: null };
    return {
      ok: false,
      error:
        hosting === "unknown"
          ? `${error} (no remote recognizable as github.com, so a PR cannot be ruled out)`
          : error,
    };
  };

  // A single try/catch around the whole spawn-through-parse sequence: a
  // missing `gh` binary throws from `Bun.spawn` itself (ENOENT) rather than
  // producing a process to await, so there is no exit code to branch on for
  // that case. JSON parsing gets its own inner catch so its message can say
  // "JSON" specifically rather than being folded into the generic one below.
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
    if (exitCode !== 0) return failed(`gh pr list exited ${exitCode}`);

    let rows: GhPRRow[];
    try {
      rows = (await new Response(proc.stdout).json()) as GhPRRow[];
    } catch (err) {
      return failed(
        `gh pr list did not return valid JSON: ${errorMessage(err)}`,
      );
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: true, pr: null };
    }

    // `refs/heads/` qualified for the same reason as `isMergedInto`: a tag
    // sharing the branch name outranks the branch in git's disambiguation,
    // and this SHA is what proves the PR belongs to this branch.
    const tip = await runGit(cwd, [
      "rev-parse",
      "--verify",
      `refs/heads/${branch}^{commit}`,
    ]);
    const localTip = tip.exitCode === 0 ? tip.stdout.trim() : null;
    return { ok: true, pr: selectPRForBranch(rows, localTip) };
  } catch (err) {
    return failed(`gh could not be run: ${errorMessage(err)}`);
  }
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ScanDeps {
  git?: GitRun;
  lookupPR?: PRStateLookup;
  /**
   * Sessions living in a worktree, keyed by its (realpath-normalized) root.
   * Supplied by the daemon, which is the only thing that knows.
   */
  sessionsFor?: (worktreePath: string) => WorktreeSession[];
  /**
   * The already-known OPEN pull request for a branch, read off the daemon's
   * existing `branchPRs` cache. Lets the common busy-branch case skip the gh
   * call entirely; answering null only costs a lookup that would have happened
   * anyway, which is also what an unusable cache entry should do rather than
   * reporting an open row with no PR to name.
   */
  openPR?: (cwd: string, branch: string) => PRState | null;
  /** Skip the per-repo `git fetch --prune` (tests, offline runs). */
  skipFetch?: boolean;
}

/** `N ignored <noun>s (a, b, c, +M more)`, or "" for an empty list. */
function summarizeIgnored(
  entries: string[],
  noun: string,
  max: number,
): string {
  if (entries.length === 0) return "";
  const shown = entries.slice(0, max);
  const rest = entries.length - shown.length;
  const names = shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
  const plural = entries.length === 1 ? "" : "s";
  return `${entries.length} ignored ${noun}${plural} (${names})`;
}

/**
 * One-line summary of the ignored files a removal would take with it, or ""
 * when there are none. Shared by every surface so the truncation rule — and
 * therefore what a user is shown before confirming — is defined once.
 */
export function describeIgnoredFiles(files: string[], max = 3): string {
  return summarizeIgnored(files, "file", max);
}

/**
 * The same, for the ignored DIRECTORIES. Separate from
 * {@link describeIgnoredFiles} rather than folded into it because only the
 * run log gets these: every other surface would show `node_modules/` on
 * nearly every worktree.
 */
export function describeIgnoredDirs(dirs: string[], max = 3): string {
  return summarizeIgnored(dirs, "dir", max);
}

/**
 * The run log's lines for everything ignored a removal takes with it: one per
 * KIND, files first (they are the ones no backup and no git history can bring
 * back), and an empty array when there is nothing to say.
 *
 * Two lines rather than one joined line because of where they are read. Each
 * log step renders on a single un-wrapped row, so at sidebar width a combined
 * `1 ignored file (.env), 2 ignored dirs (notes/, data/)` truncates away
 * exactly the tail — the directory names, which the run log is the ONLY
 * surface to carry. That is the #81 symptom growing back at 44 columns.
 */
export function describeIgnoredDeletion(
  files: string[],
  dirs: string[],
  max = 3,
): string[] {
  return [
    describeIgnoredFiles(files, max),
    describeIgnoredDirs(dirs, max),
  ].filter((part) => part !== "");
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
 * Ordering matters for safety: the lock check and the session gate run before
 * anything else, so a worktree an agent is live in is never classified on
 * local evidence. A worktree whose sessions are ALL idle is classified, but
 * only through {@link classifyEndIdle}, where a merged PR is the single
 * reason that can offer it.
 *
 * It buys less than it looks like on cost. An ordinary active worktree — a
 * branch pushed with a PR still open — reaches the `gh` call, because
 * "is there an open PR" is exactly what the network is being asked. Measured:
 * 15 active worktrees still made 15 gh calls. What genuinely avoids the call
 * is a branch with no upstream, a branch already merged locally, or a hit in
 * the daemon's open-PR cache (`openPR`); everything else pays for it, which
 * is why the calls run concurrently rather than one at a time.
 *
 * A worktree whose sessions are all idle now pays for one as well
 * ({@link classifyEndIdle}): a merged PR is the only thing that may offer it,
 * and the cache can only ever answer OPEN. A worktree an agent is working or
 * waiting in still spends nothing, because it is not offerable whatever the
 * answer comes back as.
 */
export async function scanRepo(
  repoRoot: string,
  deps: ScanDeps = {},
): Promise<PruneScan> {
  const git = deps.git ?? runGit;
  const candidates: PruneCandidate[] = [];
  const skipped: PruneSkip[] = [];
  const open: PruneOpen[] = [];

  const entries = await listWorktrees(repoRoot, git);
  const linked = entries.filter((e) => !e.isMain && !e.bare);
  if (linked.length === 0) return { candidates, skipped, open };

  // One network call per repo, not per worktree: this is what turns a branch
  // deleted on GitHub into a locally visible `[gone]`.
  if (!deps.skipFetch) await fetchPrune(repoRoot, git);

  const [baseRefs, upstreams] = await Promise.all([
    resolveBaseRefs(repoRoot, git),
    readUpstreamStates(repoRoot, git),
  ]);
  const repoName = basename(repoRoot);
  // Read once per repo, not per worktree: it is the same file for all of them.
  const setupSymlinks = readSymlinkDirectories(repoRoot);
  // Same reasoning, one step lazier: the remote classification is repo-level
  // too, but only the PR-lookup failure path reads it, so it is resolved on
  // first use and then shared instead of being probed per worktree.
  const hosting = onceAsync(() => classifyRemoteHosting(repoRoot, git));

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
        setupSymlinks,
        hosting,
        git,
        deps,
      }),
  );
  for (const result of results) {
    if (result.candidate) candidates.push(result.candidate);
    if (result.skip) skipped.push(result.skip);
    if (result.open) open.push(result.open);
  }

  return { candidates, skipped, open };
}

/** Concurrent `gh pr list` calls per repo during classification. */
const CLASSIFY_CONCURRENCY = 6;

/**
 * Run an async producer at most once, sharing the SAME promise with every
 * later caller. Sharing the promise (rather than the resolved value) is what
 * makes it safe under `mapWithConcurrency`, where several worktrees can ask
 * before the first answer has landed.
 */
function onceAsync<T>(produce: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= produce());
}

interface ClassifyContext {
  repoRoot: string;
  repoName: string;
  baseRefs: string[];
  upstreams: Map<string, UpstreamState>;
  /** `worktree.symlinkDirectories`, so a setup symlink is not read as dirt. */
  setupSymlinks: string[];
  /** The repo's shared remote classification. @see RemoteHostingLookup */
  hosting: RemoteHostingLookup;
  git: GitRun;
  deps: ScanDeps;
}

/** What one worktree contributed to the scan. */
interface Classification {
  candidate?: PruneCandidate;
  skip?: PruneSkip;
  open?: PruneOpen;
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
  // A session that HOLDS the worktree whatever the refs or GitHub say, and
  // the three shapes it comes in:
  //
  // - `working`: pulling the directory out from under it loses whatever it
  //   has not written yet.
  // - `waiting`: the agent is by definition mid-turn, blocked on an answer.
  //   It reads as the calmer state and is not.
  // - background: a paneless Claude background row or a subagent folded in
  //   under its parent. ccmux cannot end it (the pid is the supervisor's), so
  //   it can never honestly offer to remove what it lives in, at any status.
  //
  // `working` is looked for before `waiting` so a worktree holding both does
  // not report the quieter of the two.
  const holding =
    sessions.find((s) => s.status === "working") ??
    sessions.find((s) => s.status === "waiting") ??
    sessions.find((s) => s.background === true) ??
    null;
  if (holding) {
    const reason = `an agent is ${holding.status} here`;
    // The skip and the open row are INDEPENDENT facts, and an occupied
    // worktree is the likeliest one of all to have an open PR — reporting
    // only the skip made the panel's badge unreachable for exactly those
    // rows. The skip still stands on its own: it is the removal gate, and
    // nothing here weakens it.
    //
    // Cache only, no `gh` call. This worktree is not going to be offered for
    // removal whatever the answer, so it does not get to spend a network
    // round trip — and the daemon's PR cache is populated from the branches
    // its SESSIONS sit on, which is precisely this case. A miss still warms
    // the cache for the next scan (`PRResolver.get` refreshes in the
    // background), so the badge arrives a scan later rather than never.
    const openPR = deps.openPR?.(path, branch) ?? null;
    return {
      skip: { path, repoRoot, branch, reason },
      ...(openPR ? { open: { path, repoRoot, branch, pr: openPR } } : {}),
    };
  }

  // Every session here is idle and is ccmux's to stop, so the worktree can be
  // OFFERED. It goes down its own path rather than the local-evidence one
  // below, and never falls through to it: `merged-locally` and
  // `upstream-gone` must not reach an occupied worktree. A worktree branched
  // from base carries the base's own tip, which every local check reads as
  // "already merged" (see `isMergedInto`), and that is precisely the fresh
  // worktree an agent is sitting idle in.
  if (sessions.length > 0) return classifyEndIdle(entry, ctx, branch, sessions);

  const upstream = ctx.upstreams.get(branch) ?? {
    upstream: null,
    gone: false,
    ahead: 0,
    behind: 0,
  };

  // An open PR means the work is still in flight, whatever the local refs
  // look like. Checked against the daemon's existing cache first so the
  // common case costs nothing.
  const cachedPR = deps.openPR?.(path, branch) ?? null;
  if (cachedPR) return { open: { path, repoRoot, branch, pr: cachedPR } };

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
  //
  // S7: a failed lookup is NOT treated as "no PR". `gh` missing,
  // unauthenticated, rate-limited, offline, or replying with garbage used to
  // collapse to the same `null` as a branch with no PR, which reproduces
  // exactly the skip two paragraphs up warns against: an open PR going
  // undetected. It only matters when local evidence would otherwise offer
  // this worktree (`mergedLocally` or `upstream.gone`) — a failure can only
  // ever WITHHOLD a worktree, never manufacture a reason, so `reasonFor` is
  // never reached with a guessed PR state. A worktree with no local evidence
  // either was never a candidate, gh or no gh, so it stays silent rather than
  // turning every in-flight worktree into a skip line on a broken machine.
  const lookupPR = deps.lookupPR ?? ghPRStateLookup;
  const lookup = await lookupPR(path, branch, ctx.hosting);
  if (!lookup.ok) {
    if (mergedLocally || upstream.gone) {
      return skip(`PR state could not be determined: ${lookup.error}`);
    }
    return {};
  }
  const pr = lookup.pr;
  if (pr?.state === "OPEN") return { open: { path, repoRoot, branch, pr } };

  const reason = reasonFor(pr, mergedLocally, upstream.gone);
  if (!reason) return {};

  return {
    candidate: await buildCandidate(path, ctx, {
      branch,
      reason,
      pr,
      upstream: upstream.upstream,
      sessions,
    }),
  };
}

/**
 * Classify a worktree whose bound sessions are ALL idle and all ccmux's to
 * stop: the end-idle gate.
 *
 * The rule is one thing, deliberately narrow. Only `pr-merged` may offer an
 * occupied worktree, because it is the only reason backed by evidence from
 * outside this machine: GitHub says the work landed, and
 * {@link selectPRForBranch} has already proven the PR is about THIS branch by
 * head SHA. Everything else stays a skip, including the two reasons that
 * would offer an unoccupied worktree happily (`merged-locally`,
 * `upstream-gone`), the rejected-work reason (`pr-closed`), a branch with no
 * PR at all, and a lookup that could not reach an answer. No proof is not a
 * guess: the cost of being wrong here is a live agent killed and its
 * directory deleted.
 *
 * Every arm returns. Falling through to the local-evidence path would both
 * spend a second `gh` call and hand `reasonFor` an occupied worktree.
 */
async function classifyEndIdle(
  entry: WorktreeEntry,
  ctx: ClassifyContext,
  branch: string,
  sessions: WorktreeSession[],
): Promise<Classification> {
  const { repoRoot, deps } = ctx;
  const path = entry.path;
  // The skip this gate falls back to, kept as one value so every refusal
  // arm below reports the same sentence. It names the session's own status
  // rather than the literal "idle" so a status this gate does not know about
  // cannot be described as one it does.
  const held: Classification = {
    skip: {
      path,
      repoRoot,
      branch,
      reason: `an agent is ${sessions[0].status} here`,
    },
  };

  // The daemon's cache first: it is populated from the branches its SESSIONS
  // sit on, which is exactly this case, so the busy-branch answer is usually
  // already here and costs no network at all. A cache entry is only ever an
  // OPEN PR, so a hit is a skip plus the badge the panel wants.
  const cachedPR = deps.openPR?.(path, branch) ?? null;
  if (cachedPR) {
    return { ...held, open: { path, repoRoot, branch, pr: cachedPR } };
  }

  // The one `gh` call the end-idle gate spends, and it is spent only here:
  // on a worktree whose sessions are all idle and whose branch had no cached
  // open PR. An occupied worktree that is NOT offerable still pays nothing,
  // because it returned at the holding gate above.
  const lookupPR = deps.lookupPR ?? ghPRStateLookup;
  const lookup = await lookupPR(path, branch, ctx.hosting);
  if (!lookup.ok) return held;

  const pr = lookup.pr;
  if (pr?.state === "OPEN") {
    return { ...held, open: { path, repoRoot, branch, pr } };
  }
  if (pr?.state !== "MERGED") return held;

  return {
    candidate: await buildCandidate(path, ctx, {
      branch,
      reason: "pr-merged",
      pr,
      upstream: ctx.upstreams.get(branch)?.upstream ?? null,
      sessions,
    }),
  };
}

/**
 * Assemble the candidate for a worktree that has earned a reason, including
 * the `git status` its dirty counts come from.
 *
 * Shared by both classification paths so an end-idle candidate is the SAME
 * shape as any other: same dirty accounting, same ignored-file accounting,
 * same branch-deletion policy. The only thing that separates them is a
 * non-empty `sessions`, which is what {@link runPrune}'s end-idle opt-in
 * keys off.
 */
async function buildCandidate(
  path: string,
  ctx: ClassifyContext,
  args: {
    branch: string;
    reason: PruneReason;
    pr: PRState | null;
    upstream: string | null;
    sessions: WorktreeSession[];
  },
): Promise<PruneCandidate> {
  const dirtyState = await readDirtyState(path, ctx.git, {
    setupSymlinks: ctx.setupSymlinks,
  });
  return {
    path,
    repoRoot: ctx.repoRoot,
    repoName: ctx.repoName,
    name: basename(path),
    branch: args.branch,
    reason: args.reason,
    detail: detailFor(args.reason, args.pr, args.upstream, ctx.baseRefs),
    pr: args.pr,
    dirty: dirtyState.dirty,
    modified: dirtyState.modified,
    untracked: dirtyState.untracked,
    ignoredFiles: dirtyState.ignoredFiles,
    ignoredDirs: dirtyState.ignoredDirs,
    branchDeletion: branchDeletionFor(args.reason),
    adminDir: readAdminDir(path),
    sessions: args.sessions,
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
  const open: PruneOpen[] = [];
  for (const root of repoRoots) {
    const key = normalizePath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const scan = await scanRepo(root, deps);
    candidates.push(...scan.candidates);
    skipped.push(...scan.skipped);
    open.push(...scan.open);
  }
  candidates.sort(
    (a, b) =>
      a.repoName.localeCompare(b.repoName) || a.name.localeCompare(b.name),
  );
  open.sort((a, b) => a.path.localeCompare(b.path));
  return { candidates, skipped, open };
}

/**
 * A pane as the last-moment occupancy guard sees it. Structural rather than
 * `TmuxPane` so the rule below can be tested without building tmux rows.
 */
export interface OccupantPane {
  paneId: string;
  currentPath: string | null;
  currentCommand: string | null;
  /** `#{pane_title}`, which is how a ccmux surface identifies itself. */
  paneTitle: string | null;
}

/**
 * Panes that are evidence of LIVE WORK inside a worktree about to be removed.
 *
 * This exists because the session gate cannot close its own race. The scan
 * snapshots sessions, then spends seconds on `git fetch` and a `gh` call per
 * branch; the run re-derives, but an agent that started in the meantime — or
 * one that started before the scan and has not been detected yet, since
 * binding costs a pane scan and a marker — is invisible to both. tmux, asked
 * at the moment of deletion, is the one observer that has no such latency.
 *
 * A pane counts as an occupant when its cwd is inside the worktree AND its
 * foreground command is not a bare shell AND it is not a ccmux surface. The
 * shell exemption is the whole subtlety: a shell left sitting in a directory
 * that is about to disappear is the ORDINARY leftover, and refusing on it
 * would block most legitimate removals (the prune surfaces are themselves
 * usually opened from a pane in the repo). An editor is not exempt —
 * `isShellCommand` is deliberately narrower than `isNonAgentCommand` for
 * exactly this call.
 *
 * A ccmux surface is exempt BY IDENTITY, not by being the caller. A sidebar
 * reports `bun` as its foreground command, so the shell exemption never
 * covered it, and `callerPane` cannot cover it either: inside a
 * `display-popup` TMUX_PANE is unset, so the popup picker sends no exemption
 * at all and refused every prune of a worktree a sidebar happened to sit in.
 * The pane title is what distinguishes them — every ccmux surface sets one
 * (`isCcmuxPane`), and a surface is never the work a prune should refuse on.
 *
 * `ignorePaneIds` carries the panes this run actually closed, which
 * {@link runPrune} has already stopped by this point; a pane tmux has not
 * finished reaping must not become a refusal of the removal that just closed
 * it. A scan pane whose live row is gone is not among them.
 *
 * What it does NOT catch, and cannot: work outside tmux (an editor in another
 * terminal, a build in an IDE), and a process whose pane cwd is elsewhere. The
 * guard narrows the window; it does not close it.
 */
export function paneOccupants(
  panes: OccupantPane[],
  worktreePath: string,
  ignorePaneIds: Iterable<string> = [],
): OccupantPane[] {
  const root = normalizePath(worktreePath);
  const prefix = root.endsWith(sep) ? root : root + sep;
  const ignored = new Set(ignorePaneIds);
  return panes.filter((pane) => {
    if (ignored.has(pane.paneId)) return false;
    if (!pane.currentPath) return false;
    const path = normalizePath(pane.currentPath);
    if (path !== root && !path.startsWith(prefix)) return false;
    if (isCcmuxPane(pane.paneTitle)) return false;
    return !isShellCommand(pane.currentCommand);
  });
}

/** How the guard describes what it found, for the run log and the error. */
function describeOccupants(occupants: OccupantPane[]): string {
  return occupants
    .map((pane) => `${pane.paneId} (${pane.currentCommand ?? "unknown"})`)
    .join(", ");
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
  /**
   * Every tmux pane, for the last-moment occupancy guard
   * ({@link paneOccupants}). THROWING means tmux could not be inspected;
   * {@link runPrune} then proceeds WITHOUT the guard, logging a
   * `live-pane check skipped` step — see the fail-soft rationale at the call
   * site. A tmux that is simply not running is not a throw; it is zero panes,
   * which is a definitive answer.
   */
  listPanes?: () => Promise<OccupantPane[]>;
  sleep?: (ms: number) => Promise<void>;
  stateFiles?: AgentStateFile[];
  now?: () => Date;
  /** Surface tag for the run log (`picker`, `cli`). */
  source?: string;
  log?: (message: string) => void;
}

export interface PruneOptions extends PruneDeps {
  /**
   * The pane the request came FROM, exempt from the occupancy guard.
   *
   * This covers the CLI, whose pane runs `ccmux worktree prune` itself: prune
   * from a pane sitting inside the worktree, the most natural way to do it,
   * and the guard would otherwise refuse on the process doing the pruning.
   * Surfaces need no exemption of their own — a `display-popup` is not a pane
   * (verified: a popup running a long command does not appear in
   * `list-panes -a`), and a sidebar, which IS a real pane, is exempt by its
   * title (see {@link paneOccupants}) rather than by sending an id it cannot
   * always know. Callers that have `$TMUX_PANE` send it anyway, the same
   * convention spawn placement uses.
   *
   * It exempts that pane from the LAST-MOMENT check only. A worktree with a
   * working, waiting or background session is still skipped at
   * classification, and one whose sessions are all idle still needs
   * {@link PruneOptions.allowEndIdlePaths}, so this cannot be used to prune a
   * worktree an agent is actually working in.
   */
  callerPane?: string;
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
   *
   * Compared against `normalizePath(candidate.path)`, not the raw path (S10):
   * a caller (`server.ts`) normalizes this list before sending it, and
   * `candidate.path` is git's own raw recorded path, which can differ from
   * the normalized form by case (case-insensitive filesystem) or a resolved
   * symlink. Comparing them un-normalized still fails closed, but dead-ends
   * an opted-in removal on a spurious "was not opted in".
   */
  allowDirtyPaths?: string[];
  /**
   * Worktree paths the user separately opted in to ENDING the idle agent
   * sessions in. A candidate carrying sessions and not listed here is
   * refused before anything is signalled, for the same reason a dirty one is:
   * the confirmation that selected a row is about a directory, and killing
   * someone's agent is a different thing to agree to.
   *
   * A separate axis from {@link PruneOptions.allowDirtyPaths}, not a
   * stronger form of it. A merged worktree that is both dirty and occupied
   * needs BOTH opt-ins and refuses on whichever is missing.
   *
   * Compared against `normalizePath(candidate.path)` exactly like the dirty
   * list, and for the same reason (S10).
   */
  allowEndIdlePaths?: string[];
  /**
   * The session RIGHT NOW, as the daemon sees it: both the status the consent
   * is checked against and the pid the signal is sent to.
   *
   * It has to carry the pid, not just the status. A candidate's sessions are
   * a snapshot that a `gh` call per branch and every earlier candidate's
   * shutdown wait have aged, and the reconciler rewrites a live row's `pid`
   * when a new agent process takes over a pane, or clears it on a soft evict.
   * Reading the status from the live row and the pid from the snapshot is the
   * mismatch `handleKillSession` warns about in its own comment: the status
   * that authorized the kill would describe one process and the SIGTERM would
   * land on another.
   *
   * Any non-idle answer refuses the candidate; consent never overrides live
   * status. `undefined` means the daemon has no such session any more, which
   * is the good case (it exited) — the run proceeds, but with nothing left to
   * signal and without closing the scan pane. `handleKillSession` 404s a
   * missing row the same way; the pane can already hold a replacement occupant,
   * and occupancy would exempt it as one this run closed. Omitting the
   * callback entirely skips both the re-check and the pid refresh, for callers
   * with nothing live to ask.
   */
  liveSession?: (
    sessionId: string,
  ) => Pick<WorktreeSession, "status" | "pid"> | undefined;
}

const PROCESS_EXIT_TIMEOUT_MS = 3000;
/**
 * How long to wait for a SIGKILL to take effect after SIGTERM went
 * unanswered (S9). SIGKILL cannot be trapped or ignored, so this only needs
 * to cover the OS's own reap latency, not any agent shutdown work — kept
 * short deliberately.
 */
const SIGKILL_VERIFY_TIMEOUT_MS = 1000;

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

async function tmuxOk(args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(tmuxArgv(...args), {
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
    const proc = Bun.spawn(tmuxArgv("list-panes", "-a", "-F", "#{pane_id}"), {
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
 * Default pane source for the occupancy guard.
 *
 * `scanTmuxPanesOrThrow`, NOT the fail-soft `listTmuxPanes`: no tmux server is
 * a definitive "there are no panes" and comes back as an empty list, while a
 * tmux that could not be run or answered an unexpected error THROWS — so
 * {@link runPrune} can tell the two apart and log that the check was skipped
 * instead of silently treating a broken tmux as an empty one.
 */
async function defaultListPanes(): Promise<OccupantPane[]> {
  const scan = await scanTmuxPanesOrThrow();
  return scan.panes.map((pane) => ({
    paneId: pane.paneId,
    currentPath: pane.currentPath,
    currentCommand: pane.currentCommand,
    paneTitle: pane.paneTitle,
  }));
}

/**
 * Poll `kill(pid, 0)` until it throws (process gone) or `timeoutMs` elapses,
 * reporting whether the process is STILL alive at the end of that window.
 * Shared by the SIGTERM wait and the SIGKILL verify (S9): both are "did the
 * signal already land" checks that differ only in the timeout and which
 * signal preceded them.
 */
async function stillAliveAfter(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals | 0) => void,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let alive = true;
  const deadline = Date.now() + timeoutMs;
  while (alive && Date.now() < deadline) {
    try {
      kill(pid, 0);
      await sleep(50);
    } catch {
      alive = false;
    }
  }
  return alive; // true == still answering when the window ran out
}

/**
 * Stop a worktree's agents and close their panes.
 *
 * The pane is closed only after the process is confirmed gone (or SIGKILL was
 * tried and its own wait ran out): closing first would leave the agent
 * orphaned mid-write against a directory that is about to be renamed out from
 * under it, which is exactly the shutdown this is trying to avoid.
 *
 * S9: a SIGTERM that goes unanswered for `PROCESS_EXIT_TIMEOUT_MS` escalates
 * to SIGKILL, verified the same way. `allExited` in the returned summary is
 * false only when a process still answers `kill(pid, 0)` after that
 * escalation — at that point ccmux has done everything short of a bug in the
 * OS to end it, and {@link runPrune} refuses to rename or delete that
 * candidate's directory rather than delete out from under a process that may
 * still be writing to it. The pane is still closed either way: closing it is
 * a UI courtesy, not a data-safety measure, so it is not worth withholding
 * over a process ccmux could not kill.
 *
 * Takes the sessions rather than the candidate because the pids it signals
 * are the ones {@link runPrune} just re-read from the live daemon, not the
 * ones the scan wrote down (S12). A session the daemon no longer knows
 * arrives here with a null pid and a null pane: nothing to signal, and
 * nothing to close.
 */
async function stopSessions(
  sessions: WorktreeSession[],
  deps: PruneDeps,
  steps: PruneStep[],
): Promise<{ closedPanes: string[]; allExited: boolean }> {
  const kill = deps.killProcess ?? defaultKill;
  const closePane = deps.closePane ?? defaultClosePane;
  const sleep = deps.sleep ?? defaultSleep;
  const closed: string[] = [];
  let allExited = true;

  for (const session of sessions) {
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
      if (alive) {
        alive = await stillAliveAfter(
          session.pid,
          kill,
          sleep,
          PROCESS_EXIT_TIMEOUT_MS,
        );
      }
      let escalated = false;
      if (alive) {
        escalated = true;
        try {
          kill(session.pid, "SIGKILL");
        } catch {
          alive = false; // died between the check and the signal
        }
        if (alive) {
          alive = await stillAliveAfter(
            session.pid,
            kill,
            sleep,
            SIGKILL_VERIFY_TIMEOUT_MS,
          );
        }
      }
      if (alive) allExited = false;
      steps.push({
        step: "stop agent",
        ok: !alive,
        detail: alive
          ? `${session.agentType} pid ${session.pid} did not exit after SIGTERM or SIGKILL; this worktree will be refused`
          : escalated
            ? `${session.agentType} pid ${session.pid} did not exit in ${PROCESS_EXIT_TIMEOUT_MS}ms; SIGKILLed`
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
  return { closedPanes: closed, allExited };
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
 *
 * Both consent gates come first, before anything is signalled or moved: the
 * dirty opt-in, then the end-idle opt-in and the live-status re-check it is
 * paired with. A candidate that fails either has nothing done to it at all,
 * and both run under `dryRun` too so a dry run refuses what a real run
 * would.
 *
 * Per candidate, `stopSessions` (S9) runs BEFORE the dirty re-check (S8),
 * which runs immediately before the rename. Checking dirt first would leave
 * the whole agent-shutdown wait unguarded — exactly the gap that let a
 * comment here claim "immediately before deletion" while the code ran the
 * check before the wait that made it stale.
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
  const allowEndIdle = new Set(options.allowEndIdlePaths ?? []);
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

    // S10: compared against the normalized path on both sides. `allowDirty`
    // arrives normalized (the server normalizes the opt-in list it was
    // sent), but `candidate.path` is git's own raw recorded path, which can
    // differ by case on a case-insensitive filesystem or by a symlink git
    // resolved and the caller's echo did not. Comparing raw-to-normalized
    // fails closed (nothing is destroyed) but dead-ends the user on a
    // refusal for a worktree they did opt into.
    if (candidate.dirty && !allowDirty.has(normalizePath(candidate.path))) {
      outcome.error =
        "has uncommitted or untracked changes and was not opted in";
      steps.push({
        step: "refused",
        ok: false,
        detail: `${candidate.modified} modified, ${candidate.untracked} untracked; needs an explicit dirty opt-in`,
      });
      continue;
    }

    // What this run will actually signal, and what the dry run reports. It
    // starts as the scan's snapshot and is replaced below by whatever the
    // live lookup says, when there is one.
    let sessionsToStop = candidate.sessions;

    // The other consent gate, and an INDEPENDENT one: a candidate carrying
    // sessions is a worktree whose idle agents this run would end, which the
    // scan offers only for a merged PR. Selecting the row is agreement about
    // a directory; ending someone's session is a separate thing to agree to,
    // so it takes its own opt-in and refuses before anything is signalled.
    // Normalized on both sides for the same reason as the dirty list (S10).
    if (candidate.sessions.length > 0) {
      if (!allowEndIdle.has(normalizePath(candidate.path))) {
        outcome.error = "has an idle agent session and was not opted in";
        const count = candidate.sessions.length;
        steps.push({
          step: "refused",
          ok: false,
          detail: `${count} idle agent session${count === 1 ? "" : "s"} would be ended; needs an explicit end-idle opt-in`,
        });
        continue;
      }

      // Consent is not a claim about the present. The scan's status is a
      // snapshot that a `gh` call per branch and the user's own confirmation
      // have aged, and an agent that picked up work in that window must not
      // be killed on an opt-in given while it was idle. Runs under dryRun
      // too, so a dry run reports what would actually happen rather than what
      // the stale list says.
      //
      // The SAME lookup supplies the pid this run signals (S12). Asking the
      // live row whether it may be killed and then killing the pid the scan
      // wrote down is only sound while the two describe one process, and the
      // reconciler is free to rewrite a row's pid in exactly this window.
      //
      // Background sessions are not asked about: ccmux cannot end one, so
      // `stopSessions` never signals it and its status decides nothing here.
      const lookup = options.liveSession;
      if (lookup) {
        const resolved = candidate.sessions.map((session) => ({
          session,
          live: session.background ? undefined : lookup(session.id),
        }));
        const busy = resolved.find(
          (entry) => entry.live !== undefined && entry.live.status !== "idle",
        );
        if (busy) {
          outcome.error = `its agent is ${busy.live?.status} now, not idle; nothing was deleted`;
          steps.push({
            step: "refused",
            ok: false,
            detail: `${busy.session.agentType} ${busy.session.id} went ${busy.live?.status} after the list was built; the end-idle opt-in does not cover that`,
          });
          continue;
        }
        // An `undefined` answer leaves a null pid AND a null pane: the daemon
        // no longer tracks this session, so there is no process it can
        // honestly claim to be ending and no pane it can honestly claim to
        // own. `handleKillSession` 404s a missing row and leaves the pane;
        // closing it here would destroy a replacement occupant (native UUID
        // gone, new agent in the same `%N`) that occupancy would then exempt
        // as a pane this run already closed. A live row still carries the
        // scan's pane: that is the one this run verified.
        sessionsToStop = resolved.map(({ session, live }) =>
          session.background
            ? session
            : live
              ? { ...session, pid: live.pid }
              : { ...session, pid: null, tmuxPane: null },
        );
      }
    }

    // Everything gitignored the removal takes with it. The FILES are already
    // on the row and in both confirmations; the DIRECTORIES are named here
    // and nowhere else, because a `node_modules/` in front of every confirm
    // trains the reflex approval the whole ignored policy exists to avoid —
    // but a gitignored `notes/` used to go with no record at all.
    // One step per kind: a joined line loses its tail to truncation at
    // sidebar width, and the tail is the half only this surface carries.
    const ignoredSummaries = describeIgnoredDeletion(
      candidate.ignoredFiles,
      candidate.ignoredDirs,
      10,
    );

    if (dryRun) {
      outcome.removed = true;
      for (const session of sessionsToStop) {
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
      // What a dry run owes the user most: the sessions this removal would
      // END. The directory line alone reads as a file operation, and the
      // opt-in that authorized it is exactly the one worth being able to
      // review before the real run.
      for (const session of sessionsToStop) {
        steps.push({
          step: "would stop agent",
          ok: true,
          detail: session.background
            ? `${session.agentType} ${session.id} is supervisor-owned; it would not be signalled`
            : session.pid
              ? `${session.agentType} pid ${session.pid} would be stopped`
              : session.tmuxPane
                ? `${session.agentType} ${session.id} has no pid; only its pane would be closed`
                : `${session.agentType} ${session.id} is gone; nothing would be signalled or closed`,
        });
      }
      for (const detail of ignoredSummaries) {
        steps.push({ step: "would delete ignored", ok: true, detail });
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
    for (const detail of ignoredSummaries) {
      steps.push({ step: "deleting ignored", ok: true, detail });
    }

    // Stop the worktree's agents (and close their panes) BEFORE the dirty
    // re-check and the rename, not after (S8). The wait below is up to
    // PROCESS_EXIT_TIMEOUT_MS per session, and running it AFTER the re-check
    // — the previous order — left that whole window unguarded: an agent
    // flushing state during its own shutdown, or a user editing in a shell,
    // could dirty the directory in the gap between the check and the rename.
    //
    // S9: `stopSessions` escalates an unanswered SIGTERM to SIGKILL and
    // reports whether every session's process is confirmed gone. A candidate
    // whose agent survives even SIGKILL is refused here rather than deleted:
    // the previous behavior renamed and deleted the directory unconditionally
    // after the wait, so a wedged agent kept writing into the trash directory
    // right up until it was removed.
    const shutdown = await stopSessions(sessionsToStop, options, steps);
    outcome.panesClosed = shutdown.closedPanes;
    if (!shutdown.allExited) {
      outcome.error =
        "its agent could not be stopped even after SIGKILL; nothing was deleted";
      steps.push({
        step: "refused",
        ok: false,
        detail:
          "a live process may still be writing to this worktree; it was left in place",
      });
      continue;
    }

    // Re-check at the point of no return, AFTER the shutdown wait above, not
    // before it (S8). The scan-time answer can be tens of seconds old by
    // now — a `gh pr list` per worktree, plus the agent-exit wait
    // `stopSessions` just ran — and someone editing in this worktree during
    // that window would otherwise lose the work with no opt-in. One
    // `git status`, immediately before the directory moves.
    if (!allowDirty.has(normalizePath(candidate.path))) {
      // Same setup-symlink exemption as the scan, or a worktree that passed
      // the list would be refused here for the link the tooling itself made.
      //
      // Re-read rather than reusing the scan's value, unlike the once-per-repo
      // read there: this is the point of no return, and the settings file may
      // have changed since the list was built. One small file read against a
      // directory deletion is not a cost worth optimizing.
      const fresh = await readDirtyState(candidate.path, git, {
        setupSymlinks: readSymlinkDirectories(candidate.repoRoot),
      });
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

    // LAST check before the directory moves, and the only one that does not
    // rely on the daemon's own session tracking (S11). The session gate is a
    // snapshot the scan took seconds ago, and binding a newly started agent
    // costs a pane scan plus a marker on top of that, so an agent that
    // started in this worktree during the window is invisible to every check
    // above. tmux has no such latency.
    //
    // Placed after `stopSessions` deliberately: the panes this run legitimately
    // closed are gone by now, and THOSE panes (not the scan's snapshot) are
    // passed as exemptions for any tmux has not finished reaping. A scan pane
    // whose live row is gone is not among them, so a replacement occupant
    // still sitting in it is a refusal.
    try {
      const panes = await (options.listPanes ?? defaultListPanes)();
      const occupants = paneOccupants(panes, candidate.path, [
        ...sessionsToStop.flatMap((s) => (s.tmuxPane ? [s.tmuxPane] : [])),
        ...(options.callerPane ? [options.callerPane] : []),
      ]);
      if (occupants.length > 0) {
        outcome.error =
          "something is running in this worktree; nothing was deleted";
        steps.push({
          step: "refused",
          ok: false,
          detail: `${describeOccupants(occupants)} ${occupants.length === 1 ? "is" : "are"} live in this directory (a bare shell would not have blocked it)`,
        });
        continue;
      }
    } catch (err) {
      // Fail SOFT, and say so in the log. This is the one place the guard
      // deliberately does not follow `readDirtyState`'s "refuse what you
      // cannot inspect" rule, because the two failures are not alike: an
      // unreadable worktree is a fact about THIS directory, while an
      // unreachable tmux is environmental and global. Refusing on it would
      // turn "tmux is missing or misconfigured" into "ccmux can no longer
      // delete anything", including on a machine that has no tmux at all —
      // and the behavior this guard replaced was to proceed without checking
      // at all. It may narrow the race; it must never be a new way to fail.
      steps.push({
        step: "live-pane check skipped",
        ok: false,
        detail: `tmux could not be listed (${errorMessage(err)}); removal proceeded unchecked`,
      });
    }

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
