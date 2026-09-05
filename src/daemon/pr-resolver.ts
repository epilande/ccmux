import type { BranchPR } from "../types/session";

/**
 * Resolves open PRs for a session's (cwd, branch) via the `gh` CLI,
 * agent-agnostic: every session carries a cwd and a git branch, so this
 * covers Claude, Codex, OpenCode, Gemini, and custom agents uniformly.
 *
 * `gh pr list` is a network call (hundreds of ms), and `enrichSession`
 * runs on every SSE update for every session, so reads are synchronous
 * against a cache and refreshes happen in the background
 * (stale-while-revalidate). When a refresh lands a changed value,
 * `onChange` fires so the server can re-broadcast affected sessions;
 * without it, idle sessions would show stale PRs until their next event.
 */

/** Returns open PRs, or null when the lookup failed (cached as negative). */
export type PRLookupFn = (
  cwd: string,
  branch: string,
) => Promise<BranchPR[] | null>;

interface PRCacheEntry {
  prs: BranchPR[] | null;
  expiresAt: number;
}

/**
 * Successful lookups (gh answered, with or without PRs) refresh on a short
 * TTL so the PR transitions a user actually watches — a merge clearing the
 * cell, a fresh `gh pr create` populating it — land within TTL plus the
 * server's 2-min sweep. Failed lookups (null) back off on a long TTL: the
 * conditions behind them (no GitHub remote, logged-out gh, deleted cwd)
 * are persistent on the minutes scale, so fast retries would only burn
 * spawns on a doomed call.
 */
const PR_CACHE_SUCCESS_TTL_MS = 2 * 60_000;
const PR_CACHE_FAILURE_TTL_MS = 10 * 60_000;

/**
 * Cap on concurrent refreshes across distinct keys. A cold cache (TUI
 * connect, sweep after a long idle) can expire many keys at once, and
 * each refresh is a gh process + network round-trip. Keys over the cap
 * skip the round; the next read of a still-stale key (organic event or
 * the server's 2-min sweep) reschedules it, trading a spawn burst for
 * slightly longer cold-start staleness.
 */
const MAX_CONCURRENT_REFRESHES = 4;

/** Default branches never have a meaningful head-branch PR; skip the call. */
const SKIP_BRANCHES = new Set(["main", "master", "HEAD"]);

/** One `statusCheckRollup` entry as gh flattens it: a union of CheckRun
 * (Actions/checks; read `status` then `conclusion`) and StatusContext
 * (legacy commit statuses; read `state`), discriminated by `__typename`. */
export interface RollupEntry {
  __typename?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
}

/** CheckRun conclusions that gh buckets as failing in its PR-status rollup
 * (cli/cli api/queries_pr.go, the verdict `gh pr view`/`gh pr status` show).
 * SUCCESS/NEUTRAL/SKIPPED are passing; STALE/STARTUP_FAILURE and any
 * non-COMPLETED run are pending. Mirroring that rollup keeps ccmux's color in
 * agreement with `gh pr view`/`gh pr status`. CANCELLED is failing here by
 * design: the separate `gh pr checks` subcommand buckets it apart from both
 * fail and pending, but the rollup (and ccmux) treat a cancelled run as not a
 * clean pass — don't "align" it to `gh pr checks` without weighing that. */
const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
]);

/**
 * Fold a statusCheckRollup array to one CI signal. Any failing context
 * wins; else any pending; else passing. An empty/absent rollup is `"none"`
 * (no checks configured) — deliberately NOT `"passing"`, so an un-CI'd PR is
 * never treated as verified.
 */
export function foldChecks(
  rollup: RollupEntry[] | null | undefined,
): NonNullable<BranchPR["ciStatus"]> {
  if (!rollup || rollup.length === 0) return "none";
  let sawPending = false;
  for (const c of rollup) {
    if (c.__typename === "StatusContext") {
      if (c.state === "FAILURE" || c.state === "ERROR") return "failing";
      if (c.state === "PENDING" || c.state === "EXPECTED") sawPending = true;
      // SUCCESS => passing
    } else {
      // CheckRun: conclusion is null until status === COMPLETED.
      if (c.status !== "COMPLETED") {
        sawPending = true;
        continue;
      }
      const concl = c.conclusion ?? "";
      if (FAILING_CONCLUSIONS.has(concl)) return "failing";
      if (concl === "STALE" || concl === "STARTUP_FAILURE") sawPending = true;
      // SUCCESS / NEUTRAL / SKIPPED => passing
    }
  }
  return sawPending ? "pending" : "passing";
}

/** gh returns `""` for "no review decision" (e.g. unprotected branch with
 * no submitted review); normalize that and anything unexpected to null. */
export function normalizeReviewDecision(
  raw: string | null | undefined,
): BranchPR["reviewDecision"] {
  return raw === "APPROVED" ||
    raw === "CHANGES_REQUESTED" ||
    raw === "REVIEW_REQUIRED"
    ? raw
    : null;
}

/**
 * Default lookup via `gh pr list --head <branch>`. Run with the session's
 * cwd so gh resolves the right repo/remote. Throws only when spawning gh
 * itself fails (binary missing) — the resolver treats a throw as
 * "environment can't do this" and disables itself for the daemon's
 * lifetime. A non-zero exit (not a repo, no GitHub remote, unauthed) is a
 * per-key failure and returns null.
 */
export async function ghPRLookup(
  cwd: string,
  branch: string,
): Promise<BranchPR[] | null> {
  const proc = Bun.spawn(
    [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url,reviewDecision,statusCheckRollup",
      "--limit",
      "5",
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;
  try {
    const rows = (await new Response(proc.stdout).json()) as Array<{
      number: number;
      url: string;
      reviewDecision?: string;
      statusCheckRollup?: RollupEntry[];
    }>;
    return rows.map((r) => ({
      id: String(r.number),
      href: r.url,
      reviewDecision: normalizeReviewDecision(r.reviewDecision),
      ciStatus: foldChecks(r.statusCheckRollup),
    }));
  } catch {
    return null;
  }
}

function samePRs(a: BranchPR[] | null, b: BranchPR[] | null): boolean {
  const an = a ?? [];
  const bn = b ?? [];
  if (an.length !== bn.length) return false;
  // Compare state fields too: a CI flip or a new review changes the color
  // without changing id/href, and must still re-broadcast the session.
  return an.every(
    (pr, i) =>
      pr.id === bn[i].id &&
      pr.href === bn[i].href &&
      pr.reviewDecision === bn[i].reviewDecision &&
      pr.ciStatus === bn[i].ciStatus,
  );
}

export interface PRResolverOptions {
  lookup?: PRLookupFn;
  onChange?: (cwd: string, branch: string) => void;
  successTtlMs?: number;
  failureTtlMs?: number;
  /** Injectable for tests; defaults to a `Bun.which("gh")` probe. */
  ghMissing?: () => boolean;
}

export class PRResolver {
  private cache = new Map<string, PRCacheEntry>();
  private inflight = new Set<string>();
  private disabled = false;
  private lookup: PRLookupFn;
  private onChange?: (cwd: string, branch: string) => void;
  private successTtlMs: number;
  private failureTtlMs: number;
  private ghMissing: () => boolean;

  constructor(options: PRResolverOptions = {}) {
    this.lookup = options.lookup ?? ghPRLookup;
    this.onChange = options.onChange;
    this.successTtlMs = options.successTtlMs ?? PR_CACHE_SUCCESS_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? PR_CACHE_FAILURE_TTL_MS;
    this.ghMissing = options.ghMissing ?? (() => Bun.which("gh") === null);
  }

  /**
   * Synchronous cached read. Schedules a background refresh when the entry
   * is missing or stale; a stale value is still returned in the meantime.
   */
  get(cwd: string | null, branch: string | null): BranchPR[] | null {
    if (this.disabled || !cwd || !branch || SKIP_BRANCHES.has(branch)) {
      return null;
    }
    const key = `${cwd}\0${branch}`;
    const entry = this.cache.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.refresh(key, cwd, branch);
    }
    return entry?.prs ?? null;
  }

  private refresh(key: string, cwd: string, branch: string): void {
    if (this.inflight.has(key)) return;
    if (this.inflight.size >= MAX_CONCURRENT_REFRESHES) return;
    this.inflight.add(key);
    this.lookup(cwd, branch)
      .then((prs) => {
        const prev = this.cache.get(key)?.prs ?? null;
        const ttl = prs === null ? this.failureTtlMs : this.successTtlMs;
        this.cache.set(key, { prs, expiresAt: Date.now() + ttl });
        if (!samePRs(prev, prs)) this.onChange?.(cwd, branch);
      })
      .catch(() => {
        // A throw is ambiguous: Bun.spawn throws both when the gh binary
        // is missing AND when the key's cwd no longer exists (deleted
        // worktree). Only the former is grounds for a lifetime disable —
        // probe the binary to tell them apart, and negative-cache the key
        // otherwise so a dead cwd can't kill the feature daemon-wide.
        if (this.ghMissing()) {
          this.disabled = true;
        } else {
          this.cache.set(key, {
            prs: null,
            expiresAt: Date.now() + this.failureTtlMs,
          });
        }
      })
      .finally(() => {
        this.inflight.delete(key);
      });
  }
}
