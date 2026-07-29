import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorktreeFileSetup,
  createWorktree,
  readSymlinkDirectories,
  readWorktreeIncludes,
  resolveBase,
  resolveWorktreeName,
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

async function makeRepo(name = "repo"): Promise<string> {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  await git(root, ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await git(repo, ["config", "user.name", "Test"]);
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
    expect(out).toEqual({ ok: true, name: "fix-sidebar" });
  });

  it("falls back to the prompt", () => {
    const out = resolveWorktreeName(undefined, "fix sidebar flicker on resize");
    expect(out).toEqual({ ok: true, name: "fix-sidebar-flicker" });
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
  it("reads symlinkDirectories, tolerating absent and malformed settings", () => {
    const repo = join(root, "cfg");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    expect(readSymlinkDirectories(repo)).toEqual([]);

    writeFileSync(join(repo, ".claude", "settings.json"), "{not json");
    expect(readSymlinkDirectories(repo)).toEqual([]);

    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ worktree: { symlinkDirectories: ["node_modules", 7] } }),
    );
    expect(readSymlinkDirectories(repo)).toEqual(["node_modules"]);
  });

  it("reads .worktreeinclude, ignoring blanks and comments", () => {
    const repo = join(root, "inc");
    mkdirSync(repo, { recursive: true });
    expect(readWorktreeIncludes(repo)).toEqual([]);

    writeFileSync(
      join(repo, ".worktreeinclude"),
      "# a comment\n\n.claude/settings.local.json\n  .env  \n",
    );
    expect(readWorktreeIncludes(repo)).toEqual([
      ".claude/settings.local.json",
      ".env",
    ]);
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
    writeFileSync(join(root, "escape-file"), "no\n");
    mkdirSync(join(root, "escape"), { recursive: true });
    const wt = join(root, "target3");
    mkdirSync(wt, { recursive: true });

    const out = await applyWorktreeFileSetup(repo, wt);

    expect(out.symlinked).toEqual([]);
    expect(out.included).toEqual([]);
    expect(existsSync(join(root, "escape", "..", "escape"))).toBe(true);
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
    if (first.ok) expect(second.result.path).toBe(first.result.path);
  });

  it("reuses an existing branch of the same name", async () => {
    const repo = await makeRepo();
    await git(repo, ["branch", "already-there"]);

    const out = await createWorktree(repo, { name: "already-there" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(
      await git(out.result.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ).toBe("already-there");
  });

  it("clears a leftover directory that has no .git", async () => {
    const repo = await makeRepo();
    const target = worktreePathFor(repo, "debris");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "leftover.txt"), "from an interrupted run\n");

    const out = await createWorktree(repo, { name: "debris" });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(existsSync(join(target, "leftover.txt"))).toBe(false);
    expect(existsSync(join(target, ".git"))).toBe(true);
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
