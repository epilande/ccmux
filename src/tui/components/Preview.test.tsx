import { describe, it, expect, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { TickContext } from "../store";
import { mockEnrichedSession } from "./test-helpers";
import type { EnrichedSession } from "../../types";

// Mock capturePane before importing Preview. Spread the real module so
// other test files reading unmocked exports still see real impls. mock.module
// is process-wide and persistent across files in Bun.
const realTmux = await import("../utils/tmux");

const DEFAULT_PANE_CONTENT =
  "mocked pane content line 1\nmocked pane content line 2";
// Mutable so individual tests can drive the late-capture race and the
// capture-failure path; afterEach restores the default the other tests rely on.
let captureImpl: (pane: string, lines: number) => Promise<string> = async () =>
  DEFAULT_PANE_CONTENT;

mock.module("../utils/tmux", () => ({
  ...realTmux,
  capturePane: (pane: string, lines: number) => captureImpl(pane, lines),
  getActivePaneId: async () => null,
  switchToPane: async () => {},
  sendKeys: async () => {},
  notifyActivePane: () => {},
}));

const { Preview } = await import("./Preview");
const { setDaemonSocketPath } = await import("../utils/server-guard");

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
  captureImpl = async () => DEFAULT_PANE_CONTENT;
  // Module-global cache: restore the fail-open verdict for other tests.
  setDaemonSocketPath(null);
});

async function renderPreview(session: EnrichedSession | null, width = 40) {
  const [tick] = createSignal(0);
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <Preview session={session} width={width} />
      </TickContext.Provider>
    ),
    { width: 100, height: 15 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("Preview", () => {
  it("shows fallback when no session", async () => {
    const frame = await renderPreview(null);
    expect(frame).toContain("Select a session to preview");
  });

  it("shows session project name", async () => {
    const frame = await renderPreview(
      mockEnrichedSession({ project: "myapp", tmuxPane: "%1" }),
    );
    expect(frame).toContain("myapp");
  });

  it("shows shortened cwd", async () => {
    const home = process.env.HOME || "";
    const frame = await renderPreview(
      mockEnrichedSession({ cwd: `${home}/Code/myapp`, tmuxPane: "%1" }),
    );
    expect(frame).toContain("~/Code/myapp");
  });

  it("shows metadata with branch and version", async () => {
    const frame = await renderPreview(
      mockEnrichedSession({
        project: "myapp",
        gitBranch: "main",
        version: "1.2.3",
        tmuxTarget: "dev:1",
        tmuxPane: "%1",
      }),
    );
    expect(frame).toContain("myapp:main");
    expect(frame).toContain("1.2.3");
    expect(frame).toContain("dev:1");
  });

  it("shows no tmux pane message", async () => {
    const frame = await renderPreview(mockEnrichedSession({ tmuxPane: null }));
    expect(frame).toContain("No tmux pane associated");
  });

  it("shows status text", async () => {
    const frame = await renderPreview(
      mockEnrichedSession({ status: "idle", tmuxPane: "%1" }),
    );
    expect(frame).toContain("idle");
  });

  it("shows worktree indicator in metadata", async () => {
    const frame = await renderPreview(
      mockEnrichedSession({
        project: "myapp",
        gitBranch: "feat",
        isWorktree: true,
        tmuxPane: "%1",
      }),
    );
    expect(frame).toContain("(worktree)");
  });

  it("lists live subagents with parsed names and shows agents status", async () => {
    const frame = await renderPreview(
      mockEnrichedSession({
        status: "idle",
        tmuxPane: "%1",
        subagents: [
          {
            agentId: "areviewer-quality-4e04b65eee350afe",
            status: "working",
            attentionType: null,
            pendingTool: null,
            lastActivityAt: "2024-01-15T12:00:00Z",
          },
          {
            agentId: "a3a022751130cff19",
            status: "waiting",
            attentionType: "permission",
            pendingTool: "Bash",
            lastActivityAt: null,
          },
        ],
      }),
    );
    expect(frame).toContain("Agents (2)");
    expect(frame).toContain("reviewer-quality");
    expect(frame).toContain("3a0227");
    // Lifted status label in the header, not raw idle/working
    expect(frame).toContain("agents");
  });

  it("caps the agents list and shows an overflow line", async () => {
    const subagents = Array.from({ length: 6 }, (_, i) => ({
      agentId: `aworker-${i}-4e04b65eee350afe`,
      status: "working" as const,
      attentionType: null,
      pendingTool: null,
      lastActivityAt: null,
    }));
    const frame = await renderPreview(
      mockEnrichedSession({ status: "idle", tmuxPane: "%1", subagents }),
    );
    expect(frame).toContain("Agents (6)");
    expect(frame).toContain("worker-3");
    expect(frame).not.toContain("worker-4");
    expect(frame).toContain("+2 more");
  });

  it("shows no agents section without subagents", async () => {
    const frame = await renderPreview(
      mockEnrichedSession({ tmuxPane: "%1", subagents: [] }),
    );
    expect(frame).not.toContain("Agents (");
  });
});

describe("Preview pane capture", () => {
  async function renderReactive(initial: EnrichedSession) {
    const [session, setSession] = createSignal<EnrichedSession>(initial);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <Preview session={session()} width={40} />
        </TickContext.Provider>
      ),
      { width: 100, height: 15 },
    );
    await setup.renderOnce();
    return setSession;
  }

  async function pollFrame(steps = 30): Promise<string> {
    let frame = "";
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, 10));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
    }
    return frame;
  }

  it("drops a stale capture when the selection moves to another pane", async () => {
    // Pane A's capture is slow; B's is fast. A's late resolve must NOT paint
    // its content under row B (the identity guard) nor corrupt the backoff.
    captureImpl = async (pane) => {
      if (pane === "%A") {
        await new Promise((r) => setTimeout(r, 80));
        return "AAA_STALE_CONTENT";
      }
      return "BBB_FRESH_CONTENT";
    };
    const setSession = await renderReactive(
      mockEnrichedSession({ tmuxPane: "%A", project: "aaa" }),
    );
    // Switch to B while A's capture is still in flight (before its 80ms delay).
    setSession(mockEnrichedSession({ tmuxPane: "%B", project: "bbb" }));
    // Poll well past A's delay so its late resolve has fired and been dropped.
    const frame = await pollFrame();
    expect(frame).toContain("BBB_FRESH_CONTENT");
    expect(frame).not.toContain("AAA_STALE_CONTENT");
  });

  it("re-captures on a refreshKey bump even when unfocused", async () => {
    // An unfocused preview is a single snapshot: it must NOT pick up pane
    // changes on its own, but a refreshKey bump (e.g. after review notes are
    // delivered to the agent's composer) forces one re-capture.
    let content = "BEFORE_FILL";
    captureImpl = async () => content;
    const [refreshKey, setRefreshKey] = createSignal(0);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <Preview
            session={mockEnrichedSession({ tmuxPane: "%1" })}
            width={40}
            focused={false}
            refreshKey={refreshKey()}
          />
        </TickContext.Provider>
      ),
      { width: 100, height: 15 },
    );
    await setup.renderOnce();
    expect(await pollFrame(5)).toContain("BEFORE_FILL");

    content = "AFTER_FILL";
    // Unfocused and un-bumped: the stale snapshot stays.
    expect(await pollFrame(5)).toContain("BEFORE_FILL");

    setRefreshKey(1);
    const frame = await pollFrame(5);
    expect(frame).toContain("AFTER_FILL");
    expect(frame).not.toContain("BEFORE_FILL");
  });

  it("renders the failure state when a capture throws (dead pane)", async () => {
    captureImpl = async () => {
      throw new Error("pane gone");
    };
    await renderReactive(mockEnrichedSession({ tmuxPane: "%1" }));
    const frame = await pollFrame();
    expect(frame).toContain("Failed to capture pane");
  });

  it("dedupes repeated failed captures so the focused poll backs off", async () => {
    // Issue #114: every consecutive failure used to report "changed", pinning
    // the poll loop at MIN_DELAY (a dead pane re-captured every 500ms). With
    // the failure state deduped, only the TRANSITION into failure counts as a
    // change, so the delay doubles up to MAX_DELAY like a silent live pane.
    // Tiny injected delays make the backoff observable in a fast test: at a
    // constant 20ms cadence ~25 polls fit in 500ms, while the backed-off
    // schedule (20, 40, 80, 100, 100, ...) fits ~7.
    let calls = 0;
    captureImpl = async () => {
      calls++;
      throw new Error("pane gone");
    };
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <Preview
            session={mockEnrichedSession({ tmuxPane: "%1" })}
            width={40}
            focused={true}
            pollDelays={{ min: 20, max: 100 }}
          />
        </TickContext.Provider>
      ),
      { width: 100, height: 15 },
    );
    await setup.renderOnce();
    const frame = await pollFrame(50); // ~500ms of focused polling
    expect(frame).toContain("Failed to capture pane");
    // Backed-off schedule stays in single digits; the broken constant-cadence
    // loop lands near 25. The bound leaves slack for timer jitter.
    expect(calls).toBeLessThanOrEqual(12);

    // Recovery must still repaint: the failed state may not dedupe against a
    // later successful capture, even after the loop has backed off.
    captureImpl = async () => "RECOVERED_CONTENT";
    const recovered = await pollFrame(30);
    expect(recovered).toContain("RECOVERED_CONTENT");
    expect(recovered).not.toContain("Failed to capture pane");
  });

  it("refuses to capture a cross-server pane and says so", async () => {
    // Issue #113: a daemon-supplied %N is unique only within the daemon's tmux
    // server. On a genuine second-server collision, capturing here would
    // silently render some OTHER pane's content; the guard must refuse before
    // spawning tmux at all.
    const originalTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath("/tmp/tmux-test/other");
    let calls = 0;
    captureImpl = async () => {
      calls++;
      return "WRONG_PANE_CONTENT";
    };
    try {
      await renderReactive(mockEnrichedSession({ tmuxPane: "%1" }));
      const frame = await pollFrame(10);
      expect(frame).toContain("Pane is on a different tmux server");
      expect(frame).not.toContain("WRONG_PANE_CONTENT");
      expect(calls).toBe(0);
    } finally {
      if (originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = originalTmux;
    }
  });
});

function mockBackgroundSession(
  overrides: Partial<EnrichedSession> = {},
): EnrichedSession {
  return mockEnrichedSession({
    trackingMode: "background",
    tmuxPane: null,
    logPath: null,
    ...overrides,
  });
}

describe("BackgroundPeek", () => {
  it("shows the ask (intent) above the detail", async () => {
    const frame = await renderPreview(
      mockBackgroundSession({
        lastPrompt: "Research the flaky test",
        backgroundDetail: "Scanning CI logs",
        status: "working",
      }),
    );
    expect(frame).toContain("Task");
    expect(frame).toContain("Research the flaky test");
    expect(frame).toContain("Scanning CI logs");
  });

  it("shows inFlight progress while working", async () => {
    const frame = await renderPreview(
      mockBackgroundSession({
        status: "working",
        backgroundDetail: "Working",
        backgroundInFlight: { tasks: 2, queued: 1, kinds: ["Task"] },
      }),
    );
    expect(frame).toContain("2 running");
    expect(frame).toContain("1 queued");
  });

  it("hides inFlight progress when not working", async () => {
    const frame = await renderPreview(
      mockBackgroundSession({
        status: "idle",
        backgroundDetail: "Done",
        backgroundInFlight: { tasks: 2 },
      }),
    );
    expect(frame).not.toContain("2 running");
  });

  it("shows the result and the launch footer when done", async () => {
    const frame = await renderPreview(
      mockBackgroundSession({
        status: "idle",
        backgroundDetail: "Finished",
        backgroundResult: "The answer is 42.",
      }),
    );
    expect(frame).toContain("The answer is 42.");
    expect(frame).toContain("enter: attach agent");
    expect(frame).not.toContain("to respond");
  });

  it("offers the respond affordance when waiting", async () => {
    const frame = await renderPreview(
      mockBackgroundSession({
        status: "waiting",
        attentionType: "permission",
        backgroundDetail: "Needs approval",
      }),
    );
    expect(frame).toContain("enter: attach agent to respond");
  });

  // The transcript read is real file I/O (mocking ../utils/transcript here
  // would leak process-wide into transcript.test.ts), so write a tiny JSONL
  // and poll the frame until the async effect lands.
  function writeTranscript(lines: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), "ccmux-peek-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  const userEntry = {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    timestamp: "2024-01-15T12:00:00Z",
    message: { role: "user", content: "research the thing" },
  };
  const assistantEntry = (text: string) => ({
    type: "assistant",
    uuid: "u2",
    parentUuid: null,
    timestamp: "2024-01-15T12:00:00Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

  async function waitForFrame(text: string): Promise<string> {
    let frame = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      if (frame.includes(text)) break;
    }
    return frame;
  }

  it("renders the Last reply read from the transcript when done", async () => {
    const path = writeTranscript([
      userEntry,
      assistantEntry("Here is what I found."),
    ]);
    await renderPreview(
      mockBackgroundSession({
        status: "idle",
        backgroundDetail: "Finished",
        backgroundResult: "summary line",
        logPath: path,
      }),
    );
    const frame = await waitForFrame("Last reply");
    expect(frame).toContain("Last reply");
    expect(frame).toContain("Here is what I found.");
  });

  it("suppresses the Last reply when it equals the result", async () => {
    const path = writeTranscript([
      userEntry,
      assistantEntry("The answer is 42."),
    ]);
    await renderPreview(
      mockBackgroundSession({
        status: "idle",
        backgroundDetail: "Finished",
        backgroundResult: "The answer is 42.",
        logPath: path,
      }),
    );
    // Give the async read time to resolve, then confirm no duplicate section.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("The answer is 42.");
    expect(frame).not.toContain("Last reply");
  });
});
