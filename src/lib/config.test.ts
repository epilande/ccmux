import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  PROJECTS_DIR,
  resolveClaudeProjectDirs,
  resolvedHomeDir,
} from "./config";

describe("resolveClaudeProjectDirs", () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  it("defaults to the primary projects dir when nothing is configured", () => {
    expect(resolveClaudeProjectDirs()).toEqual([PROJECTS_DIR]);
    expect(resolveClaudeProjectDirs([])).toEqual([PROJECTS_DIR]);
  });

  it("appends `projects` to each configured config dir, primary first", () => {
    expect(resolveClaudeProjectDirs(["/home/bob/.claude-personal"])).toEqual([
      PROJECTS_DIR,
      "/home/bob/.claude-personal/projects",
    ]);
  });

  it("expands a leading ~ to the home directory", () => {
    expect(resolveClaudeProjectDirs(["~/.claude-work"])).toEqual([
      PROJECTS_DIR,
      join(homedir(), ".claude-work", "projects"),
    ]);
  });

  it("includes CLAUDE_CONFIG_DIR before preference-configured dirs", () => {
    process.env.CLAUDE_CONFIG_DIR = "/env/.claude-alt";
    expect(resolveClaudeProjectDirs(["/pref/.claude-extra"])).toEqual([
      PROJECTS_DIR,
      "/env/.claude-alt/projects",
      "/pref/.claude-extra/projects",
    ]);
  });

  it("de-duplicates while preserving order (default tree is never doubled)", () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
    expect(
      resolveClaudeProjectDirs([
        "~/.claude-personal",
        "/home/bob/.claude-personal",
        "~/.claude-personal",
      ]),
    ).toEqual([
      PROJECTS_DIR,
      join(homedir(), ".claude-personal", "projects"),
      "/home/bob/.claude-personal/projects",
    ]);
  });

  it("ignores empty entries", () => {
    expect(resolveClaudeProjectDirs(["", "/a/.claude"])).toEqual([
      PROJECTS_DIR,
      "/a/.claude/projects",
    ]);
  });
});

describe("resolvedHomeDir", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-home-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a symlinked home to the directory git would report", () => {
    const real = join(root, "real-home");
    const link = join(root, "linked-home");
    mkdirSync(real);
    symlinkSync(real, link);

    expect(resolvedHomeDir(link)).toBe(real);
  });

  it("keeps an unresolvable home rather than throwing", () => {
    const missing = join(root, "not-there");
    expect(resolvedHomeDir(missing)).toBe(missing);
  });

  it("defaults to the process's own home", () => {
    expect(resolvedHomeDir()).toBe(realpathSync(homedir()));
  });
});
