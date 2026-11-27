/**
 * Route tests for the preview detail reads: `GET /worktrees/detail`,
 * `GET /prs/detail` and `GET /issues/detail`.
 *
 * The repo is a real one in a temp dir, because what the worktree route
 * guards is git's own list of registered worktrees; `gh` is a stub through
 * the server's `detailGh` seam.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DaemonServer } from "./server";
import { SessionManager } from "./sessions";
import { AttentionTracker } from "./attention-tracker";
import { InvocationManager } from "./invocation-manager";
import { InvocationRegistry } from "./invokers/registry";
import { stubInvoker } from "./invokers/test-helpers";
import { BUILTIN_AGENTS } from "../lib/agents";
import type { GhRun } from "./gh-spawn-source";

type Internals = {
  handleRequest(req: Request): Promise<Response>;
  detailGh: GhRun;
};

function createServer(): Internals {
  const manager = new SessionManager();
  const invocationManager = new InvocationManager(
    manager,
    new InvocationRegistry(
      stubInvoker("claude-interactive"),
      stubInvoker("subprocess"),
    ),
  );
  const server = new DaemonServer(
    manager,
    () => new Map(),
    (agentType: string) => BUILTIN_AGENTS.find((a) => a.name === agentType),
    new AttentionTracker(5_000),
    invocationManager,
    () => null,
    {
      sendLiteralToPane: mock(async () => true),
      sendPromptToPane: mock(async () => true),
    },
  );
  return server as unknown as Internals;
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

let dir: string;
let repo: string;
let worktree: string;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-detail-route-")));
  repo = join(dir, "repo");
  worktree = join(dir, "feature");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "first commit");
  git(repo, "worktree", "add", "-q", "-b", "feature", worktree);
  writeFileSync(join(worktree, "a.txt"), "changed\n");
  writeFileSync(join(worktree, "new file.txt"), "new\n");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const get = (server: Internals, path: string) =>
  server.handleRequest(new Request(`http://localhost${path}`));

describe("GET /worktrees/detail", () => {
  it("reads a registered worktree's changes and commits", async () => {
    const response = await get(
      createServer(),
      `/worktrees/detail?path=${encodeURIComponent(worktree)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      detail: {
        changes: { code: string; path: string }[];
        commits: { subject: string }[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.detail.changes).toEqual([
      { code: " M", path: "a.txt" },
      { code: "??", path: "new file.txt" },
    ]);
    expect(body.detail.commits.map((c) => c.subject)).toEqual(["first commit"]);
  });

  it("refuses a directory that is not one of its repo's worktrees", async () => {
    const inside = join(worktree, "sub");
    mkdirSync(inside, { recursive: true });
    for (const path of [inside, dir, "/definitely/not/here"]) {
      const response = await get(
        createServer(),
        `/worktrees/detail?path=${encodeURIComponent(path)}`,
      );
      expect([path, response.status]).toEqual([path, 400]);
    }
  });

  it("refuses a relative or missing path", async () => {
    expect((await get(createServer(), "/worktrees/detail")).status).toBe(400);
    expect(
      (await get(createServer(), "/worktrees/detail?path=feature")).status,
    ).toBe(400);
  });
});

describe("GET /prs/detail and /issues/detail", () => {
  /** A gh stub that counts calls and answers each `view` with `body`. */
  function stubGh(
    server: Internals,
    answer: { exitCode?: number; stdout?: string },
  ) {
    const calls: string[][] = [];
    server.detailGh = async (_cwd, args) => {
      calls.push(args);
      await new Promise((r) => setTimeout(r, 5));
      return {
        exitCode: answer.exitCode ?? 0,
        stdout: answer.stdout ?? "",
        stderr: answer.exitCode ? "boom" : "",
      };
    };
    return calls;
  }

  it("answers ok with the detail, keyed to the repo's main checkout", async () => {
    const server = createServer();
    const calls = stubGh(server, {
      stdout: JSON.stringify({ body: "hello", statusCheckRollup: [] }),
    });
    // Asked once through the main checkout and once through a worktree:
    // one repo, one cache entry, one gh call.
    const first = await get(
      server,
      `/prs/detail?repo=${encodeURIComponent(repo)}&number=5`,
    );
    const second = await get(
      server,
      `/prs/detail?repo=${encodeURIComponent(worktree)}&number=5`,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      detail: { number: 5, body: "hello", checks: [] },
    });
    expect(await second.json()).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("joins concurrent asks for the same item", async () => {
    const server = createServer();
    const calls = stubGh(server, { stdout: JSON.stringify({ body: "x" }) });
    const url = `/issues/detail?repo=${encodeURIComponent(repo)}&number=3`;
    await Promise.all([get(server, url), get(server, url), get(server, url)]);
    expect(calls).toEqual([["issue", "view", "3", "--json", "body"]]);
  });

  it("re-reads on refresh=1", async () => {
    const server = createServer();
    const calls = stubGh(server, { stdout: JSON.stringify({ body: "x" }) });
    const url = `/prs/detail?repo=${encodeURIComponent(repo)}&number=8`;
    await get(server, url);
    await get(server, `${url}&refresh=1`);
    expect(calls).toHaveLength(2);
  });

  it("reports a gh failure inside a 200", async () => {
    const server = createServer();
    stubGh(server, { exitCode: 1 });
    const response = await get(
      server,
      `/prs/detail?repo=${encodeURIComponent(repo)}&number=2`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      error: "gh pr view exited 1: boom",
    });
  });

  it("refuses a bad number or a missing repo", async () => {
    const server = createServer();
    const calls = stubGh(server, { stdout: "{}" });
    const r = encodeURIComponent(repo);
    for (const query of [
      `repo=${r}&number=0`,
      `repo=${r}&number=-1`,
      `repo=${r}&number=1.5`,
      `repo=${r}&number=abc`,
      `repo=${r}`,
      `number=4`,
      `repo=${encodeURIComponent(dir)}&number=4`,
    ]) {
      const response = await get(server, `/prs/detail?${query}`);
      expect([query, response.status]).toEqual([query, 400]);
    }
    expect(calls).toEqual([]);
  });
});
