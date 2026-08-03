/**
 * Route tests for `GET /sessions/:ref/transcript`.
 *
 * A file of its own rather than an addition to `server.test.ts`: the route is
 * new surface with its own fixtures, and the big file is already contended.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DaemonServer } from "./server";
import { SessionManager } from "./sessions";
import { AttentionTracker } from "./attention-tracker";
import { InvocationManager } from "./invocation-manager";
import { InvocationRegistry } from "./invokers/registry";
import { stubInvoker } from "./invokers/test-helpers";
import { BUILTIN_AGENTS } from "../lib/agents";
import type { TmuxPane } from "../types/session";
import * as paneIo from "./pane-io";

type Internals = {
  handleSessionTranscript(
    ref: string,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response>;
};

function createServer(paneCache: Map<string, TmuxPane> = new Map()) {
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
    () => paneCache,
    (agentType: string) => BUILTIN_AGENTS.find((a) => a.name === agentType),
    new AttentionTracker(5_000),
    invocationManager,
    () => null,
    {
      sendLiteralToPane: mock(async () => true),
      sendPromptToPane: mock(async () => true),
    },
  );
  return {
    manager,
    internals: server as unknown as Internals,
  };
}

function pane(
  paneId: string,
  sessionName: string,
  windowIndex: number,
  paneIndex = 0,
): TmuxPane {
  return {
    paneId,
    panePid: 1,
    sessionName,
    windowIndex,
    paneIndex,
    target: `${sessionName}:${windowIndex}.${paneIndex}`,
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: null,
    currentCommand: null,
    currentPath: null,
  };
}

function request(
  ref: string,
  query = "",
): [string, URL, Record<string, string>] {
  return [ref, new URL(`http://localhost/sessions/x/transcript${query}`), {}];
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-transcript-route-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

function claudeTranscript(name: string, turnCount: number): string {
  const path = join(dir, name);
  const lines: string[] = [];
  for (let i = 1; i <= turnCount; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        timestamp: `2024-01-15T12:0${i}:00Z`,
        message: { content: `prompt ${i}` },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: `2024-01-15T12:0${i}:30Z`,
        message: { content: [{ type: "text", text: `answer ${i}` }] },
      }),
    );
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

describe("GET /sessions/:ref/transcript", () => {
  it("returns the last turn from the transcript", async () => {
    const { manager, internals } = createServer();
    const path = claudeTranscript("s1.jsonl", 3);
    manager.createSession("s1", path);

    const response = await internals.handleSessionTranscript(...request("s1"));
    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toMatchObject({
      sessionId: "s1",
      agentType: "claude",
      source: "transcript",
      truncated: false,
      turns: [
        {
          role: "assistant",
          text: "answer 3",
          timestamp: "2024-01-15T12:03:30Z",
        },
      ],
    });
  });

  it("widens with ?turns and clamps above the maximum", async () => {
    const { manager, internals } = createServer();
    manager.createSession("s1", claudeTranscript("s1.jsonl", 4));

    const two = await internals.handleSessionTranscript(
      ...request("s1", "?turns=2"),
    );
    const twoData = (await two.json()) as { turns: { text: string }[] };
    expect(twoData.turns.map((t) => t.text)).toEqual([
      "answer 3",
      "prompt 4",
      "answer 4",
    ]);

    const clamped = await internals.handleSessionTranscript(
      ...request("s1", "?turns=999"),
    );
    const clampedData = (await clamped.json()) as { turns: unknown[] };
    // Only 4 turns exist, so the clamp is invisible here beyond "no error".
    expect(clamped.status).toBe(200);
    expect(clampedData.turns.length).toBe(7);
  });

  it("falls back to a pane capture when the agent has no reader", async () => {
    const capture = spyOn(paneIo, "capturePane").mockResolvedValue(
      "gemini pane\n[31mred[0m output\n",
    );
    const { manager, internals } = createServer();
    manager.createSession("g1", join(dir, "gemini.log"), "gemini");
    manager.setTmuxPane("g1", "%1");

    const response = await internals.handleSessionTranscript(...request("g1"));
    const data = (await response.json()) as {
      source: string;
      turns: { role: string; text: string }[];
    };
    expect(capture).toHaveBeenCalled();
    expect(data.source).toBe("pane");
    expect(data.turns).toHaveLength(1);
    expect(data.turns[0].role).toBe("assistant");
    // Control bytes are stripped; the visible text survives.
    expect(data.turns[0].text).toBe("gemini pane\n[31mred[0m output");
    capture.mockRestore();
  });

  it("returns 400 when there is neither a transcript nor a usable pane", async () => {
    const empty = spyOn(paneIo, "capturePane").mockResolvedValue("");
    const { manager, internals } = createServer();
    manager.createSession("g1", join(dir, "gemini.log"), "gemini");
    manager.setTmuxPane("g1", "%1");

    const withPane = await internals.handleSessionTranscript(...request("g1"));
    expect(withPane.status).toBe(400);
    empty.mockRestore();

    manager.createSession("g2", join(dir, "gemini.log"), "gemini");
    const paneless = await internals.handleSessionTranscript(...request("g2"));
    expect(paneless.status).toBe(400);
  });

  it("returns 404 for an unknown ref", async () => {
    const { internals } = createServer();
    const response = await internals.handleSessionTranscript(
      ...request("nope"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("resolves a fuzzy ref against the caller's window and reports how", async () => {
    const panes = new Map([
      ["%1", pane("%1", "work", 1, 0)],
      ["%2", pane("%2", "work", 1, 1)],
      ["%3", pane("%3", "other", 0, 0)],
    ]);
    const { manager, internals } = createServer(panes);
    manager.createSession("near", claudeTranscript("near.jsonl", 1));
    manager.setTmuxPane("near", "%2");
    manager.createSession("far", claudeTranscript("far.jsonl", 1));
    manager.setTmuxPane("far", "%3");

    const response = await internals.handleSessionTranscript(
      ...request("claude", "?callerPane=%1"),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      sessionId: string;
      resolution: {
        ref: string;
        exact: boolean;
        proximity: string;
        tier: string;
      };
    };
    expect(data.sessionId).toBe("near");
    expect(data.resolution).toEqual({
      ref: "claude",
      tier: "agent-type",
      exact: false,
      proximity: "same-window",
    });
  });

  it("refuses an ambiguous ref with the candidate list", async () => {
    const panes = new Map([
      ["%1", pane("%1", "work", 1, 0)],
      ["%2", pane("%2", "work", 1, 1)],
    ]);
    const { manager, internals } = createServer(panes);
    manager.createSession("a", claudeTranscript("a.jsonl", 1));
    manager.setTmuxPane("a", "%1");
    manager.createSession("b", claudeTranscript("b.jsonl", 1));
    manager.setTmuxPane("b", "%2");

    const response = await internals.handleSessionTranscript(
      ...request("claude"),
    );
    expect(response.status).toBe(409);
    const data = (await response.json()) as {
      error: string;
      candidates: { sessionId: string; coordinate: string }[];
    };
    expect(data.error).toBe('Ambiguous session reference "claude"');
    expect(data.candidates.map((c) => c.sessionId).sort()).toEqual(["a", "b"]);
    expect(data.candidates.map((c) => c.coordinate).sort()).toEqual([
      "work:1.0",
      "work:1.1",
    ]);
  });

  it("marks an exact ref as exact so the CLI stays quiet", async () => {
    const { manager, internals } = createServer();
    manager.createSession("s1", claudeTranscript("s1.jsonl", 1));

    const response = await internals.handleSessionTranscript(...request("s1"));
    const data = (await response.json()) as {
      resolution: { exact: boolean; tier: string };
    };
    expect(data.resolution).toMatchObject({ exact: true, tier: "id" });
  });
});
