import { describe, expect, it } from "bun:test";
import { readRepoSourceCounts } from "./repo-source-counts";
import type { GhRun } from "./gh-spawn-source";

const answer =
  (stdout: string, exitCode = 0): GhRun =>
  async () => ({ stdout, stderr: "", exitCode });
describe("repository source counts", () => {
  it("counts beyond the source list cap and keeps successful zeroes", async () => {
    expect(
      await readRepoSourceCounts(
        "/repo",
        answer(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: { totalCount: 123 },
                issues: { totalCount: 0 },
              },
            },
          }),
        ),
      ),
    ).toEqual({ ok: true, value: { prs: 123, issues: 0 } });
  });
  it("uses the caller's repository and GraphQL count fields", async () => {
    const calls: unknown[] = [];
    await readRepoSourceCounts("/repo", async (cwd, args) => {
      calls.push(cwd, args);
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });
    expect(calls[0]).toBe("/repo");
    expect(calls[1]).toContain("owner={owner}");
    expect(calls[1]).toContain("name={repo}");
  });
  for (const body of [
    "bad json",
    "{}",
    '{"data":{"repository":null}}',
    '{"data":{"repository":{"pullRequests":{"totalCount":-1},"issues":{"totalCount":1}}}}',
  ]) {
    it(`treats invalid counts as unavailable: ${body}`, async () => {
      expect((await readRepoSourceCounts("/repo", answer(body))).ok).toBe(
        false,
      );
    });
  }
  it("does not turn a failed lookup into zero", async () => {
    expect((await readRepoSourceCounts("/repo", answer("", 1))).ok).toBe(false);
  });
});
