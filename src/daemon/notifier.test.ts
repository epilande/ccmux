import { describe, it, expect } from "bun:test";
import {
  Notifier,
  buildStateChangedPayload,
  decideNotification,
  type NotifierDeps,
  type NotificationsConfig,
} from "./notifier";
import { SessionManager } from "./sessions";
import { BUILTIN_AGENTS, type AgentDef } from "../lib/agents";
import type { NotificationPayload } from "../lib/notify";
import { SCAN_INTERVAL_MS } from "../lib/config";
import type { Session, SessionStatus } from "../types/session";

/** Lets pending promise chains inside `Notifier` (getPrefs -> focus checks
 * -> deliver, each a separate await) settle before assertions run. Uses a
 * real macrotask so every already-queued microtask drains first. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Real, short delay so two back-to-back `updateSession` calls land in
 * different milliseconds — `statusChangedAt` is `Date.now()`-based, and the
 * dedup key depends on it changing between transitions. */
function tick(ms = 2): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Comfortably past `STARTUP_GRACE_MS` (`SCAN_INTERVAL_MS * 2 + 1000`), so
 * tests unrelated to the startup grace window aren't accidentally inside
 * it. The grace-window tests below override `startTime` to 0 instead. */
const PAST_GRACE_WINDOW = SCAN_INTERVAL_MS * 2 + 2000;

interface ScheduledTimer {
  id: number;
  fn: () => void;
  ms: number;
}

/** Builds a fully fake `NotifierDeps` set: a real `SessionManager` (so
 * "change" events have real shapes) plus fully injectable/controllable
 * timers, clock, focus, prefs, and delivery. */
function createHarness(
  overrides: Partial<NotifierDeps> & { startTime?: number } = {},
) {
  const delivered: NotificationPayload[] = [];
  const retracted: string[] = [];
  const scheduled: ScheduledTimer[] = [];
  let nextTimerId = 1;
  let currentTime = overrides.startTime ?? PAST_GRACE_WINDOW;

  let prefs: { notifications?: NotificationsConfig } = {
    notifications: { enabled: true, events: ["waiting", "finished"] },
  };

  const sessionManager = overrides.sessionManager ?? new SessionManager();

  const deps: NotifierDeps = {
    sessionManager,
    getActivePaneId: overrides.getActivePaneId ?? (async () => null),
    isTerminalFrontmost: overrides.isTerminalFrontmost ?? (async () => false),
    getPrefs: overrides.getPrefs ?? (async () => prefs),
    // Stub context enrichment off by default: the real one reads the pane via
    // tmux (permission waits) or the transcript (question waits), which would
    // spawn a subprocess in the fire path and make delivery nondeterministic.
    // The dedicated context-enrichment block overrides this explicitly.
    buildContext: overrides.buildContext ?? (async () => ({ body: null })),
    // Stub finished enrichment off by default: the real one reads the
    // transcript tail, nondeterministic in a unit test. The finished-context
    // block overrides this explicitly.
    buildFinishedContext: overrides.buildFinishedContext ?? (async () => null),
    deliver:
      overrides.deliver ??
      (async (payload: NotificationPayload) => {
        delivered.push(payload);
      }),
    retract:
      overrides.retract ??
      ((sessionId: string) => {
        retracted.push(sessionId);
      }),
    now: overrides.now ?? (() => currentTime),
    setTimer:
      overrides.setTimer ??
      ((fn: () => void, ms: number) => {
        const id = nextTimerId++;
        scheduled.push({ id, fn, ms });
        return id;
      }),
    clearTimer:
      overrides.clearTimer ??
      ((handle: unknown) => {
        const idx = scheduled.findIndex((s) => s.id === handle);
        if (idx >= 0) scheduled.splice(idx, 1);
      }),
  };

  return {
    deps,
    sessionManager,
    delivered,
    retracted,
    scheduled,
    setPrefs: (next: { notifications?: NotificationsConfig }) => {
      prefs = next;
    },
    advanceTime: (ms: number) => {
      currentTime += ms;
    },
    /** Manually fires the first scheduled timer (simulating the debounce
     * elapsing) and drains the resulting async chain. */
    fireScheduled: async (index = 0) => {
      const [entry] = scheduled.splice(index, 1);
      entry.fn();
      await flush();
    },
  };
}

describe("decideNotification", () => {
  const cases: Array<{
    prev: SessionStatus | null;
    next: SessionStatus;
    eventType: "created" | "updated" | "removed";
    expected: "waiting" | "finished" | null;
    label: string;
  }> = [
    {
      prev: "working",
      next: "waiting",
      eventType: "updated",
      expected: "waiting",
      label: "working -> waiting",
    },
    {
      prev: "idle",
      next: "waiting",
      eventType: "updated",
      expected: "waiting",
      label: "idle -> waiting",
    },
    {
      prev: "working",
      next: "idle",
      eventType: "updated",
      expected: "finished",
      label: "working -> idle",
    },
    {
      prev: "waiting",
      next: "idle",
      eventType: "updated",
      expected: "finished",
      label: "waiting -> idle",
    },
    {
      prev: "idle",
      next: "working",
      eventType: "updated",
      expected: null,
      label: "idle -> working",
    },
    {
      prev: "idle",
      next: "waiting",
      eventType: "created",
      expected: null,
      label: "created event never notifies",
    },
    {
      prev: "waiting",
      next: "waiting",
      eventType: "updated",
      expected: null,
      label: "same-status update",
    },
  ];

  for (const { prev, next, eventType, expected, label } of cases) {
    it(label, () => {
      expect(decideNotification(prev, next, eventType)).toBe(expected);
    });
  }
});

describe("Notifier", () => {
  it("waiting delivers immediately with no timer armed", async () => {
    const h = createHarness();
    const notifier = new Notifier(h.deps);
    notifier.start();
    h.advanceTime(PAST_GRACE_WINDOW);

    const session = h.sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/tmp/myapp",
      pid: 1,
    });
    h.sessionManager.updateSession(session.id, {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
    });
    await flush();

    expect(h.scheduled.length).toBe(0);
    expect(h.delivered.length).toBe(1);
    expect(h.delivered[0].event).toBe("waiting");
    // The event line is the subtitle now; the body carries context only (empty
    // here, since buildContext is stubbed off).
    expect(h.delivered[0].subtitle).toBe("Needs permission: Bash");
    expect(h.delivered[0].body).toBe("");
  });

  it("finished arms a debounce timer instead of delivering immediately", async () => {
    const h = createHarness();
    const notifier = new Notifier(h.deps);
    notifier.start();
    h.advanceTime(PAST_GRACE_WINDOW);

    const session = h.sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/tmp/myapp",
      pid: 1,
    });
    // Enriched (has a log path) so this exercises plain `delayMs`, not the
    // terminal-only floor (covered separately below).
    h.sessionManager.setLogPath(session.id, "/tmp/myapp/log.jsonl");
    h.sessionManager.updateSession(session.id, { status: "working" });
    await tick();
    h.sessionManager.updateSession(session.id, { status: "idle" });
    await flush();

    expect(h.delivered.length).toBe(0);
    expect(h.scheduled.length).toBe(1);
    expect(h.scheduled[0].ms).toBe(1000);

    await h.fireScheduled();
    expect(h.delivered.length).toBe(1);
    expect(h.delivered[0].event).toBe("finished");
    // "Finished" is the subtitle now; the body carries the (stubbed-empty)
    // finished context.
    expect(h.delivered[0].subtitle).toBe("Finished");
    expect(h.delivered[0].body).toBe("");
  });

  it("enriched session uses delayMs; terminal-only session floors at SCAN_INTERVAL_MS + 1000", async () => {
    const h = createHarness();
    const notifier = new Notifier(h.deps);
    notifier.start();
    h.advanceTime(PAST_GRACE_WINDOW);

    const enriched = h.sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/tmp/enriched",
      pid: 1,
    });
    h.sessionManager.setLogPath(enriched.id, "/tmp/enriched/log.jsonl");

    const terminalOnly = h.sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%2",
      cwd: "/tmp/terminal-only",
      pid: 2,
    });

    h.sessionManager.updateSession(enriched.id, { status: "working" });
    h.sessionManager.updateSession(terminalOnly.id, { status: "working" });
    await tick();
    h.sessionManager.updateSession(enriched.id, { status: "idle" });
    h.sessionManager.updateSession(terminalOnly.id, { status: "idle" });
    await flush();

    expect(h.scheduled.length).toBe(2);
    // Order of scheduling matches call order above.
    const [enrichedEntry, terminalEntry] = h.scheduled;
    expect(enrichedEntry.ms).toBe(1000);
    expect(terminalEntry.ms).toBe(SCAN_INTERVAL_MS + 1000);
  });

  it("status flipping back before the debounce fires delivers nothing", async () => {
    const h = createHarness();
    const notifier = new Notifier(h.deps);
    notifier.start();
    h.advanceTime(PAST_GRACE_WINDOW);

    const session = h.sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/tmp/myapp",
      pid: 1,
    });
    h.sessionManager.updateSession(session.id, { status: "working" });
    await tick();
    h.sessionManager.updateSession(session.id, { status: "idle" });
    await flush();
    expect(h.scheduled.length).toBe(1);

    // Flaps back to working before the timer elapses — decideNotification
    // for idle->working is null, so this doesn't schedule anything new, but
    // it does move session.status/statusChangedAt out from under the timer.
    await tick();
    h.sessionManager.updateSession(session.id, { status: "working" });
    await flush();

    await h.fireScheduled();
    expect(h.delivered.length).toBe(0);
  });

  it("a second finished transition replaces the first pending timer", async () => {
    const h = createHarness();
    const notifier = new Notifier(h.deps);
    notifier.start();
    h.advanceTime(PAST_GRACE_WINDOW);

    const session = h.sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/tmp/myapp",
      pid: 1,
    });
    h.sessionManager.updateSession(session.id, { status: "working" });
    await tick();
    h.sessionManager.updateSession(session.id, { status: "idle" });
    await flush();
    expect(h.scheduled.length).toBe(1);
    const firstTimerId = h.scheduled[0].id;

    await tick();
    h.sessionManager.updateSession(session.id, { status: "waiting" });
    await flush();
    expect(h.delivered.length).toBe(1); // waiting fires immediately

    await tick();
    h.sessionManager.updateSession(session.id, { status: "idle" });
    await flush();

    expect(h.scheduled.length).toBe(1);
    expect(h.scheduled[0].id).not.toBe(firstTimerId);
  });

  it("dropped when statusChangedAt has changed by fire time", async () => {
    const h = createHarness();
    const notifier = new Notifier(h.deps);
    notifier.start();
    h.advanceTime(PAST_GRACE_WINDOW);

    const session = h.sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/tmp/myapp",
      pid: 1,
    });
    h.sessionManager.updateSession(session.id, { status: "working" });
    await tick();
    h.sessionManager.updateSession(session.id, { status: "idle" });
    await flush();
    expect(h.scheduled.length).toBe(1);

    // Mutate the stored session object directly — bypassing Notifier's own
    // "change" subscription entirely, so no new arm/clear runs and the
    // ONE pending timer above is untouched — to move status/statusChangedAt
    // out from under it without relying on a second real transition. This
    // isolates `fireDebounced`'s re-read guard specifically, independent of
    // whether some other transition would also have re-armed/cleared the
    // timer via the normal event pipeline (covered separately above).
    const stored = h.sessionManager.getSession(session.id);
    expect(stored).toBeDefined();
    (stored as Session).status = "working";
    (stored as Session).statusChangedAt = new Date().toISOString();

    await h.fireScheduled();
    expect(h.delivered.length).toBe(0);
  });

  describe("dedup", () => {
    it("delivers once per statusChangedAt across repeated updates", async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1);

      // A non-status update re-fires "change" with the same statusChangedAt.
      h.sessionManager.updateSession(session.id, { gitBranch: "dev" });
      await flush();
      expect(h.delivered.length).toBe(1);
    });

    it("removed clears the pending debounce timer", async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await flush();
      expect(h.scheduled.length).toBe(1);

      h.sessionManager.removeSession(session.id);
      expect(h.scheduled.length).toBe(0);
    });
  });

  describe("focus suppression", () => {
    it("suppresses when active pane matches and terminal is frontmost", async () => {
      const h = createHarness({
        getActivePaneId: async () => "%1",
        isTerminalFrontmost: async () => true,
      });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();

      expect(h.delivered.length).toBe(0);
    });

    it("delivers when active pane matches but terminal is not frontmost", async () => {
      const h = createHarness({
        getActivePaneId: async () => "%1",
        isTerminalFrontmost: async () => false,
      });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();

      expect(h.delivered.length).toBe(1);
    });

    it("delivers when there is no active pane", async () => {
      const h = createHarness({ getActivePaneId: async () => null });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();

      expect(h.delivered.length).toBe(1);
    });

    it("background sessions are never suppressed", async () => {
      const h = createHarness({
        getActivePaneId: async () => "%1",
        isTerminalFrontmost: async () => true,
      });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createBackgroundSession({
        daemonShort: "bg1",
        pid: 1,
        cwd: "/tmp/bg",
        logPath: "/tmp/bg/log.jsonl",
        version: null,
        status: "working",
        attentionType: null,
        pendingTool: null,
        lastPrompt: null,
        lastActivityAt: null,
      });
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await flush();
      expect(h.delivered.length).toBe(0); // debounced
      await h.fireScheduled();

      expect(h.delivered.length).toBe(1);
    });
  });

  describe("config gating", () => {
    it("does not deliver when disabled", async () => {
      const h = createHarness();
      h.setPrefs({ notifications: { enabled: false } });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();

      expect(h.delivered.length).toBe(0);
    });

    it("suppresses finished when events only includes waiting", async () => {
      const h = createHarness();
      h.setPrefs({ notifications: { enabled: true, events: ["waiting"] } });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await flush();
      await h.fireScheduled();

      expect(h.delivered.length).toBe(0);
    });

    it("re-reads prefs per event, so flipping enabled mid-run takes effect without restart", async () => {
      const h = createHarness();
      h.setPrefs({ notifications: { enabled: true, events: ["waiting"] } });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1);

      h.setPrefs({ notifications: { enabled: false, events: ["waiting"] } });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();

      expect(h.delivered.length).toBe(1); // second waiting suppressed by disabled
    });
  });

  describe("cooldown", () => {
    it("drops a second waiting within 60s, delivers again after, and read clears it early", async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1);

      // Second waiting well within the 60s cooldown window is dropped.
      h.advanceTime(5_000);
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1);

      // Reading the session (attentionState -> "read") clears the cooldown
      // stamp early, so the very next waiting delivers despite being well
      // inside the 60s window.
      h.sessionManager.setAttentionState(session.id, "read");
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(2);

      // Advancing past 60s from the last stamp also allows a new delivery,
      // without needing the read-clear.
      h.advanceTime(61_000);
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(3);
    });

    it("a waiting cooldown stamp does not block a finished notification", async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1);

      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await flush();
      await h.fireScheduled();

      expect(h.delivered.length).toBe(2);
      expect(h.delivered[1].event).toBe("finished");
    });

    it('clears the cooldown only on the non-"read" -> "read" transition, not on every event while already read', async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1);

      // The real non-"read" -> "read" transition clears the cooldown, so
      // this waiting delivers despite being well inside the 60s window.
      h.sessionManager.setAttentionState(session.id, "read");
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(2);

      // The session is still "read" (nothing has flipped it back). An
      // unrelated update that merely re-fires "change" while attentionState
      // is unchanged (already "read") must NOT re-clear the fresh cooldown
      // stamp from the delivery above — only the transition INTO "read"
      // clears it, not every event observed while already in that state.
      h.sessionManager.updateSession(session.id, { gitBranch: "dev" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(2); // still within cooldown, correctly suppressed
    });
  });

  describe("races", () => {
    it("an out-of-order prefs resolution keeps the newer arm's timer, not a stale one", async () => {
      // The first two `getPrefs()` calls (both from `armFinishedTimer`) are
      // manually controlled so they can be resolved in reverse order,
      // simulating arm A's prefs read taking longer than arm B's. Anything
      // after that (the eventual `fire()` call) resolves immediately so the
      // test doesn't hang.
      const resolvers: Array<
        (value: { notifications?: NotificationsConfig }) => void
      > = [];
      let callIndex = 0;
      const defaultPrefs: { notifications?: NotificationsConfig } = {
        notifications: {
          enabled: true,
          events: ["waiting", "finished"],
        },
      };
      const h = createHarness({
        getPrefs: () => {
          const index = callIndex++;
          if (index < 2) {
            return new Promise<{ notifications?: NotificationsConfig }>(
              (resolve) => {
                resolvers[index] = resolve;
              },
            );
          }
          return Promise.resolve(defaultPrefs);
        },
      });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });

      // Arm A: working -> idle. Synchronously bumps generation 1 and
      // suspends on its own (uncontrolled) prefs promise (resolvers[0]).
      h.sessionManager.updateSession(session.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });

      // A later, genuinely newer transition for the same session: arm B
      // (working -> idle again). Synchronously bumps generation 2 — arm A's
      // timer doesn't exist yet (still awaiting), so there's nothing to
      // clear — then suspends on resolvers[1].
      await tick();
      h.sessionManager.updateSession(session.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });

      expect(resolvers.length).toBe(2);

      // Resolve OUT OF ORDER: the newer arm (B) first, the stale arm (A)
      // second — the scenario that silently dropped a valid notification
      // before the generation-counter fix.
      resolvers[1](defaultPrefs);
      await flush();
      resolvers[0](defaultPrefs);
      await flush();

      // Exactly one timer pending: arm B's. Arm A's late-resolving
      // continuation saw its generation was superseded and bailed instead
      // of clearing/replacing it.
      expect(h.scheduled.length).toBe(1);

      await h.fireScheduled();
      expect(h.delivered.length).toBe(1);
      expect(h.delivered[0].event).toBe("finished");
    });

    it("stamps the cooldown before awaiting delivery, so a second fire during an in-flight delivery is dropped", async () => {
      let releaseFirst: (() => void) | null = null;
      const delivered: NotificationPayload[] = [];
      let deliverCalls = 0;
      const h = createHarness({
        deliver: (payload: NotificationPayload) => {
          deliverCalls++;
          if (deliverCalls === 1) {
            return new Promise<void>((resolve) => {
              releaseFirst = () => {
                delivered.push(payload);
                resolve();
              };
            });
          }
          delivered.push(payload);
          return Promise.resolve();
        },
      });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });

      // First "waiting" fire reaches `deliver`, whose promise is held open
      // (simulating a slow notifier backend).
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(delivered.length).toBe(0);
      expect(releaseFirst).not.toBeNull();

      // A second "waiting" transition for the SAME session while the first
      // delivery is still in flight. This only reaches `deliver` again if
      // the cooldown wasn't stamped until after the first `deliver` call
      // resolved — with the fix, the stamp already happened synchronously
      // before that await, so this is dropped by the cooldown check.
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(delivered.length).toBe(0);
      expect(deliverCalls).toBe(1); // deliver was not invoked a second time

      releaseFirst!();
      await flush();
      expect(delivered.length).toBe(1);
    });
  });

  it("swallows a delivery failure and keeps notifying on subsequent events", async () => {
    let callCount = 0;
    const delivered: NotificationPayload[] = [];
    const h = createHarness({
      deliver: async (payload: NotificationPayload) => {
        callCount++;
        if (callCount === 1) throw new Error("delivery failed");
        delivered.push(payload);
      },
    });
    const notifier = new Notifier(h.deps);
    notifier.start();
    h.advanceTime(PAST_GRACE_WINDOW);

    const session = h.sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/tmp/myapp",
      pid: 1,
    });
    h.sessionManager.updateSession(session.id, { status: "waiting" });
    await flush();
    expect(delivered.length).toBe(0); // first call threw, swallowed

    // The cooldown is stamped before `deliver` is awaited (so two
    // concurrent fires can't both slip past the check — see the dedicated
    // cooldown-race test below), which means even a FAILED delivery leaves
    // a stamp behind. A retry within the 60s window is therefore still
    // suppressed by cooldown, not by the earlier failure.
    await tick();
    h.sessionManager.updateSession(session.id, { status: "idle" });
    await tick();
    h.sessionManager.updateSession(session.id, { status: "waiting" });
    await flush();
    expect(delivered.length).toBe(0);

    // Past the cooldown window, the retry goes through and succeeds.
    h.advanceTime(61_000);
    await tick();
    h.sessionManager.updateSession(session.id, { status: "idle" });
    await tick();
    h.sessionManager.updateSession(session.id, { status: "waiting" });
    await flush();
    expect(delivered.length).toBe(1);
  });

  describe("startup grace window", () => {
    // Explicitly start the fake clock at 0 (unlike the default harness,
    // which starts past the window) so `notifier.start()` stamps
    // `startedAt` at 0 and time 0 is "just booted."

    it("suppresses a waiting transition inside the window, and the edge stays consumed after it", async () => {
      const h = createHarness({ startTime: 0 });
      const notifier = new Notifier(h.deps);
      notifier.start();

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(0);

      // Past the window now, but replaying the same edge (a non-status
      // update re-fires "change" with the same statusChangedAt) must still
      // not deliver — the dedup set already consumed it.
      h.advanceTime(PAST_GRACE_WINDOW);
      h.sessionManager.updateSession(session.id, { gitBranch: "dev" });
      await flush();
      expect(h.delivered.length).toBe(0);
    });

    it("suppresses a finished transition inside the window without arming a timer", async () => {
      const h = createHarness({ startTime: 0 });
      const notifier = new Notifier(h.deps);
      notifier.start();

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await flush();

      expect(h.scheduled.length).toBe(0);
      expect(h.delivered.length).toBe(0);
    });

    it("delivers/arms normally once the window has passed", async () => {
      const h = createHarness({ startTime: 0 });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const waitingSession = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/waiting",
        pid: 1,
      });
      h.sessionManager.updateSession(waitingSession.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1);

      const finishedSession = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%2",
        cwd: "/tmp/finished",
        pid: 2,
      });
      h.sessionManager.updateSession(finishedSession.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(finishedSession.id, { status: "idle" });
      await flush();
      expect(h.scheduled.length).toBe(1);

      await h.fireScheduled();
      expect(h.delivered.length).toBe(2);
    });

    it("stop() + start() re-arms the grace window on restart", async () => {
      const h = createHarness({ startTime: 0 });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1); // window had already elapsed

      notifier.stop();
      notifier.start(); // re-stamps startedAt at the current (already-advanced) clock

      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();

      // Immediately after restart, still inside the fresh window.
      expect(h.delivered.length).toBe(1);
    });
  });

  describe("actionable payload stamping", () => {
    const claudeAgent = BUILTIN_AGENTS.find((a) => a.name === "claude")!;
    const opencodeAgent = BUILTIN_AGENTS.find((a) => a.name === "opencode")!;
    /** An agent with NO notificationActions map at all, kept map-less by
     *  stripping the field so it stays a valid "no map" fixture as built-in
     *  agents gain maps. */
    const noMapAgent: AgentDef = {
      ...opencodeAgent,
      notificationActions: undefined,
    };

    /** Drives a session to `waiting` with the given attention type and returns
     *  the single delivered payload. `buildContext` is stubbed off by default
     *  so the body is deterministic. */
    async function deliverWaiting(opts: {
      attentionType: Session["attentionType"];
      pendingTool?: string;
      getAgent?: NotifierDeps["getAgent"];
      buildContext?: NotifierDeps["buildContext"];
      ambiguousWait?: boolean;
    }): Promise<NotificationPayload> {
      const h = createHarness();
      const notifier = new Notifier({
        ...h.deps,
        getAgent: opts.getAgent,
        buildContext: opts.buildContext ?? (async () => ({ body: null })),
      });
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, {
        status: "waiting",
        attentionType: opts.attentionType,
        pendingTool: opts.pendingTool ?? null,
        ...(opts.ambiguousWait !== undefined
          ? { ambiguousWait: opts.ambiguousWait }
          : {}),
      });
      await flush();
      expect(h.delivered.length).toBe(1);
      return h.delivered[0];
    }

    /** Drives a session working -> idle and returns the single delivered
     *  finished payload. `buildContext` is stubbed to a value that must NEVER
     *  appear, so the assertions prove the waiting context is never consulted. */
    async function deliverFinished(
      getAgent?: NotifierDeps["getAgent"],
    ): Promise<NotificationPayload> {
      const h = createHarness();
      const notifier = new Notifier({
        ...h.deps,
        getAgent,
        buildContext: async () => ({ body: "should not appear" }),
        buildFinishedContext: async () => "Wrapped up the refactor.",
      });
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);
      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.setLogPath(session.id, "/tmp/myapp/log.jsonl");
      h.sessionManager.updateSession(session.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await flush();
      await h.fireScheduled();
      expect(h.delivered.length).toBe(1);
      return h.delivered[0];
    }

    it("stamps Approve/Deny AND Reply for a permission wait on Claude", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
        getAgent: () => claudeAgent,
      });
      expect(payload.actions).toEqual([
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ]);
      // Claude sets `permissionReplyPrelude`, so a permission wait also carries
      // the deny-with-feedback Reply.
      expect(payload.reply).toEqual({ id: "answer", label: "Reply" });
    });

    it("stamps Approve/Deny only when the agent has no permissionReplyPrelude", async () => {
      const noPermReplyAgent: AgentDef = {
        ...claudeAgent,
        notificationActions: { approve: ["1"], deny: ["Escape"] },
      };
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
        getAgent: () => noPermReplyAgent,
      });
      expect(payload.actions).toEqual([
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ]);
      expect(payload.reply).toBeUndefined();
    });

    it("omits buttons for a permission wait when the agent has no map", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
        getAgent: () => noMapAgent,
      });
      expect(payload.actions).toBeUndefined();
    });

    it("stamps Approve/Deny for an opencode permission wait (mapped, single wait)", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "external_directory",
        getAgent: () => opencodeAgent,
      });
      expect(payload.actions).toEqual([
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ]);
      // OpenCode has no permissionReplyPrelude, so no deny-with-feedback Reply.
      expect(payload.reply).toBeUndefined();
    });

    it("suppresses opencode buttons when the aggregate has multiple concurrent waits", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "external_directory",
        getAgent: () => opencodeAgent,
        ambiguousWait: true,
      });
      // A keystroke would land on whichever dialog the shared pane renders, so
      // the notification ships informational-only.
      expect(payload.actions).toBeUndefined();
      expect(payload.reply).toBeUndefined();
    });

    it("omits buttons when no agent lookup is wired", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
      });
      expect(payload.actions).toBeUndefined();
    });

    it("omits buttons for a def with only approve (both Approve+Deny or neither)", async () => {
      const approveOnlyAgent: AgentDef = {
        ...claudeAgent,
        notificationActions: { approve: ["1"] },
      };
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
        getAgent: () => approveOnlyAgent,
      });
      // A lone button matches none of the macOS helper's registered categories,
      // so it is dropped rather than shipped as a silently button-less banner.
      expect(payload.actions).toBeUndefined();
    });

    it("stamps neither actions nor reply for a paneless (background) wait", async () => {
      const h = createHarness();
      const notifier = new Notifier({
        ...h.deps,
        getAgent: () => claudeAgent,
        buildContext: async () => ({ body: null }),
      });
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);
      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      // Soft-evict the pane: a background/paneless row can only 409 a press.
      // (tmuxPane is a binding, not a SessionState field, so null it directly.)
      session.tmuxPane = null;
      h.sessionManager.updateSession(session.id, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
      });
      await flush();
      expect(h.delivered.length).toBe(1);
      expect(h.delivered[0].actions).toBeUndefined();
      expect(h.delivered[0].reply).toBeUndefined();
    });

    it("stamps a Reply action for a Claude question wait", async () => {
      const payload = await deliverWaiting({
        attentionType: "question",
        getAgent: () => claudeAgent,
      });
      expect(payload.reply).toEqual({ id: "answer", label: "Reply" });
      expect(payload.actions).toBeUndefined();
    });

    it("stamps no Reply for a question wait when the agent lacks replyOnQuestion", async () => {
      const payload = await deliverWaiting({
        attentionType: "question",
        getAgent: () => opencodeAgent,
      });
      expect(payload.reply).toBeUndefined();
      expect(payload.actions).toBeUndefined();
    });

    it("stamps no Reply for a question wait when replyOnQuestion lacks an answerPrelude", async () => {
      // Mirrors the handler's question-row gate: with no cancel key the press
      // would 409 (the picker ignores typed text), so no button is offered.
      // Reachable only via an override, since notificationActions is a
      // whole-map replace and the built-in def always carries answerPrelude.
      const noPreludeAgent: AgentDef = {
        ...claudeAgent,
        notificationActions: {
          approve: ["1"],
          deny: ["Escape"],
          replyOnQuestion: true,
        },
      };
      const payload = await deliverWaiting({
        attentionType: "question",
        getAgent: () => noPreludeAgent,
      });
      expect(payload.reply).toBeUndefined();
      expect(payload.actions).toBeUndefined();
    });

    it("stamps Approve/Deny AND Reply for a plan_approval wait on Claude", async () => {
      const payload = await deliverWaiting({
        attentionType: "plan_approval",
        getAgent: () => claudeAgent,
      });
      expect(payload.actions).toEqual([
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ]);
      expect(payload.reply).toEqual({ id: "answer", label: "Reply" });
      expect(payload.subtitle).toBe("Plan ready for review");
    });

    it("stamps neither actions nor reply for a plan_approval wait when the agent has no plan keys", async () => {
      const payload = await deliverWaiting({
        attentionType: "plan_approval",
        getAgent: () => opencodeAgent,
      });
      expect(payload.actions).toBeUndefined();
      expect(payload.reply).toBeUndefined();
    });

    it("delivery-time reclassify: a permission wait revealed as a plan gets plan actions, not permission actions", async () => {
      // Plan-only agent: if the permission branch ran (it should NOT), there
      // would be no approve/deny/reply, so any actions prove the plan branch ran.
      const planOnlyAgent: AgentDef = {
        ...claudeAgent,
        notificationActions: {
          planApprove: ["2"],
          planDeny: ["Escape"],
          planReplyPrelude: ["Escape"],
        },
      };
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "ExitPlanMode",
        getAgent: () => planOnlyAgent,
        buildContext: async () => ({
          body: "Plan: add a hello-world script",
          reclassifyAs: "plan_approval",
        }),
      });
      expect(payload.actions).toEqual([
        { id: "approve", label: "Approve" },
        { id: "deny", label: "Deny" },
      ]);
      expect(payload.reply).toEqual({ id: "answer", label: "Reply" });
      // The subtitle rebuilds for the reclassified (plan) type, not the stored
      // "Needs permission: ExitPlanMode".
      expect(payload.subtitle).toBe("Plan ready for review");
      expect(payload.body).toBe("Plan: add a hello-world script");
    });

    it("puts the buildContext text in the body, with the event line in the subtitle", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
        getAgent: () => claudeAgent,
        buildContext: async () => ({ body: "Bash: rm -rf /tmp/x" }),
      });
      expect(payload.subtitle).toBe("Needs permission: Bash");
      expect(payload.body).toBe("Bash: rm -rf /tmp/x");
    });

    it("delivery-time reclassify: a permission wait the pane reveals as a question gets Reply, not Approve/Deny", async () => {
      const payload = await deliverWaiting({
        // Store still says permission (Part 1's scan correction hasn't landed).
        attentionType: "permission",
        pendingTool: "Bash",
        getAgent: () => claudeAgent,
        buildContext: async () => ({
          body: "What's your favorite color?",
          reclassifyAs: "question",
        }),
      });
      expect(payload.reply).toEqual({ id: "answer", label: "Reply" });
      expect(payload.actions).toBeUndefined();
      // The SUBTITLE is rebuilt for the effective (question) type, not the
      // stored "Needs permission: Bash"; the body is the question text alone.
      expect(payload.subtitle).toBe("Waiting for your input");
      expect(payload.body).toBe("What's your favorite color?");
    });

    it("stamps statusChangedAt as the staleness token", async () => {
      const h = createHarness();
      const notifier = new Notifier({
        ...h.deps,
        buildContext: async () => ({ body: null }),
      });
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);
      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
      });
      await flush();
      const live = h.sessionManager.getSession(session.id);
      expect(h.delivered[0].statusChangedAt).toBe(live!.statusChangedAt!);
    });

    it("stamps attentionGeneration alongside the staleness token", async () => {
      const h = createHarness();
      const notifier = new Notifier({
        ...h.deps,
        buildContext: async () => ({ body: null }),
      });
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);
      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
      });
      await flush();
      const live = h.sessionManager.getSession(session.id);
      expect(h.delivered[0].attentionGeneration).toBe(
        live!.attentionGeneration,
      );
    });

    it("stamps a Reply on a finished Claude notification, no buttons, and never consults the waiting context", async () => {
      const payload = await deliverFinished(() => claudeAgent);
      expect(payload.event).toBe("finished");
      expect(payload.subtitle).toBe("Finished");
      // The finished body is the enrichment, not the waiting context.
      expect(payload.body).toBe("Wrapped up the refactor.");
      expect(payload.actions).toBeUndefined();
      expect(payload.reply).toEqual({ id: "answer", label: "Reply" });
    });

    it("stamps no Reply on a finished notification when no agent lookup is wired", async () => {
      const payload = await deliverFinished();
      expect(payload.reply).toBeUndefined();
      expect(payload.actions).toBeUndefined();
    });

    it("stamps no Reply on a finished notification for an agent without replyOnFinished", async () => {
      const payload = await deliverFinished(() => opencodeAgent);
      expect(payload.reply).toBeUndefined();
      expect(payload.actions).toBeUndefined();
    });

    it("finished body stays empty when the finished context yields nothing", async () => {
      const payload = await (async () => {
        const h = createHarness();
        const notifier = new Notifier({
          ...h.deps,
          buildFinishedContext: async () => null,
        });
        notifier.start();
        h.advanceTime(PAST_GRACE_WINDOW);
        const session = h.sessionManager.createPaneTrackedSession({
          agentType: "claude",
          paneId: "%1",
          cwd: "/tmp/myapp",
          pid: 1,
        });
        h.sessionManager.setLogPath(session.id, "/tmp/myapp/log.jsonl");
        h.sessionManager.updateSession(session.id, { status: "working" });
        await tick();
        h.sessionManager.updateSession(session.id, { status: "idle" });
        await flush();
        await h.fireScheduled();
        return h.delivered[0];
      })();
      expect(payload.subtitle).toBe("Finished");
      expect(payload.body).toBe("");
    });
  });

  describe("retract on wait resolution", () => {
    /** Creates a session and drives it to a delivered `waiting` notification,
     *  returning the session so the caller can resolve the wait. */
    async function deliverWaiting(h: ReturnType<typeof createHarness>) {
      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
      });
      await flush();
      return session;
    }

    it("retracts once when a delivered waiting resolves to working", async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = await deliverWaiting(h);
      expect(h.delivered.length).toBe(1);
      expect(h.retracted.length).toBe(0);

      await tick();
      h.sessionManager.updateSession(session.id, { status: "working" });
      await flush();
      expect(h.retracted).toEqual([session.id]);

      // A further non-waiting update must not retract again (tracking cleared).
      await tick();
      h.sessionManager.updateSession(session.id, { gitBranch: "feature" });
      await flush();
      expect(h.retracted).toEqual([session.id]);
    });

    it("does not retract when no waiting notification was delivered", async () => {
      const h = createHarness();
      // Notifications disabled: the wait is observed but nothing is delivered,
      // so there is no banner to retract when it resolves.
      h.setPrefs({ notifications: { enabled: false } });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = await deliverWaiting(h);
      expect(h.delivered.length).toBe(0);

      await tick();
      h.sessionManager.updateSession(session.id, { status: "working" });
      await flush();
      expect(h.retracted).toEqual([]);
    });

    it("does not retract on a waiting -> waiting attention swap", async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = await deliverWaiting(h);
      expect(h.delivered.length).toBe(1);

      // Same status, different attention: the wait is still live, so the
      // banner must stay.
      await tick();
      h.sessionManager.updateSession(session.id, {
        status: "waiting",
        attentionType: "question",
        pendingTool: "AskUserQuestion",
      });
      await flush();
      expect(h.retracted).toEqual([]);
    });

    it("retracts the waiting banner then still delivers finished on waiting -> idle", async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = await deliverWaiting(h);
      expect(h.delivered.length).toBe(1);

      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await flush();

      // Retract fires immediately on the resolving transition...
      expect(h.retracted).toEqual([session.id]);
      // ...and the separate finished notification still arms + delivers.
      expect(h.scheduled.length).toBe(1);
      await h.fireScheduled();
      expect(h.delivered.some((p) => p.event === "finished")).toBe(true);
      // Still exactly one retract.
      expect(h.retracted).toEqual([session.id]);
    });

    it("does not retract a finished-only session (no waiting was delivered)", async () => {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      h.sessionManager.updateSession(session.id, { status: "working" });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "idle" });
      await flush();
      await h.fireScheduled();

      expect(h.delivered.some((p) => p.event === "finished")).toBe(true);
      expect(h.retracted).toEqual([]);
    });

    it("retracts once when the wait resolves mid-delivery (no lingering banner)", async () => {
      const sessionManager = new SessionManager();
      let sessionId = "";
      let flipped = false;
      // Delivery flips the session to `working` before it resolves, so
      // handleChange sees the resolving edge while deliveredWaiting is still
      // empty (the race). The post-delivery re-check in fire() must catch it.
      const h = createHarness({
        sessionManager,
        deliver: async () => {
          if (!flipped && sessionId) {
            flipped = true;
            sessionManager.updateSession(sessionId, { status: "working" });
          }
        },
      });
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);

      const session = sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
      sessionId = session.id;
      sessionManager.updateSession(session.id, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
      });
      await flush();

      expect(h.retracted).toEqual([session.id]);

      // deliveredWaiting must not have been left populated: a further
      // non-waiting update would otherwise retract a second time.
      await tick();
      sessionManager.updateSession(session.id, { gitBranch: "feature" });
      await flush();
      expect(h.retracted).toEqual([session.id]);
    });
  });

  describe("title", () => {
    /** Drives a session (project = basename of `cwd`) to `waiting`, optionally
     *  with a git branch, and returns the delivered payload's title. */
    async function titleFor(
      gitBranch: string | null,
      cwd = "/tmp/myapp",
    ): Promise<string> {
      const h = createHarness();
      const notifier = new Notifier(h.deps);
      notifier.start();
      h.advanceTime(PAST_GRACE_WINDOW);
      const session = h.sessionManager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd,
        pid: 1,
      });
      if (gitBranch) h.sessionManager.updateSession(session.id, { gitBranch });
      await tick();
      h.sessionManager.updateSession(session.id, { status: "waiting" });
      await flush();
      expect(h.delivered.length).toBe(1);
      return h.delivered[0].title;
    }

    it("is agent-first with the project:branch ref", async () => {
      expect(await titleFor("main")).toBe("Claude · myapp:main");
    });

    it("omits the branch (and its colon) when there is none", async () => {
      expect(await titleFor(null)).toBe("Claude · myapp");
    });

    it("passes a long project:branch ref through untruncated (macOS tail-truncates at render)", async () => {
      expect(await titleFor("feat/notification-content")).toBe(
        "Claude · myapp:feat/notification-content",
      );
    });
  });

  describe("buildStateChangedPayload", () => {
    function makeSession(): Session {
      const sm = new SessionManager();
      return sm.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%1",
        cwd: "/tmp/myapp",
        pid: 1,
      });
    }

    it("carries the configured command and sound so the re-notify still delivers", () => {
      // Regression: this payload was previously built with cfg=undefined, so on
      // the "command" backend it delivered NOTHING (no payload.command) and the
      // configured sound was dropped.
      const payload = buildStateChangedPayload(
        makeSession(),
        "State changed. Check the pane.",
        { enabled: true, command: "my-notify.sh", sound: "Glass" },
      );
      expect(payload.command).toBe("my-notify.sh");
      expect(payload.sound).toBe("Glass");
      expect(payload.body).toBe("State changed. Check the pane.");
      // The self-contained message is the whole notification: the base waiting
      // subtitle is cleared so it doesn't prepend a stale "Needs permission".
      expect(payload.subtitle).toBeUndefined();
      // Informational only: no action buttons or reply on a stale-press notice.
      expect(payload.event).toBe("waiting");
      expect(payload.actions).toBeUndefined();
      expect(payload.reply).toBeUndefined();
    });

    it("tolerates an undefined config (no command/sound to carry)", () => {
      const payload = buildStateChangedPayload(
        makeSession(),
        "body",
        undefined,
      );
      expect(payload.command).toBeUndefined();
      expect(payload.sound).toBeUndefined();
      expect(payload.body).toBe("body");
    });
  });
});
