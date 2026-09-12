import type { RepoSourceCounts } from "./repo-source-counts";
import { basename } from "node:path";
import { PR_LIST_LIMIT, type OpenPR } from "./pr-list";
import type { BranchPR } from "../types/session";
import type { OpenIssue } from "./issue-list";
import type { SourceResult } from "./gh-spawn-source";
import type { WorktreeInventory } from "./worktree-list";
import { mapWithConcurrency } from "../lib/concurrency";

export interface RepoFact<T> {
  value: T;
  updatedAt: number;
  stale: boolean;
}
export interface RepoFacts {
  repoRoot: string;
  repoName: string;
  worktrees?: RepoFact<WorktreeInventory>;
  prs?: RepoFact<OpenPR[]>;
  issues?: RepoFact<OpenIssue[]>;
  counts?: RepoFact<RepoSourceCounts>;
  branchPRs?: Record<string, RepoFact<BranchPR[]>>;
}
export interface RepoFactsResponse {
  repos: RepoFacts[];
  headerPR: boolean;
}
interface Dependencies {
  roots: () => Promise<string[]>;
  local: (root: string) => Promise<WorktreeInventory | null>;
  prs: (root: string, refresh: boolean) => Promise<SourceResult<OpenPR[]>>;
  issues: (
    root: string,
    refresh: boolean,
  ) => Promise<SourceResult<OpenIssue[]>>;
  counts?: (root: string) => Promise<SourceResult<RepoSourceCounts>>;
  branchPRs?: (root: string, branch: string) => Promise<SourceResult<OpenPR[]>>;
  headerPR: () => Promise<boolean>;
  now?: () => number;
}

/** Read-through snapshots never await GitHub. Each source publishes independently;
 * a failure preserves only an answer that really succeeded, marked stale. */
export class RepoFactsCache {
  private facts = new Map<string, RepoFacts>();
  private inFlight = new Map<string, Promise<void>>();
  private attempted = new Map<string, number>();
  private requestedSources = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private now: () => number;
  constructor(
    private deps: Dependencies,
    private intervalMs = 60_000,
  ) {
    this.now = deps.now ?? Date.now;
  }
  snapshot(roots: string[]): RepoFacts[] {
    return roots.map(
      (root) =>
        this.facts.get(root) ?? {
          repoRoot: root,
          repoName: basename(root),
        },
    );
  }
  start(): void {
    if (this.timer) return;
    const tick = async () => {
      const roots = await this.deps.roots();
      await this.refresh(roots);
    };
    void tick().catch(() => {});
    this.timer = setInterval(
      () => void tick().catch(() => {}),
      this.intervalMs,
    );
    this.timer.unref();
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  async refresh(
    roots: string[],
    force = false,
    sources = false,
  ): Promise<void> {
    const headerPR = await this.deps.headerPR();
    await mapWithConcurrency([...new Set(roots)], 3, async (root) => {
      if (sources) this.requestedSources.set(root, this.now() + 10_000);
      const facts: RepoFacts = this.facts.get(root) ?? {
        repoRoot: root,
        repoName: basename(root),
      };
      this.facts.set(root, facts);
      const update = <K extends "worktrees" | "prs" | "issues" | "counts">(
        key: K,
        read: () => Promise<
          RepoFacts[K] extends RepoFact<infer T> | undefined ? T | null : never
        >,
      ) =>
        this.run(`${root}\n${key}`, force, async () => {
          try {
            const value = await read();
            if (value === null) throw new Error("unavailable");
            // The generic key and value are correlated by the read signature.
            Object.assign(facts, {
              [key]: { value, updatedAt: this.now(), stale: false },
            });
          } catch {
            const previous = facts[key];
            if (previous)
              Object.assign(facts, { [key]: { ...previous, stale: true } });
          }
        });
      await Promise.all([
        update("worktrees", () => this.deps.local(root)),
        ...(headerPR || (this.requestedSources.get(root) ?? 0) > this.now()
          ? [
              ...(this.deps.counts
                ? [
                    update("counts", async () => {
                      const result = await this.deps.counts!(root);
                      return result.ok ? result.value : null;
                    }),
                  ]
                : []),
              update("prs", async () => {
                const result = await this.deps.prs(root, force);
                return result.ok ? result.value : null;
              }),
              update("issues", async () => {
                const result = await this.deps.issues(root, force);
                return result.ok ? result.value : null;
              }),
            ]
          : []),
      ]);
      if (headerPR || (this.requestedSources.get(root) ?? 0) > this.now()) {
        const branches = [
          ...new Set(
            facts.worktrees?.value.worktrees
              .map((tree) => tree.branch)
              .filter(
                (branch): branch is string => !!branch && branch !== "HEAD",
              ) ?? [],
          ),
        ];
        await mapWithConcurrency(branches, 3, (branch) =>
          this.run(`${root}\nbranch:${branch}`, force, async () => {
            const previous =
              facts.branchPRs && Object.hasOwn(facts.branchPRs, branch)
                ? facts.branchPRs[branch]
                : undefined;
            try {
              const all = facts.prs;
              if (!all || all.stale) throw new Error("unavailable");
              // A full repo snapshot can answer every branch without another
              // request. At the display cap, query the branch independently so
              // older PRs on an active checkout cannot disappear from badges.
              const complete =
                all.value.length < PR_LIST_LIMIT ||
                (facts.counts &&
                  !facts.counts.stale &&
                  facts.counts.value.prs <= all.value.length);
              const result = complete
                ? {
                    ok: true as const,
                    value: all.value.filter((pr) => pr.headRefName === branch),
                  }
                : await this.deps.branchPRs?.(root, branch);
              if (!result?.ok) throw new Error("unavailable");
              const value = result.value.map((pr) => ({
                id: String(pr.number),
                href: pr.url,
                ciStatus: pr.ciStatus,
                reviewDecision: pr.reviewDecision,
              }));
              facts.branchPRs = {
                ...facts.branchPRs,
                [branch]: { value, updatedAt: this.now(), stale: false },
              };
            } catch {
              if (previous)
                facts.branchPRs = {
                  ...facts.branchPRs,
                  [branch]: { ...previous, stale: true },
                };
            }
          }),
        );
      }
    });
  }
  private run(
    key: string,
    force: boolean,
    read: () => Promise<void>,
  ): Promise<void> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const last = this.attempted.get(key);
    if (
      last !== undefined &&
      this.now() - last < (force ? 2_000 : this.intervalMs)
    )
      return Promise.resolve();
    this.attempted.set(key, this.now());
    const promise = Promise.resolve()
      .then(read)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}
