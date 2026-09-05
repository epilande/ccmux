/**
 * Reading a repo's open PRs and open issues from the daemon.
 *
 * The two `gh`-backed lists a surface can offer as a place to START work
 * (issue #151): `GET /prs` and `GET /issues`. Extracted from
 * `WorktreesPanel.tsx`'s phase-3 block so the panel's PR view and the source
 * picker fetch them the same way rather than each growing its own URL
 * building, timeout and normalization.
 *
 * What deliberately does NOT live here is the generation guard. Every caller
 * has one already, keyed to its own reload, and a guard inside a shared
 * fetcher would either be global (wrong across two open surfaces) or a
 * parameter that each caller has to remember to pass, which is the same
 * discipline with an extra step. Callers keep their `if (generation !==
 * loadGeneration) return`.
 *
 * The per-repo TTL that makes a rescope or a reopen free is daemon-side
 * (`repo-answer-cache.ts`), which is why neither this module nor its callers
 * cache anything.
 */

import { getDaemonUrl } from "../../lib/config";
import { describeHttpFailure } from "../../daemon/worktree-prune";
import type { IssueListBody, IssueListResponse } from "../../daemon/issue-list";
import { normalizeIssueList } from "../../daemon/issue-list";
import type { PRListBody, PRListResponse } from "../../daemon/pr-list";
import { normalizePRList } from "../../daemon/pr-list";

/**
 * How long a source list may take before the surface calls it unavailable.
 *
 * One `gh` call per repo behind the daemon's TTL, fanned out three at a time.
 * Generous next to the local reads beside it because this one talks to
 * GitHub, and short enough that a wedged daemon becomes a message rather than
 * a spinner that never stops.
 */
const SOURCE_TIMEOUT_MS = 30_000;

/**
 * What a source list has to say about ONE repo.
 *
 * A union rather than a count plus flags, so "still waiting" and "answered
 * zero" cannot be confused. A nullable count invited exactly that. The
 * failure carries its own CAUSE, because a surface says it under the repo it
 * applies to rather than in one line below a list of many.
 *
 * Shared by both lists, so a repo's PR section and its issue section report
 * their state in one vocabulary. A second union would drift.
 */
export type SourceSectionStatus =
  | { kind: "pending" }
  | { kind: "ready"; count: number }
  | { kind: "unavailable"; reason: string | null };

/** The scope both lists take, meaning exactly what it means on `/worktrees`. */
export interface SourceListQuery {
  /** Main checkout to scope to; null asks about every known repo. */
  repo: string | null;
  /** The caller's own directory, ADDITIVE to `repo`. */
  cwd?: string;
  /**
   * Skip the daemon's freshness check.
   *
   * Only an EXPLICIT user refresh. A refresh key that answers from a 60s
   * cache does nothing for the one thing here that goes stale on its own: a
   * PR merged a moment ago still reads open. Every other load is happy with
   * the TTL, which is what keeps a rescope free.
   */
  refresh?: boolean;
}

function sourceUrl(path: string, query: SourceListQuery): URL {
  const url = new URL(`${getDaemonUrl()}${path}`);
  if (query.repo) url.searchParams.set("repo", query.repo);
  if (query.cwd) url.searchParams.set("cwd", query.cwd);
  if (query.refresh) url.searchParams.set("refresh", "1");
  return url;
}

/**
 * Throws on any failure, with the message a surface can render as-is.
 *
 * A per-REPO failure is not one of those: it arrives inside a 200, in the
 * response's `errors`, precisely so one broken checkout costs its own section
 * and not the whole read.
 */
async function readList<Body, Response_>(
  url: URL,
  normalize: (body: Body) => Response_,
): Promise<Response_> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(describeHttpFailure(response.status));
  return normalize((await response.json()) as Body);
}

/** Every open pull request of every repo in scope. */
export function fetchOpenPRs(query: SourceListQuery): Promise<PRListResponse> {
  return readList<PRListBody, PRListResponse>(
    sourceUrl("/prs", query),
    normalizePRList,
  );
}

/** Every open issue of every repo in scope. */
export function fetchOpenIssues(
  query: SourceListQuery,
): Promise<IssueListResponse> {
  return readList<IssueListBody, IssueListResponse>(
    sourceUrl("/issues", query),
    normalizeIssueList,
  );
}
