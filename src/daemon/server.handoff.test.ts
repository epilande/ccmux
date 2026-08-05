/**
 * Route tests for `POST /handoff`: the guard stack's refusal reasons in
 * order, the delivery policy per target status, the queue's deliver-on-idle
 * (with the guards re-run), and the `pendingHandoff` surfacing.
 *
 * A file of its own for the same reason `server.transcript.test.ts` is: new
 * surface with its own fixtures, and `server.test.ts` is already contended.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  type Mock,
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
import { HANDOFF_PREFIX, MAX_HANDOFF_NOTE_CHARS } from "./handoff";
import { renderTurns } from "./transcript-read";
import { MAX_SEND_PASTE_CHARS } from "../lib/config";
import type { EnrichedSession, TmuxPane } from "../types/session";

type Internals = {
  handleHandoff(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response>;
  enrichSession(session: unknown): Promise<EnrichedSession>;
};

/** A literal ESC byte, spelled without an escape sequence so it survives any
 *  editor/tool round-trip intact. Inside a bracketed paste this is what can
 *  emit `ESC[201~` early and leak the remainder into the pane as keystrokes. */
const ESC = String.fromCharCode(0x1b);

function pane(paneId: string, sessionName = "work", windowIndex = 0): TmuxPane {
  return {
    paneId,
    panePid: 1,
    sessionName,
    windowIndex,
    paneIndex: Number(paneId.slice(1)),
    target: `${sessionName}:${windowIndex}.${paneId.slice(1)}`,
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: null,
    currentCommand: null,
    currentPath: null,
  };
}

function createServer(paneCache: Map<string, TmuxPane> = new Map()) {
  const manager = new SessionManager();
  const invocationManager = new InvocationManager(
    manager,
    new InvocationRegistry(
      stubInvoker("claude-interactive"),
      stubInvoker("subprocess"),
    ),
  );
  const sendPromptToPane = mock(async () => true);
  // Every pane is at a live agent unless a test says otherwise.
  const getPaneCommand = mock(async () => "claude");
  const server = new DaemonServer(
    manager,
    () => paneCache,
    (agentType: string) => BUILTIN_AGENTS.find((a) => a.name === agentType),
    new AttentionTracker(5_000),
    invocationManager,
    () => null,
    {
      sendLiteralToPane: mock(async () => true),
      sendPromptToPane,
      getPaneCommand,
    },
  );
  return {
    manager,
    sendPromptToPane,
    getPaneCommand,
    internals: server as unknown as Internals,
  };
}

function post(
  internals: Internals,
  body: Record<string, unknown>,
): Promise<Response> {
  return internals.handleHandoff(
    new Request("http://localhost/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    {},
  );
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-handoff-route-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

/** A Claude transcript whose last assistant text is `answer`. */
function transcript(name: string, answer = "the conclusion"): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "user",
        timestamp: "2024-01-15T12:01:00Z",
        message: { content: "prompt" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-01-15T12:01:30Z",
        message: { content: [{ type: "text", text: answer }] },
      }),
    ].join("\n") + "\n",
  );
  return path;
}

/** A Claude transcript of several complete turns, oldest first: `exchanges`
 *  is read as `[prompt, answer]` pairs. */
function multiTurnTranscript(
  name: string,
  exchanges: [string, string][],
): string {
  const path = join(dir, name);
  const lines: string[] = [];
  exchanges.forEach(([prompt, answer], index) => {
    lines.push(
      JSON.stringify({
        type: "user",
        timestamp: `2024-01-15T12:0${index}:00Z`,
        message: { content: prompt },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: `2024-01-15T12:0${index}:30Z`,
        message: { content: [{ type: "text", text: answer }] },
      }),
    );
  });
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/** A codex rollout whose last turn's text is `answer`. Used where the source
 *  must NOT be a claude session (so a fuzzy `claude` ref can't match it). */
function codexTranscript(name: string, answer = "the conclusion"): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-15T12:01:00Z",
        payload: { type: "user_message", message: "prompt" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2024-01-15T12:01:30Z",
        payload: { type: "task_complete", last_agent_message: answer },
      }),
    ].join("\n") + "\n",
  );
  return path;
}

/** Source + target, both claude, both paned, target idle. */
function pair(
  manager: SessionManager,
  answer = "the conclusion",
): { srcPane: string; dstPane: string } {
  manager.createSession("src", transcript("src.jsonl", answer));
  manager.setTmuxPane("src", "%1");
  manager.createSession("dst", transcript("dst.jsonl"));
  manager.setTmuxPane("dst", "%2");
  return { srcPane: "%1", dstPane: "%2" };
}

describe("POST /handoff — composition", () => {
  it("delivers the frozen header plus the payload through the paste path", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "ship it");

    const response = await post(internals, {
      from: "src",
      to: "dst",
      note: "over to you",
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toMatchObject({ status: "delivered", truncated: false });

    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    const [target, text, enter] = sendPromptToPane.mock.calls[0] as unknown as [
      string,
      string,
      boolean,
    ];
    // The stable `%N`, never the coordinate.
    expect(target).toBe("%2");
    expect(enter).toBe(true);
    const lines = text.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(
        `^\\${HANDOFF_PREFIX.slice(0, 1)}ccmux handoff\\] from: src \\(claude · .+\\) at \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`,
      ),
    );
    expect(lines[1]).toBe("note: over to you");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("ship it");
  });

  it("keeps a one-turn payload bare, with no role labels", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "ship it");

    await post(internals, { from: "src", to: "dst", turns: 1 });
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    // One turn IS the last response, which is what every caller that omits
    // `turns` has always received.
    expect(text).not.toContain("assistant:");
    expect(text.split("\n\n").slice(1).join("\n\n")).toBe("ship it");
  });

  it("renders several turns exactly as `ccmux last --turns N` prints them", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    manager.createSession(
      "src",
      multiTurnTranscript("src.jsonl", [
        ["first prompt", "first answer"],
        ["second prompt", "second answer"],
      ]),
    );
    manager.setTmuxPane("src", "%1");
    manager.createSession("dst", transcript("dst.jsonl"));
    manager.setTmuxPane("dst", "%2");

    await post(internals, { from: "src", to: "dst", turns: 2 });
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    const payload = text.split("\n\n").slice(1).join("\n\n");
    // Byte-identical to the shared renderer, so a receiver told to pull more
    // with `ccmux last <id> --turns N` sees the same shape it was handed.
    // The leading prompt is dropped by the fold: `turns=2` is
    // `[assistant, user, assistant]`, oldest first.
    expect(payload).toBe(
      renderTurns([
        { role: "assistant", text: "first answer" },
        { role: "user", text: "second prompt" },
        { role: "assistant", text: "second answer" },
      ]),
    );
  });

  it("caps a multi-turn payload the same way, keeping the tail", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    manager.createSession(
      "src",
      multiTurnTranscript("src.jsonl", [
        ["p1", "HEAD" + "x".repeat(MAX_SEND_PASTE_CHARS)],
        ["p2", "the conclusion TAIL"],
      ]),
    );
    manager.setTmuxPane("src", "%1");
    manager.createSession("dst", transcript("dst.jsonl"));
    manager.setTmuxPane("dst", "%2");

    const response = await post(internals, {
      from: "src",
      to: "dst",
      turns: 2,
    });
    const data = (await response.json()) as {
      truncated: boolean;
      chars: number;
    };
    expect(data.truncated).toBe(true);
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text.length).toBeLessThanOrEqual(MAX_SEND_PASTE_CHARS);
    expect(data.chars).toBe(text.length);
    // One cap over the WHOLE composed text: the header survives at the front
    // (it is what makes the paste identifiable) and the newest turn at the end.
    expect(text.startsWith(HANDOFF_PREFIX)).toBe(true);
    expect(text.endsWith("the conclusion TAIL")).toBe(true);
  });

  it("truncates past the paste cap and says so", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "HEAD" + "x".repeat(MAX_SEND_PASTE_CHARS) + "TAIL");

    const response = await post(internals, { from: "src", to: "dst" });
    const data = (await response.json()) as {
      truncated: boolean;
      chars: number;
    };
    expect(data.truncated).toBe(true);
    expect(data.chars).toBeLessThanOrEqual(MAX_SEND_PASTE_CHARS);
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text.length).toBeLessThanOrEqual(MAX_SEND_PASTE_CHARS);
    // Tail-preserving: a response's conclusion is at its end.
    expect(text.endsWith("TAIL")).toBe(true);
  });

  it("refuses a source with no readable transcript rather than scraping its pane", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    // gemini has no reader in this wave, so the transcript read returns null.
    manager.createSession("src", join(dir, "gemini.log"), "gemini");
    manager.setTmuxPane("src", "%1");
    manager.createSession("dst", transcript("dst.jsonl"));
    manager.setTmuxPane("dst", "%2");

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    const data = (await response.json()) as { reason: string; error: string };
    expect(data.reason).toBe("no-transcript");
    expect(data.error).toContain("not fall back to a pane capture");
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });
});

describe("POST /handoff — reference resolution", () => {
  it("refuses an ambiguous <to> with the candidate list and never picks", async () => {
    const panes = new Map([
      ["%1", pane("%1")],
      ["%2", pane("%2")],
      ["%3", pane("%3")],
    ]);
    const { manager, internals, sendPromptToPane } = createServer(panes);
    manager.createSession("src", codexTranscript("src.jsonl"), "codex");
    manager.setTmuxPane("src", "%1");
    manager.createSession("a", transcript("a.jsonl"));
    manager.setTmuxPane("a", "%2");
    manager.createSession("b", transcript("b.jsonl"));
    manager.setTmuxPane("b", "%3");

    const response = await post(internals, { from: "src", to: "claude" });
    expect(response.status).toBe(409);
    const data = (await response.json()) as {
      reason: string;
      end: string;
      candidates: { sessionId: string }[];
    };
    expect(data.reason).toBe("ambiguous-ref");
    expect(data.end).toBe("to");
    expect(data.candidates.map((c) => c.sessionId).sort()).toEqual(["a", "b"]);
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous <from> before reading anything", async () => {
    const panes = new Map([
      ["%1", pane("%1")],
      ["%2", pane("%2")],
    ]);
    const { manager, internals } = createServer(panes);
    manager.createSession("a", transcript("a.jsonl"));
    manager.setTmuxPane("a", "%1");
    manager.createSession("b", transcript("b.jsonl"));
    manager.setTmuxPane("b", "%2");

    const response = await post(internals, { from: "claude", to: "a" });
    expect(response.status).toBe(409);
    const data = (await response.json()) as { end: string };
    expect(data.end).toBe("from");
  });

  it("resolves `self` from callerPane and echoes how both ends resolved", async () => {
    const panes = new Map([
      ["%1", pane("%1")],
      ["%2", pane("%2")],
    ]);
    const { manager, internals } = createServer(panes);
    manager.createSession("src", codexTranscript("src.jsonl"), "codex");
    manager.setTmuxPane("src", "%1");
    manager.createSession("dst", transcript("dst.jsonl"));
    manager.setTmuxPane("dst", "%2");

    const response = await post(internals, {
      from: "self",
      to: "claude",
      callerPane: "%1",
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      from: { sessionId: string; resolution: { tier: string; exact: boolean } };
      to: { sessionId: string; resolution: { tier: string; exact: boolean } };
    };
    expect(data.from.sessionId).toBe("src");
    expect(data.from.resolution).toMatchObject({ tier: "self", exact: true });
    expect(data.to.sessionId).toBe("dst");
    expect(data.to.resolution).toMatchObject({
      tier: "agent-type",
      exact: false,
    });
  });

  it("404s an unknown ref and names the end", async () => {
    const { manager, internals } = createServer();
    pair(manager);
    const response = await post(internals, { from: "src", to: "nope" });
    expect(response.status).toBe(404);
    expect((await response.json()) as { end: string }).toMatchObject({
      end: "to",
    });
  });

  it("refuses a session handing off to itself", async () => {
    const { manager, internals } = createServer();
    pair(manager);
    const response = await post(internals, { from: "src", to: "src" });
    expect(response.status).toBe(400);
    expect((await response.json()) as { reason: string }).toMatchObject({
      reason: "self-handoff",
    });
  });
});

describe("POST /handoff — guard stack", () => {
  it("refuses a waiting target; a permission prompt is never answered with a paste", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager);
    manager.updateSession("dst", { status: "waiting" });

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    const data = (await response.json()) as { reason: string; error: string };
    expect(data.reason).toBe("target-waiting");
    expect(data.error).toContain("pending prompt");
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });

  it("refuses an aggregated row with more than one concurrent wait", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager);
    manager.updateSession("dst", { ambiguousWait: true });

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    expect((await response.json()) as { reason: string }).toMatchObject({
      reason: "ambiguous-wait",
    });
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });

  it("refuses a paneless target", async () => {
    const { manager, internals } = createServer();
    manager.createSession("src", transcript("src.jsonl"));
    manager.setTmuxPane("src", "%1");
    manager.createSession("dst", transcript("dst.jsonl"));

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    expect((await response.json()) as { reason: string }).toMatchObject({
      reason: "no-pane",
    });
  });

  it("fails CLOSED when the pane's foreground is a shell", async () => {
    const { manager, internals, sendPromptToPane, getPaneCommand } =
      createServer();
    pair(manager);
    getPaneCommand.mockResolvedValue("zsh");

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    const data = (await response.json()) as { reason: string; error: string };
    expect(data.reason).toBe("not-at-agent");
    expect(data.error).toContain("zsh");
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the foreground query itself fails", async () => {
    const { manager, internals, sendPromptToPane, getPaneCommand } =
      createServer();
    pair(manager);
    (
      getPaneCommand as unknown as Mock<() => Promise<string | null>>
    ).mockResolvedValue(null as unknown as string);

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    expect((await response.json()) as { reason: string }).toMatchObject({
      reason: "not-at-agent",
    });
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });

  it("refuses a payload the target agent's composer cannot receive safely", async () => {
    const panes = new Map([
      ["%1", pane("%1")],
      ["%2", pane("%2")],
    ]);
    const { manager, internals, sendPromptToPane } = createServer(panes);
    // Cursor's unsafeReplyPattern matches a `/token` ANYWHERE, which the
    // leading-trigger defuse cannot neutralize, so it is a refusal.
    const cursor = BUILTIN_AGENTS.find((a) => a.name === "cursor");
    expect(cursor?.notificationActions?.unsafeReplyPattern).toBeDefined();
    manager.createSession("src", transcript("src.jsonl", "run /clear now"));
    manager.setTmuxPane("src", "%1");
    manager.createSession("dst", transcript("dst.jsonl"), "cursor");
    manager.setTmuxPane("dst", "%2");

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    expect((await response.json()) as { reason: string }).toMatchObject({
      reason: "unsafe-payload",
    });
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });

  it("strips control characters out of the payload", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, `before${ESC}[201~after`);

    await post(internals, { from: "src", to: "dst" });
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text).toContain("before[201~after");
    expect(text).not.toContain(ESC);
  });

  it("strips control characters that arrive through the NOTE, not just the payload", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "clean payload");

    // The note is caller-supplied and only whitespace-folded on its way into
    // the header (ESC is not `\s`), so it reaches the composed text untouched
    // by the payload's own strip. The guarantee has to live on the final
    // composed text, which is what this proves.
    const response = await post(internals, {
      from: "src",
      to: "dst",
      note: `before${ESC}[201~after`,
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { chars: number };

    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text).not.toContain(ESC);
    expect(text).toContain("note: before[201~after");
    expect(text).toContain("clean payload");
    // The reported size is the size of what was actually pasted.
    expect(data.chars).toBe(text.length);
  });

  it("strips control characters that arrive through the source's cwd", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "clean payload");
    // A control byte is legal in a POSIX path, so the cwd is another way one
    // reaches the header.
    manager.updateSession("src", { cwd: `/tmp/we${ESC}ird` });

    await post(internals, { from: "src", to: "dst" });
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text).not.toContain(ESC);
    expect(text).toContain("/tmp/weird");
  });

  it("keeps the QUEUED copy clean, so the dequeue pastes stripped text too", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "clean payload");
    manager.updateSession("dst", { status: "working" });

    await post(internals, {
      from: "src",
      to: "dst",
      note: `queued${ESC}[201~note`,
    });
    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(10);

    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text).not.toContain(ESC);
    expect(text).toContain("note: queued[201~note");
  });
});

describe("POST /handoff — queue on busy", () => {
  it("queues for a working target and surfaces it as pendingHandoff", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager);
    manager.updateSession("dst", { status: "working" });

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      status: string;
      queuedAt: string;
      expiresAt: string;
    };
    expect(data.status).toBe("queued");
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(
      Date.parse(data.queuedAt),
    );
    expect(sendPromptToPane).not.toHaveBeenCalled();

    const enriched = await internals.enrichSession(manager.getSession("dst"));
    expect(enriched.pendingHandoff).toEqual({
      fromSessionId: "src",
      queuedAt: data.queuedAt,
    });
  });

  it("queues the text already composed, turns and note included", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    manager.createSession(
      "src",
      multiTurnTranscript("src.jsonl", [
        ["p1", "first answer"],
        ["p2", "second answer"],
      ]),
    );
    manager.setTmuxPane("src", "%1");
    manager.createSession("dst", transcript("dst.jsonl"));
    manager.setTmuxPane("dst", "%2");
    manager.updateSession("dst", { status: "working" });

    await post(internals, {
      from: "src",
      to: "dst",
      turns: 2,
      note: "over to you",
    });
    expect(sendPromptToPane).not.toHaveBeenCalled();

    // Composition happens BEFORE the status branch, so what waits in the
    // queue is the exact bytes that will be pasted — not a request to be
    // re-read half an hour later against a transcript that has moved on.
    manager.updateSession("dst", { status: "idle" });
    // The listener is async; let its microtasks drain.
    await Bun.sleep(10);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text.split("\n")[1]).toBe("note: over to you");
    expect(text).toContain("assistant:\nfirst answer");
    expect(text).toContain("assistant:\nsecond answer");
  });

  it("omits pendingHandoff for a session with nothing queued", async () => {
    const { manager, internals } = createServer();
    pair(manager);
    const enriched = await internals.enrichSession(manager.getSession("dst"));
    expect(enriched.pendingHandoff).toBeUndefined();
  });

  it("delivers on the working -> idle transition, once", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "queued conclusion");
    manager.updateSession("dst", { status: "working" });
    await post(internals, { from: "src", to: "dst" });
    expect(sendPromptToPane).not.toHaveBeenCalled();

    manager.updateSession("dst", { status: "idle" });
    // The listener is async; let its microtasks drain.
    await Bun.sleep(10);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    expect(
      (sendPromptToPane.mock.calls[0] as unknown as string[])[1],
    ).toContain("queued conclusion");

    // A second idle-ish update must not re-paste: the record was taken.
    manager.updateSession("dst", { status: "working" });
    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(10);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);

    const enriched = await internals.enrichSession(manager.getSession("dst"));
    expect(enriched.pendingHandoff).toBeUndefined();
  });

  it("delivers after a detour through waiting", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager);
    manager.updateSession("dst", { status: "working" });
    await post(internals, { from: "src", to: "dst" });

    manager.updateSession("dst", { status: "waiting" });
    await Bun.sleep(5);
    expect(sendPromptToPane).not.toHaveBeenCalled();

    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(10);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
  });

  it("re-runs the guards at dequeue and drops the handoff when they refuse", async () => {
    const { manager, internals, sendPromptToPane, getPaneCommand } =
      createServer();
    pair(manager);
    manager.updateSession("dst", { status: "working" });
    await post(internals, { from: "src", to: "dst" });

    // The agent exited while the handoff waited; the pane is now a shell.
    getPaneCommand.mockResolvedValue("zsh");
    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(10);

    expect(sendPromptToPane).not.toHaveBeenCalled();
    const enriched = await internals.enrichSession(manager.getSession("dst"));
    expect(enriched.pendingHandoff).toBeUndefined();
  });

  it("replaces a second queued handoff and reports whose it dropped", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "first");
    manager.createSession("src2", transcript("src2.jsonl", "second"));
    manager.setTmuxPane("src2", "%3");
    manager.updateSession("dst", { status: "working" });

    await post(internals, { from: "src", to: "dst" });
    const second = await post(internals, { from: "src2", to: "dst" });
    const data = (await second.json()) as {
      status: string;
      replaced?: { fromSessionId: string };
    };
    expect(data.status).toBe("queued");
    expect(data.replaced).toEqual({ fromSessionId: "src" });

    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(10);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    expect(
      (sendPromptToPane.mock.calls[0] as unknown as string[])[1],
    ).toContain("second");
  });

  it("drops the record when the target session goes away", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager);
    manager.updateSession("dst", { status: "working" });
    await post(internals, { from: "src", to: "dst" });

    manager.removeSession("dst");
    await Bun.sleep(5);
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });
});

/**
 * Stub every `Bun.spawn` the spawn path makes, recording the argv. The pane
 * id comes back on the first call's stdout, exactly as `tmux new-window -P`
 * would give it.
 */
function stubSpawn(): { argv: string[][]; restore: () => void } {
  const argv: string[][] = [];
  const original = Bun.spawn;
  let first = true;
  Bun.spawn = ((spawned: string[]) => {
    argv.push(spawned);
    const stdout = first ? "%9\n" : "";
    first = false;
    return {
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    };
  }) as unknown as typeof Bun.spawn;
  return { argv, restore: () => (Bun.spawn = original) };
}

describe("POST /handoff — --spawn", () => {
  it("rides POST /spawn with the composed handoff as the opening prompt", async () => {
    const { manager, internals } = createServer();
    manager.createSession("src", transcript("src.jsonl", "here is the plan"));
    manager.setTmuxPane("src", "%1");
    const spawn = stubSpawn();

    try {
      const response = await post(internals, {
        from: "src",
        spawn: { agent: "claude", cwd: dir },
        note: "continue this",
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        status: string;
        to: { agentType: string; cwd: string; paneId: string | null };
        notes?: string[];
      };
      expect(data.status).toBe("spawned");
      expect(data.to).toMatchObject({
        agentType: "claude",
        cwd: dir,
        paneId: "%9",
      });
      // No codex, no trust-prompt note.
      expect(data.notes).toBeUndefined();

      const sendKeys = spawn.argv.find((a) => a.includes("send-keys"));
      expect(sendKeys).toBeDefined();
      const command = sendKeys!.join(" ");
      expect(command).toContain(HANDOFF_PREFIX);
      expect(command).toContain("note: continue this");
      expect(command).toContain("here is the plan");
    } finally {
      spawn.restore();
    }
  });

  it("defaults the agent and cwd to the source's, and surfaces codex's trust prompt", async () => {
    const { manager, internals } = createServer();
    manager.createSession("src", codexTranscript("src.jsonl"), "codex");
    manager.setTmuxPane("src", "%1");
    const spawn = stubSpawn();

    try {
      const response = await post(internals, {
        from: "src",
        spawn: { cwd: dir },
      });
      const data = (await response.json()) as {
        to: { agentType: string };
        notes: string[];
      };
      expect(data.to.agentType).toBe("codex");
      // Surfaced, never auto-answered: codex holds the initial prompt behind
      // a first-time directory-trust question.
      expect(data.notes).toHaveLength(1);
      expect(data.notes[0]).toContain("trust");
    } finally {
      spawn.restore();
    }
  });

  it("reports a spawn refusal as the handoff's own failure", async () => {
    const { manager, internals } = createServer();
    manager.createSession("src", transcript("src.jsonl"));
    manager.setTmuxPane("src", "%1");

    const response = await post(internals, {
      from: "src",
      spawn: { cwd: "/nonexistent/ccmux-handoff-test" },
    });
    expect(response.status).toBe(400);
    const data = (await response.json()) as { reason: string; error: string };
    expect(data.reason).toBe("spawn-failed");
    expect(data.error).toContain("Directory does not exist");
  });
});

describe("POST /handoff — request validation", () => {
  it("rejects a malformed body", async () => {
    const { internals } = createServer();
    const response = await internals.handleHandoff(
      new Request("http://localhost/handoff", { method: "POST", body: "{" }),
      {},
    );
    expect(response.status).toBe(400);
  });

  it("requires 'from', and 'to' unless spawning", async () => {
    const { manager, internals } = createServer();
    pair(manager);
    expect((await post(internals, { to: "dst" })).status).toBe(400);
    expect((await post(internals, { from: "src" })).status).toBe(400);
  });

  it("refuses 'to' and 'spawn' together", async () => {
    const { manager, internals } = createServer();
    pair(manager);
    const response = await post(internals, {
      from: "src",
      to: "dst",
      spawn: true,
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("mutually exclusive"),
    });
  });

  it("bounds 'turns' and 'note'", async () => {
    const { manager, internals } = createServer();
    pair(manager);
    expect(
      (await post(internals, { from: "src", to: "dst", turns: 0 })).status,
    ).toBe(400);
    expect(
      (await post(internals, { from: "src", to: "dst", turns: 99 })).status,
    ).toBe(400);
    expect(
      (
        await post(internals, {
          from: "src",
          to: "dst",
          note: "x".repeat(MAX_HANDOFF_NOTE_CHARS + 1),
        })
      ).status,
    ).toBe(400);
  });
});
