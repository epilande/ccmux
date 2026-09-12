import { createEffect, createSignal, onCleanup } from "solid-js";
import { prColorOf } from "../components/session-columns";
import { theme } from "../theme";
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
  let requestId = 0;
  let appliedRequest = 0;
  async function refresh(force = false) {
    const current = generation;
    const request = ++requestId;
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
      if (
        current === generation &&
        request > appliedRequest &&
        Array.isArray(next.repos)
      ) {
        appliedRequest = request;
        setData(next);
      }
    } catch {
      /* An old or unreachable daemon contributes no facts. */
    }
  }
  createEffect(() => {
    const connected = options.connected();
    void options.sources();
    generation++;
    onCleanup(() => {
      generation++;
    });
    if (!connected) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    onCleanup(() => clearInterval(timer));
  });
  return { data, refresh };
}
/** Branch badges describe association; checkout routing separately requires SHA proof. */
export function branchPRs(
  session: Pick<
    EnrichedSession,
    "mainRepoRoot" | "worktreeRoot" | "gitBranch" | "branchPRs"
  >,
  facts: RepoFacts[],
): BranchPR[] {
  const repo = facts.find(
    (r) => r.repoRoot === (session.mainRepoRoot ?? session.worktreeRoot),
  );
  const cached =
    session.gitBranch &&
    repo?.branchPRs &&
    Object.hasOwn(repo.branchPRs, session.gitBranch)
      ? repo.branchPRs[session.gitBranch]
      : undefined;
  if (cached) return cached.value.map((pr) => ({ ...pr, stale: cached.stale }));
  // A repo-wide list cannot prove which fork a namesake branch belongs to.
  // Keep the daemon's existing associations until branch facts answer.
  return session.branchPRs ?? [];
}
export function branchPR(
  session: EnrichedSession,
  facts: RepoFacts[],
): BranchPR | null {
  return branchPRs(session, facts)[0] ?? null;
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
  const review =
    pr.reviewDecision === "CHANGES_REQUESTED"
      ? " changes"
      : pr.reviewDecision === "APPROVED"
        ? " approved"
        : "";
  return `PR #${pr.id}${check}${review}${stale || pr.stale ? " ~" : ""}`;
}

export function badgeColor(prs: BranchPR[]): string {
  const states = prs.map(prColorOf);
  return states.includes("red")
    ? theme.red
    : states.includes("yellow")
      ? theme.yellow
      : states.includes("green")
        ? theme.green
        : theme.mauve;
}
