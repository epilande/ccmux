import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, basename, relative } from "path";
import { deriveProject } from "./project-derivation";

const cleanupDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(
    join(tmpdir(), `ccmux-project-derivation-${prefix}-`),
  );
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("deriveProject", () => {
  it("resolves the main checkout root's own basename", () => {
    const root = tempDir("main");
    mkdirSync(join(root, ".git"));

    expect(deriveProject(root, "fallback", { cache: new Map() })).toBe(
      basename(root),
    );
  });

  it("resolves a subdirectory of a repo to the repo root's basename, not the subdir", () => {
    const root = tempDir("main-sub");
    mkdirSync(join(root, ".git"));
    const subdir = join(root, "src", "nested");
    mkdirSync(subdir, { recursive: true });

    expect(deriveProject(subdir, "fallback", { cache: new Map() })).toBe(
      basename(root),
    );
  });

  it("resolves a worktree via an absolute `gitdir:` path to the main root's basename", () => {
    const main = tempDir("wt-main-abs");
    const worktreesDir = join(main, ".git", "worktrees", "feature-x");
    mkdirSync(worktreesDir, { recursive: true });

    const worktree = tempDir("wt-abs");
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreesDir}\n`);

    const project = deriveProject(worktree, "fallback", { cache: new Map() });
    expect(project).toBe(basename(main));
    expect(project).not.toBe(basename(worktree));
  });

  it("resolves a worktree via a relative `gitdir:` path to the main root's basename", () => {
    const main = tempDir("wt-main-rel");
    const worktreesDir = join(main, ".git", "worktrees", "feature-y");
    mkdirSync(worktreesDir, { recursive: true });

    const worktree = tempDir("wt-rel");
    const relativeGitdir = relative(worktree, worktreesDir);
    writeFileSync(join(worktree, ".git"), `gitdir: ${relativeGitdir}\n`);

    const project = deriveProject(worktree, "fallback", { cache: new Map() });
    expect(project).toBe(basename(main));
    expect(project).not.toBe(basename(worktree));
  });

  it("falls back to the submodule's own cwd basename when the gitdir doesn't match the worktrees shape", () => {
    const parent = tempDir("submodule-parent");
    const submoduleGitdir = join(parent, ".git", "modules", "sub");
    mkdirSync(submoduleGitdir, { recursive: true });

    const submodule = tempDir("submodule");
    writeFileSync(join(submodule, ".git"), `gitdir: ${submoduleGitdir}\n`);

    const project = deriveProject(submodule, "fallback", { cache: new Map() });
    expect(project).toBe(basename(submodule));
  });

  it("falls back to the cwd basename when not inside a git repo", () => {
    const dir = tempDir("non-git");

    expect(deriveProject(dir, "fallback", { cache: new Map() })).toBe(
      basename(dir),
    );
  });

  it("falls back to the provided fallback when the basename is empty (root cwd)", () => {
    expect(deriveProject("/", "root-fallback", { cache: new Map() })).toBe(
      "root-fallback",
    );
  });

  it("stops walking upward at homeDir and does not find a .git above it", () => {
    const outer = tempDir("home-boundary-outer");
    mkdirSync(join(outer, ".git"));

    const fakeHome = join(outer, "home");
    const cwd = join(fakeHome, "work", "project-dir");
    mkdirSync(cwd, { recursive: true });

    // Bounded by homeDir: must not see outer's .git, so it falls back to
    // the cwd's own basename.
    const bounded = deriveProject(cwd, "fallback", {
      cache: new Map(),
      homeDir: fakeHome,
    });
    expect(bounded).toBe(basename(cwd));
    expect(bounded).not.toBe(basename(outer));

    // Same fixture, unbounded (homeDir doesn't match anything on the walk):
    // the walk continues past where fakeHome would have stopped it and
    // finds outer's .git, proving the boundary in the first assertion was
    // actually doing something.
    const unbounded = deriveProject(cwd, "fallback", {
      cache: new Map(),
      homeDir: "/nonexistent-home-for-test",
    });
    expect(unbounded).toBe(basename(outer));
  });

  it("caches by cwd: a second call reuses the cached value without re-walking the filesystem", () => {
    const main = tempDir("cache-main");
    const worktreesDir = join(main, ".git", "worktrees", "wt");
    mkdirSync(worktreesDir, { recursive: true });

    const worktree = tempDir("cache-wt");
    const gitFile = join(worktree, ".git");
    writeFileSync(gitFile, `gitdir: ${worktreesDir}\n`);

    const cache = new Map<string, string>();
    const first = deriveProject(worktree, "fallback", { cache });
    expect(first).toBe(basename(main));
    expect(cache.get(worktree)).toBe(basename(main));

    // Remove the .git file so a fresh (uncached) walk would find nothing
    // and fall back to the worktree's own basename instead.
    unlinkSync(gitFile);

    const second = deriveProject(worktree, "fallback", { cache });
    expect(second).toBe(basename(main));
    expect(second).not.toBe(basename(worktree));
  });

  it("uses a separate result per cwd within the same cache", () => {
    const a = tempDir("cache-a");
    mkdirSync(join(a, ".git"));
    const b = tempDir("cache-b");
    mkdirSync(join(b, ".git"));

    const cache = new Map<string, string>();
    expect(deriveProject(a, "fallback", { cache })).toBe(basename(a));
    expect(deriveProject(b, "fallback", { cache })).toBe(basename(b));
    expect(cache.size).toBe(2);
  });
});
