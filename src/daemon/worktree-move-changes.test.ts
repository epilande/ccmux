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
  dropStashCommand,
  isUntrackedMode,
  moveChangesToWorktree,
  readOperationInProgress,
  readUncommitted,
  type CreateWorktree,
} from "./worktree-move-changes";
import { normalizePath, runGit, type GitRun } from "./worktree-git";
import { failureNeedsAcknowledgement } from "../lib/move-report";

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
  // The developer's own `~/.config/git/ignore` is read even with
  // GIT_CONFIG_GLOBAL neutered — it is git's DEFAULT excludes path, not a
  // config value — and the gitignore fixtures below ask git what it excludes.
  // Without this, whether those tests pass depends on whose machine they run
  // on.
  await git(repo, ["config", "core.excludesFile", "/dev/null"]);
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
    // The status read expands the directory, so the copy gets the buried
    // file by name and has to create the directories on the way to it.
    expect(
      readFileSync(
        join(result.worktreePath, "deep", "nested", "file.txt"),
        "utf-8",
      ),
    ).toBe("buried\n");
  });

  it("never carries gitignored content into the worktree", async () => {
    // The one asymmetry that used to exist between the modes: `move` routes
    // untracked files through a stash, which excludes ignored ones, while
    // `copy` recursed into the collapsed `?? deep/` directory and swept up
    // the .env sitting in it. Ignored content is the engine's file-setup
    // job (symlinkDirectories, .worktreeinclude), never the move's.
    const repo = await makeRepo();
    writeFileSync(join(repo, ".gitignore"), "deep/.env\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore"]);
    await mkdir(join(repo, "deep"), { recursive: true });
    writeFileSync(join(repo, "deep", "index.ts"), "export {};\n");
    writeFileSync(join(repo, "deep", ".env"), "TOKEN=secret\n");
    writeFileSync(join(repo, "tracked.txt"), "edited\n");

    const result = await moveChangesToWorktree({
      source: repo,
      untracked: "copy",
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.worktreePath, "deep", "index.ts"))).toBe(
      true,
    );
    expect(existsSync(join(result.worktreePath, "deep", ".env"))).toBe(false);
    // And it is still where the user left it.
    expect(readFileSync(join(repo, "deep", ".env"), "utf-8")).toBe(
      "TOKEN=secret\n",
    );
    expect(result.untracked.files).toEqual(["deep/index.ts"]);
  });

  it("leaves gitignored content behind on 'move' too", async () => {
    // The other half of the same rule, so the two modes agree.
    const repo = await makeRepo();
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore"]);
    writeFileSync(join(repo, ".env"), "TOKEN=secret\n");
    writeFileSync(join(repo, "new.txt"), "brand new\n");

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.worktreePath, "new.txt"))).toBe(true);
    expect(existsSync(join(result.worktreePath, ".env"))).toBe(false);
    expect(readFileSync(join(repo, ".env"), "utf-8")).toBe("TOKEN=secret\n");
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

  it("refuses rather than adopting a previous run's leftover entry", async () => {
    // `git stash push` exits 0 with "No local changes to save" and creates
    // NOTHING when the tree went clean since the status read. The entry on
    // top is then somebody else's, and identifying ours by message alone
    // would apply and then DROP it.
    const repo = await makeRepo();
    dirty(repo);

    // Run one fails after stashing, so its entry stays behind holding the
    // work, named exactly the way run two's would be.
    const first = await moveChangesToWorktree({
      source: repo,
      createWorktree: async () => {
        throw new Error("disk full");
      },
    });
    expect(first.ok).toBe(false);
    expect(await stashCount(repo)).toBe(1);
    const leftover = await git(repo, ["rev-parse", "refs/stash"]);

    // Run two, on a source that goes clean between the status read and the
    // push: an agent in that pane reverting its own edit.
    const raced: GitRun = async (cwd, args) => {
      const res = await runGit(cwd, args);
      if (args[0] === "status") {
        await runGit(repo, ["checkout", "--", "tracked.txt"]);
        rmSync(join(repo, "new.txt"), { force: true });
      }
      return res;
    };
    const second = await moveChangesToWorktree({
      source: repo,
      git: raced,
      createWorktree: realCreator(repo),
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("nothing-to-move");
    // Run one's work is exactly where it was.
    expect(await stashCount(repo)).toBe(1);
    expect(await git(repo, ["rev-parse", "refs/stash"])).toBe(leftover);
    expect(await git(repo, ["show", `${leftover}:tracked.txt`])).toBe("edited");
  });

  it("preserves the staged/unstaged split", async () => {
    // A plain `stash apply` merges the two halves into one worktree state,
    // and once the entry drops the staged snapshot is gone. For content the
    // user deliberately `git add`ed that is lost work, not a cosmetic
    // difference in what `git status` prints.
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "staged\n");
    await git(repo, ["add", "tracked.txt"]);
    writeFileSync(join(repo, "tracked.txt"), "and then edited\n");

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wt = result.worktreePath;
    expect(await git(wt, ["status", "--porcelain"])).toBe("MM tracked.txt");
    expect(await git(wt, ["show", ":tracked.txt"])).toBe("staged");
    expect(readFileSync(join(wt, "tracked.txt"), "utf-8")).toBe(
      "and then edited\n",
    );
    // Nothing was lost, so there is nothing to warn about.
    expect(result.flattenedIndex).toBeUndefined();
  });

  it("still applies when the split cannot be kept, and says so", async () => {
    // `--index` refuses a target that has staged changes of its own. The
    // move must not fail over that — it just cannot keep the split, and the
    // user is told rather than left to notice.
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "staged\n");
    await git(repo, ["add", "tracked.txt"]);
    writeFileSync(join(repo, "tracked.txt"), "and then edited\n");

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: async ({ name }) => {
        const path = join(root, "wt", name ?? "moved");
        await git(repo, ["worktree", "add", "-b", "moved", path, "HEAD"]);
        writeFileSync(join(path, "sibling.txt"), "from file setup\n");
        await git(path, ["add", "sibling.txt"]);
        return { path, created: true };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // All of the work is there; all of it landed in the worktree half.
    expect(
      readFileSync(join(result.worktreePath, "tracked.txt"), "utf-8"),
    ).toBe("and then edited\n");
    expect(result.flattenedIndex).toBe(true);
  });

  it("reports a source it could NOT put back", async () => {
    // The unhappiest path there is, and until now only ever reached through
    // a stub. The pane's agent rewrites the very file the stash holds while
    // the move is running, so the restore has nowhere to land — and the sha
    // becomes the only handle on the work.
    const repo = await makeRepo();
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: async () => {
        writeFileSync(join(repo, "tracked.txt"), "rewritten while we worked\n");
        throw new Error("disk full");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("create-failed");
    expect(result.sourceRestored).toBe(false);
    expect(result.stashSha).toBeDefined();
    // Still reachable, which is what makes reporting it worth anything.
    expect(await git(repo, ["show", `${result.stashSha}:tracked.txt`])).toBe(
      "edited",
    );
    expect(await stashCount(repo)).toBe(1);
  });

  it("reports a stash entry it could not drop", async () => {
    // The move SUCCEEDS and the entry stays behind. Driven through the git
    // seam because real git will not refuse a drop of an entry it just
    // resolved, and an untested branch here would mean a leftover nobody is
    // ever told about.
    const repo = await makeRepo();
    dirty(repo);

    const noDrop: GitRun = async (cwd, args) => {
      if (args[0] === "stash" && args[1] === "drop") {
        return { exitCode: 1, stdout: "", stderr: "refusing to drop" };
      }
      return runGit(cwd, args);
    };

    const result = await moveChangesToWorktree({
      source: repo,
      git: noDrop,
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leftoverStash).toMatch(/^[0-9a-f]{40}$/);
    // The work landed anyway; the entry is a redundant copy, not a failure.
    expect(
      readFileSync(join(result.worktreePath, "tracked.txt"), "utf-8"),
    ).toBe("edited\n");
    expect(await statusOf(repo)).toBe("");
    expect(await stashCount(repo)).toBe(1);
  });

  it("names the entry a FAILED push still managed to create", async () => {
    // git writes `refs/stash` before it finishes cleaning the working tree,
    // so a push that fails partway (an untracked file it cannot remove) exits
    // non-zero with a complete entry behind it. Reporting no sha there hides
    // the only handle on work that is now half out of the tree.
    const repo = await makeRepo();
    dirty(repo);

    const failingPush: GitRun = async (cwd, args) => {
      const res = await runGit(cwd, args);
      if (args[0] === "stash" && args[1] === "push") {
        return {
          exitCode: 1,
          stdout: res.stdout,
          stderr: "could not remove untracked file new.txt",
        };
      }
      return res;
    };

    const result = await moveChangesToWorktree({
      source: repo,
      git: failingPush,
      createWorktree: async () => {
        throw new Error("must not be called");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stash-failed");
    expect(result.stashSha).toMatch(/^[0-9a-f]{40}$/);
    // An entry exists, so the work is out of the tree and nothing put it
    // back: a refusal the user has to acknowledge, not one to show briefly.
    expect(result.sourceRestored).toBe(false);
    // A real handle on the real work, and named in the message the user sees.
    expect(await git(repo, ["show", `${result.stashSha}:tracked.txt`])).toBe(
      "edited",
    );
    expect(result.error).toContain(result.stashSha!);
  });

  it("serializes moves that share a repo, so neither sees the other mid-flight", async () => {
    // The stash stack is shared by every worktree of a repo, so two moves
    // running at once read and push into the same stack. Interleaved, one
    // reads a status the other already stashed away.
    const repo = await makeRepo();
    dirty(repo);

    const trace: string[] = [];
    const traced =
      (label: string): GitRun =>
      async (cwd, args) => {
        // Only the transaction's own steps; the pre-lock repo probe is not
        // part of what has to be serialized.
        if (args[0] === "status" || args[0] === "stash") {
          trace.push(`${label}:${args[0]}`);
        }
        return runGit(cwd, args);
      };

    await Promise.all([
      moveChangesToWorktree({
        source: repo,
        name: "first",
        git: traced("a"),
        createWorktree: async ({ name }) => {
          // Long enough that an unserialized second move runs to completion
          // inside this window.
          await new Promise((r) => setTimeout(r, 50));
          const path = join(root, "wt", name ?? "first");
          await git(repo, ["worktree", "add", "-b", "first", path, "HEAD"]);
          return { path, created: true };
        },
      }),
      moveChangesToWorktree({
        source: repo,
        name: "second",
        git: traced("b"),
        createWorktree: realCreator(repo, "second"),
      }),
    ]);

    // Two contiguous runs of one label each: one move finished before the
    // other looked.
    const labels = trace.map((entry) => entry.split(":")[0]);
    const blocks = labels.filter((label, i) => label !== labels[i - 1]);
    expect(`${blocks.length} blocks in ${trace.join(",")}`).toBe(
      `2 blocks in ${trace.join(",")}`,
    );
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

  it("moves the whole checkout's work when run from a SUBDIRECTORY", async () => {
    // The source is routinely a subdirectory: the picker passes a pane's cwd
    // and the CLI passes its own pwd. Status paths are repo-root relative, so
    // every git call and every copy has to run from the root or they resolve
    // against the wrong base.
    const repo = await makeRepo();
    await mkdir(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "inside.txt"), "under the subdir\n");
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: join(repo, "sub"),
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wt = result.worktreePath;
    expect(readFileSync(join(wt, "sub", "inside.txt"), "utf-8")).toBe(
      "under the subdir\n",
    );
    expect(readFileSync(join(wt, "tracked.txt"), "utf-8")).toBe("edited\n");
    expect(readFileSync(join(wt, "new.txt"), "utf-8")).toBe("brand new\n");
    expect(await statusOf(repo)).toBe("");
    // The checkout emptied is the whole worktree, whichever directory the
    // request named, so that is what the report has to say: naming the
    // subdirectory misattributes repo-wide work to it. Compared through
    // `normalizePath` because git answers with the physical path, and the
    // fixture root goes through /var on macOS.
    expect(normalizePath(result.source)).toBe(normalizePath(repo));
  });

  it("copies untracked files when run from a SUBDIRECTORY", async () => {
    // The silent one: repo-root-relative status paths joined onto the
    // subdirectory name files that do not exist, so the copy skips every one
    // of them and reports a success that moved nothing.
    const repo = await makeRepo();
    await mkdir(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "inside.txt"), "under the subdir\n");
    writeFileSync(join(repo, "tracked.txt"), "edited\n");

    const result = await moveChangesToWorktree({
      source: join(repo, "sub"),
      untracked: "copy",
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      readFileSync(join(result.worktreePath, "sub", "inside.txt"), "utf-8"),
    ).toBe("under the subdir\n");
    expect(existsSync(join(repo, "sub", "inside.txt"))).toBe(true);
    expect(result.untracked.files).toEqual(["sub/inside.txt"]);
  });

  it("succeeds from a subdirectory the stash itself deletes", async () => {
    // The worst version of the same bug. Stashing the only files under the
    // source directory removes the directory, so every git call after the
    // push runs from a cwd that is gone — read as an empty stash stack, and
    // reported as "nothing to move" with the work already in an entry nobody
    // named.
    const repo = await makeRepo();
    await mkdir(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "only.txt"), "all there is\n");

    const result = await moveChangesToWorktree({
      source: join(repo, "sub"),
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      readFileSync(join(result.worktreePath, "sub", "only.txt"), "utf-8"),
    ).toBe("all there is\n");
    expect(await statusOf(repo)).toBe("");
    expect(await stashCount(repo)).toBe(0);
  });

  it("refuses when the stash ref cannot be READ, rather than calling it empty", async () => {
    // Exit 1 from `rev-parse --verify --quiet refs/stash` is "no such ref",
    // the one non-zero code that means an empty stack. Anything else is a
    // question that could not be asked, and answering it as an empty stack
    // reports "nothing to move" for work that has just left the tree.
    const repo = await makeRepo();
    dirty(repo);

    let pushed = false;
    const blindAfterPush: GitRun = async (cwd, args) => {
      if (pushed && args[0] === "rev-parse" && args.includes("refs/stash")) {
        return { exitCode: 128, stdout: "", stderr: "fatal: cannot read ref" };
      }
      const res = await runGit(cwd, args);
      if (args[0] === "stash" && args[1] === "push") pushed = true;
      return res;
    };

    const result = await moveChangesToWorktree({
      source: repo,
      git: blindAfterPush,
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stash-failed");
    // The changes are out of the tree, so this is not a refusal to show for
    // four seconds and forget.
    expect(result.sourceRestored).toBe(false);
    expect(await stashCount(repo)).toBe(1);
  });

  it("flags an unconfirmable entry as work that left the checkout", async () => {
    // Ours was created and something landed on top before it could be
    // confirmed. The entry cannot be told apart from an earlier run's, so the
    // move refuses — but the changes ARE out of the tree, which is the
    // difference between a message worth interrupting someone for and an
    // ordinary validation refusal.
    const repo = await makeRepo();
    dirty(repo);

    const pushOnTop: GitRun = async (cwd, args) => {
      const res = await runGit(cwd, args);
      if (args[0] === "stash" && args[1] === "push" && res.exitCode === 0) {
        writeFileSync(join(repo, "tracked.txt"), "someone else's edit\n");
        await runGit(repo, ["stash", "push", "--message", "unrelated"]);
      }
      return res;
    };

    const result = await moveChangesToWorktree({
      source: repo,
      git: pushOnTop,
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stash-failed");
    expect(result.sourceRestored).toBe(false);
    expect(failureNeedsAcknowledgement(result)).toBe(true);
  });

  it("leaves a push that created NOTHING reported as an intact tree", async () => {
    // The other half of the push failure: no entry means the work never left
    // the working tree, so claiming an unrestored source would send the user
    // hunting through a stash stack for changes that are still in front of
    // them.
    const repo = await makeRepo();
    dirty(repo);

    const refusedPush: GitRun = async (cwd, args) => {
      if (args[0] === "stash" && args[1] === "push") {
        return { exitCode: 1, stdout: "", stderr: "cannot write stash" };
      }
      return runGit(cwd, args);
    };

    const result = await moveChangesToWorktree({
      source: repo,
      git: refusedPush,
      createWorktree: async () => {
        throw new Error("must not be called");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("stash-failed");
    expect(result.stashSha).toBeUndefined();
    expect(result.sourceRestored).toBeUndefined();
    expect(readFileSync(join(repo, "tracked.txt"), "utf-8")).toBe("edited\n");
  });

  it("survives a name git's own formatting would reshape", async () => {
    // git reads a stash message back through `%s`, which strips trailing
    // whitespace and collapses newlines, so a marker built from the raw name
    // is not what comes back out. An ordinary typo — a trailing space in
    // `--worktree "my feature "` — then lands in the "another stash was
    // pushed on top" arm and refuses a move that was going fine.
    const repo = await makeRepo();
    dirty(repo);

    const result = await moveChangesToWorktree({
      source: repo,
      name: "my feature ",
      // Named by hand: a ref cannot contain a space, so the fixture creator's
      // name-as-branch-name would fail on this input for its own reasons.
      createWorktree: async () => {
        const path = join(root, "wt", "trailing");
        await git(repo, ["worktree", "add", "-b", "trailing", path, "HEAD"]);
        return { path, created: true };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      readFileSync(join(result.worktreePath, "tracked.txt"), "utf-8"),
    ).toBe("edited\n");
    expect(await stashCount(repo)).toBe(0);
  });

  it("copies on past a file that vanished after the status read", async () => {
    // The pane's agent deleting its own scratch file in the seconds this
    // takes is not a reason to fail a move and roll back the worktree.
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    writeFileSync(join(repo, "keep.txt"), "keep\n");
    writeFileSync(join(repo, "doomed.txt"), "not for long\n");

    const result = await moveChangesToWorktree({
      source: repo,
      untracked: "copy",
      createWorktree: async ({ name }) => {
        rmSync(join(repo, "doomed.txt"), { force: true });
        const path = join(root, "wt", name ?? "moved");
        await git(repo, ["worktree", "add", "-b", "moved", path, "HEAD"]);
        return { path, created: true };
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(result.worktreePath, "keep.txt"), "utf-8")).toBe(
      "keep\n",
    );
    expect(existsSync(join(result.worktreePath, "doomed.txt"))).toBe(false);
    // And the report names what LANDED, not what the status read listed. The
    // skipped file is sorted first, so this also proves the copy carried on
    // past it.
    expect(result.untracked.files).toEqual(["keep.txt"]);
  });

  it("never copies a nested checkout git could not expand", async () => {
    // git refuses to descend into another repository, so a stray clone or a
    // submodule arrives as one collapsed `vendor/` record even under -uall.
    // Copied as a directory it brings its .git, its node_modules and its
    // secrets with it.
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    const nested = join(repo, "vendor");
    await mkdir(nested, { recursive: true });
    await git(root, ["init", "--initial-branch=main", nested]);
    writeFileSync(join(nested, ".env"), "TOKEN=secret\n");

    const result = await moveChangesToWorktree({
      source: repo,
      untracked: "copy",
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(result.worktreePath, "vendor"))).toBe(false);
    // And the report does not claim it either.
    expect(result.untracked.files).toEqual([]);
    // Untouched where the user left it.
    expect(readFileSync(join(nested, ".env"), "utf-8")).toBe("TOKEN=secret\n");
  });

  it("never reports a nested checkout 'move' could not take either", async () => {
    // `git stash push --include-untracked` prints "Ignoring path vendor/" and
    // exits 0: git will not stash another repository. The directory stays put,
    // so naming it in the report would tell the user their work moved when it
    // is still sitting in the source.
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    const nested = join(repo, "vendor");
    await mkdir(nested, { recursive: true });
    await git(root, ["init", "--initial-branch=main", nested]);
    writeFileSync(join(nested, ".env"), "TOKEN=secret\n");

    const result = await moveChangesToWorktree({
      source: repo,
      createWorktree: realCreator(repo),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.untracked.files).toEqual([]);
    // Still where the user left it, which is why the report cannot claim it.
    expect(readFileSync(join(nested, ".env"), "utf-8")).toBe("TOKEN=secret\n");
    expect(existsSync(join(result.worktreePath, "vendor"))).toBe(false);
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

describe("dropStashCommand", () => {
  it("drops the named entry, where git's own by-sha form does not", async () => {
    // The advice printed for a leftover entry, run against real git. Three
    // entries deep with ours in the middle, so a bare `git stash drop` would
    // take somebody else's.
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "first\n");
    await git(repo, ["stash", "push", "--message", "keep me"]);
    writeFileSync(join(repo, "tracked.txt"), "second\n");
    await git(repo, ["stash", "push", "--message", "ccmux move-changes"]);
    writeFileSync(join(repo, "tracked.txt"), "third\n");
    await git(repo, ["stash", "push", "--message", "someone else"]);

    const listing = await git(repo, ["stash", "list", "--format=%H %gs"]);
    const ours = listing
      .split("\n")
      .find((line) => line.includes("ccmux move-changes"))!
      .split(" ")[0]!;

    // What the CLI used to suggest, and what git says about it.
    const bySha = await runGit(repo, ["stash", "drop", ours]);
    expect(bySha.exitCode).not.toBe(0);
    expect(bySha.stderr).toContain("not a stash reference");

    const advised = Bun.spawnSync(["sh", "-c", dropStashCommand(ours)], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(advised.stderr.toString()).toBe("");
    expect(advised.exitCode).toBe(0);

    const after = await git(repo, ["stash", "list", "--format=%gs"]);
    expect(after).not.toContain("ccmux move-changes");
    expect(after).toContain("keep me");
    expect(after).toContain("someone else");
  });

  it("drops NOTHING when the entry is not in the stack", async () => {
    // The predicate that produces this advice is the same one that empties
    // the grep: a leftover is reported when the entry cannot be found. With
    // no argument, `git stash drop` takes whatever is on top — so the advice
    // for an entry that is gone destroys an unrelated one.
    const repo = await makeRepo();
    writeFileSync(join(repo, "tracked.txt"), "first\n");
    await git(repo, ["stash", "push", "--message", "keep me"]);

    const absent = "0".repeat(40);
    expect(dropStashCommand(absent)).toContain('[ -n "$ref" ]');
    Bun.spawnSync(["sh", "-c", dropStashCommand(absent)], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await stashCount(repo)).toBe(1);
    expect(await git(repo, ["stash", "list", "--format=%gs"])).toContain(
      "keep me",
    );
  });

  it("never lets something that is not a sha reach the shell", async () => {
    // Defense in depth: the sha comes back from git, but this string is
    // printed for a person to paste into their own shell, and a value that is
    // not a sha has no business being expanded there.
    const repo = await makeRepo();
    const sentinel = join(root, "pwned");

    Bun.spawnSync(["sh", "-c", dropStashCommand(`$(touch ${sentinel})`)], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(existsSync(sentinel)).toBe(false);
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

  it("lists untracked FILES, not the directory git collapses them into", async () => {
    // git reports a wholly untracked directory as one `?? deep/` record, so
    // a reader that takes the records at face value says "1 untracked file"
    // for a hundred of them, and hands the copy a directory to recurse
    // rather than a list to enumerate.
    const repo = await makeRepo();
    await mkdir(join(repo, "deep", "nested"), { recursive: true });
    writeFileSync(join(repo, "deep", "a.txt"), "1\n");
    writeFileSync(join(repo, "deep", "nested", "b.txt"), "2\n");

    const state = await readUncommitted(repo);
    expect(state!.untrackedPaths.sort()).toEqual([
      "deep/a.txt",
      "deep/nested/b.txt",
    ]);
  });

  it("counts a rename once, not twice", async () => {
    // With `-z` a rename is TWO records — the new path, then the original —
    // so counting records reports one `git mv` as two changed files.
    const repo = await makeRepo();
    await git(repo, ["mv", "tracked.txt", "renamed.txt"]);

    const state = await readUncommitted(repo);
    expect(state!.modified).toBe(1);
    expect(state!.untrackedPaths).toEqual([]);
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
