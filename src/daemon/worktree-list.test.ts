import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAllWorktrees, listRepoWorktrees } from "./worktree-list";
import type { WorktreeRow } from "./worktree-list";
import type { WorktreeSession } from "./worktree-prune";
import { normalizePath, runGit } from "./worktree-git";

/**
 * These tests drive REAL git against throwaway fixture repos under the OS
 * temp dir, the way `worktree-prune.test.ts` does. Nothing here touches a repo
 * outside `root`.
 *
 * The property under test throughout is that this listing does NOT filter the
 * way the prune scan does: the main checkout, a detached worktree and a
 * perfectly ordinary in-flight worktree are all rows here, and every one of
 * them is invisible to `scanRepo`.
 */

let root: string;

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args);
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  }
  return res.stdout.trim();
}

async function makeRepo(name: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  await git(root, ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

async function addWorktree(repo: string, branch: string): Promise<string> {
  const path = join(root, "wt", branch.replace(/\//g, "-"));
  await git(repo, ["worktree", "add", "-b", branch, path, "main"]);
  writeFileSync(join(path, "work.txt"), "work\n");
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-m", `work on ${branch}`]);
  return path;
}

function session(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    id: "s1",
    agentType: "claude",
    status: "working",
    tmuxPane: "%1",
    tmuxTarget: "work:0.1",
    pid: null,
    ...overrides,
  };
}

function rowFor(rows: WorktreeRow[], name: string): WorktreeRow {
  const row = rows.find((r) => r.name === name);
  if (!row)
    throw new Error(`no row named ${name} in ${rows.map((r) => r.name)}`);
  return row;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccmux-worktree-list-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("listRepoWorktrees", () => {
  it("lists the main checkout first, then the linked worktrees", async () => {
    const repo = await makeRepo("proj");
    await addWorktree(repo, "feat/a");
    await addWorktree(repo, "feat/b");

    const listed = await listRepoWorktrees(repo);

    expect(listed?.repoName).toBe("proj");
    expect(listed?.worktrees.map((w) => w.name)).toEqual([
      "proj",
      "feat-a",
      "feat-b",
    ]);
    expect(listed?.worktrees[0]).toMatchObject({
      isMain: true,
      branch: "main",
      repoRoot: repo,
    });
    expect(listed?.worktrees[1]).toMatchObject({
      isMain: false,
      branch: "feat/a",
      detached: false,
      locked: false,
    });
  });

  // The gap this module exists to close: `scanRepo` produces nothing at all
  // for a worktree with no proven removal reason, so an in-flight worktree is
  // invisible in the entire product.
  it("includes a worktree that no removal reason applies to", async () => {
    const repo = await makeRepo("proj");
    await addWorktree(repo, "feat/in-flight");

    const listed = await listRepoWorktrees(repo);

    expect(rowFor(listed?.worktrees ?? [], "feat-in-flight")).toMatchObject({
      branch: "feat/in-flight",
      upstream: { upstream: null, gone: false, ahead: 0, behind: 0 },
    });
  });

  it("includes a detached worktree, with a null branch and upstream", async () => {
    const repo = await makeRepo("proj");
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const path = join(root, "wt", "detached");
    await git(repo, ["worktree", "add", "--detach", path, head]);

    const listed = await listRepoWorktrees(repo);

    expect(rowFor(listed?.worktrees ?? [], "detached")).toMatchObject({
      branch: null,
      detached: true,
      upstream: null,
    });
  });

  // The tip is what proves a pull request is checked out HERE: matching the
  // branch NAME instead answers with every fork's namesake.
  it("reports each branch's tip commit, and null for a detached worktree", async () => {
    const repo = await makeRepo("proj");
    const wt = await addWorktree(repo, "feat/tips");
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const detached = join(root, "wt", "detached-tip");
    await git(repo, ["worktree", "add", "--detach", detached, head]);

    const rows = (await listRepoWorktrees(repo))?.worktrees ?? [];

    expect(rowFor(rows, "feat-tips").tip).toBe(
      await git(wt, ["rev-parse", "HEAD"]),
    );
    expect(rowFor(rows, "proj").tip).toBe(head);
    expect(rowFor(rows, "detached-tip").tip).toBeNull();
  });

  // `%(refname:short)` is CONTEXTUAL: a branch sharing its name with a tag
  // disambiguates to `heads/<name>`, so the tip landed under a key nothing
  // looks up and the PR was silently never marked checked out.
  it("reports a tip for a branch whose name collides with a tag", async () => {
    const repo = await makeRepo("proj");
    const wt = await addWorktree(repo, "feat-collide");
    await git(repo, ["tag", "feat-collide", "main"]);

    const rows = (await listRepoWorktrees(repo))?.worktrees ?? [];

    expect(rowFor(rows, "feat-collide").tip).toBe(
      await git(wt, ["rev-parse", "HEAD"]),
    );
  });

  it("counts modified and untracked files separately", async () => {
    const repo = await makeRepo("proj");
    const wt = await addWorktree(repo, "feat/dirty");
    writeFileSync(join(wt, "work.txt"), "changed\n");
    writeFileSync(join(wt, "scratch.txt"), "new\n");

    const listed = await listRepoWorktrees(repo);

    expect(rowFor(listed?.worktrees ?? [], "feat-dirty").dirty).toEqual({
      dirty: true,
      modified: 1,
      untracked: 1,
    });
  });

  it("reports a clean worktree as clean", async () => {
    const repo = await makeRepo("proj");
    await addWorktree(repo, "feat/clean");

    const listed = await listRepoWorktrees(repo);

    expect(rowFor(listed?.worktrees ?? [], "feat-clean").dirty).toEqual({
      dirty: false,
      modified: 0,
      untracked: 0,
    });
  });

  it("reports a locked worktree as locked", async () => {
    const repo = await makeRepo("proj");
    const wt = await addWorktree(repo, "feat/locked");
    await git(repo, ["worktree", "lock", wt]);

    const listed = await listRepoWorktrees(repo);

    expect(rowFor(listed?.worktrees ?? [], "feat-locked").locked).toBe(true);
  });

  it("attaches the sessions the caller reports, keyed by normalized path", async () => {
    const repo = await makeRepo("proj");
    const wt = await addWorktree(repo, "feat/busy");
    const sessions = new Map<string, WorktreeSession[]>([
      [normalizePath(wt), [session({ id: "busy-1" })]],
    ]);

    const listed = await listRepoWorktrees(repo, {
      sessionsFor: (path) => sessions.get(path) ?? [],
    });

    expect(rowFor(listed?.worktrees ?? [], "feat-busy").sessions).toEqual([
      session({ id: "busy-1" }),
    ]);
    expect(rowFor(listed?.worktrees ?? [], "proj").sessions).toEqual([]);
  });

  it("carries ahead and behind through to the row", async () => {
    const remote = join(root, "remote.git");
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);
    const repo = await makeRepo("proj");
    await git(repo, ["remote", "add", "origin", remote]);
    await git(repo, ["push", "-u", "origin", "main"]);
    const wt = await addWorktree(repo, "feat/pushed");
    await git(wt, ["push", "-u", "origin", "feat/pushed"]);
    writeFileSync(join(wt, "more.txt"), "more\n");
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-m", "more"]);

    const listed = await listRepoWorktrees(repo);

    expect(rowFor(listed?.worktrees ?? [], "feat-pushed").upstream).toEqual({
      upstream: "origin/feat/pushed",
      gone: false,
      ahead: 1,
      behind: 0,
    });
  });

  // A stale admin entry has no directory to jump to, spawn into, copy or
  // diff, so it is not a row the panel could do anything with.
  it("drops a worktree whose directory is gone", async () => {
    const repo = await makeRepo("proj");
    const wt = await addWorktree(repo, "feat/vanished");
    await rm(wt, { recursive: true, force: true });

    const listed = await listRepoWorktrees(repo);

    expect(listed?.worktrees.map((w) => w.name)).toEqual(["proj"]);
  });

  it("returns null for a directory that is not a git repo", async () => {
    const plain = join(root, "plain");
    await mkdir(plain, { recursive: true });

    expect(await listRepoWorktrees(plain)).toBeNull();
  });
});

describe("listAllWorktrees", () => {
  it("lists several repos, sorted by name", async () => {
    const zed = await makeRepo("zed");
    const alpha = await makeRepo("alpha");

    const { repos } = await listAllWorktrees([zed, alpha]);

    expect(repos.map((r) => r.repoName)).toEqual(["alpha", "zed"]);
  });

  it("de-duplicates a repo reached by two spellings of its root", async () => {
    const repo = await makeRepo("proj");

    const { repos } = await listAllWorktrees([repo, `${repo}/`, repo]);

    expect(repos).toHaveLength(1);
  });

  it("skips roots that are not repos rather than failing the whole listing", async () => {
    const repo = await makeRepo("proj");
    const plain = join(root, "plain");
    await mkdir(plain, { recursive: true });

    const { repos } = await listAllWorktrees([plain, repo]);

    expect(repos.map((r) => r.repoName)).toEqual(["proj"]);
  });
});
