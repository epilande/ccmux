import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  paneListIncludes,
  runPrune,
  scanRepo,
  selectPRForBranch,
  trashPathFor,
  type GhPRRow,
  type PRLookupResult,
  type PruneCandidate,
  type WorktreeSession,
} from "./worktree-prune";
import {
  classifyRemoteHosting,
  isGitHubRemoteUrl,
  isMergedInto,
  normalizePath,
  parseWorktreeList,
  readAdminDir,
  readDirtyState,
  readSymlinkDirectories,
  resolveBaseRefs,
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

const noPR = async (): Promise<PRLookupResult> => ({ ok: true, pr: null });

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
        ok: true,
        pr: {
          number: 68,
          url: "https://github.com/o/r/pull/68",
          state: "MERGED",
        },
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
        ok: true,
        pr: {
          number: 12,
          url: "https://github.com/o/r/pull/12",
          state: "CLOSED",
        },
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
        ok: true,
        pr: {
          number: 7,
          url: "https://github.com/o/r/pull/7",
          state: "MERGED",
        },
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
        ok: true,
        pr: {
          number: 3,
          url: "https://github.com/o/r/pull/3",
          state: "OPEN",
        },
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
        return { ok: true, pr: null };
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

/**
 * A worktree that was JUST created is not finished work.
 *
 * `git worktree add -b feat/x <path> main`, what `spawn --worktree` runs, gives
 * the new branch the base's own tip, and a commit is an ancestor of
 * itself, so the ancestry check answered "merged into main" for a directory
 * created seconds earlier. Nothing else dissented: the setup files are
 * gitignored or symlinks, so it read perfectly clean, and the session gate only
 * looked at `working`. Confirming that list SIGTERMed a live agent, deleted the
 * directory, and deleted the branch.
 */
describe("a branch sitting on the base tip is not merged", () => {
  /** Exactly what `spawn --worktree` leaves behind: a branch, zero commits. */
  async function addFreshWorktree(
    repo: string,
    branch: string,
  ): Promise<string> {
    const path = join(root, "wt", branch.replace(/\//g, "-"));
    await git(repo, ["worktree", "add", "-b", branch, path, "main"]);
    return path;
  }

  // `waiting` is called out separately because it is the state that reads as
  // safest and is not: the agent is mid-turn, blocked on a permission answer.
  const bound = [null, "idle", "waiting"] as const;
  for (const status of bound) {
    it(`is not a candidate with ${status ?? "no"} session bound`, async () => {
      const { repo } = await makeRepo(`fresh-${status ?? "none"}`);
      const wt = await addFreshWorktree(repo, "feat/fresh");
      expect(await git(repo, ["rev-parse", "feat/fresh"])).toBe(
        await git(repo, ["rev-parse", "main"]),
      );

      const scan = await scanRepo(repo, {
        skipFetch: true,
        lookupPR: noPR,
        sessionsFor: (path) =>
          status && path === normalizePath(wt) ? [session({ status })] : [],
      });

      expect(scan.candidates).toEqual([]);
      expect(existsSync(wt)).toBe(true);
    });
  }

  // The shipping shape, since it is what made the row invisible: the setup
  // symlink is exempt from `dirty`, so nothing at all flagged the worktree.
  it("is not a candidate when its only content is a setup symlink", async () => {
    const { repo } = await makeRepo("fresh-symlinked");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["node_modules"] } }),
    );
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "config"]);
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    const wt = await addFreshWorktree(repo, "feat/fresh-linked");
    symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toEqual([]);
  });

  // The other half of the rule: suppressing tip-equality must not cost the
  // reason itself. A real merge advances the base PAST the branch, so the two
  // tips differ and the ancestry check still answers yes.
  it("still classifies a branch the base has moved past as merged-locally", async () => {
    const { repo } = await makeRepo("still-merged");
    const wt = await addWorktree(repo, "feat/really-done");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/really-done"]);
    expect(await git(repo, ["rev-parse", "main"])).not.toBe(
      await git(repo, ["rev-parse", "feat/really-done"]),
    );

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      path: normalizePath(wt),
      branch: "feat/really-done",
      reason: "merged-locally",
      branchDeletion: "safe",
    });
  });
});

/**
 * The same rule with SEVERAL base refs, which is every real repo: local `main`
 * and `origin/main` both resolve, and `resolveBaseRefs` puts the remote one
 * first.
 *
 * Suppressing tip-equality per base leaks here. In the ordinary not-yet-pulled
 * state, which this feature's own `fetch --prune` produces, local `main` sits at
 * B while `origin/main` is already at C. A worktree cut from local `main` has
 * tip B, so the `origin/main` iteration compares B against C, finds them
 * unequal, asks whether B is an ancestor of C, and gets yes. The brand new
 * worktree was classified `merged-locally` before the `main` iteration it does
 * match was ever reached.
 */
describe("a branch on a base tip with several base refs", () => {
  /**
   * Local `main` at B with `origin/main` one commit ahead at C, the shape a
   * fetch leaves when the remote has moved and nobody has pulled.
   */
  async function repoWithRemoteAhead(
    name: string,
  ): Promise<{ repo: string; localTip: string; remoteTip: string }> {
    const { repo } = await makeRepo(name);
    writeFileSync(join(repo, "b.txt"), "b\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "b"]);
    await git(repo, ["push", "origin", "main"]);
    const localTip = await git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "c.txt"), "c\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "c"]);
    await git(repo, ["push", "origin", "main"]);
    const remoteTip = await git(repo, ["rev-parse", "HEAD"]);
    // Local main falls back to B; the remote-tracking ref stays at C.
    await git(repo, ["reset", "--hard", localTip]);
    return { repo, localTip, remoteTip };
  }

  it("is not merged when it sits on the base that is behind the remote", async () => {
    const { repo, localTip, remoteTip } =
      await repoWithRemoteAhead("multi-base");
    expect(localTip).not.toBe(remoteTip);
    expect(await git(repo, ["rev-parse", "origin/main"])).toBe(remoteTip);
    const path = join(root, "wt", "feat-fresh-multi");
    await git(repo, [
      "worktree",
      "add",
      "-b",
      "feat/fresh-multi",
      path,
      "main",
    ]);

    // The ordering is the trap, so it is asserted rather than assumed: the
    // remote ref is tried first, and B really is an ancestor of C.
    const baseRefs = await resolveBaseRefs(repo);
    expect(baseRefs).toEqual(["origin/main", "main"]);
    expect(
      (await runGit(repo, ["merge-base", "--is-ancestor", localTip, remoteTip]))
        .exitCode,
    ).toBe(0);

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });
    expect(scan.candidates).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(await isMergedInto(repo, "feat/fresh-multi", baseRefs)).toBe(false);
  });

  // The other half again, at multiple bases: a branch with its own commit,
  // merged so no base tip equals it, still classifies.
  it("still classifies a genuinely merged branch in the same repo state", async () => {
    const { repo } = await repoWithRemoteAhead("multi-base-merged");
    const wt = await addWorktree(repo, "feat/multi-done");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/multi-done"]);
    const branchTip = await git(repo, ["rev-parse", "feat/multi-done"]);
    for (const base of ["main", "origin/main"]) {
      expect(await git(repo, ["rev-parse", base])).not.toBe(branchTip);
    }

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });

    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({
      path: normalizePath(wt),
      branch: "feat/multi-done",
      reason: "merged-locally",
      branchDeletion: "safe",
    });
  });
});

/**
 * The session gate, widened from `working` to any bound session. An agent at
 * its prompt (`idle`) or blocked on a permission question (`waiting`) is a
 * session the user is still in the middle of, and it holds the worktree as its
 * cwd, so removal SIGTERMs it and deletes the directory under it.
 */
describe("session gate", () => {
  async function mergedWorktree(
    name: string,
  ): Promise<{ repo: string; wt: string }> {
    const { repo } = await makeRepo(name);
    const wt = await addWorktree(repo, "feat/held");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/held"]);
    return { repo, wt };
  }

  for (const status of ["working", "idle", "waiting"] as const) {
    it(`skips a removable worktree while an agent is ${status} in it`, async () => {
      const { repo, wt } = await mergedWorktree(`gate-${status}`);

      const scan = await scanRepo(repo, {
        skipFetch: true,
        lookupPR: noPR,
        sessionsFor: (path) =>
          path === normalizePath(wt) ? [session({ status })] : [],
      });

      expect(scan.candidates).toEqual([]);
      expect(scan.skipped).toHaveLength(1);
      expect(scan.skipped[0]).toMatchObject({
        path: normalizePath(wt),
        branch: "feat/held",
        reason: `an agent is ${status} here`,
      });
    });
  }

  // With several sessions the message names the one that matters most, so the
  // skip line does not read as "idle" while an agent is mid-write.
  it("reports the working session when the worktree holds several", async () => {
    const { repo, wt } = await mergedWorktree("gate-mixed");

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: noPR,
      sessionsFor: (path) =>
        path === normalizePath(wt)
          ? [
              session({ status: "idle" }),
              session({ id: "s2", status: "working" }),
            ]
          : [],
    });

    expect(scan.skipped[0].reason).toBe("an agent is working here");
  });

  it("still classifies a worktree with no session at all", async () => {
    const { repo } = await mergedWorktree("gate-none");

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: noPR,
      sessionsFor: () => [],
    });

    expect(scan.candidates).toHaveLength(1);
    expect(scan.skipped).toEqual([]);
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

  /**
   * S10. `server.ts` normalizes `allowDirty` before sending it, but
   * `candidate.path` is git's own raw recorded path. On a case-insensitive
   * filesystem those can differ by case alone, and comparing them
   * un-normalized refused an opt-in the user genuinely granted.
   *
   * Skipped where the filesystem is case-sensitive (Linux CI): git records
   * resolved paths there, so a case mismatch cannot arise and the
   * mismatched-case fixture path would simply not exist.
   */
  const caseInsensitiveFs = (() => {
    const probe = mkdtempSync(join(tmpdir(), "case-probe-"));
    try {
      writeFileSync(join(probe, "a"), "");
      return existsSync(join(probe, "A"));
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  })();
  it.skipIf(!caseInsensitiveFs)(
    "honors a dirty opt-in whose case differs from git's raw recorded path",
    async () => {
      const { wt, candidate } = await candidateFor(
        "run-dirty-case",
        "feat/case",
      );
      writeFileSync(join(wt, "scratch.txt"), "work\n");
      const mismatchedCase = join(dirname(wt), basename(wt).toUpperCase());
      // Sanity: still the very same file on this filesystem, or the rest of
      // the test would not be exercising the case-mismatch this guards.
      expect(normalizePath(mismatchedCase)).toBe(normalizePath(wt));
      const dirty: PruneCandidate = {
        ...candidate,
        path: mismatchedCase,
        dirty: true,
        untracked: 1,
      };

      const result = await runPrune([dirty], {
        stateFiles: [],
        log: () => {},
        // As server.ts sends it: normalized, not echoing the candidate's raw
        // case back.
        allowDirtyPaths: [normalizePath(wt)],
      });

      expect(result.outcomes[0].removed).toBe(true);
      expect(existsSync(wt)).toBe(false);
    },
  );

  /**
   * The portable half of S10: `normalizePath` resolves symlinks as well as
   * case, so a candidate path that reaches the compare through a symlinked
   * parent pins the same normalize-before-compare property on filesystems
   * where a case mismatch cannot arise.
   */
  it("honors a dirty opt-in when the candidate path arrives through a symlink", async () => {
    const { wt, candidate } = await candidateFor("run-dirty-link", "feat/link");
    writeFileSync(join(wt, "scratch.txt"), "work\n");
    const linkParent = mkdtempSync(join(tmpdir(), "prune-link-"));
    try {
      const link = join(linkParent, "via-link");
      symlinkSync(dirname(wt), link);
      const viaLink = join(link, basename(wt));
      expect(normalizePath(viaLink)).toBe(normalizePath(wt));
      const dirty: PruneCandidate = {
        ...candidate,
        path: viaLink,
        dirty: true,
        untracked: 1,
      };

      const result = await runPrune([dirty], {
        stateFiles: [],
        log: () => {},
        allowDirtyPaths: [normalizePath(wt)],
      });

      expect(result.outcomes[0].removed).toBe(true);
      expect(existsSync(wt)).toBe(false);
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
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

  /**
   * S9. Previously: one SIGTERM, a 3s poll, then `ok: false` with "closing
   * its pane anyway", and the caller renamed and deleted the directory
   * unconditionally. A wedged agent kept writing into the trash directory
   * right up until it was deleted.
   *
   * A REAL process, not the injected `killProcess`/`sleep` seam: the point is
   * to prove the escalation against actual OS signal semantics. A shell that
   * traps and ignores SIGTERM still cannot ignore SIGKILL, so this proves
   * the "gets SIGKILLed" half of the fix.
   */
  it("SIGKILLs an agent that ignores SIGTERM, then proceeds with removal", async () => {
    const { wt, candidate } = await candidateFor("run-sigkill", "feat/sigkill");
    // A readiness file, touched only AFTER `trap` installs, and polled for
    // below: without this handshake, SIGTERM can arrive before the shell has
    // finished installing the trap, killing it by the ordinary default
    // disposition and making the test pass for the wrong reason.
    const ready = join(root, "sigkill-ready");
    // `exec sleep` rather than a plain one: without it the shell stays as a
    // parent and the SIGKILL below reaps only the shell, leaking a `sleep 30`
    // grandchild per run. Replacing the shell keeps the trapped-TERM property
    // (the trap is inherited as ignored) with a single pid to kill.
    const proc = Bun.spawn(
      ["sh", "-c", `trap "" TERM; touch '${ready}'; exec sleep 30`],
      { stdout: "ignore", stderr: "ignore" },
    );
    const pid = proc.pid;
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(ready)).toBe(true);
    const withSession: PruneCandidate = {
      ...candidate,
      sessions: [session({ pid, tmuxPane: null })],
    };

    try {
      const result = await runPrune([withSession], {
        stateFiles: [],
        log: () => {},
      });

      const stopStep = result.outcomes[0].steps.find(
        (s) => s.step === "stop agent",
      );
      expect(stopStep?.ok).toBe(true);
      expect(stopStep?.detail).toContain("SIGKILLed");
      expect(result.outcomes[0].removed).toBe(true);
      expect(existsSync(wt)).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead, which is the point of the test.
      }
    }
  }, 10000);

  /**
   * S9's other half: the design decision is "SIGKILL escalation, and refuse
   * the candidate if even that does not confirm death" rather than deleting
   * unconditionally. SIGKILL itself cannot be blocked by a real process, so
   * this drives the refusal through the injectable `killProcess` seam — the
   * same seam a real "permission denied to signal" failure would surface
   * through.
   */
  it("refuses a candidate whose agent still answers after SIGKILL", async () => {
    const { wt, candidate } = await candidateFor(
      "run-unkillable",
      "feat/unkillable",
    );
    const withSession: PruneCandidate = {
      ...candidate,
      sessions: [session({ pid: 999999, tmuxPane: "%9" })],
    };

    const result = await runPrune([withSession], {
      stateFiles: [],
      log: () => {},
      // Never throws for any pid or signal: every liveness probe reports
      // the process alive, exactly like an agent that resists both
      // SIGTERM and SIGKILL.
      killProcess: () => {},
    });

    expect(result.outcomes[0].removed).toBe(false);
    expect(result.outcomes[0].error).toContain("SIGKILL");
    expect(existsSync(wt)).toBe(true);
  }, 10000);

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
 * S7's escape hatch, the one branch that may still answer "no PR" without gh.
 *
 * It used to be a boolean: "recognizably github.com" took the strict path and
 * EVERYTHING else took the permissive one, which is backwards for every remote
 * shape github.com is not spelled in: a GitHub Enterprise domain, an ssh
 * config alias, an `insteadOf` shorthand. Those all host real pull requests
 * and all read as "no PR possible", so a broken gh offered a worktree with an
 * open PR for deletion. Only a repo with NO remotes proves absence.
 */
describe("isGitHubRemoteUrl", () => {
  it("recognizes the https and ssh spellings of github.com", () => {
    expect(isGitHubRemoteUrl("https://github.com/o/r.git")).toBe(true);
    expect(isGitHubRemoteUrl("git@github.com:o/r.git")).toBe(true);
    expect(isGitHubRemoteUrl("ssh://git@github.com/o/r.git")).toBe(true);
    expect(isGitHubRemoteUrl("https://user@github.com/o/r")).toBe(true);
  });

  // Both halves of the boundary, because a lookalike host that passed would
  // send a real gh failure down the permissive branch.
  it("rejects lookalike hosts on either side of the label", () => {
    expect(isGitHubRemoteUrl("https://evil-github.com/o/r.git")).toBe(false);
    expect(isGitHubRemoteUrl("https://github.com.evil.io/o/r.git")).toBe(false);
    expect(isGitHubRemoteUrl("git@evil-github.com:o/r.git")).toBe(false);
  });

  it("does not recognize hosts github.com is merely absent from", () => {
    expect(isGitHubRemoteUrl("https://github.mycorp.example/o/r.git")).toBe(
      false,
    );
    expect(isGitHubRemoteUrl("git@gh-personal:o/r.git")).toBe(false);
    expect(isGitHubRemoteUrl("gh:o/r")).toBe(false);
    expect(isGitHubRemoteUrl("/srv/git/local.git")).toBe(false);
  });
});

describe("classifyRemoteHosting", () => {
  /** Point the fixture's `origin` at `url` without touching anything else. */
  async function repoWithRemote(name: string, url: string): Promise<string> {
    const { repo } = await makeRepo(name);
    await git(repo, ["remote", "set-url", "origin", url]);
    return repo;
  }

  it("reports github for a recognizable github.com remote", async () => {
    const repo = await repoWithRemote("host-gh", "git@github.com:o/r.git");
    expect(await classifyRemoteHosting(repo)).toBe("github");
  });

  it("reports none only when the repo has no remote at all", async () => {
    const { repo } = await makeRepo("host-none");
    await git(repo, ["remote", "remove", "origin"]);
    expect(await classifyRemoteHosting(repo)).toBe("none");
  });

  // The finding itself: each of these hosts pull requests, and each used to
  // read as "no PR can exist here".
  it.each([
    ["a GitHub Enterprise domain", "https://github.mycorp.example/o/r.git"],
    ["an ssh config alias", "git@gh-personal:o/r.git"],
    ["an insteadOf shorthand", "gh:o/r"],
    ["a local path remote", "/srv/git/local.git"],
  ])("reports unknown for %s", async (_label, url) => {
    const repo = await repoWithRemote(`host-${url.replace(/\W/g, "-")}`, url);
    expect(await classifyRemoteHosting(repo)).toBe("unknown");
  });

  it("reports unknown when git itself cannot answer", async () => {
    const notARepo = join(root, "not-a-repo");
    mkdirSync(notARepo, { recursive: true });
    expect(await classifyRemoteHosting(notARepo)).toBe("unknown");
  });

  // A second remote is enough: gh answers for whichever one is a GitHub one.
  it("reports github when only a non-origin remote is on github.com", async () => {
    const { repo } = await makeRepo("host-second");
    await git(repo, [
      "remote",
      "add",
      "upstream",
      "https://github.com/o/r.git",
    ]);
    expect(await classifyRemoteHosting(repo)).toBe("github");
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
  ): Promise<PRLookupResult> {
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
    expect(matched.ok).toBe(true);
    expect(matched.ok && matched.pr).toMatchObject({
      number: 42,
      state: "MERGED",
    });

    const namesake = await withFakeGh(wt, "feat/looked-up", [
      {
        number: 7,
        url: "u",
        state: "MERGED",
        isCrossRepository: false,
        headRefOid: "0000000000000000000000000000000000000000",
      },
    ]);
    expect(namesake).toEqual({ ok: true, pr: null });
  });

  it("reports an error, not an empty result, when gh fails", async () => {
    const { repo } = await makeRepo("gh-fails");
    await git(repo, ["remote", "set-url", "origin", "git@github.com:o/r.git"]);
    writeFileSync(join(binDir, "gh"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });

    const result = await ghPRStateLookup(repo, "feat/x");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("exited 1");
  });

  it("reports an error for malformed output instead of throwing", async () => {
    const { repo } = await makeRepo("gh-garbage");
    await git(repo, ["remote", "set-url", "origin", "git@github.com:o/r.git"]);
    writeFileSync(join(binDir, "gh"), "#!/bin/bash\necho 'not json'\n", {
      mode: 0o755,
    });

    const result = await ghPRStateLookup(repo, "feat/x");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("JSON");
  });

  it("reports an error when gh is not installed at all", async () => {
    const { repo } = await makeRepo("gh-absent");
    await git(repo, ["remote", "set-url", "origin", "git@github.com:o/r.git"]);
    // git stays reachable (the lookup needs it), gh does not exist anywhere.
    symlinkSync(Bun.which("git")!, join(binDir, "git"));
    process.env.PATH = binDir;

    const result = await ghPRStateLookup(repo, "feat/x");

    expect(result.ok).toBe(false);
  });

  it("treats a gh failure in a repo with no remotes at all as no PR", async () => {
    // The only provable absence: with no remote there is nowhere for a pull
    // request to live, so gh refusing to run is a complete answer.
    const { repo } = await makeRepo("gh-no-remote");
    await git(repo, ["remote", "remove", "origin"]);
    writeFileSync(join(binDir, "gh"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });

    expect(await ghPRStateLookup(repo, "feat/x")).toEqual({
      ok: true,
      pr: null,
    });
  });

  // S7: a remote whose host ccmux cannot place is NOT evidence that no PR
  // exists. Each of these can host one, and a gh failure hides it.
  it.each([
    ["a GitHub Enterprise domain", "https://github.mycorp.example/o/r.git"],
    ["an ssh config alias", "git@gh-personal:o/r.git"],
    ["an insteadOf shorthand", "gh:o/r"],
    ["a local path remote", "/srv/git/local.git"],
  ])("reports unknowable, not no-PR, for %s", async (_label, url) => {
    const { repo } = await makeRepo(`gh-unknown-${url.replace(/\W/g, "-")}`);
    await git(repo, ["remote", "set-url", "origin", url]);
    writeFileSync(join(binDir, "gh"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });

    const result = await ghPRStateLookup(repo, "feat/x");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("exited 1");
    expect(result.ok === false && result.error).toContain("github.com");
  });

  it("reports no PR for an empty reply", async () => {
    const { repo } = await makeRepo("gh-empty");
    expect(await withFakeGh(repo, "feat/x", [])).toEqual({
      ok: true,
      pr: null,
    });
  });
});

/**
 * S7: an undeterminable PR state must not read as "no PR".
 *
 * `gh` missing, unauthenticated, rate-limited or offline used to return the
 * same `null` as a repo with no PR, which reproduces exactly the skip the
 * module argues against: an open PR going undetected on a branch that looks
 * merged locally, and with it a worktree offered for deletion while its review
 * is still in flight.
 */
describe("a PR lookup that could not answer", () => {
  const failedLookup = async (): Promise<PRLookupResult> => ({
    ok: false,
    error: "gh: authentication required",
  });

  it("withholds a locally merged worktree and says why", async () => {
    const { repo } = await makeRepo("lookup-failed");
    const wt = await addWorktree(repo, "feat/unknown");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/unknown"]);

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: failedLookup,
    });

    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toHaveLength(1);
    expect(scan.skipped[0]).toMatchObject({
      path: normalizePath(wt),
      branch: "feat/unknown",
    });
    expect(scan.skipped[0].reason).toContain("PR state");
    expect(scan.skipped[0].reason).toContain("authentication required");
  });

  // The force-delete path is the one that must be unreachable: nothing may be
  // classified `pr-merged` on a lookup that failed.
  it("never reaches pr-merged when the branch was squash-merged", async () => {
    const { repo, remote } = await makeRepo("lookup-failed-squash");
    const wt = await addWorktree(repo, "feat/squash", { push: true });
    await git(repo, ["merge", "--squash", "feat/squash"]);
    await git(repo, ["commit", "-m", "squash"]);
    await git(remote, ["update-ref", "-d", "refs/heads/feat/squash"]);

    const scan = await scanRepo(repo, { lookupPR: failedLookup });

    expect(scan.candidates).toEqual([]);
    expect(existsSync(wt)).toBe(true);
  });

  // A worktree nothing local proves finished was never going to be offered, so
  // it stays silent: a machine without gh must not turn every in-flight
  // worktree into a skip line.
  it("stays silent for a worktree with no local removal evidence", async () => {
    const { repo } = await makeRepo("lookup-failed-active");
    await addWorktree(repo, "feat/in-flight");

    const scan = await scanRepo(repo, {
      skipFetch: true,
      lookupPR: failedLookup,
    });

    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toEqual([]);
  });

  /**
   * The whole chain, with no `lookupPR` stub, because the defect lived in the
   * default lookup's own escape hatch rather than in classification: a repo on
   * a GitHub Enterprise domain plus a failing `gh` used to reach
   * `merged-locally` and offer the worktree, since "not recognizably
   * github.com" was read as "no PR can exist". The github.com spelling of the
   * same repo skipped correctly, which is what made it a hatch and not a bug
   * in the S7 rule.
   */
  describe("through the real gh path, per remote spelling", () => {
    let binDir: string;
    let originalPath: string | undefined;

    beforeEach(() => {
      binDir = join(root, "fakebin");
      mkdirSync(binDir, { recursive: true });
      originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath}`;
      writeFileSync(join(binDir, "gh"), "#!/bin/bash\nexit 1\n", {
        mode: 0o755,
      });
    });

    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it.each([
      ["github.com", "git@github.com:o/r.git"],
      ["a GitHub Enterprise domain", "https://github.mycorp.example/o/r.git"],
      ["an ssh config alias", "git@gh-personal:o/r.git"],
    ])("withholds a locally merged worktree on %s", async (_label, url) => {
      const { repo } = await makeRepo(`gh-broken-${url.replace(/\W/g, "-")}`);
      const wt = await addWorktree(repo, "feat/hatch");
      await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/hatch"]);
      await git(repo, ["remote", "set-url", "origin", url]);

      const scan = await scanRepo(repo, { skipFetch: true });

      expect(scan.candidates).toEqual([]);
      expect(scan.skipped).toHaveLength(1);
      expect(scan.skipped[0]).toMatchObject({ path: normalizePath(wt) });
      expect(scan.skipped[0].reason).toContain("PR state");
      expect(existsSync(wt)).toBe(true);
    });
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
  it("is never signalled", async () => {
    const { repo } = await makeRepo("bg");
    await addWorktree(repo, "feat/bg");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/bg"]);
    // Attached by hand: the session gate now withholds every worktree that has
    // one, so a scan can no longer produce a candidate carrying a session, and
    // this is about what `runPrune` does with the candidate it is handed.
    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });
    const candidates: PruneCandidate[] = [
      {
        ...scan.candidates[0],
        sessions: [
          session({
            status: "idle",
            pid: 4242,
            tmuxPane: null,
            background: true,
          }),
        ],
      },
    ];
    const killed: number[] = [];

    const result = await runPrune(candidates, {
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

  /**
   * S8: the comment used to claim the re-check ran "immediately before the
   * directory moves" and cited the agent-exit wait as the staleness it
   * covers, but the check actually ran BEFORE `stopSessions`, leaving that
   * whole wait unguarded. This drives the dirtying through `closePane`, the
   * one existing injectable seam that fires from inside `stopSessions`
   * itself, so it lands exactly in the window the old order left open.
   */
  it("catches a worktree dirtied during the agent-shutdown wait, not just before it", async () => {
    const { repo } = await makeRepo("recheck-during-shutdown");
    const wt = await addWorktree(repo, "feat/recheck-shutdown");
    await git(repo, [
      "merge",
      "--no-ff",
      "-m",
      "merge",
      "feat/recheck-shutdown",
    ]);
    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });
    expect(scan.candidates[0].dirty).toBe(false);

    const withSession: PruneCandidate = {
      ...scan.candidates[0],
      sessions: [session({ pid: 4242, tmuxPane: "%9" })],
    };
    let alive = true;

    const result = await runPrune([withSession], {
      stateFiles: [],
      log: () => {},
      sleep: async () => {},
      killProcess: (_pid, signal) => {
        if (signal === "SIGTERM") {
          alive = false;
          return;
        }
        if (!alive) throw new Error("ESRCH");
      },
      // An agent flushing state to disk on its way out, mid-shutdown-wait —
      // exactly the window a check that runs before `stopSessions` cannot see.
      closePane: async () => {
        writeFileSync(join(wt, "flushed-during-shutdown.txt"), "late write\n");
        return "closed";
      },
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

/**
 * A `worktree.symlinkDirectories` link is setup, not user work.
 *
 * A `node_modules/` gitignore pattern is DIRECTORY-only, so it does not match
 * a symlink of that name and git reports `?? node_modules`. Confirmed against
 * the real repo, where every Claude-Code-created worktree reports exactly
 * that, which meant the prune list demanded the uncommitted-work opt-in for a
 * worktree whose only "work" was a link the tooling made itself.
 */
describe("setup symlinks are not dirt", () => {
  async function repoWithSymlinkedWorktree(name: string): Promise<{
    repo: string;
    wt: string;
  }> {
    const { repo } = await makeRepo(name);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["node_modules"] } }),
    );
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-qm", "config"]);
    mkdirSync(join(repo, "node_modules"), { recursive: true });

    const wt = await addWorktree(repo, "feat/linked");
    await git(repo, ["merge", "--no-ff", "-m", "merge", "feat/linked"]);
    symlinkSync(join(repo, "node_modules"), join(wt, "node_modules"));
    return { repo, wt };
  }

  it("does not report a configured symlink as dirty", async () => {
    const { repo, wt } = await repoWithSymlinkedWorktree("setup-symlink");
    // Without the exemption git calls this untracked, which is the bug.
    const raw = await readDirtyState(wt);
    expect(raw.untracked).toBe(1);

    const exempt = await readDirtyState(wt, undefined, {
      setupSymlinks: ["node_modules"],
    });

    expect(exempt.untracked).toBe(0);
    expect(exempt.dirty).toBe(false);
    void repo;
  });

  it("still counts a REAL directory of the same name", async () => {
    const { repo } = await makeRepo("real-dir");
    const wt = await addWorktree(repo, "feat/real");
    mkdirSync(join(wt, "node_modules"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "thing.js"), "x\n");

    const state = await readDirtyState(wt, undefined, {
      setupSymlinks: ["node_modules"],
    });

    // Not a symlink, so the exemption must not apply.
    expect(state.dirty).toBe(true);
  });

  it("still counts a symlink the repo did not configure", async () => {
    const { repo } = await makeRepo("unconfigured");
    const wt = await addWorktree(repo, "feat/other");
    symlinkSync(join(repo, "README.md"), join(wt, "somewhere-else"));

    const state = await readDirtyState(wt, undefined, {
      setupSymlinks: ["node_modules"],
    });

    expect(state.dirty).toBe(true);
  });

  it("lets a symlinked worktree prune without a dirty opt-in", async () => {
    const { repo, wt } = await repoWithSymlinkedWorktree("prune-symlinked");

    const scan = await scanRepo(repo, { skipFetch: true, lookupPR: noPR });
    expect(scan.candidates[0]?.dirty).toBe(false);
    const result = await runPrune(scan.candidates, {
      stateFiles: [],
      log: () => {},
    });

    expect(result.outcomes[0].removed).toBe(true);
    expect(existsSync(wt)).toBe(false);
    // The link was followed by nobody: the main checkout keeps its directory.
    expect(existsSync(join(repo, "node_modules"))).toBe(true);
  });

  // A plain FILE of the configured name is not a symlink, so the exemption
  // must not apply. Correct already; pinned so it stays that way.
  it("still counts a plain FILE of the configured name", async () => {
    const { repo } = await makeRepo("plain-file");
    const wt = await addWorktree(repo, "feat/file");
    writeFileSync(join(wt, "node_modules"), "not a directory\n");

    const state = await readDirtyState(wt, undefined, {
      setupSymlinks: ["node_modules"],
    });

    expect(state.dirty).toBe(true);
  });
});

/**
 * Claude Code resolves `worktree.symlinkDirectories` from MERGED settings, so
 * reading only the project file would miss the user-scope case — which is the
 * natural place to put a machine-wide "share node_modules" preference, and
 * therefore exactly the user who would keep the bug with no signal why.
 */
describe("readSymlinkDirectories scopes", () => {
  function writeSettings(dir: string, dirs: string[] | null): void {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        dirs === null ? {} : { worktree: { symlinkDirectories: dirs } },
      ),
    );
  }

  it("reads user scope when the project says nothing", () => {
    const repo = join(root, "repo-user");
    const home = join(root, "home-user");
    mkdirSync(repo, { recursive: true });
    writeSettings(home, ["node_modules"]);

    expect(readSymlinkDirectories(repo, home)).toEqual(["node_modules"]);
  });

  it("lets project scope replace user scope", () => {
    const repo = join(root, "repo-proj");
    const home = join(root, "home-proj");
    writeSettings(repo, ["vendor"]);
    writeSettings(home, ["node_modules"]);

    expect(readSymlinkDirectories(repo, home)).toEqual(["vendor"]);
  });

  it("lets settings.local.json win over both", () => {
    const repo = join(root, "repo-local");
    const home = join(root, "home-local");
    writeSettings(repo, ["vendor"]);
    writeSettings(home, ["node_modules"]);
    writeFileSync(
      join(repo, ".claude", "settings.local.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["local-only"] } }),
    );

    expect(readSymlinkDirectories(repo, home)).toEqual(["local-only"]);
  });

  // A scope that merely EXISTS without the key must not shadow the one below.
  it("falls through a scope that does not define the key", () => {
    const repo = join(root, "repo-empty");
    const home = join(root, "home-empty");
    writeSettings(repo, null);
    writeSettings(home, ["node_modules"]);

    expect(readSymlinkDirectories(repo, home)).toEqual(["node_modules"]);
  });

  it("returns nothing when no scope defines it", () => {
    const repo = join(root, "repo-none");
    const home = join(root, "home-none");
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });

    expect(readSymlinkDirectories(repo, home)).toEqual([]);
  });

  // A half-written settings file must not shadow the scope below it, and a
  // list holding something that is not a directory name must not produce a
  // symlink target of `undefined`.
  it("falls through malformed JSON and drops non-string entries", () => {
    const repo = join(root, "repo-malformed");
    const home = join(root, "home-malformed");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), "{not json");
    writeSettings(home, ["node_modules"]);

    expect(readSymlinkDirectories(repo, home)).toEqual(["node_modules"]);

    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["vendor", 7, ""] } }),
    );
    expect(readSymlinkDirectories(repo, home)).toEqual(["vendor"]);
  });
});
