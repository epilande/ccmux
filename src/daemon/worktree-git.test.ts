import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseUpstreamTrack,
  readUpstreamStates,
  runGit,
  type GitResult,
  type GitRun,
} from "./worktree-git";

/**
 * Upstream tracking, which the Worktrees panel reads for ahead/behind and the
 * prune scan reads for `[gone]`.
 *
 * The end-to-end case at the bottom drives REAL git against throwaway repos
 * under the OS temp dir, because the parse below is an assumption about
 * git's output format and only git can confirm it.
 */

let root: string;

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args);
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  }
  return res.stdout.trim();
}

async function makeClone(name: string, remote: string): Promise<string> {
  const path = join(root, name);
  await git(root, ["clone", remote, path]);
  await git(path, ["config", "user.email", "test@example.com"]);
  await git(path, ["config", "user.name", "Test"]);
  return path;
}

async function commit(repo: string, file: string): Promise<void> {
  writeFileSync(join(repo, file), `${file}\n`);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", file]);
}

/** A `GitRun` that answers one canned `for-each-ref` result. */
function stubGit(stdout: string, exitCode = 0): GitRun {
  return async (): Promise<GitResult> => ({ exitCode, stdout, stderr: "" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccmux-worktree-git-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseUpstreamTrack", () => {
  it("reads ahead on its own", () => {
    expect(parseUpstreamTrack("[ahead 2]")).toEqual({
      gone: false,
      ahead: 2,
      behind: 0,
    });
  });

  it("reads behind on its own", () => {
    expect(parseUpstreamTrack("[behind 3]")).toEqual({
      gone: false,
      ahead: 0,
      behind: 3,
    });
  });

  it("reads both from a diverged branch", () => {
    expect(parseUpstreamTrack("[ahead 2, behind 3]")).toEqual({
      gone: false,
      ahead: 2,
      behind: 3,
    });
  });

  // A gone upstream carries no counts, and reporting the two zeros as "in
  // sync" would be the wrong reading of them.
  it("reads gone, with no counts", () => {
    expect(parseUpstreamTrack("[gone]")).toEqual({
      gone: true,
      ahead: 0,
      behind: 0,
    });
  });

  it("reads an empty track as in sync", () => {
    expect(parseUpstreamTrack("")).toEqual({
      gone: false,
      ahead: 0,
      behind: 0,
    });
  });
});

describe("readUpstreamStates", () => {
  it("maps every branch's upstream, counts and gone flag", async () => {
    const states = await readUpstreamStates(
      "/repo",
      stubGit(
        [
          "main\torigin/main\t",
          "feat/ahead\torigin/feat/ahead\t[ahead 2]",
          "feat/both\torigin/feat/both\t[ahead 1, behind 4]",
          "feat/gone\torigin/feat/gone\t[gone]",
          "feat/local\t\t",
          "",
        ].join("\n"),
      ),
    );

    expect(states.get("main")).toEqual({
      upstream: "origin/main",
      gone: false,
      ahead: 0,
      behind: 0,
    });
    expect(states.get("feat/ahead")).toEqual({
      upstream: "origin/feat/ahead",
      gone: false,
      ahead: 2,
      behind: 0,
    });
    expect(states.get("feat/both")).toEqual({
      upstream: "origin/feat/both",
      gone: false,
      ahead: 1,
      behind: 4,
    });
    expect(states.get("feat/gone")).toEqual({
      upstream: "origin/feat/gone",
      gone: true,
      ahead: 0,
      behind: 0,
    });
  });

  // A purely local branch has no upstream to have lost, so it is never gone.
  it("reports a branch with no upstream as not gone", async () => {
    const states = await readUpstreamStates(
      "/repo",
      stubGit("feat/local\t\t\n"),
    );
    expect(states.get("feat/local")).toEqual({
      upstream: null,
      gone: false,
      ahead: 0,
      behind: 0,
    });
  });

  it("returns nothing when for-each-ref fails", async () => {
    const states = await readUpstreamStates("/repo", stubGit("", 128));
    expect(states.size).toBe(0);
  });

  // Pins the assumption the parse rests on: this IS what git prints for a
  // branch that has commits of its own and commits waiting upstream.
  it("reports real ahead and behind counts from git", async () => {
    const remote = join(root, "remote.git");
    await mkdir(root, { recursive: true });
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);

    const seed = await makeClone("seed", remote);
    await commit(seed, "README.md");
    await git(seed, ["push", "-u", "origin", "main"]);

    const mine = await makeClone("mine", remote);
    // Someone else moves the branch on: two commits this checkout lacks.
    await commit(seed, "theirs-1.txt");
    await commit(seed, "theirs-2.txt");
    await git(seed, ["push"]);
    // And one of my own that is not pushed.
    await commit(mine, "mine.txt");
    await git(mine, ["fetch"]);

    const states = await readUpstreamStates(mine);

    expect(states.get("main")).toEqual({
      upstream: "origin/main",
      gone: false,
      ahead: 1,
      behind: 2,
    });
  });
});
