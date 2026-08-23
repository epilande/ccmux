import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorktreeFileSetup,
  createWorktree,
  readCheckoutHead,
  resolveWorktreeIncludes,
  resolveBase,
  resolveWorktreeName,
  slugForFork,
  slugForIssue,
  slugForPR,
  slugFromPrompt,
  slugify,
  withRepoLock,
  worktreePathFor,
} from "./worktree-create";
import { runGit } from "./worktree-git";

/**
 * Real git against throwaway fixture repos under the OS temp dir. Nothing
 * here touches a repo outside `root`, which matters more than usual for this
 * module: its placement convention is `<repo>/.claude/worktrees/<name>`, the
 * same path the real checkout uses for live agent worktrees.
 */

let root: string;

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runGit(cwd, args);
  if (res.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr}`);
  }
  return res.stdout.trim();
}

/** Where a branch's recorded base lives; see `recordBranchBase`. */
const CONFIG_KEY = (branch: string) => `branch.${branch}.ccmux-base`;

/** A config value, or null for a key that is not set (git exits non-zero). */
async function readConfig(repo: string, key: string): Promise<string | null> {
  const res = await runGit(repo, ["config", "--get", key]);
  return res.exitCode === 0 ? res.stdout.trim() : null;
}

/** `lstatSync` throws on an absent path, and absent is an answer here. */
function lstatIsSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function makeRepo(name = "repo"): Promise<string> {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  await git(root, ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
  // The developer's own `~/.config/git/ignore` is read even with
  // GIT_CONFIG_GLOBAL neutered — it is git's DEFAULT excludes path, not a
  // config value — and one of these fixtures asks git whether a path is
  // ignored. Without this, whether that test passes depends on whose machine
  // it runs on.
  await git(repo, ["config", "core.excludesFile", "/dev/null"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "init"]);
  return repo;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccmux-wt-create-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("slugify", () => {
  it("lowercases and collapses non-alphanumerics to single hyphens", () => {
    expect(slugify("Fix Sidebar Flicker")).toBe("fix-sidebar-flicker");
    expect(slugify("feat/some__thing")).toBe("feat-some-thing");
    expect(slugify("  spaced  out  ")).toBe("spaced-out");
  });

  it("never leaves leading or trailing hyphens", () => {
    expect(slugify("---edge---")).toBe("edge");
    expect(slugify("!!!")).toBe("");
  });

  it("caps length without leaving a trailing hyphen", () => {
    const slug = slugify("a".repeat(80));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("slugFromPrompt", () => {
  // The example from the issue, kept verbatim so a change to word count or
  // punctuation handling is visible as a change to the documented behavior.
  it("derives a name from the first words", () => {
    expect(slugFromPrompt("fix sidebar flicker on resize")).toBe(
      "fix-sidebar-flicker",
    );
  });

  it("is deterministic", () => {
    const prompt = "refactor the parser to stream input";
    expect(slugFromPrompt(prompt)).toBe(slugFromPrompt(prompt));
  });

  // Punctuation is stripped BEFORE the split, so `fix:` does not consume a
  // word slot and leave a two-word name.
  it("does not let punctuation eat a word", () => {
    expect(slugFromPrompt("fix: sidebar flicker on resize")).toBe(
      "fix-sidebar-flicker",
    );
  });

  it("returns nothing usable for an unusable prompt", () => {
    expect(slugFromPrompt("!!! ???")).toBe("");
  });
});

describe("resolveWorktreeName", () => {
  it("prefers an explicit name, slugified", () => {
    const out = resolveWorktreeName("Fix Sidebar", "some prompt text");
    expect(out).toEqual({ ok: true, name: "fix-sidebar", derived: false });
  });

  // `derived` is what decides whether a collision opens the existing worktree
  // or takes the next number, so it travels with the name.
  it("falls back to the prompt, marked derived", () => {
    const out = resolveWorktreeName(undefined, "fix sidebar flicker on resize");
    expect(out).toEqual({
      ok: true,
      name: "fix-sidebar-flicker",
      derived: true,
    });
  });

  // Neither is an error rather than a generated placeholder: an invented
  // name is a directory and a branch the user cannot guess later.
  it("errors with neither a name nor a prompt", () => {
    const out = resolveWorktreeName(undefined, undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("needs a name");
  });

  it("errors on a name with nothing usable in it", () => {
    const out = resolveWorktreeName("!!!", undefined);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("no usable characters");
  });

  // A fork has no prompt to derive from, so the caller derives the name and
  // hands it over. It has to arrive marked derived, or a collision would open
  // the existing worktree instead of numbering past it.
  it("accepts a caller-derived name, marked derived", () => {
    const out = resolveWorktreeName(undefined, undefined, "feat-foo-fork");
    expect(out).toEqual({ ok: true, name: "feat-foo-fork", derived: true });
  });

  it("still prefers an explicit name over a caller-derived one", () => {
    const out = resolveWorktreeName("Mine", undefined, "feat-foo-fork");
    expect(out).toEqual({ ok: true, name: "mine", derived: false });
  });
});

describe("slugForFork", () => {
  it("suffixes a branch name", () => {
    expect(slugForFork("feat/fork-worktree")).toBe("feat-fork-worktree-fork");
  });

  /**
   * The lengths that used to lie. The suffix is budgeted INSIDE the cap
   * rather than appended past it, because the name is handed to
   * `resolveWorktreeName`, which slugifies again: anything the suffix pushed
   * over the cap was cut off there. A 36-character branch lost part of the
   * `-fork` that says what the worktree is, and a 39-character one lost all
   * of it and derived its own branch's name, which numbering then turned
   * into `<branch>-2`.
   */
  const boundaries = [35, 36, 39, 40, 80];

  it("keeps the whole suffix at every length", () => {
    for (const length of boundaries) {
      const name = slugForFork("a".repeat(length));
      expect(name.endsWith("-fork")).toBe(true);
      expect(name.length).toBeLessThanOrEqual(40);
    }
  });

  // Through the resolver, because that is where the collision happened: a
  // name equal to the source branch's is one `firstFreeDerivedName` finds
  // taken, so the fork landed on `<branch>-2`.
  it("never resolves to the source's own name", () => {
    for (const length of boundaries) {
      const branch = "a".repeat(length);
      const resolved = resolveWorktreeName(
        undefined,
        undefined,
        slugForFork(branch),
      );
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.name).not.toBe(slugify(branch));
    }
  });

  // What makes both of the above true end to end: the property only holds if
  // the re-slugify every caller's name goes through leaves this alone.
  it("survives the re-slugify resolveWorktreeName does", () => {
    for (const length of boundaries) {
      const name = slugForFork("a".repeat(length));
      expect(slugify(name)).toBe(name);
      expect(resolveWorktreeName(undefined, undefined, name)).toEqual({
        ok: true,
        name,
        derived: true,
      });
    }
  });

  it("returns nothing usable for a label with nothing in it", () => {
    expect(slugForFork("!!!")).toBe("");
  });
});

describe("readCheckoutHead", () => {
  it("reports the branch a checkout is on", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-q", "-b", "feat/thing"]);

    expect(await readCheckoutHead(repo)).toEqual({
      ref: "feat/thing",
      label: "feat/thing",
    });
  });

  // A detached HEAD answers the literal "HEAD" to `--abbrev-ref`, which any
  // other checkout would resolve to its OWN head, so the sha is what travels.
  it("reports a sha for a detached HEAD", async () => {
    const repo = await makeRepo();
    const sha = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "--detach"]);

    expect(await readCheckoutHead(repo)).toEqual({
      ref: sha,
      label: sha.slice(0, 12),
    });
  });

  it("reports nothing for an unborn HEAD", async () => {
    const empty = join(root, "unborn");
    mkdirSync(empty, { recursive: true });
    await git(root, ["init", "--initial-branch=main", empty]);

    expect(await readCheckoutHead(empty)).toBeNull();
  });
});

describe("resolveBase", () => {
  it("defaults to the main checkout's current branch", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-q", "-b", "release/2.0"]);

    const out = await resolveBase(repo, undefined);

    expect(out).toEqual({ ok: true, base: "release/2.0" });
  });

  it("accepts an explicit ref that exists", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "other"]);

    expect(await resolveBase(repo, "other")).toEqual({
      ok: true,
      base: "other",
    });
  });

  it("rejects a ref that does not exist", async () => {
    const repo = await makeRepo();

    const out = await resolveBase(repo, "no-such-ref");

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("Base ref not found");
  });
});

describe("file setup", () => {
  /**
   * `.worktreeinclude` is GITIGNORE SYNTAX under a dual filter: a path is
   * included only if it matches a pattern AND is gitignored. Both halves are
   * delegated to git, so this exercises the real thing against a fixture
   * rather than asserting on a hand-rolled parse.
   */
  it("resolves .worktreeinclude patterns under the dual filter", async () => {
    const repo = await makeRepo("includes");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n*.local\n");
    // Matches a pattern below, but is TRACKED: must never be duplicated.
    writeFileSync(join(repo, "config.local"), "tracked\n");
    writeFileSync(join(repo, ".worktreeinclude"), ".env\n*.local\nnotes.txt\n");
    await git(repo, [
      "add",
      "-f",
      ".gitignore",
      ".worktreeinclude",
      "config.local",
    ]);
    await git(repo, ["commit", "-m", "config"]);

    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    writeFileSync(join(repo, "app.local"), "settings\n");
    // Gitignored but matches no include pattern.
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep.js"), "x\n");
    // Matches a pattern but is NOT gitignored, so the dual filter drops it.
    writeFileSync(join(repo, "notes.txt"), "notes\n");

    const resolved = await resolveWorktreeIncludes(repo);

    expect(resolved.sort()).toEqual([".env", "app.local"]);
    expect(resolved).not.toContain("config.local");
    expect(resolved).not.toContain("notes.txt");
  });

  it("resolves nothing when there is no .worktreeinclude", async () => {
    const repo = await makeRepo("no-includes");
    expect(await resolveWorktreeIncludes(repo)).toEqual([]);
  });

  it("symlinks configured directories and copies included files", async () => {
    const repo = await makeRepo();
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "x\n");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["node_modules"] } }),
    );
    writeFileSync(join(repo, ".worktreeinclude"), ".env\n");
    // Gitignored as well as matched: the include contract is a dual filter,
    // so a pattern alone would (correctly) resolve to nothing.
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
    await git(repo, ["add", "-f", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore"]);
    writeFileSync(join(repo, ".env"), "SECRET=1\n");
    const wt = join(root, "target");
    mkdirSync(wt, { recursive: true });

    const out = await applyWorktreeFileSetup(repo, wt);

    expect(out.symlinked).toEqual(["node_modules"]);
    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(wt, "node_modules"))).toBe(
      join(repo, "node_modules"),
    );
    // Copied, not linked: an edit to a local settings file or a secret in one
    // worktree must not propagate back to the main checkout.
    expect(out.included).toEqual([".env"]);
    expect(lstatSync(join(wt, ".env")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(wt, ".env"), "utf-8")).toBe("SECRET=1\n");
  });

  it("skips sources that do not exist and targets that already do", async () => {
    const repo = await makeRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["absent", "kept"] } }),
    );
    mkdirSync(join(repo, "kept"), { recursive: true });
    const wt = join(root, "target2");
    mkdirSync(join(wt, "kept"), { recursive: true });
    writeFileSync(join(wt, "kept", "tracked.txt"), "repo content\n");

    const out = await applyWorktreeFileSetup(repo, wt);

    // Neither is linked: one has no source, and replacing the other would
    // delete a checked-out path of the same name.
    expect(out.symlinked).toEqual([]);
    expect(readFileSync(join(wt, "kept", "tracked.txt"), "utf-8")).toBe(
      "repo content\n",
    );
  });

  // `.claude/settings.json` and `.worktreeinclude` are repo content, so on a
  // repo written by someone else they are untrusted input that this turns
  // into filesystem writes.
  it("refuses configured paths that escape the worktree", async () => {
    const repo = await makeRepo();
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["../escape"] } }),
    );
    writeFileSync(join(repo, ".worktreeinclude"), "../escape-file\n");
    // Both sources exist, so the escape guard is the only thing standing
    // between this config and a write outside the worktree. A missing source
    // would be skipped for an unrelated reason and prove nothing.
    mkdirSync(join(root, "escape"), { recursive: true });
    writeFileSync(join(root, "escape", "occupant.txt"), "mine\n");
    writeFileSync(join(root, "escape-file"), "no\n");
    // Nested one level deeper than the repo, so `..` from the worktree names a
    // DIFFERENT directory than `..` from the repo. As siblings under `root`
    // each entry's source and target collide on one path, and a broken guard
    // would fail on that collision rather than on the guard.
    const wt = join(root, "nest", "target3");
    mkdirSync(wt, { recursive: true });
    // git never lists a path outside the repo, so the real resolver can't
    // produce an escaping include even from an escaping pattern. Fed directly
    // instead: the guard is what is under test, not git's own filtering.
    const escapingGit = async () => ({
      exitCode: 0,
      stdout: "../escape-file\n",
      stderr: "",
    });

    const out = await applyWorktreeFileSetup(repo, wt, escapingGit);

    // The filesystem first: the report is secondary to whether a write
    // actually landed outside the worktree.
    //
    // Nothing was written at either escape target...
    expect(existsSync(join(root, "nest", "escape"))).toBe(false);
    expect(lstatIsSymlink(join(root, "nest", "escape"))).toBe(false);
    expect(existsSync(join(root, "nest", "escape-file"))).toBe(false);
    // ...the escaped-to directory is untouched...
    expect(readdirSync(join(root, "escape"))).toEqual(["occupant.txt"]);
    // ...and nothing landed inside the worktree either, so the entries were
    // refused rather than redirected.
    expect(readdirSync(wt)).toEqual([]);
    expect(out.symlinked).toEqual([]);
    expect(out.included).toEqual([]);
  });

  // The escape guard cannot see this one: the entry itself stays inside the
  // worktree, and the way out is the LINK TEXT of a path git checked out
  // there. `existsSync` follows symlinks, so a dangling one reads as absent
  // and a copy writes THROUGH it to whatever it names.
  it("refuses to copy over a dangling symlink in the worktree", async () => {
    const repo = await makeRepo("through-link");
    const leaked = join(root, "leaked.txt");
    // Four levels up from `<repo>/.claude/worktrees/wt` is `root`, so the
    // committed link names a path outside the repo entirely.
    symlinkSync(
      join("..", "..", "..", "..", "leaked.txt"),
      join(repo, "env.local"),
    );
    writeFileSync(join(repo, ".gitignore"), "env.local\n");
    writeFileSync(join(repo, ".worktreeinclude"), "env.local\n");
    await git(repo, [
      "add",
      "-f",
      ".gitignore",
      ".worktreeinclude",
      "env.local",
    ]);
    await git(repo, ["commit", "-m", "link"]);
    await git(repo, ["branch", "old"]);
    // The main checkout's own copy is a real, untracked, ignored file: the one
    // the include pass then tries to copy in on top of the checked-out link.
    await git(repo, ["rm", "--cached", "-q", "env.local"]);
    rmSync(join(repo, "env.local"));
    writeFileSync(join(repo, "env.local"), "SECRET=1\n");
    await git(repo, ["commit", "-m", "untrack"]);

    const out = await createWorktree(repo, { name: "wt", base: "old" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The filesystem first: what a regression costs is a secret written to a
    // path outside the repo.
    expect(existsSync(leaked)).toBe(false);
    expect(lstatIsSymlink(join(out.result.path, "env.local"))).toBe(true);
    expect(out.result.included).not.toContain("env.local");
  });

  // `git ls-files` C-quotes a non-ASCII path by default, handing back the
  // literal `"caf\303\251.local"`, which names nothing on disk and got
  // silently skipped. Both calls run NUL-terminated so an entry arrives as
  // its real bytes.
  it("includes a non-ASCII path", async () => {
    const repo = await makeRepo("non-ascii");
    writeFileSync(join(repo, ".gitignore"), "*.local\n");
    writeFileSync(join(repo, ".worktreeinclude"), "*.local\n");
    await git(repo, ["add", "-f", ".gitignore", ".worktreeinclude"]);
    await git(repo, ["commit", "-m", "config"]);
    writeFileSync(join(repo, "café.local"), "SECRET=1\n");
    const wt = join(root, "target-non-ascii");
    mkdirSync(wt, { recursive: true });

    const out = await applyWorktreeFileSetup(repo, wt);

    expect(out.included).toEqual(["café.local"]);
    expect(readFileSync(join(wt, "café.local"), "utf-8")).toBe("SECRET=1\n");
  });
});

describe("createWorktree", () => {
  it("creates the worktree at the shared convention path, on a new branch", async () => {
    const repo = await makeRepo();

    const out = await createWorktree(repo, { name: "Fix Sidebar" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.name).toBe("fix-sidebar");
    expect(out.result.path).toBe(worktreePathFor(repo, "fix-sidebar"));
    expect(out.result.path).toContain(join(".claude", "worktrees"));
    expect(out.result.created).toBe(true);
    expect(out.result.branchCreated).toBe(true);
    // The base is reported so a caller can say where the branch came from
    // instead of leaving the user to guess which ref it was cut at.
    expect(out.result.base).toBe("main");
    expect(existsSync(out.result.path)).toBe(true);
    expect(
      await git(out.result.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ).toBe("fix-sidebar");
  });

  it("derives the name from a prompt when none is given", async () => {
    const repo = await makeRepo();

    const out = await createWorktree(repo, {
      prompt: "fix sidebar flicker on resize",
    });

    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.name).toBe("fix-sidebar-flicker");
  });

  it("branches from --base when given", async () => {
    const repo = await makeRepo();
    await git(repo, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(repo, "f.txt"), "f\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "on feature"]);
    const featureTip = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "main"]);

    const out = await createWorktree(repo, {
      name: "off-feature",
      base: "feature",
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(await git(out.result.path, ["rev-parse", "HEAD"])).toBe(featureTip);
    expect(out.result.base).toBe("feature");
  });

  // "Spawn an agent on this task" is satisfiable when the worktree is already
  // there, so the second spawn of a name opens rather than fails.
  it("opens an existing worktree instead of failing", async () => {
    const repo = await makeRepo();
    const first = await createWorktree(repo, { name: "shared" });
    expect(first.ok).toBe(true);

    const second = await createWorktree(repo, { name: "shared" });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.created).toBe(false);
    expect(second.result.branch).toBe("shared");
    // Nothing was cut for this request, so there is no base to report.
    expect(second.result.branchCreated).toBe(false);
    expect(second.result.base).toBeUndefined();
    if (first.ok) expect(second.result.path).toBe(first.result.path);
  });

  // The branch reuse is intentional, but a reused branch can already carry
  // twenty commits, so the result must not describe it as newly cut.
  it("reuses an existing branch of the same name, and says so", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "already-there"]);

    const out = await createWorktree(repo, { name: "already-there" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(
      await git(out.result.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ).toBe("already-there");
    expect(out.result.created).toBe(true);
    expect(out.result.branchCreated).toBe(false);
    expect(out.result.base).toBeUndefined();
  });

  // The picker's branch review asks git where the branch came from rather
  // than guessing the repo's default branch, which is only possible if the
  // answer was written down at the one moment it is known.
  it("records the base the branch was cut from in branch config", async () => {
    const repo = await makeRepo();

    const out = await createWorktree(repo, { name: "fix-sidebar" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // A ref NAME, not the sha it pointed at: the merge-base still lands on
    // the fork point after the user merges the base back in. Fully
    // qualified, so it cannot be re-read as a tag or a rev expression.
    expect(await readConfig(repo, CONFIG_KEY("fix-sidebar"))).toBe(
      "refs/heads/main",
    );
    expect(out.result.base).toBe("main");
  });

  // A base whose meaning depends on WHERE it is evaluated is the whole risk:
  // the record is read back inside the worktree, where HEAD is the branch's
  // own tip. Stored verbatim, `HEAD~1` reviews the branch against its own
  // parent — silently, with no error and no fallback.
  it("pins a HEAD-relative base to the commit it named in the main checkout", async () => {
    const repo = await makeRepo();
    writeFileSync(join(repo, "second.txt"), "2\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "second"]);
    const parent = await git(repo, ["rev-parse", "HEAD~1"]);

    const out = await createWorktree(repo, { name: "off-parent", base: "HEAD~1" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(await readConfig(repo, CONFIG_KEY("off-parent"))).toBe(parent);
  });

  // `@` is `HEAD`, which git DOES name here (`refs/heads/main`) while the
  // main checkout is attached — so the record is that name, and the thing
  // that matters is what it means from inside the worktree: the base it was
  // cut from, never the worktree's own head.
  it("records a base of @ as the ref it names, not the worktree's own head", async () => {
    const repo = await makeRepo();
    const mainTip = await git(repo, ["rev-parse", "HEAD"]);

    const out = await createWorktree(repo, { name: "off-at", base: "@" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const stored = await readConfig(repo, CONFIG_KEY("off-at"));
    expect(stored).not.toBeNull();
    // A commit of the worktree's own moves its HEAD off the base; the record
    // must still resolve to the base.
    writeFileSync(join(out.result.path, "work.txt"), "w\n");
    await git(out.result.path, ["add", "-A"]);
    await git(out.result.path, ["commit", "-m", "agent work"]);
    expect(await git(out.result.path, ["rev-parse", stored ?? ""])).toBe(
      mainTip,
    );
    expect(await git(out.result.path, ["rev-parse", "HEAD"])).not.toBe(mainTip);
  });

  // A reused branch was not cut from the base, so a record would misdescribe
  // where its history comes from - the same reason `result.base` is undefined.
  it("records nothing when it reuses an existing branch", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "already-there"]);

    const out = await createWorktree(repo, { name: "already-there" });

    expect(out.ok).toBe(true);
    expect(await readConfig(repo, CONFIG_KEY("already-there"))).toBeNull();
  });

  // A DETACHED main checkout resolves its base as the literal "HEAD", which
  // read back from the worktree would name the worktree's own head and make
  // the merge-base the branch tip itself. The sha is stored instead.
  it("stores a sha rather than the literal HEAD for a detached base", async () => {
    const repo = await makeRepo();
    const head = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["checkout", "-q", "--detach"]);

    const out = await createWorktree(repo, { name: "off-detached" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.base).toBe("HEAD");
    expect(await readConfig(repo, CONFIG_KEY("off-detached"))).toBe(head);
  });

  // Two tasks that open the same way derive one slug, and there is no name
  // here anyone typed, so joining the first agent's worktree and branch would
  // be a collision the user never sees. "Start three agents on this prompt" is
  // the headline case for the feature, so it has to yield three worktrees.
  it("numbers a derived name that collides instead of opening it", async () => {
    const repo = await makeRepo();

    const first = await createWorktree(repo, {
      prompt: "fix the flaky test in the sidebar renderer",
    });
    const second = await createWorktree(repo, {
      prompt: "fix the flaky test in the binder",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.result.name).toBe("fix-the-flaky");
    expect(second.result.name).toBe("fix-the-flaky-2");
    expect(second.result.created).toBe(true);
    expect(second.result.branchCreated).toBe(true);
    expect(second.result.path).not.toBe(first.result.path);
    expect(
      await git(second.result.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ).toBe("fix-the-flaky-2");
  });

  // The same rule for the name a fork derives: two forks of one branch are
  // two conversations, and stacking the second onto the first's checkout is
  // the outcome numbering exists to prevent.
  it("numbers a caller-derived name that collides", async () => {
    const repo = await makeRepo();

    const first = await createWorktree(repo, { derivedName: "main-fork" });
    const second = await createWorktree(repo, { derivedName: "main-fork" });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.result.name).toBe("main-fork");
    expect(second.result.name).toBe("main-fork-2");
    expect(second.result.created).toBe(true);
  });

  // The boundary that mattered in practice: a long branch's `-fork` used to
  // be trimmed back off inside `resolveWorktreeName`, and at 39 characters
  // that left the fork asking for the SOURCE branch's own name. Numbering
  // then handed it `<branch>-2`, a worktree whose name says nothing about
  // what it is and which the dialog's preview never showed.
  it("keeps a long branch's -fork through creation", async () => {
    const repo = await makeRepo();
    const branch = "a".repeat(39);
    await git(repo, ["checkout", "-q", "-b", branch]);

    const out = await createWorktree(repo, {
      derivedName: slugForFork(branch),
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.name.endsWith("-fork")).toBe(true);
    expect(out.result.name).not.toBe(branch);
    expect(out.result.branch).toBe(out.result.name);
  });

  it("gives three concurrent spawns of one prompt three worktrees", async () => {
    const repo = await makeRepo();
    const prompt = "refactor the parser to stream input";

    const results = await Promise.all([
      createWorktree(repo, { prompt }),
      createWorktree(repo, { prompt }),
      createWorktree(repo, { prompt }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const names = results.map((r) => (r.ok ? r.result.name : "")).sort();
    expect(names).toEqual([
      "refactor-the-parser",
      "refactor-the-parser-2",
      "refactor-the-parser-3",
    ]);
    for (const name of names) {
      expect(existsSync(worktreePathFor(repo, name))).toBe(true);
    }
  });

  // A branch counts as taken too: the create path reuses a branch it finds,
  // which for a name nobody typed would start the agent on unrelated history.
  it("skips a derived candidate a branch already holds", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "fix-the-flaky"]);

    const out = await createWorktree(repo, {
      prompt: "fix the flaky test in the sidebar",
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.name).toBe("fix-the-flaky-2");
    expect(out.result.branchCreated).toBe(true);
  });

  // `withRepoLock` is process-local, so a branch of the derived name can
  // appear between the candidate probe and the add: another checkout of this
  // repo, another tool, a person at a shell. Reusing it would start the agent
  // on unrelated history under a name nobody chose, so a derived name always
  // passes `-b` and lets git refuse.
  it("fails loudly when a branch takes the derived name mid-create", async () => {
    const repo = await makeRepo();
    // A commit off main's tip, so reuse would visibly start the agent
    // somewhere other than where this spawn asked to start.
    writeFileSync(join(repo, "theirs.txt"), "unrelated work\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-m", "work this spawn knows nothing about"]);
    const interloperTip = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["branch", "elsewhere"]);
    await git(repo, ["reset", "-q", "--hard", "HEAD~1"]);

    // Plants the branch in the window the real race opens: after the candidate
    // probe reports the name free, before `git worktree add` runs.
    let planted = false;
    const racingGit = async (cwd: string, args: string[]) => {
      const res = await runGit(cwd, args);
      if (
        !planted &&
        args[0] === "rev-parse" &&
        args.at(-1) === "refs/heads/fix-the-flaky"
      ) {
        planted = true;
        await runGit(repo, ["branch", "fix-the-flaky", interloperTip]);
      }
      return res;
    };

    const out = await createWorktree(
      repo,
      { prompt: "fix the flaky test" },
      { git: racingGit },
    );

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("worktree add -b fix-the-flaky");
    // The interloper's branch still points where it did, and no worktree was
    // handed the agent on top of it.
    expect(await git(repo, ["rev-parse", "fix-the-flaky"])).toBe(interloperTip);
    expect(existsSync(worktreePathFor(repo, "fix-the-flaky"))).toBe(false);
  });

  // An explicit name is documented intent, so it keeps create-or-open: the
  // numbering exists for names the user never chose.
  it("still opens an explicitly named worktree on a collision", async () => {
    const repo = await makeRepo();
    await createWorktree(repo, { name: "explicit" });

    const second = await createWorktree(repo, {
      name: "explicit",
      prompt: "explicit something else",
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.name).toBe("explicit");
    expect(second.result.created).toBe(false);
    expect(existsSync(worktreePathFor(repo, "explicit-2"))).toBe(false);
  });

  it("adds into a leftover directory that is empty", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "debris");
    mkdirSync(target, { recursive: true });

    const out = await createWorktree(repo, { name: "debris" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  // Clearing a non-empty directory buys nothing, since `git worktree add`
  // refuses a non-empty target anyway, and the top level does not say whose
  // files these are. Refusing costs one message; clearing costs the files.
  it("refuses a non-empty leftover directory", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "debris");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "leftover.txt"), "from an interrupted run\n");

    const out = await createWorktree(repo, { name: "debris" });

    // The file first: what a regression here costs is the content, and a
    // failure should name that rather than the return shape.
    expect(existsSync(join(target, "leftover.txt"))).toBe(true);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("is not empty");
  });

  // The hazard the top-level check cannot see: an interrupted clone at
  // `<path>/sub` is a repository with work in it, and a recursive delete of
  // the target would take the whole thing.
  it("refuses a leftover directory holding a nested repo", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "nested");
    mkdirSync(join(target, "sub", ".git"), { recursive: true });
    writeFileSync(join(target, "sub", "precious.txt"), "someone's work\n");

    const out = await createWorktree(repo, { name: "nested" });

    expect(existsSync(join(target, "sub", "precious.txt"))).toBe(true);
    expect(out.ok).toBe(false);
  });

  // A directory with a `.git` belongs to some repository. Removing it could
  // destroy work, so this refuses rather than guessing.
  it("refuses a leftover directory that contains a .git", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "occupied");
    mkdirSync(join(target, ".git"), { recursive: true });
    writeFileSync(join(target, "precious.txt"), "someone's work\n");

    const out = await createWorktree(repo, { name: "occupied" });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("contains a .git");
    expect(existsSync(join(target, "precious.txt"))).toBe(true);
  });

  // `existsSync` follows symlinks, so a `.git` pointing nowhere reads as
  // absent. It still says the directory was a checkout, and reading it as
  // debris would recursively delete everything beside it.
  it("refuses a leftover directory whose .git is a broken symlink", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "dangling");
    mkdirSync(target, { recursive: true });
    symlinkSync(join(root, "no-such-git-dir"), join(target, ".git"));
    writeFileSync(join(target, "precious.txt"), "someone's work\n");

    const out = await createWorktree(repo, { name: "dangling" });

    expect(existsSync(join(target, "precious.txt"))).toBe(true);
    expect(lstatIsSymlink(join(target, ".git"))).toBe(true);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("contains a .git");
  });

  it("reports a bad base without creating anything", async () => {
    const repo = await makeRepo();

    const out = await createWorktree(repo, {
      name: "nope",
      base: "missing-ref",
    });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("Base ref not found");
    expect(existsSync(worktreePathFor(repo, "nope"))).toBe(false);
  });

  it("applies file setup to a newly created worktree", async () => {
    const repo = await makeRepo();
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["node_modules"] } }),
    );

    const out = await createWorktree(repo, { name: "with-setup" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.symlinked).toEqual(["node_modules"]);
    expect(
      lstatSync(join(out.result.path, "node_modules")).isSymbolicLink(),
    ).toBe(true);
  });

  // Two spawns racing on one repo is the normal case for this feature, not
  // an edge case: "start three agents on this" is the point.
  it("serializes concurrent creates on one repo", async () => {
    const repo = await makeRepo();

    const results = await Promise.all([
      createWorktree(repo, { name: "one" }),
      createWorktree(repo, { name: "two" }),
      createWorktree(repo, { name: "three" }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    for (const name of ["one", "two", "three"]) {
      expect(existsSync(worktreePathFor(repo, name))).toBe(true);
    }
  });

  it("lets concurrent requests for one name settle as create-then-open", async () => {
    const repo = await makeRepo();

    const [a, b] = await Promise.all([
      createWorktree(repo, { name: "same" }),
      createWorktree(repo, { name: "same" }),
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Exactly one of them did the creating.
    expect([a.result.created, b.result.created].filter(Boolean)).toHaveLength(
      1,
    );
  });
});

/**
 * `.claude/worktrees/` has to be invisible to git in the repo that HOSTS the
 * worktrees, the way Claude Code makes it. Otherwise the first worktree turns
 * the second spawn's source checkout into one that has "untracked work" in
 * it — and a `--with-changes --untracked copy` then physically duplicates
 * every sibling checkout into the new one.
 */
describe("the worktrees exclude entry", () => {
  function excludePath(repo: string): string {
    return join(repo, ".git", "info", "exclude");
  }

  /** git's own answer, independent of how the entry got written. */
  async function ignoresWorktrees(repo: string): Promise<boolean> {
    // The trailing slash is load-bearing: the pattern matches a DIRECTORY,
    // and with the path absent from disk git cannot tell it is one.
    const res = await runGit(repo, [
      "check-ignore",
      "-q",
      ".claude/worktrees/",
    ]);
    return res.exitCode === 0;
  }

  it("excludes the worktree directory when creating the first one", async () => {
    const repo = await makeRepo();
    expect(await ignoresWorktrees(repo)).toBe(false);

    const created = await createWorktree(repo, { name: "first" });
    expect(created.ok).toBe(true);

    expect(await ignoresWorktrees(repo)).toBe(true);
    expect(readFileSync(excludePath(repo), "utf-8")).toContain(
      "**/.claude/worktrees/",
    );
    // The point of all of it: the new checkout is not work sitting in the
    // source. `-uall` because that is how the move reads status.
    expect(await git(repo, ["status", "--porcelain", "-uall"])).toBe("");
  });

  it("adds the entry once and leaves existing content alone", async () => {
    const repo = await makeRepo();
    writeFileSync(excludePath(repo), "# mine\n*.log\n");

    await createWorktree(repo, { name: "one" });
    const afterFirst = readFileSync(excludePath(repo), "utf-8");
    await createWorktree(repo, { name: "two" });
    const afterSecond = readFileSync(excludePath(repo), "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond).toContain("# mine");
    expect(afterSecond).toContain("*.log");
    expect(afterSecond.match(/\.claude\/worktrees/g)).toHaveLength(1);
  });

  it("appends cleanly to a file with no trailing newline", async () => {
    const repo = await makeRepo();
    writeFileSync(excludePath(repo), "*.log");

    await createWorktree(repo, { name: "nonl" });

    const after = readFileSync(excludePath(repo), "utf-8");
    expect(after).toContain("*.log\n");
    expect(after).toContain("**/.claude/worktrees/\n");
    expect(await ignoresWorktrees(repo)).toBe(true);
  });

  it("writes nothing when the repo already ignores the directory", async () => {
    // The user's own rule already covers it, so ours would be noise in a
    // file we do not own.
    const repo = await makeRepo();
    writeFileSync(join(repo, ".gitignore"), ".claude/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore .claude"]);
    const before = readFileSync(excludePath(repo), "utf-8");

    await createWorktree(repo, { name: "covered" });

    expect(readFileSync(excludePath(repo), "utf-8")).toBe(before);
  });
});

describe("withRepoLock", () => {
  it("runs one repo's work in order", async () => {
    const order: string[] = [];
    const task = (label: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(label);
    };

    await Promise.all([
      withRepoLock("/repo", task("slow", 20)),
      withRepoLock("/repo", task("fast", 1)),
    ]);

    expect(order).toEqual(["slow", "fast"]);
  });

  // A queue that poisons on one failure would turn a single bad request into
  // a repo-wide outage for the daemon's lifetime.
  it("keeps running after a failure", async () => {
    const failing = withRepoLock("/repo2", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    await expect(withRepoLock("/repo2", async () => "fine")).resolves.toBe(
      "fine",
    );
  });

  it("does not serialize unrelated repos", async () => {
    const order: string[] = [];
    await Promise.all([
      withRepoLock("/a", async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("a");
      }),
      withRepoLock("/b", async () => {
        order.push("b");
      }),
    ]);

    expect(order).toEqual(["b", "a"]);
  });
});

describe("slugForPR / slugForIssue", () => {
  it("prefixes with the number and slugifies the label", () => {
    expect(slugForPR(7, "fix/flaky-binder")).toBe("pr-7-fix-flaky-binder");
    expect(slugForIssue(45, "spawn: --pr and --issue flags")).toBe(
      "issue-45-spawn-pr-and-issue-flags",
    );
  });

  // Budgeted INSIDE the cap, like `slugForFork`: `resolveWorktreeName`
  // re-slugifies whatever it is handed, so a name over the cap would be
  // trimmed there and could lose the prefix that makes it unique.
  it("budgets the prefix inside the slug cap", () => {
    const pr = slugForPR(12345, "a".repeat(80));
    expect(pr.length).toBeLessThanOrEqual(40);
    expect(pr.startsWith("pr-12345-")).toBe(true);
    expect(slugify(pr)).toBe(pr);

    const issue = slugForIssue(12345, "b".repeat(80));
    expect(issue.length).toBeLessThanOrEqual(40);
    expect(slugify(issue)).toBe(issue);
  });

  // Claude Code puts its own fetch-only PR checkouts at `pr-<n>`, so bare
  // `pr-<n>` is the one name this must never produce.
  it("never collapses to bare pr-<n>", () => {
    expect(slugForPR(7, "日本語")).toBe("pr-7-head");
    expect(slugForPR(7, "")).toBe("pr-7-head");
  });

  it("falls back to bare issue-<n>, which collides with nothing", () => {
    expect(slugForIssue(45, "!!!")).toBe("issue-45");
  });
});

describe("createWorktree with a branch override", () => {
  // A `--pr` spawn's directory is named after the PR while its branch has to
  // be the PR's own head ref, so `git push` works out of the box.
  it("cuts the given branch at the given base, under the given name", async () => {
    const repo = await makeRepo();
    const base = await git(repo, ["rev-parse", "HEAD"]);

    const created = await createWorktree(repo, {
      name: "pr-7-fix-flaky",
      base,
      branch: "fix/flaky-binder",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.result.name).toBe("pr-7-fix-flaky");
    expect(created.result.branch).toBe("fix/flaky-binder");
    expect(created.result.branchCreated).toBe(true);
    expect(created.result.path).toBe(worktreePathFor(repo, "pr-7-fix-flaky"));
    expect(
      await git(created.result.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ).toBe("fix/flaky-binder");
    expect(await git(created.result.path, ["rev-parse", "HEAD"])).toBe(base);
  });

  it("checks out an existing branch of that name instead of cutting one", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "fix/flaky-binder"]);

    const created = await createWorktree(repo, {
      derivedName: "pr-7-fix-flaky",
      branch: "fix/flaky-binder",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.result.branch).toBe("fix/flaky-binder");
    // Reused, so nothing was cut and no base may be reported.
    expect(created.result.branchCreated).toBe(false);
    expect(created.result.base).toBeUndefined();
  });

  // A derived name normally refuses any candidate a branch is holding,
  // because the create path would reuse that branch. With an override the
  // name is a directory label and nothing else, so that test does not apply.
  it("does not number past a same-named branch when the branch is overridden", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "pr-7-fix-flaky"]);

    const created = await createWorktree(repo, {
      derivedName: "pr-7-fix-flaky",
      branch: "fix/flaky-binder",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.result.name).toBe("pr-7-fix-flaky");
    expect(created.result.branch).toBe("fix/flaky-binder");
  });

  it("defaults the branch to the worktree name when no override is given", async () => {
    const repo = await makeRepo();

    const created = await createWorktree(repo, { name: "plain-name" });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.result.branch).toBe("plain-name");
  });
});
