import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  setSystemTime,
} from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

/** Redirect STATE_FILE to a temp dir: a "read" verdict persists `lastSeen`
 * through `markSeen`, which must not touch the real ~/.config/ccmux/state.json. */
const tempRoot = join(
  tmpdir(),
  `ccmux-attn-transitions-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import {
  AttentionTransitions,
  classifyAttentionEdge,
} from "./attention-transitions";
import { AttentionTracker } from "./attention-tracker";
import { SessionManager } from "./sessions";

/** Lets the finish verdict's lookup -> re-read -> write chain settle. A real
 * macrotask, so every already-queued microtask drains first. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function createHarness() {
  const sessionManager = new SessionManager();
  const tracker = new AttentionTracker(15_000);
  let activePaneId: string | null = "%99";
  /** When set, each lookup takes the next queued deferred instead of
   * answering `activePaneId` immediately. */
  const pendingLookups: Deferred<string | null>[] = [];
  let queued: Deferred<string | null>[] | null = null;
  let lookups = 0;
  const transitions = new AttentionTransitions({
    sessionManager,
    tracker,
    getActivePaneId: () => {
      lookups++;
      if (queued) {
        const next = deferred<string | null>();
        queued.push(next);
        return next.promise;
      }
      return Promise.resolve(activePaneId);
    },
  });

  return {
    sessionManager,
    tracker,
    transitions,
    pendingLookups,
    get lookups() {
      return lookups;
    },
    focus(paneId: string | null) {
      activePaneId = paneId;
    },
    /** Hold every lookup until the test resolves it explicitly. */
    holdLookups() {
      queued = pendingLookups;
    },
    createSession(paneId = "%1", pid = 1) {
      return sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId,
        cwd: "/tmp/myapp",
        pid,
      }).id;
    },
    attention(id: string) {
      return sessionManager.getSession(id)!.attentionState;
    },
    /** One full turn: working, then idle. */
    async turn(id: string) {
      sessionManager.updateSession(id, { status: "working" });
      sessionManager.updateSession(id, { status: "idle" });
      await flush();
    },
  };
}

describe("classifyAttentionEdge", () => {
  it("treats entering working or waiting as new work", () => {
    expect(classifyAttentionEdge("idle", "working")).toBe("new-work");
    expect(classifyAttentionEdge("idle", "waiting")).toBe("new-work");
    expect(classifyAttentionEdge("working", "waiting")).toBe("new-work");
    expect(classifyAttentionEdge("waiting", "working")).toBe("new-work");
    expect(classifyAttentionEdge(null, "working")).toBe("new-work");
  });

  it("treats entering idle from working or waiting as a finished turn", () => {
    expect(classifyAttentionEdge("working", "idle")).toBe("finished");
    expect(classifyAttentionEdge("waiting", "idle")).toBe("finished");
  });

  it("ignores idle reached from nowhere", () => {
    expect(classifyAttentionEdge(null, "idle")).toBeNull();
    expect(classifyAttentionEdge("idle", "idle")).toBeNull();
  });
});

describe("AttentionTransitions", () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    h = createHarness();
    h.transitions.start();
  });

  afterEach(() => {
    h.transitions.stop();
  });

  it("marks a finished turn unread when the user is elsewhere", async () => {
    const id = h.createSession();
    await h.turn(id);
    expect(h.attention(id)).toBe("unread");
    expect(h.lookups).toBe(1);
  });

  it("marks every short turn unread, not just one a scan happened to see", async () => {
    // Issue #232 case 1: the first turn is finished, viewed, and decays;
    // the turns after it start and end with no scan in between. The old
    // per-session guard survived those turns and they stayed `null`.
    const id = h.createSession();
    h.focus("%1");
    await h.turn(id);
    expect(h.attention(id)).toBe("read");
    h.sessionManager.setAttentionState(id, null); // read -> null decay

    h.focus("%99");
    for (let run = 0; run < 3; run++) {
      await h.turn(id);
      expect(h.attention(id)).toBe("unread");
    }
  });

  it("marks a turn read when its pane is focused as it finishes, and starts the decay timer", async () => {
    const id = h.createSession();
    h.focus("%1");
    await h.turn(id);
    expect(h.attention(id)).toBe("read");
    expect(h.tracker.hasReadTimer(id)).toBe(true);
  });

  it("judges the pane focused at finish time, not at some later scan", async () => {
    // Issue #232 case 2: watched as it finished, then switched away. The
    // lookup fires on the finish edge itself, so leaving the pane right
    // after cannot turn an already-read reply unread.
    const id = h.createSession();
    h.holdLookups();
    h.sessionManager.updateSession(id, { status: "working" });
    h.sessionManager.updateSession(id, { status: "idle" });
    expect(h.pendingLookups.length).toBe(1);

    h.pendingLookups[0].resolve("%1");
    await flush();
    expect(h.attention(id)).toBe("read");
  });

  it("decides a waiting -> idle finish too", async () => {
    const id = h.createSession();
    h.sessionManager.updateSession(id, {
      status: "waiting",
      attentionType: "permission",
    });
    h.sessionManager.updateSession(id, { status: "idle", attentionType: null });
    await flush();
    expect(h.attention(id)).toBe("unread");
  });

  it("clears unread synchronously when a new turn starts", async () => {
    // Issue #232 case 3: no await between the status change and the clear,
    // so the status line never shows a working session carrying the last
    // turn's green mark.
    const id = h.createSession();
    await h.turn(id);
    expect(h.attention(id)).toBe("unread");
    h.sessionManager.updateSession(id, { status: "working" });
    expect(h.attention(id)).toBeNull();
  });

  it("clears read and its decay timer when a new turn starts", async () => {
    const id = h.createSession();
    h.focus("%1");
    await h.turn(id);
    expect(h.tracker.hasReadTimer(id)).toBe(true);
    h.sessionManager.updateSession(id, { status: "waiting" });
    expect(h.attention(id)).toBeNull();
    expect(h.tracker.hasReadTimer(id)).toBe(false);
  });

  it("drops a finish verdict whose lookup answers after a new turn started", async () => {
    const id = h.createSession();
    h.holdLookups();
    h.sessionManager.updateSession(id, { status: "working" });
    h.sessionManager.updateSession(id, { status: "idle" });
    expect(h.pendingLookups.length).toBe(1);
    h.sessionManager.updateSession(id, { status: "working" });
    h.pendingLookups[0].resolve("%99");
    await flush();

    expect(h.sessionManager.getSession(id)!.status).toBe("working");
    expect(h.attention(id)).toBeNull();
  });

  it("keeps only the newest finish when two lookups answer out of order", async () => {
    const id = h.createSession();
    h.holdLookups();
    h.sessionManager.updateSession(id, { status: "working" });
    h.sessionManager.updateSession(id, { status: "idle" });
    h.sessionManager.updateSession(id, { status: "working" });
    h.sessionManager.updateSession(id, { status: "idle" });
    expect(h.pendingLookups.length).toBe(2);

    // Newest answers first (user elsewhere), then the stale one claims the
    // user was watching. The stale verdict must not overwrite the new one.
    h.pendingLookups[1].resolve("%99");
    await flush();
    h.pendingLookups[0].resolve("%1");
    await flush();

    expect(h.attention(id)).toBe("unread");
  });

  it("keeps a seen-acknowledgment that lands while the finish lookup is pending", async () => {
    // `ccmux switch` posts /seen right after switching; the lookup answered
    // with the pane the user was on before, which must not undo the ack.
    const id = h.createSession();
    h.holdLookups();
    h.sessionManager.updateSession(id, { status: "working" });
    h.sessionManager.updateSession(id, { status: "idle" });
    expect(h.pendingLookups.length).toBe(1);

    h.tracker.markSeen(id);
    h.sessionManager.markSeen(id);
    h.pendingLookups[0].resolve("%99");
    await flush();

    expect(h.attention(id)).toBe("read");
  });

  it("keeps an acknowledgment that came and decayed while the finish lookup is pending", async () => {
    const id = h.createSession();
    h.holdLookups();
    h.sessionManager.updateSession(id, { status: "working" });
    h.sessionManager.updateSession(id, { status: "idle" });

    h.sessionManager.markSeen(id);
    h.sessionManager.setAttentionState(id, null);
    h.pendingLookups[0].resolve("%99");
    await flush();

    expect(h.attention(id)).toBeNull();
  });

  describe("status changes within one millisecond", () => {
    afterEach(() => {
      setSystemTime();
    });

    it("still decides a finish that shares its start's millisecond", async () => {
      const id = h.createSession();
      setSystemTime(new Date("2024-01-15T12:00:00Z"));
      h.sessionManager.updateSession(id, { status: "working" });
      h.sessionManager.updateSession(id, { status: "idle" });
      await flush();

      expect(h.attention(id)).toBe("unread");
      expect(h.lookups).toBe(1);
    });

    it("still clears attention for a new turn that shares the last finish's millisecond", async () => {
      const id = h.createSession();
      setSystemTime(new Date("2024-01-15T12:00:00Z"));
      h.sessionManager.updateSession(id, { status: "working" });
      setSystemTime(new Date("2024-01-15T12:00:01Z"));
      h.sessionManager.updateSession(id, { status: "idle" });
      await flush();
      expect(h.attention(id)).toBe("unread");

      h.sessionManager.updateSession(id, { status: "working" });
      expect(h.attention(id)).toBeNull();
    });

    it("drops a pending finish verdict once a same-millisecond turn finishes again", async () => {
      const id = h.createSession();
      h.holdLookups();
      setSystemTime(new Date("2024-01-15T12:00:00Z"));
      h.sessionManager.updateSession(id, { status: "working" });
      h.sessionManager.updateSession(id, { status: "idle" });
      h.sessionManager.updateSession(id, { status: "working" });
      h.sessionManager.updateSession(id, { status: "idle" });
      expect(h.pendingLookups.length).toBe(2);

      // The first finish's stamp still matches the session's: only the
      // revision tells its verdict is outdated.
      h.pendingLookups[0].resolve("%1");
      await flush();
      expect(h.attention(id)).toBeNull();

      h.pendingLookups[1].resolve("%99");
      await flush();
      expect(h.attention(id)).toBe("unread");
    });
  });

  it("does not re-decide a finish on a later non-status update", async () => {
    const id = h.createSession();
    await h.turn(id);
    h.sessionManager.setAttentionState(id, null); // viewed, then decayed

    h.sessionManager.updateSession(id, { gitBranch: "feat/x" });
    h.sessionManager.updateSession(id, { lastPrompt: "next" });
    await flush();

    expect(h.attention(id)).toBeNull();
    expect(h.lookups).toBe(1);
  });

  it("does not read a relaunch in the same pane as a finished turn", async () => {
    // A new pid in the pane resets the row to idle with no previous
    // status: the agent was replaced, nothing finished.
    const id = h.createSession("%1", 1);
    h.sessionManager.updateSession(id, { status: "working" });
    h.createSession("%1", 2);
    await flush();

    expect(h.sessionManager.getSession(id)!.status).toBe("idle");
    expect(h.attention(id)).toBeNull();
    expect(h.lookups).toBe(0);
  });

  it("fails a lookup that throws to unread", async () => {
    const sessionManager = new SessionManager();
    const transitions = new AttentionTransitions({
      sessionManager,
      tracker: new AttentionTracker(15_000),
      getActivePaneId: () => Promise.reject(new Error("tmux gone")),
    });
    transitions.start();
    const id = sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/tmp/myapp",
      pid: 1,
    }).id;
    sessionManager.updateSession(id, { status: "working" });
    sessionManager.updateSession(id, { status: "idle" });
    await flush();
    transitions.stop();

    expect(sessionManager.getSession(id)!.attentionState).toBe("unread");
  });

  it("leaves background (paneless) sessions out entirely", async () => {
    // Unread clears on viewing a pane, which a background row never has,
    // so a finish would stick forever.
    const id = "sup-attn";
    h.sessionManager.createBackgroundSession({
      daemonShort: id,
      pid: 999,
      cwd: "/private/tmp",
      logPath: null,
      version: null,
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastPrompt: null,
      lastActivityAt: new Date().toISOString(),
    });
    h.sessionManager.updateSession(id, { status: "idle" });
    await flush();

    expect(h.attention(id)).toBeNull();
    expect(h.lookups).toBe(0);
  });

  it("does not replay an edge that landed before start()", async () => {
    const h2 = createHarness();
    const id = h2.createSession();
    h2.sessionManager.updateSession(id, { status: "working" });
    h2.sessionManager.updateSession(id, { status: "idle" });
    h2.transitions.start();

    h2.sessionManager.updateSession(id, { gitBranch: "feat/x" });
    await flush();
    h2.transitions.stop();

    expect(h2.attention(id)).toBeNull();
    expect(h2.lookups).toBe(0);
  });

  it("drops tracker state when a session is removed", async () => {
    const id = h.createSession();
    h.focus("%1");
    await h.turn(id);
    expect(h.tracker.hasReadTimer(id)).toBe(true);

    h.sessionManager.removeSession(id);
    expect(h.tracker.hasReadTimer(id)).toBe(false);
  });

  it("stops reacting after stop()", async () => {
    const id = h.createSession();
    h.transitions.stop();
    await h.turn(id);
    expect(h.attention(id)).toBeNull();
    expect(h.lookups).toBe(0);
  });
});
