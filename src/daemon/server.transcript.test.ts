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
import { MAX_TURNS } from "./transcript-read";

type Internals = {
  handleSessionTranscript(
    ref: string,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response>;
  /** The route tests go through the dispatcher, since what they exercise is
   *  the ref DECODE that only exists there. */
  handleRequest(req: Request): Promise<Response>;
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
    // Zero-padded so a fixture past nine turns still writes a real minute.
    const minute = String(i).padStart(2, "0");
    lines.push(
      JSON.stringify({
        type: "user",
        timestamp: `2024-01-15T12:${minute}:00Z`,
        message: { content: `prompt ${i}` },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: `2024-01-15T12:${minute}:30Z`,
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

  it("clamps a huge ?turns to MAX_TURNS rather than reading the whole file", async () => {
    const { manager, internals } = createServer();
    // Deeper than the limit, which is what makes the clamp observable: the
    // 4-turn fixture above stays green with the clamp removed entirely.
    const total = MAX_TURNS + 5;
    manager.createSession("s1", claudeTranscript("s1.jsonl", total));

    const response = await internals.handleSessionTranscript(
      ...request("s1", "?turns=999"),
    );
    const data = (await response.json()) as { turns: { text: string }[] };
    // N assistant entries and the N-1 prompts between them, never a leading one.
    expect(data.turns.length).toBe(2 * MAX_TURNS - 1);
    expect(data.turns[0].text).toBe(`answer ${total - MAX_TURNS + 1}`);
    expect(data.turns[data.turns.length - 1].text).toBe(`answer ${total}`);
  });

  // The clamp is for a count this endpoint cannot fully serve. A value that
  // is not a count was never a request for N turns, and `?turns=true` reading
  // as 1 hid the caller's mistake behind a plausible answer.
  it("refuses a ?turns that is not a count, where a too-large one clamps", async () => {
    const { manager, internals } = createServer();
    manager.createSession("s1", claudeTranscript("s1.jsonl", 4));

    for (const raw of ["true", "2.5", "3abc", "-1", ""]) {
      const response = await internals.handleSessionTranscript(
        ...request("s1", `?turns=${raw}`),
      );
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("Invalid 'turns' value"),
      });
    }

    // Still clamped, not refused: an integer below the floor is a count.
    const zero = await internals.handleSessionTranscript(
      ...request("s1", "?turns=0"),
    );
    expect(zero.status).toBe(200);
    expect(((await zero.json()) as { turns: unknown[] }).turns.length).toBe(1);
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
      truncated: boolean;
      turns: { role: string; text: string }[];
    };
    expect(capture).toHaveBeenCalled();
    expect(data.source).toBe("pane");
    // A capture is the visible tail of a pane, never a whole response, so
    // this branch reports truncation unconditionally.
    expect(data.truncated).toBe(true);
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

  it("strips control characters from transcript text, keeping tabs and newlines", async () => {
    const { manager, internals } = createServer();
    const path = join(dir, "esc.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "user",
          timestamp: "2024-01-15T12:01:00Z",
          message: { content: "show me the code" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2024-01-15T12:01:30Z",
          message: {
            content: [
              {
                type: "text",
                // An ESC sequence and a bare C0 byte, either of which the
                // CLI's terminal would ACT on rather than print.
                text: "before\x1b]0;pwned\x07after\x00\nif (x) {\n\tgo();\n}",
              },
            ],
          },
        }),
      ].join("\n") + "\n",
    );
    manager.createSession("esc", path);

    const response = await internals.handleSessionTranscript(...request("esc"));
    const data = (await response.json()) as { turns: { text: string }[] };
    expect(data.turns[0].text).toBe(
      "before]0;pwnedafter\nif (x) {\n\tgo();\n}",
    );
  });
});

describe("the transcript route's ref decode", () => {
  it("answers a malformed percent-escape with the normal JSON 404", async () => {
    const { internals } = createServer();

    const response = await internals.handleRequest(
      new Request("http://localhost/sessions/%zz/transcript"),
    );
    // Not a 500: an unguarded decodeURIComponent throws URIError past the
    // dispatcher, and Bun answers that with an HTML page naming source paths.
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("decodes a percent-encoded pane ref on the way to the handler", async () => {
    const panes = new Map([["%7", pane("%7", "work", 0, 0)]]);
    const { manager, internals } = createServer(panes);
    manager.createSession("p7", claudeTranscript("p7.jsonl", 1));
    manager.setTmuxPane("p7", "%7");

    // `%7` is spelled `%257` on the wire, which only resolves once decoded.
    const response = await internals.handleRequest(
      new Request("http://localhost/sessions/%257/transcript"),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      sessionId: string;
      resolution: { tier: string };
    };
    expect(data.sessionId).toBe("p7");
    expect(data.resolution.tier).toBe("pane");
  });
});
