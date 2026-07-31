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
    return { path, created: true };
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
        return { path: "/nowhere", created: true };
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
      createWorktree: async () => ({ path: "/nowhere", created: true }),
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

  it("keeps work the source gains WHILE the move runs", async () => {
    // The reason there is no `git reset --hard` on the source. An agent in
    // that pane keeps working during the seconds this takes, and a reset at
    // the end would delete files this function never stashed and could not
    // put back. `stash push` already left the source clean, so the reset
    // would buy nothing and cost exactly this.
    const repo = await makeRepo();
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: async ({ name }) => {
        // Mid-operation, after the stash: the pane's agent writes a file and
        // edits a tracked one, neither of which is part of the move.
        writeFileSync(join(repo, "written-during.txt"), "concurrent\n");
        writeFileSync(join(repo, "tracked.txt"), "touched during\n");
        const path = join(root, "wt", name ?? "moved");
        await git(repo, ["worktree", "add", "-b", "moved", path, "HEAD"]);
        return { path, created: true };
      },
    });

    expect(result.ok).toBe(true);
    // Both survive. A reset would have destroyed the first outright and
    // reverted the second.
    expect(readFileSync(join(repo, "written-during.txt"), "utf-8")).toBe(
      "concurrent\n",
    );
    expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe(
      "touched during\n",
    );
  });

  it("keeps the stash recoverable on EVERY failure after the stash", async () => {
    // The invariant that matters more than any single happy path: once the
    // changes have left the working tree, no failure may leave them
    // unreachable, and the ref has to be reported so they can be recovered
    // by hand.
    // The expected reason is pinned per case, so this cannot quietly become
    // three copies of the same failure path.
    const failures: {
      label: string;
      reason: string;
      create: (repo: string) => CreateWorktree;
      untracked?: "move" | "copy" | "leave";
    }[] = [
      {
        label: "creation throws",
        reason: "create-failed",
        create: () => async () => {
          throw new Error("boom");
        },
      },
      {
        label: "apply conflicts",
        reason: "apply-failed",
        create: (repo) => async () => {
          const path = join(root, "wt", "conflict");
          await git(repo, ["worktree", "add", "--detach", path, "diverged"]);
          return { path, created: true };
        },
      },
      {
        label: "untracked copy fails",
        reason: "copy-failed",
        untracked: "copy",
        create: (repo) => async () => {
          const path = join(root, "wt", "copyfail");
          // Based on a commit where `collides` is a FILE, while the source
          // has it as an untracked DIRECTORY, so the copy cannot land.
          await git(repo, ["worktree", "add", "--detach", path, "hasfile"]);
          return { path, created: true };
        },
      },
    ];

    for (const { label, reason, create, untracked } of failures) {
      const repo = await makeRepo(`repo-${label.replace(/\s+/g, "-")}`);
      // A base whose content conflicts with the stashed edit.
      await git(repo, ["checkout", "-b", "diverged"]);
      writeFileSync(join(repo, "tracked.txt"), "diverged\n");
      await git(repo, ["commit", "-am", "diverge"]);
      // A base where `collides` is a committed file.
      await git(repo, ["checkout", "main"]);
      await git(repo, ["checkout", "-b", "hasfile"]);
      writeFileSync(join(repo, "collides"), "i am a file\n");
      await git(repo, ["add", "collides"]);
      await git(repo, ["commit", "-m", "add collides"]);
      await git(repo, ["checkout", "main"]);

      writeFileSync(join(repo, "tracked.txt"), "edited\n");
      await mkdir(join(repo, "collides"), { recursive: true });
      writeFileSync(join(repo, "collides", "inner.txt"), "nested\n");

      const result = await moveChangesToWorktree({
        source: repo,
        untracked,
        createWorktree: create(repo),
      });

      expect(`${label}: ok=${result.ok}`).toBe(`${label}: ok=false`);
      if (result.ok) continue;
      expect(`${label}: ${result.reason}`).toBe(`${label}: ${reason}`);
      expect(result.stashSha, `${label} reports the stash`).toBeDefined();
      expect(await stashCount(repo), `${label} keeps the stash`).toBe(1);
      // Recoverable in the strongest sense: the content is still in there.
      const show = await git(repo, ["show", `${result.stashSha}:tracked.txt`]);
      expect(show, `${label} stash holds the work`).toBe("edited");
      // And the user is not left staring at an empty checkout either.
      expect(result.sourceRestored, `${label} restores the source`).toBe(true);
      expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("edited\n");
    }
  });

  it("copies untracked files with no stash when there is nothing tracked", async () => {
    // `copy` with only untracked work never needs the stash at all, so the
    // stack is left completely untouched.
    const repo = await makeRepo();
    writeFileSync(join(repo, "new.txt"), "brand new\n");

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
    expect(existsSync(join(repo, "new.txt"))).toBe(true);
    expect(await stashCount(repo)).toBe(0);
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
        return { path: wtPath, created: true };
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

  it("refuses a worktree it only OPENED, leaving it and its work alone", async () => {
    // The creation engine is create-or-open for an explicit name, so the seam
    // can hand back a worktree that was already there with the user's own
    // uncommitted work in it. Rolling back would `worktree remove --force`
    // that checkout and everything in it, which is the one outcome this
    // module exists to prevent.
    const repo = await makeRepo();
    await git(repo, ["checkout", "-b", "diverged"]);
    writeFileSync(join(repo, "tracked.txt"), "diverged content\n");
    await git(repo, ["commit", "-am", "diverge"]);
    await git(repo, ["checkout", "main"]);

    const existing = join(root, "wt", "existing");
    await git(repo, ["worktree", "add", "--detach", existing, "diverged"]);
    // Hours of somebody else's work, tracked by nothing.
    writeFileSync(join(existing, "PRECIOUS.txt"), "hours of work\n");
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      name: "existing",
      // What the engine reports for a worktree it opened rather than made.
      // The base is `diverged`, so an apply would conflict as well.
      createWorktree: async () => ({ path: existing, created: false }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("create-failed");
    expect(result.error).toContain("already exists");
    // The worktree and its untracked work are untouched.
    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(join(existing, "PRECIOUS.txt"), "utf-8")).toBe(
      "hours of work\n",
    );
    // And the source has its changes back.
    expect(result.sourceRestored).toBe(true);
    expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("edited\n");
    expect(result.stashSha).toBeDefined();
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
        return { path, created: true };
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
        return { path, created: true };
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
      createWorktree: async () => ({ path: "/nowhere", created: true }),
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
