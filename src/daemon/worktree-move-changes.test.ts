import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isUntrackedMode,
  moveChangesToWorktree,
  readOperationInProgress,
  readUncommitted,
  type CreateWorktree,
} from "./worktree-move-changes";
import { runGit } from "./worktree-git";

/**
 * These tests drive REAL git against throwaway fixture repos under the OS temp
 * dir, because the behavior under test IS git's (what a stash captures, what
 * an apply conflicts on, where an entry sits after a concurrent push). A mock
 * would only assert that we call the commands we wrote down.
 *
 * Nothing here touches a repo outside `root`, and no test runs against the
 * developer's own checkout or their stash stack.
 */

let root: string;

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args);
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  }
  return res.stdout.trim();
}

/** A checkout on `main` with one commit. */
async function makeRepo(name = "repo"): Promise<string> {
  const repo = join(root, name);
  await mkdir(repo, { recursive: true });
  await git(root, ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

/**
 * The seam, backed by a real `git worktree add` so the applies below run
 * against a genuine linked worktree sharing the source's stash stack.
 */
function realCreator(repo: string, branch = "moved"): CreateWorktree {
  return async ({ name, base }) => {
    const path = join(root, "wt", name ?? branch);
    await git(repo, [
      "worktree",
      "add",
      "-b",
      name ?? branch,
      path,
      base ?? "HEAD",
    ]);
    return { path };
  };
}

/** Dirty the checkout: a tracked edit plus an untracked file. */
function dirty(repo: string): void {
  writeFileSync(join(repo, "tracked.txt"), "edited\n");
  writeFileSync(join(repo, "new.txt"), "brand new\n");
}

async function statusOf(repo: string): Promise<string> {
  return git(repo, ["status", "--porcelain"]);
}

async function stashCount(repo: string): Promise<number> {
  const list = await git(repo, ["stash", "list"]);
  return list === "" ? 0 : list.split("\n").length;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccmux-move-changes-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("moveChangesToWorktree", () => {
  it("moves tracked and untracked work, leaving the source clean", async () => {
    const repo = await makeRepo();
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      readFileSync(join(result.worktreePath, "tracked.txt"), "utf-8"),
    ).toBe("edited\n");
    expect(readFileSync(join(result.worktreePath, "new.txt"), "utf-8")).toBe(
      "brand new\n",
    );
    // The source keeps neither, and the committed content is back.
    expect(await statusOf(repo)).toBe("");
    expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("original\n");
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  });

  it("drops the stash entry only after the work has landed", async () => {
    // The entry is the backup, so a leftover would mean the work exists twice
    // and a missing one mid-flight would mean it existed nowhere.
    const repo = await makeRepo();
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    expect(await stashCount(repo)).toBe(0);
  });

  it("copies untracked files, leaving the source's copies in place", async () => {
    const repo = await makeRepo();
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      untracked: "copy",
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(result.worktreePath, "new.txt"), "utf-8")).toBe(
      "brand new\n",
    );
    // Tracked change still MOVED; only the untracked file is duplicated.
    expect(existsSync(join(repo, "new.txt"))).toBe(true);
    expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("original\n");
    expect(await statusOf(repo)).toBe("?? new.txt");
  });

  it("leaves untracked files behind entirely on 'leave'", async () => {
    const repo = await makeRepo();
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      untracked: "leave",
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.worktreePath, "new.txt"))).toBe(false);
    expect(
      readFileSync(join(result.worktreePath, "tracked.txt"), "utf-8"),
    ).toBe("edited\n");
    expect(existsSync(join(repo, "new.txt"))).toBe(true);
    expect(await statusOf(repo)).toBe("?? new.txt");
  });

  it("copies untracked files nested in new directories", async () => {
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    await mkdir(join(repo, "deep", "nested"), { recursive: true });
    writeFileSync(join(repo, "deep", "nested", "file.txt"), "buried\n");

    const result = await moveChangesToWorktree({
      source: repo,
      untracked: "copy",
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // git collapses an untracked directory to one `deep/` entry; the copy has
    // to recurse rather than treat it as a file.
    expect(
      readFileSync(
        join(result.worktreePath, "deep", "nested", "file.txt"),
        "utf-8",
      ),
    ).toBe("buried\n");
  });

  it("refuses when a merge is in progress, touching nothing", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "other"]);
    writeFileSync(join(repo, "tracked.txt"), "theirs\n");
    await git(repo, ["commit", "-am", "theirs"]);
    await git(repo, ["checkout", "main"]);
    writeFileSync(join(repo, "tracked.txt"), "ours\n");
    await git(repo, ["commit", "-am", "ours"]);
    // Leaves MERGE_HEAD behind (conflicting merge, deliberately not resolved).
    await runGit(repo, ["merge", "other"]);
    const before = await statusOf(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: async () => {
        throw new Error("must not be called");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("operation-in-progress");
    expect(result.error).toContain("merge");
    expect(await statusOf(repo)).toBe(before);
    expect(await stashCount(repo)).toBe(0);
  });

  it("refuses a clean checkout rather than making an empty worktree", async () => {
    const repo = await makeRepo();
    let created = false;

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: async () => {
        created = true;
        return { path: "/nowhere" };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("nothing-to-move");
    expect(created).toBe(false);
  });

  it("refuses 'leave' when only untracked files exist", async () => {
    // Everything the user has would stay put, so the worktree would be empty
    // of their work while looking like the move succeeded.
    const repo = await makeRepo();
    writeFileSync(join(repo, "new.txt"), "brand new\n");

    const result = await moveChangesToWorktree({
      source: repo,
      untracked: "leave",
      createWorktree: async () => ({ path: "/nowhere" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("nothing-to-move");
    expect(await statusOf(repo)).toBe("?? new.txt");
  });

  it("restores the source and keeps the stash when creation fails", async () => {
    const repo = await makeRepo();
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: async () => {
        throw new Error("disk full");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("create-failed");
    expect(result.sourceRestored).toBe(true);
    // The changes are back where they started AND still in the stash.
    expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("edited\n");
    expect(readFileSync(join(repo, "new.txt"), "utf-8")).toBe("brand new\n");
    expect(result.stashSha).toBeDefined();
    expect(await stashCount(repo)).toBe(1);
  });

  it("rolls back a conflicting apply, keeping the stash and the worktree gone", async () => {
    // A worktree based on a commit that touched the same lines is the real
    // way this conflicts: the stash cannot apply cleanly onto that base.
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "diverged"]);
    writeFileSync(join(repo, "tracked.txt"), "diverged content\n");
    await git(repo, ["commit", "-am", "diverge"]);
    await git(repo, ["checkout", "main"]);
    dirty(repo);

    const wtPath = join(root, "wt", "conflicted");
    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: async () => {
        await git(repo, ["worktree", "add", "--detach", wtPath, "diverged"]);
        return { path: wtPath };
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("apply-failed");
    // No state lost: worktree gone, stash intact, source back as it was.
    expect(existsSync(join(wtPath, "tracked.txt"))).toBe(false);
    expect(result.stashSha).toBeDefined();
    expect(await stashCount(repo)).toBe(1);
    expect(result.sourceRestored).toBe(true);
    expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("edited\n");
  });

  it("acts on ITS OWN stash entry when another push lands on top", async () => {
    // The reason every reference re-resolves by SHA. A stash pushed by anyone
    // else (another agent, another pane; the stack is shared repo-wide)
    // renumbers the stack, and `stash@{0}` would then name theirs.
    const repo = await makeRepo();
    dirty(repo);

    const other = join(root, "other-work.txt");
    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: async ({ name }) => {
        // Runs between our push and our apply, exactly like a concurrent user.
        writeFileSync(join(repo, "tracked.txt"), "someone else's edit\n");
        await git(repo, ["stash", "push", "--message", "unrelated"]);
        writeFileSync(other, "sentinel\n");
        const path = join(root, "wt", name ?? "moved");
        await git(repo, ["worktree", "add", "-b", "moved", path, "HEAD"]);
        return { path };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Ours applied, not theirs.
    expect(
      readFileSync(join(result.worktreePath, "tracked.txt"), "utf-8"),
    ).toBe("edited\n");
    // Theirs survived untouched: we dropped only our own entry.
    expect(await stashCount(repo)).toBe(1);
    const remaining = await git(repo, ["stash", "list"]);
    expect(remaining).toContain("unrelated");
    expect(existsSync(other)).toBe(true);
  });

  it("passes the name and base through to the creation engine", async () => {
    const repo = await makeRepo();
    dirty(repo);
    const seen: { name?: string; base?: string }[] = [];

    const result = await moveChangesToWorktree({
      source: repo,
      name: "my-worktree",
      base: "main",
      createWorktree: async (opts) => {
        seen.push(opts);
        const path = join(root, "wt", "named");
        await git(repo, ["worktree", "add", "-b", "named", path, "main"]);
        return { path };
      },
    });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ name: "my-worktree", base: "main" }]);
  });

  it("names its stash entry so an orphan is recognizable", async () => {
    // If anything strands the entry, the user should be able to tell what put
    // it there rather than finding an anonymous stash.
    const repo = await makeRepo();
    dirty(repo);

    await moveChangesToWorktree({
      source: repo,
      name: "my-worktree",
      createWorktree: async () => {
        throw new Error("stop here");
      },
    });

    const list = await git(repo, ["stash", "list"]);
    expect(list).toContain("ccmux move-changes: my-worktree");
  });

  it("reports a non-repo instead of throwing", async () => {
    const plain = join(root, "not-a-repo");
    await mkdir(plain, { recursive: true });

    const result = await moveChangesToWorktree({
      source: plain,
      createWorktree: async () => ({ path: "/nowhere" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not-a-repo");
  });
});

describe("readUncommitted", () => {
  it("separates tracked counts from untracked paths", async () => {
    const repo = await makeRepo();
    dirty(repo);

    const state = await readUncommitted(repo);
    expect(state).not.toBeNull();
    expect(state!.modified).toBe(1);
    expect(state!.untrackedPaths).toEqual(["new.txt"]);
  });

  it("reads paths verbatim, including ones the default format would quote", async () => {
    // `--porcelain` without -z renders this as "a\"b.txt" with the quotes as
    // part of the output, which would then be used as a literal filename.
    const repo = await makeRepo();
    const odd = 'we"ird.txt';
    writeFileSync(join(repo, odd), "x\n");

    const state = await readUncommitted(repo);
    expect(state!.untrackedPaths).toEqual([odd]);
  });

  it("counts staged changes as tracked work", async () => {
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "staged\n");
    await git(repo, ["add", "tracked.txt"]);

    const state = await readUncommitted(repo);
    expect(state!.modified).toBe(1);
  });
});

describe("readOperationInProgress", () => {
  it("returns null for a quiet checkout", async () => {
    const repo = await makeRepo();
    expect(await readOperationInProgress(repo)).toBeNull();
  });

  it("detects a conflicted merge", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "other"]);
    writeFileSync(join(repo, "tracked.txt"), "theirs\n");
    await git(repo, ["commit", "-am", "theirs"]);
    await git(repo, ["checkout", "main"]);
    writeFileSync(join(repo, "tracked.txt"), "ours\n");
    await git(repo, ["commit", "-am", "ours"]);
    await runGit(repo, ["merge", "other"]);

    expect(await readOperationInProgress(repo)).toBe("a merge");
  });

  it("looks in the WORKTREE's admin dir, not the shared one", async () => {
    // A linked worktree keeps MERGE_HEAD in its own admin directory, so
    // joining `.git/` against the worktree path finds nothing and a merge
    // there would go unnoticed.
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "other"]);
    writeFileSync(join(repo, "tracked.txt"), "theirs\n");
    await git(repo, ["commit", "-am", "theirs"]);
    await git(repo, ["checkout", "main"]);

    const wt = join(root, "wt", "linked");
    await git(repo, ["worktree", "add", "-b", "linked", wt, "main"]);
    writeFileSync(join(wt, "tracked.txt"), "ours\n");
    await git(wt, ["commit", "-am", "ours"]);
    await runGit(wt, ["merge", "other"]);

    expect(await readOperationInProgress(wt)).toBe("a merge");
    // The main checkout is unaffected by the worktree's merge.
    expect(await readOperationInProgress(repo)).toBeNull();
  });
});

describe("isUntrackedMode", () => {
  it("accepts the three modes and nothing else", () => {
    expect(isUntrackedMode("move")).toBe(true);
    expect(isUntrackedMode("copy")).toBe(true);
    expect(isUntrackedMode("leave")).toBe(true);
    for (const bad of ["Move", "delete", "", 1, null, undefined, {}]) {
      expect(isUntrackedMode(bad)).toBe(false);
    }
  });
});
