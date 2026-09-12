import { createEffect, createSignal, onCleanup } from "solid-js";
import { getDaemonUrl } from "../../lib/config";
import type { RepoFactsResponse, RepoFacts } from "../../daemon/repo-facts";
import type { BranchPR, EnrichedSession } from "../../types/session";

export function createRepoFacts(options: {
  connected: () => boolean;
  sources: () => boolean;
  cwd: () => string;
}) {
  const [data, setData] = createSignal<RepoFactsResponse>({
    repos: [],
    headerPR: true,
  });
  let generation = 0;
  async function refresh(force = false) {
    const current = generation;
    const url = new URL(
      `${getDaemonUrl()}/repo-facts${force ? "/refresh" : ""}`,
    );
    url.searchParams.set("cwd", options.cwd());
    if (options.sources()) url.searchParams.set("sources", "1");
    try {
      const response = await fetch(url, {
        method: force ? "POST" : "GET",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return;
      const next = (await response.json()) as RepoFactsResponse;
      if (current === generation && Array.isArray(next.repos)) setData(next);
    } catch {
      /* An old or unreachable daemon contributes no facts. */
    }
  }
  createEffect(() => {
    const connected = options.connected();
    void options.sources();
    generation++;
    if (!connected) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    onCleanup(() => {
      generation++;
      clearInterval(timer);
    });
  });
  return { data, refresh };
}
export function branchPR(
  session: EnrichedSession,
  facts: RepoFacts[],
): BranchPR | null {
  const repo = facts.find(
    (r) => r.repoRoot === (session.mainRepoRoot ?? session.worktreeRoot),
  );
  const checkout = repo?.worktrees?.value.worktrees.find(
    (w) => w.path === session.worktreeRoot,
  );
  if (!checkout?.tip) return null;
  const pr = repo?.prs?.value.find(
    (p) => p.headRefOid === checkout.tip && p.headRefName === session.gitBranch,
  );
  return pr
    ? {
        id: String(pr.number),
        href: pr.url,
        ciStatus: pr.ciStatus,
        reviewDecision: pr.reviewDecision,
        stale: repo?.prs?.stale,
      }
    : null;
}
export function factsText(facts: RepoFacts | undefined): string {
  const count =
    facts?.worktrees?.value.worktrees.filter((w) => !w.isMain).length ?? 0;
  return count
    ? `main + ${count} worktree${count === 1 ? "" : "s"}${facts?.worktrees?.stale ? " ~" : ""}`
    : "";
}
export function badgeText(pr: BranchPR | null, stale = false): string {
  if (!pr) return "";
  const check =
    pr.ciStatus === "passing"
      ? " ✓"
      : pr.ciStatus === "failing"
        ? " ✗"
        : pr.ciStatus === "pending"
          ? " ◐"
          : "";
  return `PR #${pr.id}${check}${stale ? " ~" : ""}`;
}
