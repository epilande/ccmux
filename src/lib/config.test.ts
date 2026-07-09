import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import { PROJECTS_DIR, resolveClaudeProjectDirs } from "./config";

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
