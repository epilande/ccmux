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
  spyOn,
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
import {
  HANDOFF_PREFIX,
  MAX_HANDOFF_NOTE_CHARS,
  type HandoffQueue,
} from "./handoff";
import { MAX_SPAWN_PROMPT_BYTES } from "./spawn-command";
import { MAX_TURN_CHARS, renderTurns } from "./transcript-read";
import { MAX_SEND_PASTE_CHARS } from "../lib/config";
import type { EnrichedSession, TmuxPane } from "../types/session";

type Internals = {
  handleHandoff(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response>;
  enrichSession(session: unknown): Promise<EnrichedSession>;
  /** One route test goes through the dispatcher, so the endpoint is proved
   *  REACHABLE and not merely correct once called. */
  handleRequest(req: Request): Promise<Response>;
  /** For the wire assertions: a fake client, and the visibility gate
   *  `rebroadcastSession` checks before it broadcasts. */
  sseClients: Map<
    string,
    { id: string; controller: { enqueue: (data: string) => void } }
  >;
  visibleSessions: Set<string>;
  handoffQueue: HandoffQueue;
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

/**
 * What a capture of an idle Claude composer looks like: the glyph on a line of
 * its own between the rule lines, with nothing but status chrome under it.
 * Trimmed from a real Claude Code 2.1.222 pane, same fixture shape
 * `pane-classify.test.ts` uses.
 */
const IDLE_COMPOSER = [
  "⏺ Done.",
  "",
  "✻ Baked for 28s",
  "",
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "  🤖 Opus 5 │ 🧠 4% │ ⏱️ 0m48s │ 📦 v2.1.222",
  "  💬 run the bash command: touch probe.txt",
  "",
].join("\n");

/** The same pane with a live permission prompt on it: the terminator plus its
 *  option block, whose highlighted default a bare Enter would select. */
const LIVE_PERMISSION_PROMPT = [
  "⏺ I'll run that command.",
  "",
  "  Running 1 shell command…",
  "",
  "────────────────────────────────────────────",
  " Bash command",
  "",
  "   touch /tmp/probe.txt",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to tmp/ from this project",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
  "",
].join("\n");

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
  // ...and showing an idle composer. Injected rather than left to the real
  // `capturePane` so no test in this file shells out to tmux for a pane that
  // does not exist.
  const capturePane = mock(async () => IDLE_COMPOSER);
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
      capturePane,
    },
  );
  return {
    manager,
    sendPromptToPane,
    getPaneCommand,
    capturePane,
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

  it("delivers into a cursor target when only the HEADER's cwd looks like a slash command", async () => {
    const panes = new Map([
      ["%1", pane("%1")],
      ["%2", pane("%2")],
    ]);
    const { manager, internals, sendPromptToPane } = createServer(panes);
    // The discriminating case for the test above: a payload with no `/token`
    // in it at all, and an absolute cwd. Cursor's pattern is `/(^|\s)\/\S/`,
    // so an UNQUOTED cwd after the header's ` · ` separator matched, and
    // ccmux refused every handoff into a cursor target on the strength of a
    // header it wrote itself.
    manager.createSession("src", transcript("src.jsonl", "the plan is ready"));
    manager.setTmuxPane("src", "%1");
    manager.updateSession("src", { cwd: "/Users/x/code/ccmux" });
    manager.createSession("dst", transcript("dst.jsonl"), "cursor");
    manager.setTmuxPane("dst", "%2");

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({
      status: "delivered",
    });
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text).toContain("`/Users/x/code/ccmux`");
  });

  it("refuses an unsafe payload AT ENQUEUE rather than queueing a doomed one", async () => {
    const panes = new Map([
      ["%1", pane("%1")],
      ["%2", pane("%2")],
    ]);
    const { manager, internals, sendPromptToPane } = createServer(panes);
    manager.createSession("src", transcript("src.jsonl", "run /clear now"));
    manager.setTmuxPane("src", "%1");
    manager.createSession("dst", transcript("dst.jsonl"), "cursor");
    manager.setTmuxPane("dst", "%2");
    manager.updateSession("dst", { status: "working" });

    // Both inputs to the check are frozen by now (the composed text, and the
    // target's own pattern), so a busy target used to be told "queued" and
    // the dequeue silently dropped it half an hour later.
    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    expect((await response.json()) as { reason: string }).toMatchObject({
      reason: "unsafe-payload",
    });
    expect(internals.handoffQueue.peek("dst")).toBeNull();
    const enriched = await internals.enrichSession(manager.getSession("dst"));
    expect(enriched.pendingHandoff).toBeUndefined();

    // And nothing arrives when the target frees up either.
    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(10);
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

/**
 * The last guard, and the only one that reads the PANE. Every other check in
 * the stack asks about metadata, so a status that was NEVER right (a marker
 * that outlived its prompt, issue #117) walks straight through them: the paste
 * is swallowed by the live dialog and the trailing Enter selects its
 * highlighted default.
 */
describe("POST /handoff — the pane-evidence gate", () => {
  it("refuses a target whose pane is showing a live prompt, and types NOTHING", async () => {
    const { manager, internals, sendPromptToPane, capturePane } =
      createServer();
    pair(manager);
    // The store says idle. The pane says otherwise, and the pane is right.
    capturePane.mockResolvedValue(LIVE_PERMISSION_PROMPT);

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(409);
    expect((await response.json()) as { reason: string }).toMatchObject({
      reason: "pane-not-ready",
    });
    // THE assertion: nothing reached the pane, so no default got selected.
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });

  it("delivers when the pane positively shows an idle composer", async () => {
    const { manager, internals, sendPromptToPane, capturePane } =
      createServer();
    pair(manager, "ship it");
    capturePane.mockResolvedValue(IDLE_COMPOSER);

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({
      status: "delivered",
    });
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    expect(
      (sendPromptToPane.mock.calls[0] as unknown as string[])[1],
    ).toContain("ship it");
  });

  it("leaves a non-claude target alone: the pane vocabulary is Claude's", async () => {
    const { manager, internals, sendPromptToPane, capturePane } =
      createServer();
    manager.createSession("src", transcript("src.jsonl", "ship it"));
    manager.setTmuxPane("src", "%1");
    // Antigravity, not codex: it is the other built-in that CARRIES a
    // `readyPattern`, so dropping the agent-type scope would really measure
    // its pane against Claude's composer here. A target with no pattern at
    // all skips the gate for a second reason and proves nothing.
    const antigravity = BUILTIN_AGENTS.find((a) => a.name === "antigravity");
    expect(antigravity?.readyPattern).toBeDefined();
    manager.createSession("dst", transcript("dst.jsonl"), "antigravity");
    manager.setTmuxPane("dst", "%2");
    // Content that would fail Claude's predicate outright. An antigravity
    // pane is not measured against it at all.
    capturePane.mockResolvedValue(LIVE_PERMISSION_PROMPT);

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({
      status: "delivered",
    });
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
  });

  it("delivers when the pane cannot be read at all: the gate fails OPEN", async () => {
    const { manager, internals, sendPromptToPane, capturePane } =
      createServer();
    pair(manager, "ship it");
    // `capturePane` returns "" for every failure it has (dead pane, tmux
    // error), so "" carries no evidence either way. Refusing on it would
    // strand every handoff behind a transient tmux hiccup, and the checks
    // above this gate already ran. Same direction as the #117 arm, which
    // treats an unreadable pane as a no-op rather than a downgrade.
    capturePane.mockResolvedValue("");

    const response = await post(internals, { from: "src", to: "dst" });
    expect(response.status).toBe(200);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
  });

  it("RE-QUEUES a queued handoff the gate refuses, rather than dropping it", async () => {
    const { manager, internals, sendPromptToPane, capturePane } =
      createServer();
    pair(manager, "queued conclusion");
    manager.updateSession("dst", { status: "working" });
    await post(internals, { from: "src", to: "dst" });

    // A pane that is not showing an idle composer this instant may well be
    // showing one a second later, so this is TRANSIENT. Dropped, the sender
    // would have been told "queued" and then silently lost the handoff.
    capturePane.mockResolvedValue(LIVE_PERMISSION_PROMPT);
    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(20);

    expect(sendPromptToPane).not.toHaveBeenCalled();
    expect(internals.handoffQueue.peek("dst")?.attempts).toBe(1);

    // And the retry lands once the prompt is gone.
    capturePane.mockResolvedValue(IDLE_COMPOSER);
    manager.updateSession("dst", { status: "working" });
    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(20);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    expect(
      (sendPromptToPane.mock.calls[0] as unknown as string[])[1],
    ).toContain("queued conclusion");
    expect(internals.handoffQueue.peek("dst")).toBeNull();
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

  it("re-queues after a TRANSIENT send failure and retries on the next idle", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager, "queued conclusion");
    manager.updateSession("dst", { status: "working" });
    await post(internals, { from: "src", to: "dst" });

    // The tmux send fails once. That is not a refusal: nothing about the
    // handoff was rejected, so dropping it would lose work over a hiccup.
    let calls = 0;
    sendPromptToPane.mockImplementation(async () => ++calls > 1);

    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(20);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    expect(internals.handoffQueue.peek("dst")?.attempts).toBe(1);
    // Still on the wire: the sender was told "queued" and is owed a delivery.
    const enriched = await internals.enrichSession(manager.getSession("dst"));
    expect(enriched.pendingHandoff).toMatchObject({ fromSessionId: "src" });

    manager.updateSession("dst", { status: "working" });
    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(20);
    expect(sendPromptToPane).toHaveBeenCalledTimes(2);
    expect(
      (sendPromptToPane.mock.calls[1] as unknown as string[])[1],
    ).toContain("queued conclusion");
    expect(internals.handoffQueue.peek("dst")).toBeNull();
  });

  it("stops re-queueing after the attempt cap", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager);
    manager.updateSession("dst", { status: "working" });
    await post(internals, { from: "src", to: "dst" });
    sendPromptToPane.mockImplementation(async () => false);

    for (let i = 0; i < 4; i++) {
      manager.updateSession("dst", { status: "working" });
      manager.updateSession("dst", { status: "idle" });
      await Bun.sleep(20);
    }
    // Three attempts, then gone: a transient failure that never clears must
    // still be bounded, and the TTL alone would keep retrying for half an
    // hour.
    expect(sendPromptToPane).toHaveBeenCalledTimes(3);
    expect(internals.handoffQueue.peek("dst")).toBeNull();
  });

  it("drops on a DETERMINISTIC refusal instead of re-queueing it", async () => {
    const { manager, internals, sendPromptToPane, getPaneCommand } =
      createServer();
    pair(manager);
    manager.updateSession("dst", { status: "working" });
    await post(internals, { from: "src", to: "dst" });

    // The agent exited; re-running that check would only refuse again.
    getPaneCommand.mockResolvedValue("zsh");
    manager.updateSession("dst", { status: "idle" });
    await Bun.sleep(20);

    expect(sendPromptToPane).not.toHaveBeenCalled();
    expect(internals.handoffQueue.peek("dst")).toBeNull();
  });
});

describe("POST /handoff — concurrent delivery into one target", () => {
  /** Source, second source, and a shared idle target. */
  function trio(manager: SessionManager) {
    manager.createSession("src", transcript("src.jsonl", "first"));
    manager.setTmuxPane("src", "%1");
    manager.createSession("src2", transcript("src2.jsonl", "second"));
    manager.setTmuxPane("src2", "%3");
    manager.createSession("dst", transcript("dst.jsonl"));
    manager.setTmuxPane("dst", "%2");
  }

  it("never runs two deliveries at once, and tells both callers the truth", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    trio(manager);

    // A delivery is several awaits long (probe, load, paste, gap, Enter), so
    // two that both saw the same idle target used to interleave: the pane
    // received two prompts back to back.
    let inFlight = 0;
    let peak = 0;
    sendPromptToPane.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(20);
      inFlight--;
      return true;
    });

    const [a, b] = await Promise.all([
      post(internals, { from: "src", to: "dst" }),
      post(internals, { from: "src2", to: "dst" }),
    ]);
    expect(peak).toBe(1);
    expect(sendPromptToPane).toHaveBeenCalledTimes(2);
    // Nothing here moves the target's status, so the second is a serialized
    // delivery rather than a queue, and both answers are accurate.
    const statuses = [
      ((await a.json()) as { status: string }).status,
      ((await b.json()) as { status: string }).status,
    ];
    expect(statuses).toEqual(["delivered", "delivered"]);
  });

  it("queues the second when the first delivery leaves the target mid-turn", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    trio(manager);

    // The realistic shape: the agent starts working on what it was just
    // handed, so the second handoff's idle window is gone by the time it
    // reaches the pane. It gets the `working` answer, not a lost paste.
    sendPromptToPane.mockImplementation(async () => {
      await Bun.sleep(5);
      manager.updateSession("dst", { status: "working" });
      return true;
    });

    const [a, b] = await Promise.all([
      post(internals, { from: "src", to: "dst" }),
      post(internals, { from: "src2", to: "dst" }),
    ]);
    expect(sendPromptToPane).toHaveBeenCalledTimes(1);
    const statuses = [
      ((await a.json()) as { status: string }).status,
      ((await b.json()) as { status: string }).status,
    ].sort();
    expect(statuses).toEqual(["delivered", "queued"]);
    expect(internals.handoffQueue.peek("dst")).not.toBeNull();
  });
});

describe("POST /handoff — the wire", () => {
  type WireSession = {
    id: string;
    status: string;
    pendingHandoff?: { fromSessionId: string; queuedAt: string };
  };

  /** A fake SSE client, plus the visibility gate `rebroadcastSession` reads. */
  function watch(internals: Internals, sessionId: string) {
    const frames: string[] = [];
    const waiters: (() => void)[] = [];
    internals.visibleSessions.add(sessionId);
    internals.sseClients.set("test-client", {
      id: "test-client",
      controller: {
        enqueue: (data: string) => {
          frames.push(data);
          for (const wake of waiters.splice(0)) wake();
        },
      },
    });
    /** Every `session_updated` carrying `sessionId`, oldest first. */
    const updates = (): WireSession[] =>
      frames
        .map(
          (f) =>
            JSON.parse(f.slice("data: ".length)) as {
              type: string;
              session?: WireSession;
            },
        )
        .filter((e) => e.type === "session_updated")
        .map((e) => e.session)
        .filter((s): s is WireSession => s?.id === sessionId);
    return {
      updates,
      /** Forget every frame so far, so what follows is asserted alone. */
      reset(): void {
        frames.length = 0;
      },
      /**
       * Resolve once an update matching `predicate` has been enqueued.
       *
       * Driven off the client's own `enqueue` rather than off a fixed sleep,
       * because a rebroadcast is fired and FORGOTTEN (`void
       * this.rebroadcastSession(...)`) behind an `enrichSession` whose git
       * read is a cold process spawn: 8-12ms on an idle machine and more
       * under a full-suite run, against which any sleep short enough to keep
       * the test quick is a race the broadcast can lose. That is issue #122
       * — this assertion saw zero frames once under a 175-file run, and
       * never standalone.
       *
       * A predicate that never comes true stalls until bun's per-test
       * timeout, which is the honest failure for "the broadcast never
       * happened".
       */
      async until(predicate: (s: WireSession) => boolean): Promise<void> {
        while (!updates().some(predicate)) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      },
    };
  }

  it("announces a queued handoff, and the delivery that clears it", async () => {
    const { manager, internals } = createServer();
    pair(manager, "queued conclusion");
    const wire = watch(internals, "dst");
    manager.updateSession("dst", { status: "working" });
    // The fixture's OWN broadcasts are still in flight here — enrichment
    // awaits a git read — and would otherwise land after the handoff is
    // queued, carrying the badge and standing in for the rebroadcast this
    // test exists to prove. Wait for the last of them, then forget them, so
    // every frame from here is the handoff's doing and removing the
    // rebroadcast fails this test rather than passing on the backlog.
    await wire.until((s) => s.status === "working");
    wire.reset();

    const response = await post(internals, { from: "src", to: "dst" });
    const { queuedAt } = (await response.json()) as { queuedAt: string };
    await wire.until((s) => Boolean(s.pendingHandoff));

    // A queued handoff reaches clients as a field on the TARGET's session,
    // carrying the same `queuedAt` its sender was given. Asserted on content
    // rather than on a broadcast COUNT: every rebroadcast of a session with
    // a record pending carries it, and the PR resolver landing a lookup is
    // one such rebroadcast this test does not control.
    const queued = wire.updates().filter((s) => s.pendingHandoff);
    expect(queued.length).toBeGreaterThan(0);
    for (const session of queued) {
      expect(session.pendingHandoff).toEqual({
        fromSessionId: "src",
        queuedAt,
      });
    }

    manager.updateSession("dst", { status: "idle" });
    // A badge-free frame can only be enriched after the queue was TAKEN, so
    // waiting for one is waiting for the delivery, not merely for a tick.
    await wire.until((s) => s.pendingHandoff === undefined);
    // Delivery takes the badge back off, and a badge-free session is the last
    // word clients get. WHICH broadcast carries it is deliberately not
    // pinned: the idle transition's own `session_updated` and the
    // post-delivery rebroadcast both enrich after the record was taken, and
    // asserting on their order would reintroduce the race this test just
    // lost the sleep to.
    const updates = wire.updates();
    expect(updates[updates.length - 1].pendingHandoff).toBeUndefined();
  });
});

describe("the handoff route", () => {
  it("is reachable as POST /handoff through the dispatcher", async () => {
    const { manager, internals } = createServer();
    pair(manager, "routed");

    const response = await internals.handleRequest(
      new Request("http://localhost/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "src", to: "dst" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()) as { status: string }).toMatchObject({
      status: "delivered",
    });
  });
});

/**
 * Stub every `Bun.spawn` the spawn path makes, recording the argv. The pane
 * id comes back on the first call's stdout, exactly as `tmux new-window -P`
 * would give it.
 */
function stubSpawn(): { argv: string[][]; restore: () => void } {
  const argv: string[][] = [];
  let first = true;
  // `spyOn` + `mockRestore` rather than assigning `Bun.spawn` back by hand:
  // a hand-assigned global survives a thrown assertion and leaks into every
  // later file in the run, which is the shape that fails on Linux CI only.
  const spy = spyOn(Bun, "spawn").mockImplementation(((spawned: string[]) => {
    argv.push(spawned);
    const stdout = first ? "%9\n" : "";
    first = false;
    return {
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    };
  }) as unknown as typeof Bun.spawn);
  return { argv, restore: () => spy.mockRestore() };
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

  it("opens in the source PANE's cwd, not its decoded session cwd", async () => {
    // The test above passes an explicit `spawn.cwd`, so it never exercises the
    // default at all. This one does: `session.cwd` is the `decodeProjectPath`
    // guess (issue #121) and the pane is where the work actually is, so the
    // spawn must open where the header says it does.
    const panes = new Map<string, TmuxPane>([
      ["%1", { ...pane("%1"), currentPath: dir }],
    ]);
    const { manager, internals } = createServer(panes);
    manager.createSession("src", transcript("src.jsonl", "here is the plan"));
    manager.setTmuxPane("src", "%1");
    manager.updateSession("src", { cwd: "/Users/dev/my/project/sub/dir" });
    const spawn = stubSpawn();

    try {
      const response = await post(internals, { from: "src", spawn: true });
      expect(response.status).toBe(200);
      const data = (await response.json()) as { to: { cwd: string } };
      expect(data.to.cwd).toBe(dir);
    } finally {
      spawn.restore();
    }
  });

  it("refuses a composed handoff that overruns the spawn's BYTE budget", async () => {
    const { manager, internals } = createServer();
    // The cap `composeHandoff` applies is in UTF-16 CHARS while the spawn
    // path budgets BYTES, so multibyte text sits under the one and crosses
    // the other. Forwarded, this came back as a 400 about an invalid
    // 'prompt' field, which is not a field this caller ever sent.
    //
    // One turn cannot reach it (`MAX_TURN_CHARS` is 20,000), so this is a
    // multi-turn read: the compose cap lets through 65,536 chars, and at
    // three bytes each that is ~196KB against a 120,832-byte budget.
    const path = join(dir, "big.jsonl");
    const bulk = "書".repeat(MAX_TURN_CHARS);
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          timestamp: `2024-01-15T12:0${i}:00Z`,
          message: { content: "prompt" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: `2024-01-15T12:0${i}:30Z`,
          message: { content: [{ type: "text", text: bulk }] },
        }),
      );
    }
    writeFileSync(path, lines.join("\n") + "\n");
    manager.createSession("src", path);
    manager.setTmuxPane("src", "%1");

    const response = await post(internals, {
      from: "src",
      turns: 12,
      spawn: { cwd: dir },
    });
    expect(response.status).toBe(409);
    const data = (await response.json()) as { reason: string; error: string };
    expect(data.reason).toBe("too-large");
    expect(data.error).toContain("spawn prompt budget");
    expect(data.error).toContain(String(MAX_SPAWN_PROMPT_BYTES));
    expect(data.error).not.toContain("'prompt'");
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

  // `Number(true)` is 1 and `Number(["2"])` is 2, so these used to be accepted
  // as turn counts and quietly send that much of somebody's conversation.
  it("refuses a 'turns' that is not a count", async () => {
    const { manager, internals } = createServer();
    pair(manager);
    for (const turns of [true, ["2"], "2.5", {}]) {
      const response = await post(internals, { from: "src", to: "dst", turns });
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining("Invalid 'turns' field"),
      });
    }
  });

  it("refuses a note that is only whitespace instead of dropping it behind a 200", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager);
    const response = await post(internals, {
      from: "src",
      to: "dst",
      note: "   \n\t ",
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("whitespace"),
    });
    expect(sendPromptToPane).not.toHaveBeenCalled();
  });

  it("trims a note that is otherwise fine", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    pair(manager);
    const response = await post(internals, {
      from: "src",
      to: "dst",
      note: "  over to you  ",
    });
    expect(response.status).toBe(200);
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text.split("\n")[1]).toBe("note: over to you");
  });
});

/**
 * Issue #121. `session.cwd` for a native Claude session can be a
 * `decodeProjectPath` guess, which cannot tell a `-` in a directory name from
 * the `/` it encodes. The header quotes that path in backticks and a
 * receiving agent may `cd` into it, so the live pane cwd wins wherever there
 * is one.
 */
describe("POST /handoff: the header's cwd", () => {
  it("quotes the pane's live cwd, not the session's decoded one", async () => {
    const panes = new Map<string, TmuxPane>([
      ["%1", { ...pane("%1"), currentPath: "/Users/dev/my-project/sub-dir" }],
      ["%2", pane("%2")],
    ]);
    const { manager, internals, sendPromptToPane } = createServer(panes);
    pair(manager);
    // What `decodeProjectPath` would have produced for that directory.
    manager.updateSession("src", { cwd: "/Users/dev/my/project/sub/dir" });

    expect((await post(internals, { from: "src", to: "dst" })).status).toBe(
      200,
    );
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text.split("\n")[0]).toContain("`/Users/dev/my-project/sub-dir`");
    expect(text).not.toContain("/Users/dev/my/project/sub/dir");
  });

  it("falls back to the session's cwd when the source has no live pane", async () => {
    const { manager, internals, sendPromptToPane } = createServer();
    manager.createSession("src", transcript("src.jsonl", "ship it"));
    manager.updateSession("src", { cwd: "/Users/dev/paneless" });
    manager.createSession("dst", transcript("dst.jsonl"));
    manager.setTmuxPane("dst", "%2");

    expect((await post(internals, { from: "src", to: "dst" })).status).toBe(
      200,
    );
    const text = (sendPromptToPane.mock.calls[0] as unknown as string[])[1];
    expect(text.split("\n")[0]).toContain("`/Users/dev/paneless`");
  });
});
