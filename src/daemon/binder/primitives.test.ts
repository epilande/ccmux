import { describe, it, expect } from "bun:test";
import { resolveExistingLogPath } from "./primitives";

describe("resolveExistingLogPath", () => {
  const cwd = "/Users/bob/proj";
  const sid = "11111111-2222-3333-4444-555555555555";
  const primary = "/Users/bob/.claude/projects";
  const personal = "/Users/bob/.claude-personal/projects";
  const rel = `-Users-bob-proj/${sid}.jsonl`;

  it("returns the first dir whose transcript exists", () => {
    const exists = (p: string) => p === `${personal}/${rel}`;
    expect(resolveExistingLogPath([primary, personal], cwd, sid, exists)).toBe(
      `${personal}/${rel}`,
    );
  });

  it("prefers the earlier dir when multiple exist", () => {
    const exists = () => true;
    expect(resolveExistingLogPath([primary, personal], cwd, sid, exists)).toBe(
      `${primary}/${rel}`,
    );
  });

  it("falls back to the primary dir's path when none exists", () => {
    const exists = () => false;
    expect(resolveExistingLogPath([primary, personal], cwd, sid, exists)).toBe(
      `${primary}/${rel}`,
    );
  });

  it("encodes the cwd the same way Claude names project dirs", () => {
    const exists = () => false;
    const path = resolveExistingLogPath(
      ["/root/projects"],
      "/Users/bob/.dotfiles",
      sid,
      exists,
    );
    expect(path).toBe(`/root/projects/-Users-bob--dotfiles/${sid}.jsonl`);
  });
});
