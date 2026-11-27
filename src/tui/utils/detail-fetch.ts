import { getDaemonUrl } from "../../lib/config";
import type { IssueDetail, PRDetail } from "../../daemon/source-detail";
import type { WorktreeDetail } from "../../daemon/worktree-detail";

/** What a preview gets back for one item: its detail, or why not. */
export type DetailResult<T> =
  | { ok: true; detail: T }
  | { ok: false; error: string };

/** A daemon older than the detail routes answers them with a 404. */
export const NEWER_DAEMON_NEEDED =
  "Details need a newer daemon (ccmux daemon restart)";

/**
 * Longer than the daemon's own 15s `gh` timeout, so a slow answer arrives as
 * the daemon's message ("gh pr view timed out after 15s") rather than the
 * client giving up first with a vaguer one.
 */
const DETAIL_TIMEOUT_MS = 20_000;

async function getDetail<T>(
  path: string,
  params: Record<string, string>,
): Promise<DetailResult<T>> {
  const url = new URL(`${getDaemonUrl()}${path}`);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
    });
    if (response.status === 404)
      return { ok: false, error: NEWER_DAEMON_NEEDED };
    const body = (await response.json()) as {
      ok?: boolean;
      detail?: T;
      error?: string;
    };
    if (response.ok && body.ok === true && body.detail)
      return { ok: true, detail: body.detail };
    return {
      ok: false,
      error: body.error ?? `daemon answered HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && err.name === "TimeoutError"
          ? "Details timed out"
          : "Details unavailable: daemon unreachable",
    };
  }
}

export function fetchWorktreeDetail(
  path: string,
): Promise<DetailResult<WorktreeDetail>> {
  return getDetail("/worktrees/detail", { path });
}

/** `refresh` asks the daemon to skip its cached answer (the `R` key). */
export function fetchPRDetail(
  repo: string,
  number: number,
  refresh = false,
): Promise<DetailResult<PRDetail>> {
  return getDetail("/prs/detail", {
    repo,
    number: String(number),
    ...(refresh ? { refresh: "1" } : {}),
  });
}

export function fetchIssueDetail(
  repo: string,
  number: number,
  refresh = false,
): Promise<DetailResult<IssueDetail>> {
  return getDetail("/issues/detail", {
    repo,
    number: String(number),
    ...(refresh ? { refresh: "1" } : {}),
  });
}
