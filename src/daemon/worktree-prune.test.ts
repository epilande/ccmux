import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStateFile } from "./agent-state";
import {
  cleanStateEntries,
  findOrphanEntries,
  isUnderPath,
} from "./agent-state";
import {
  branchDeletionFor,
  describeIgnoredFiles,
  ghPRStateLookup,
  isRepoAdminDir,
  normalizePath,
  paneListIncludes,
  runPrune,
  scanRepo,
  selectPRForBranch,
  trashPathFor,
  type GhPRRow,
  type PRState,
  type PruneCandidate,
  type WorktreeSession,
} from "./worktree-prune";
import {
  parseWorktreeList,
  readAdminDir,
  readDirtyState,
  runGit,
} from "./worktree-git";

/**
 * These tests drive REAL git against throwaway fixture repos under the OS
 * temp dir. Nothing here touches a repo outside `root`, and the only state
 * file used is a fixture JSON created per test — never `~/.claude.json`.
 */

let root: string;

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args);
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  }
  return res.stdout.trim();
}

/** A main checkout on `main` with one commit, plus a bare "remote". */
async function makeRepo(
  name: string,
): Promise<{ repo: string; remote: string }> {
  const repo = join(root, name);
  const remote = join(root, `${name}.git`);
  await mkdir(repo, { recursive: true });
  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  await git(repo, ["remote", "add", "origin", remote]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "init"]);
  await git(repo, ["push", "-u", "origin", "main"]);
  return { repo, remote };
}

/** Add a worktree on a new branch with one commit of its own. */
async function addWorktree(
  repo: string,
  branch: string,
  options: { push?: boolean } = {},
): Promise<string> {
  const path = join(root, "wt", branch.replace(/\//g, "-"));
  await git(repo, ["worktree", "add", "-b", branch, path, "main"]);
  writeFileSync(join(path, `${branch.replace(/\//g, "-")}.txt`), "work\n");
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-m", `work on ${branch}`]);
  if (options.push) await git(path, ["push", "-u", "origin", branch]);
  return path;
}

function session(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    id: "s1",
    agentType: "claude",
    status: "idle",
    tmuxPane: "%1",
    tmuxTarget: "work:0.1",
    pid: null,
    ...overrides,
  };
}

const noPR = async (): Promise<PRState | null> => null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccmux-prune-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseWorktreeList", () => {
  it("marks the first entry as the main checkout and parses flags", () => {
    const entries = parseWorktreeList(
      [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /repo/wt/feature",
        "HEAD def456",
        "branch refs/heads/feat/x",
        "locked",
        "",
        "worktree /repo/wt/gone",
        "HEAD 000000",
        "detached",
        "prunable gitdir file points to non-existent location",
        "",
      ].join("\n"),
    );

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      path: "/repo",
      branch: "main",
      isMain: true,
    });
    expect(entries[1]).toMatchObject({
      path: "/repo/wt/feature",
      branch: "feat/x",
      locked: true,
      isMain: false,
    });
    expect(entries[2]).toMatchObject({
      detached: true,
      prunable: true,
      branch: null,
    });
  });

  it("returns nothing for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("scanRepo classification", () => {
  it("classifies a locally merged branch as merged-locally", async () => {
    const { repo } = await makeRepo("merged-locally");
    const wt = await addWorktree(repo, "feat/done");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/done"]);

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      path: normalizePath(wt),
      branch: "feat/done",
      reason: "merged-locally",
      branchDeletion: "safe",
      dirty: false,
    });
    expect(scan.candidates[0].detail).toContain("merged into");
  });

  it("classifies a branch whose upstream was deleted as upstream-gone", async () => {
    const { repo, remote } = await makeRepo("upstream-gone");
    await addWorktree(repo, "feat/pushed", { push: true });
    // Delete the remote branch the way a merge with auto-delete would.
    await git(remote, ["update-ref", "-d", "refs/heads/feat/pushed"]);

    // Not skipping the fetch: the local bare remote makes `fetch --prune`
    // offline-safe, and it is the call that produces `[gone]`.
    const scan = await scanRepo(repo, { lookupPR: noPR });

    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      branch: "feat/pushed",
      reason: "upstream-gone",
      branchDeletion: "safe",
    });
    expect(scan.candidates[0].detail).toContain("origin/feat/pushed");
  });

  it("classifies a merged PR as pr-merged and allows a forced branch delete", async () => {
    const { repo } = await makeRepo("pr-merged");
    await addWorktree(repo, "feat/squashed");

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: async () => ({
        number: 68,
        url: "https://github.com/o/r/pull/68",
        state: "MERGED",
      }),
    });

    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      reason: "pr-merged",
      branchDeletion: "force",
      detail: "PR #68 merged",
    });
    expect(scan.candidates[0].pr?.number).toBe(68);
  });

  it("classifies a closed PR as pr-closed and keeps the branch", async () => {
    const { repo } = await makeRepo("pr-closed");
    await addWorktree(repo, "feat/rejected");

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: async () => ({
        number: 12,
        url: "https://github.com/o/r/pull/12",
        state: "CLOSED",
      }),
    });

    expect(scan.candidates[0]).toMatchObject({
      reason: "pr-closed",
      branchDeletion: "none",
    });
  });

  it("prefers the merged PR over the local merge check", async () => {
    const { repo } = await makeRepo("precedence");
    await addWorktree(repo, "feat/both");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/both"]);

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: async () => ({
        number: 7,
        url: "https://github.com/o/r/pull/7",
        state: "MERGED",
      }),
    });

    expect(scan.candidates[0].reason).toBe("pr-merged");
  });

  it("leaves an unmerged worktree with no PR alone", async () => {
    const { repo } = await makeRepo("in-progress");
    await addWorktree(repo, "feat/wip");

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  it("leaves a worktree with an open PR alone", async () => {
    const { repo } = await makeRepo("open-pr");
    await addWorktree(repo, "feat/open");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/open"]);

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: async () => ({
        number: 3,
        url: "https://github.com/o/r/pull/3",
        state: "OPEN",
      }),
    });

    expect(scan.candidates).toEqual([]);
  });

  it("short-circuits on the daemon's open-PR cache without a gh lookup", async () => {
    const { repo } = await makeRepo("open-pr-cache");
    await addWorktree(repo, "feat/cached");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/cached"]);
    let lookups = 0;

    const scan = await scanRepo(repo, {
      skipFetch: true,
      hasOpenPR: () => true,
      lookupPR: async () => {
        lookups++;
        return null;
      },
    });

    expect(scan.candidates).toEqual([]);
    expect(lookups).toBe(0);
  });

  it("never offers the main checkout as a candidate", async () => {
    const { repo } = await makeRepo("main-only");
    // main is merged into itself by definition; it must still be excluded.
    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toEqual([]);
  });

  it("flags uncommitted and untracked changes as dirty", async () => {
    const { repo } = await makeRepo("dirty");
    const wt = await addWorktree(repo, "feat/dirty");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/dirty"]);
    writeFileSync(join(wt, "README.md"), "modified\n");
    writeFileSync(join(wt, "scratch.txt"), "untracked\n");

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates[0]).toMatchObject({
      dirty: true,
      modified: 1,
      untracked: 1,
    });
  });

  it("excludes a worktree whose agent is working and reports it as skipped", async () => {
    const { repo } = await makeRepo("working");
    const wt = await addWorktree(repo, "feat/busy");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/busy"]);

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: noPR,
      sessionsFor: (path) =>
        path === normalizePath(wt) ? [session({ status: "working" })] : [],
    });

    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0]).toMatchObject({
      path: normalizePath(wt),
      branch: "feat/busy",
      reason: "an agent is working here",
    });
  });

  it("lists idle and waiting sessions on the candidate instead of excluding it", async () => {
    const { repo } = await makeRepo("idle");
    const wt = await addWorktree(repo, "feat/idle");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/idle"]);

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: noPR,
      sessionsFor: (path) =>
        path === normalizePath(wt)
          ? [
              session({ status: "idle" }),
              session({ id: "s2", status: "waiting" }),
            ]
          : [],
    });

    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0].sessions.map((s) => s.status)).toEqual([
      "idle",
      "waiting",
    ]);
  });

  it("respects a user lock on a live worktree", async () => {
    const { repo } = await makeRepo("locked");
    const wt = await addWorktree(repo, "feat/locked");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/locked"]);
    await git(repo, ["worktree", "lock", wt]);

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toEqual([]);
    expect(scan.skipped[0]).toMatchObject({ reason: "locked" });
  });

  it("ignores a detached-HEAD worktree", async () => {
    const { repo } = await makeRepo("detached");
    const path = join(root, "wt", "detached");
    await git(repo, ["worktree", "add", "--detach", path, "main"]);

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toEqual([]);
  });
});

describe("branchDeletionFor", () => {
  it("forces only where the merge is proven by a merged PR", () => {
    expect(branchDeletionFor("pr-merged")).toBe("force");
    expect(branchDeletionFor("merged-locally")).toBe("safe");
    expect(branchDeletionFor("upstream-gone")).toBe("safe");
    expect(branchDeletionFor("pr-closed")).toBe("none");
  });
});

describe("trashPathFor", () => {
  it("names a dot-prefixed sibling in the same parent directory", () => {
    const trash = trashPathFor(
      "/a/b/feature",
      new Date("2026-07-29T10:11:12.500Z"),
    );
    expect(trash).toBe("/a/b/.ccmux-trash-feature-2026-07-29T10-11-12-500Z");
  });
});

describe("runPrune", () => {
  async function candidateFor(
    repoName: string,
    branch: string,
    extra: Partial<PruneCandidate> = {},
  ): Promise<{ repo: string; wt: string; candidate: PruneCandidate }> {
    const { repo } = await makeRepo(repoName);
    const wt = await addWorktree(repo, branch);
    await git(repo, ["merge", "--no-ff", "-m", "merge", branch]);
    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });
    return { repo, wt, candidate: { ...scan.candidates[0], ...extra } };
  }

  it("removes the directory, deletes the branch and prunes metadata", async () => {
    const { repo, wt, candidate } = await candidateFor(
      "run-basic",
      "feat/gone",
    );

    const result = await runPrune([candidate], {
      stateFiles: [],
      log: () => {},
    });

    expect(result.outcomes[0].removed).toBe(true);
    expect(result.outcomes[0].branchDeleted).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(result.outcomes[0].trashPath!)).toBe(false);
    const branches = await git(repo, ["branch", "--format=%(refname:short)"]);
    expect(branches.split("\n")).not.toContain("feat/gone");
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain(wt);
  });

  it("keeps the branch for a pr-closed candidate", async () => {
    const { repo, wt, candidate } = await candidateFor(
      "run-closed",
      "feat/kept",
      {
        reason: "pr-closed",
        branchDeletion: "none",
      },
    );

    await runPrune([candidate], { stateFiles: [], log: () => {} });

    expect(existsSync(wt)).toBe(false);
    const branches = await git(repo, ["branch", "--format=%(refname:short)"]);
    expect(branches.split("\n")).toContain("feat/kept");
  });

  it("refuses a dirty candidate that was not opted in", async () => {
    const { wt, candidate } = await candidateFor("run-dirty", "feat/dirty");
    writeFileSync(join(wt, "scratch.txt"), "work\n");
    const dirty = { ...candidate, dirty: true, untracked: 1 };

    const result = await runPrune([dirty], { stateFiles: [], log: () => {} });

    expect(result.outcomes[0].removed).toBe(false);
    expect(result.outcomes[0].error).toContain("not opted in");
    expect(existsSync(wt)).toBe(true);
  });

  it("removes a dirty candidate that was opted in", async () => {
    const { wt, candidate } = await candidateFor("run-dirty-ok", "feat/dirty2");
    writeFileSync(join(wt, "scratch.txt"), "work\n");
    const dirty = { ...candidate, dirty: true, untracked: 1 };

    const result = await runPrune([dirty], {
      stateFiles: [],
      log: () => {},
      allowDirtyPaths: [dirty.path],
    });

    expect(result.outcomes[0].removed).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it("changes nothing under dryRun", async () => {
    const { repo, wt, candidate } = await candidateFor("run-dry", "feat/dry");

    const result = await runPrune([candidate], {
      dryRun: true,
      stateFiles: [],
      log: () => {},
    });

    expect(result.dryRun).toBe(true);
    expect(result.outcomes[0].steps[0].step).toBe("would remove");
    expect(existsSync(wt)).toBe(true);
    const branches = await git(repo, ["branch", "--format=%(refname:short)"]);
    expect(branches.split("\n")).toContain("feat/dry");
  });

  it("stops the agent before closing its pane", async () => {
    const { candidate } = await candidateFor("run-sessions", "feat/session");
    const order: string[] = [];
    let alive = true;
    const withSession: PruneCandidate = {
      ...candidate,
      sessions: [session({ pid: 4242, tmuxPane: "%9" })],
    };

    const result = await runPrune([withSession], {
      stateFiles: [],
      log: () => {},
      sleep: async () => {},
      killProcess: (pid, signal) => {
        if (signal === "SIGTERM") {
          order.push(`kill:${pid}`);
          alive = false;
          return;
        }
        if (!alive) throw new Error("ESRCH");
      },
      closePane: async (paneId) => {
        order.push(`close:${paneId}`);
        return "closed";
      },
    });

    expect(order).toEqual(["kill:4242", "close:%9"]);
    expect(result.outcomes[0].panesClosed).toEqual(["%9"]);
  });

  // Stopping the agent frequently closes its own pane, so a `kill-pane` that
  // finds nothing is the success path — reporting it as a failure made a
  // clean run read as broken.
  it("counts a pane that closed with its agent as closed, not failed", async () => {
    const { candidate } = await candidateFor("run-pane-gone", "feat/pane-gone");
    const withSession: PruneCandidate = {
      ...candidate,
      sessions: [session({ pid: null, tmuxPane: "%9" })],
    };

    const result = await runPrune([withSession], {
      stateFiles: [],
      log: () => {},
      closePane: async () => "already-gone",
    });

    const closeStep = result.outcomes[0].steps.find(
      (s) => s.step === "close pane",
    );
    expect(closeStep?.ok).toBe(true);
    expect(closeStep?.detail).toContain("closed with its agent");
    expect(result.outcomes[0].panesClosed).toEqual(["%9"]);
  });

  it("clears a stale lock so git worktree prune can reclaim the entry", async () => {
    const { repo } = await makeRepo("stale-lock");
    const wt = await addWorktree(repo, "feat/stale");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/stale"]);
    const adminDir = readAdminDir(wt);
    expect(adminDir).not.toBeNull();
    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });
    // Simulate the marker an interrupted `git worktree add` leaves behind.
    writeFileSync(join(adminDir!, "locked"), "interrupted\n");

    await runPrune(scan.candidates, { stateFiles: [], log: () => {} });

    expect(existsSync(adminDir!)).toBe(false);
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain(wt);
  });

  it("removes the pruned path's state entry after backing the file up", async () => {
    const { wt, candidate } = await candidateFor("run-state", "feat/state");
    const file = join(root, "fixture-claude.json");
    writeFileSync(
      file,
      JSON.stringify(
        {
          numStartups: 3,
          projects: {
            [normalizePath(wt)]: { history: ["a"] },
            [join(normalizePath(wt), "src")]: { history: ["b"] },
            "/somewhere/else": { history: ["c"] },
          },
        },
        null,
        2,
      ),
    );
    const stateFile: AgentStateFile = {
      agent: "claude",
      file,
      projectsKey: "projects",
    };

    const result = await runPrune([candidate], {
      stateFiles: [stateFile],
      log: () => {},
    });

    expect(result.state[0].removed).toHaveLength(2);
    const after = JSON.parse(readFileSync(file, "utf-8")) as {
      numStartups: number;
      projects: Record<string, unknown>;
    };
    expect(Object.keys(after.projects)).toEqual(["/somewhere/else"]);
    expect(after.numStartups).toBe(3);
    expect(existsSync(result.state[0].backupPath!)).toBe(true);
  });
});

describe("agent state cleanup", () => {
  function fixtureState(projects: Record<string, unknown>): AgentStateFile {
    const file = join(
      root,
      `state-${Math.random().toString(36).slice(2)}.json`,
    );
    writeFileSync(file, JSON.stringify({ projects }, null, 2));
    return { agent: "claude", file, projectsKey: "projects" };
  }

  it("matches a path and its descendants but not a sibling prefix", () => {
    expect(isUnderPath("/a/b", "/a/b")).toBe(true);
    expect(isUnderPath("/a/b/src", "/a/b")).toBe(true);
    expect(isUnderPath("/a/bc", "/a/b")).toBe(false);
    expect(isUnderPath("/a", "/a/b")).toBe(false);
  });

  it("finds entries whose directory no longer exists", () => {
    const state = fixtureState({
      [root]: {},
      [join(root, "deleted-worktree")]: {},
    });

    expect(findOrphanEntries(state)).toEqual([join(root, "deleted-worktree")]);
  });

  it("sweeps the orphan backlog without writing under dryRun", async () => {
    const state = fixtureState({ [join(root, "gone")]: {} });
    const before = readFileSync(state.file, "utf-8");

    const result = await runPrune([], {
      dryRun: true,
      cleanOrphanState: true,
      stateFiles: [state],
    });

    expect(result.state[0].removed).toEqual([join(root, "gone")]);
    expect(result.state[0].backupPath).toBeNull();
    expect(readFileSync(state.file, "utf-8")).toBe(before);
  });

  it("reports an error instead of throwing on a malformed file", () => {
    const file = join(root, "broken.json");
    writeFileSync(file, "{not json");

    const result = cleanStateEntries(
      { agent: "claude", file, projectsKey: "projects" },
      ["/anything"],
    );

    expect(result.error).toBeDefined();
    expect(result.removed).toEqual([]);
  });

  it("does nothing when no path matches", () => {
    const state = fixtureState({ "/keep/me": {} });
    const before = readFileSync(state.file, "utf-8");

    const result = cleanStateEntries(state, ["/other"]);

    expect(result.removed).toEqual([]);
    expect(result.backupPath).toBeNull();
    expect(readFileSync(state.file, "utf-8")).toBe(before);
  });
});

/**
 * `gh pr list --head <branch>` matches the branch NAME across the whole
 * network — every fork's PR and every earlier reuse of that name. Verified
 * against a real repo while writing these: `--head patch-1` on cli/cli
 * returns 25 PRs from 25 different fork owners, three of them MERGED. Taking
 * any of those as proof classifies a local `patch-1` as `pr-merged`, the one
 * reason that force-deletes the branch.
 */
describe("selectPRForBranch", () => {
  const row = (overrides: Partial<GhPRRow> = {}): GhPRRow => ({
    number: 1,
    url: "https://github.com/o/r/pull/1",
    state: "MERGED",
    isCrossRepository: false,
    headRefOid: "tip",
    ...overrides,
  });

  it("accepts a same-repo merged PR whose head is the branch tip", () => {
    expect(selectPRForBranch([row()], "tip")).toMatchObject({
      number: 1,
      state: "MERGED",
    });
  });

  // Modelled on the real `cli/cli --head patch-1` reply. What rejects these
  // is the SHA, not the fork flag: none of them is at this branch's tip.
  it("ignores merged PRs from forks that share the branch name", () => {
    const forks = [
      row({ number: 13296, isCrossRepository: true, headRefOid: "e40c592e" }),
      row({ number: 13273, isCrossRepository: true, headRefOid: "993d4bb6" }),
      row({
        number: 13126,
        isCrossRepository: true,
        headRefOid: "ba333082",
        state: "CLOSED",
      }),
    ];

    expect(selectPRForBranch(forks, "tip")).toBeNull();
  });

  /**
   * The fork-to-upstream workflow: your own PR is cross-repository, and its
   * head IS your local commit. Requiring same-repo would break this for no
   * gain, since a matching SHA is already proof of identity — a commit hash
   * equal to the local tip cannot belong to a different branch.
   */
  it("accepts a fork PR whose head is exactly this branch's tip", () => {
    const forkPR = row({
      number: 4242,
      isCrossRepository: true,
      headRefOid: "tip",
    });

    expect(selectPRForBranch([forkPR], "tip")).toMatchObject({
      number: 4242,
      state: "MERGED",
    });
  });

  it("accepts a closed fork PR at this branch's tip", () => {
    const forkPR = row({
      number: 4243,
      isCrossRepository: true,
      headRefOid: "tip",
      state: "CLOSED",
    });

    expect(selectPRForBranch([forkPR], "tip")).toMatchObject({
      state: "CLOSED",
    });
  });

  // A branch name reused after the original was merged and deleted: same
  // repo, but a different tip, so the old PR does not speak for this branch.
  it("ignores a same-repo merged PR whose head is a different commit", () => {
    expect(selectPRForBranch([row({ headRefOid: "old" })], "tip")).toBeNull();
  });

  /**
   * REGRESSION GUARD. Do not delete as a duplicate of the case above: that
   * one describes branch-name reuse, this one describes work in progress,
   * and only this one explains why `branchDeletionFor` needs no force gate.
   *
   * The scenario: a PR is squash-merged, and the author keeps working in the
   * worktree and COMMITS. Those commits are on no remote and are not in the
   * squash, so if the row were classified `pr-merged` the run would force
   * delete the branch, remove the directory, and drop the per-worktree
   * reflog, taking all three recovery handles in one pass.
   *
   * What prevents it is this function and nothing else: the later commit
   * moves the tip away from the PR's head, so the merged PR stops matching
   * and the row falls through to a reason that uses a safe `-d`.
   */
  it("ignores a merged PR when the branch has commits made after the merge", () => {
    const mergedAtOldTip = row({
      number: 1,
      state: "MERGED",
      headRefOid: "the-commit-that-was-merged",
    });

    expect(
      selectPRForBranch([mergedAtOldTip], "a-commit-made-after-the-merge"),
    ).toBeNull();
  });

  it("ignores a closed PR that cannot be proven to be this branch", () => {
    const rows = [row({ state: "CLOSED", headRefOid: "old" })];
    expect(selectPRForBranch(rows, "tip")).toBeNull();
  });

  it("accepts a closed PR that is proven to be this branch", () => {
    const rows = [row({ state: "CLOSED" })];
    expect(selectPRForBranch(rows, "tip")).toMatchObject({ state: "CLOSED" });
  });

  // An open PR is the state that makes a worktree NOT removable, so it has to
  // dominate: a branch carrying both a merged PR and a live one is in use.
  it("lets an open PR win over a merged one", () => {
    const rows = [
      row({ number: 5, state: "MERGED" }),
      row({ number: 9, state: "OPEN" }),
    ];
    expect(selectPRForBranch(rows, "tip")).toMatchObject({
      number: 9,
      state: "OPEN",
    });
  });

  it("honors an open PR even from a fork, since that only skips cleanup", () => {
    const rows = [
      row({
        number: 9,
        state: "OPEN",
        isCrossRepository: true,
        headRefOid: "x",
      }),
    ];
    expect(selectPRForBranch(rows, "tip")).toMatchObject({ state: "OPEN" });
  });

  // Fail closed: with no local tip nothing can be proven, so nothing that
  // would justify a removal is reported.
  it("reports nothing removable when the branch tip is unknown", () => {
    expect(selectPRForBranch([row()], null)).toBeNull();
    expect(selectPRForBranch([row({ state: "OPEN" })], null)).toMatchObject({
      state: "OPEN",
    });
  });

  it("returns null for an empty reply", () => {
    expect(selectPRForBranch([], "tip")).toBeNull();
  });
});

/**
 * Drives the real `ghPRStateLookup` (spawn, JSON parse, tip resolution) with
 * a fake `gh` on PATH, against a real fixture repo. Previously uncovered:
 * every classification test injects `lookupPR` instead.
 */
describe("ghPRStateLookup", () => {
  let binDir: string;
  let originalPath: string | undefined;

  async function withFakeGh(
    repo: string,
    branch: string,
    reply: unknown,
  ): Promise<PRState | null> {
    writeFileSync(
      join(binDir, "gh"),
      `#!/bin/bash\ncat <<'JSON'\n${JSON.stringify(reply)}\nJSON\n`,
      { mode: 0o755 },
    );
    return ghPRStateLookup(repo, branch);
  }

  beforeEach(() => {
    binDir = join(root, "fakebin");
    require("node:fs").mkdirSync(binDir, { recursive: true });
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("resolves the local branch tip and matches it against the PR head", async () => {
    const { repo } = await makeRepo("gh-lookup");
    const wt = await addWorktree(repo, "feat/looked-up");
    const tip = await git(wt, ["rev-parse", "HEAD"]);

    const matched = await withFakeGh(wt, "feat/looked-up", [
      {
        number: 42,
        url: "u",
        state: "MERGED",
        isCrossRepository: false,
        headRefOid: tip,
      },
    ]);
    expect(matched).toMatchObject({ number: 42, state: "MERGED" });

    const namesake = await withFakeGh(wt, "feat/looked-up", [
      {
        number: 7,
        url: "u",
        state: "MERGED",
        isCrossRepository: false,
        headRefOid: "0000000000000000000000000000000000000000",
      },
    ]);
    expect(namesake).toBeNull();
  });

  it("returns null when gh fails", async () => {
    const { repo } = await makeRepo("gh-fails");
    writeFileSync(join(binDir, "gh"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
    expect(await ghPRStateLookup(repo, "feat/x")).toBeNull();
  });

  it("returns null for malformed output instead of throwing", async () => {
    const { repo } = await makeRepo("gh-garbage");
    writeFileSync(join(binDir, "gh"), "#!/bin/bash\necho 'not json'\n", {
      mode: 0o755,
    });
    expect(await ghPRStateLookup(repo, "feat/x")).toBeNull();
  });
});

describe("ignored files", () => {
  it("reports ignored files that a plain status hides, without collapsing dirs", async () => {
    const { repo } = await makeRepo("ignored");
    const wt = await addWorktree(repo, "feat/ignored");
    writeFileSync(join(wt, ".gitignore"), "node_modules/\n.env\n");
    await git(wt, ["add", ".gitignore"]);
    await git(wt, ["commit", "-qm", "ignore"]);
    writeFileSync(join(wt, ".env"), "SECRET=1\n");
    await mkdir(join(wt, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "pkg", "index.js"), "x\n");

    const state = await readDirtyState(wt);

    // The precious file is named; the regenerable directory is not counted.
    expect(state.ignoredFiles).toEqual([".env"]);
    // And it stays OUT of the dirty gate, which exists for tracked work.
    expect(state.dirty).toBe(false);
  });

  it("surfaces ignored files on the candidate", async () => {
    const { repo } = await makeRepo("ignored-candidate");
    const wt = await addWorktree(repo, "feat/ignored2");
    writeFileSync(join(wt, ".gitignore"), ".env\n");
    await git(wt, ["add", ".gitignore"]);
    await git(wt, ["commit", "-qm", "ignore"]);
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/ignored2"]);
    writeFileSync(join(wt, ".env"), "SECRET=1\n");

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates[0].ignoredFiles).toEqual([".env"]);
  });

  it("records the ignored files in a dry run so they are visible first", async () => {
    const { repo } = await makeRepo("ignored-dry");
    const wt = await addWorktree(repo, "feat/ignored3");
    writeFileSync(join(wt, ".gitignore"), ".env\n");
    await git(wt, ["add", ".gitignore"]);
    await git(wt, ["commit", "-qm", "ignore"]);
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/ignored3"]);
    writeFileSync(join(wt, ".env"), "SECRET=1\n");
    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    const result = await runPrune(scan.candidates, {
      dryRun: true,
      stateFiles: [],
      log: () => {},
    });

    const step = result.outcomes[0].steps.find(
      (s) => s.step === "would delete ignored",
    );
    expect(step?.detail).toContain(".env");
  });
});

describe("describeIgnoredFiles", () => {
  it("returns nothing for an empty list", () => {
    expect(describeIgnoredFiles([])).toBe("");
  });

  it("names the files and counts the overflow", () => {
    expect(describeIgnoredFiles([".env"])).toBe("1 ignored file (.env)");
    expect(describeIgnoredFiles([".env", ".env.local"])).toBe(
      "2 ignored files (.env, .env.local)",
    );
    expect(describeIgnoredFiles(["a", "b", "c", "d", "e"])).toBe(
      "5 ignored files (a, b, c, +2 more)",
    );
  });
});

/**
 * Pane liveness is decided by MEMBERSHIP in the pane list, not by the exit
 * code of a `display-message -t <id>` probe: tmux exits 0 with empty output
 * for a pane that no longer exists, which reported every self-closed pane as
 * a failure. Verified against a live tmux server: `display-message -p -t %99
 * '#{pane_id}'` on a dead id prints "" and exits 0.
 */
describe("paneListIncludes", () => {
  const listing = "%1\n%2\n%12\n";

  it("matches an id that is present", () => {
    expect(paneListIncludes(listing, "%1")).toBe(true);
    expect(paneListIncludes(listing, "%12")).toBe(true);
  });

  it("rejects an id that is absent, including prefix lookalikes", () => {
    expect(paneListIncludes(listing, "%99")).toBe(false);
    expect(paneListIncludes(listing, "%")).toBe(false);
    expect(paneListIncludes("", "%1")).toBe(false);
  });
});

/**
 * The `upstream-gone` deviation, pinned. A deleted remote branch is a strong
 * hint but NOT proof of a merge, so this reason uses the safe `-d`. When git
 * then refuses because the branch really does carry unmerged commits, the
 * worktree still goes and the branch survives with the refusal reported —
 * that combination is the whole point, so it is asserted rather than assumed.
 */
describe("branch deletion refusal", () => {
  it("removes the worktree but keeps an unmerged branch, and says why", async () => {
    const { repo, remote } = await makeRepo("refusal");
    const wt = await addWorktree(repo, "feat/unmerged", { push: true });
    await git(remote, ["update-ref", "-d", "refs/heads/feat/unmerged"]);
    const scan = await scanRepo(repo, { lookupPR: noPR });
    expect(scan.candidates[0]).toMatchObject({
      reason: "upstream-gone",
      branchDeletion: "safe",
    });

    const result = await runPrune(scan.candidates, {
      stateFiles: [],
      log: () => {},
    });

    expect(result.outcomes[0].removed).toBe(true);
    expect(result.outcomes[0].branchDeleted).toBe(false);
    expect(existsSync(wt)).toBe(false);
    const step = result.outcomes[0].steps.find(
      (s) => s.step === "delete branch",
    );
    expect(step?.ok).toBe(false);
    expect(step?.detail).toContain("kept:");
    expect(step?.detail).toContain("not fully merged");
    const branches = await git(repo, ["branch", "--format=%(refname:short)"]);
    expect(branches.split("\n")).toContain("feat/unmerged");
  });
});

/**
 * A tag sharing a branch's name outranks the branch in git's revision
 * disambiguation, so an unmerged branch answered "yes" to the ancestry check
 * and lost its directory on a false reason.
 */
describe("tag shadowing", () => {
  it("does not call a branch merged because a same-named tag is", async () => {
    const { repo } = await makeRepo("tag-shadow");
    const wt = await addWorktree(repo, "release");
    // A tag named exactly like the branch, pointing at something merged.
    await git(repo, ["tag", "release", "main"]);

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });
});

describe("reclaimRepoMetadata blast radius", () => {
  it("leaves a user-locked worktree of the same repo untouched", async () => {
    const { repo } = await makeRepo("blast");
    const target = await addWorktree(repo, "feat/target");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/target"]);
    // A second worktree the user locked, whose path is currently missing —
    // git's own documented reason for locking (external drive, network share).
    const external = await addWorktree(repo, "feat/external");
    await git(repo, ["worktree", "lock", external]);
    rmSync(external, { recursive: true, force: true });

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });
    expect(scan.candidates.map((c) => c.name)).toEqual(["feat-target"]);
    await runPrune(scan.candidates, { stateFiles: [], log: () => {} });

    // The locked registration must survive: the user never selected it.
    // Compared by basename, since the deleted path can no longer be resolved
    // through symlinks the way git recorded it.
    const list = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(list).toContain("feat-external");
    expect(list).not.toContain("feat-target");
    expect(existsSync(target)).toBe(false);
  });

  it("does not prune the repo at all when every candidate was refused", async () => {
    const { repo } = await makeRepo("blast-refused");
    const wt = await addWorktree(repo, "feat/dirty-only");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/dirty-only"]);
    writeFileSync(join(wt, "scratch.txt"), "work\n");
    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    const result = await runPrune(scan.candidates, {
      stateFiles: [],
      log: () => {},
    });

    expect(result.outcomes[0].removed).toBe(false);
    expect(
      result.outcomes[0].steps.some((s) => s.step === "git worktree prune"),
    ).toBe(false);
  });
});

describe("isRepoAdminDir", () => {
  it("accepts this repo's worktree admin dirs and nothing else", () => {
    expect(isRepoAdminDir("/r/.git/worktrees/a", "/r")).toBe(true);
    expect(isRepoAdminDir("/r/.git/worktrees/a/sub", "/r")).toBe(true);
    expect(isRepoAdminDir("/r/.git", "/r")).toBe(false);
    expect(isRepoAdminDir("/elsewhere/.git/worktrees/a", "/r")).toBe(false);
    expect(isRepoAdminDir("/etc", "/r")).toBe(false);
  });
});

describe("background sessions", () => {
  it("is never signalled, but still counts for the working gate", async () => {
    const { repo } = await makeRepo("bg");
    const wt = await addWorktree(repo, "feat/bg");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/bg"]);
    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: noPR,
      sessionsFor: (path) =>
        path === normalizePath(wt)
          ? [
              session({
                status: "idle",
                pid: 4242,
                tmuxPane: null,
                background: true,
              }),
            ]
          : [],
    });
    const killed: number[] = [];

    const result = await runPrune(scan.candidates, {
      stateFiles: [],
      log: () => {},
      killProcess: (pid) => {
        killed.push(pid);
      },
    });

    expect(killed).toEqual([]);
    expect(
      result.outcomes[0].steps.some((s) => s.step === "skip background agent"),
    ).toBe(true);
  });

  it("blocks the whole worktree when a background agent is working", async () => {
    const { repo } = await makeRepo("bg-working");
    const wt = await addWorktree(repo, "feat/bg2");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/bg2"]);

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: noPR,
      sessionsFor: (path) =>
        path === normalizePath(wt)
          ? [session({ status: "working", background: true })]
          : [],
    });

    expect(scan.candidates).toEqual([]);
    expect(scan.skipped[0].reason).toContain("working");
  });
});

/**
 * Dirtiness is decided at scan time but acted on many seconds later, so it is
 * re-checked at the point of no return.
 */
describe("dirty re-check before removal", () => {
  it("refuses a worktree that became dirty after it was listed", async () => {
    const { repo } = await makeRepo("recheck");
    const wt = await addWorktree(repo, "feat/recheck");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/recheck"]);
    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });
    expect(scan.candidates[0].dirty).toBe(false);

    // Someone edits in the worktree between the scan and the removal.
    writeFileSync(join(wt, "just-typed.txt"), "unsaved work\n");

    const result = await runPrune(scan.candidates, {
      stateFiles: [],
      log: () => {},
    });

    expect(result.outcomes[0].removed).toBe(false);
    expect(result.outcomes[0].error).toContain("became dirty");
    expect(existsSync(wt)).toBe(true);
  });
});

/**
 * The post-merge-commit scenario end to end against a real repo, driving the
 * REAL `ghPRStateLookup` through a stub `gh` on PATH.
 *
 * Pinned here as well as at `selectPRForBranch` because this is the level the
 * finding was originally proven at, and because only the whole chain shows
 * the property: `scanRepo` does no identity filtering of its own, so
 * injecting a `lookupPR` stub would bypass the exact code under test.
 *
 * The sequence is simply what happens after a review lands:
 *   1. `feat/pr` is squash-merged; the remote branch is auto-deleted.
 *   2. The author keeps working in that worktree and commits.
 *   3. Those commits exist on no remote and are not in the squash.
 */
describe("A1: a branch with commits made after its PR merged", () => {
  let binDir: string;
  let originalPath: string | undefined;

  /** Stub `gh` reporting one MERGED PR at `head`, honoring `--state open`. */
  function stubGh(head: string): void {
    const rows = JSON.stringify([
      {
        number: 1,
        url: "https://github.com/o/r/pull/1",
        state: "MERGED",
        isCrossRepository: false,
        headRefOid: head,
      },
    ]);
    writeFileSync(
      join(binDir, "gh"),
      "#!/bin/bash\n" +
        // The daemon's open-PR resolver asks with `--state open`; only the
        // `--state all` lookup should see the merged PR.
        'for a in "$@"; do [ "$a" = "open" ] && { echo "[]"; exit 0; }; done\n' +
        `cat <<'JSON'\n${rows}\nJSON\n`,
      { mode: 0o755 },
    );
  }

  /** Squash-merge `branch`, delete its remote ref, then commit again in `wt`. */
  async function mergeThenKeepWorking(
    repo: string,
    remote: string,
    wt: string,
    branch: string,
  ): Promise<{ prHead: string; afterTip: string }> {
    const prHead = await git(wt, ["rev-parse", "HEAD"]);
    await git(repo, ["merge", "--squash", branch]);
    await git(repo, ["commit", "-m", `squash: ${branch}`]);
    await git(remote, ["update-ref", "-d", `refs/heads/${branch}`]);
    writeFileSync(join(wt, "after-merge.txt"), "work nobody else has\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-m", "post-merge work"]);
    return { prHead, afterTip: await git(wt, ["rev-parse", "HEAD"]) };
  }

  beforeEach(() => {
    binDir = join(root, "fakebin");
    mkdirSync(binDir, { recursive: true });
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("is never classified pr-merged, and keeps a safe branch deletion", async () => {
    const { repo, remote } = await makeRepo("post-merge-commit");
    const wt = await addWorktree(repo, "feat/pr", { push: true });
    const { prHead, afterTip } = await mergeThenKeepWorking(
      repo,
      remote,
      wt,
      "feat/pr",
    );
    expect(afterTip).not.toBe(prHead);
    stubGh(prHead);

    // No `lookupPR` override: the real gh path runs, tip resolution included.
    const scan = await scanRepo(repo);

    const candidate = scan.candidates.find((c) => c.branch === "feat/pr");
    expect(candidate?.reason).not.toBe("pr-merged");
    expect(candidate?.branchDeletion).not.toBe("force");
  });

  it("survives a real prune run with its branch and commit intact", async () => {
    const { repo, remote } = await makeRepo("post-merge-survives");
    const wt = await addWorktree(repo, "feat/pr2", { push: true });
    const { prHead } = await mergeThenKeepWorking(repo, remote, wt, "feat/pr2");
    stubGh(prHead);
    const unpublished = await git(wt, ["rev-parse", "HEAD"]);

    const scan = await scanRepo(repo);
    const result = await runPrune(scan.candidates, {
      stateFiles: [],
      log: () => {},
    });

    // The worktree directory may well go, which is fine and expected. What
    // must not happen is losing the branch, and with it the only reference
    // to that commit.
    expect(result.outcomes[0]?.branchDeleted).toBe(false);
    const branches = await git(repo, ["branch", "--format=%(refname:short)"]);
    expect(branches.split("\n")).toContain("feat/pr2");
    const stillReachable = await runGit(repo, [
      "rev-parse",
      "--verify",
      unpublished,
    ]);
    expect(stillReachable.exitCode).toBe(0);
  });
});
