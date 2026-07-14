import { describe, it, expect } from "bun:test";
import {
  Notifier,
  buildStateChangedPayload,
  decideNotification,
  type NotifierDeps,
  type NotificationsConfig,
} from "./notifier";
import { SessionManager } from "./sessions";
import { BUILTIN_AGENTS } from "../lib/agents";
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
    buildContext: overrides.buildContext ?? (async () => null),
    deliver:
      overrides.deliver ??
      (async (payload: NotificationPayload) => {
        delivered.push(payload);
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
    expect(h.delivered[0].body).toBe("Needs permission: Bash");
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
    expect(h.delivered[0].body).toBe("Finished");
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

    /** Drives a session to `waiting` with the given attention type and returns
     *  the single delivered payload. `buildContext` is stubbed off by default
     *  so the body is deterministic. */
    async function deliverWaiting(opts: {
      attentionType: Session["attentionType"];
      pendingTool?: string;
      getAgent?: NotifierDeps["getAgent"];
      buildContext?: NotifierDeps["buildContext"];
    }): Promise<NotificationPayload> {
      const h = createHarness();
      const notifier = new Notifier({
        ...h.deps,
        getAgent: opts.getAgent,
        buildContext: opts.buildContext ?? (async () => null),
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
      });
      await flush();
      expect(h.delivered.length).toBe(1);
      return h.delivered[0];
    }

    it("stamps Approve/Deny for a permission wait when the agent has a map", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
        getAgent: () => claudeAgent,
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
        getAgent: () => opencodeAgent,
      });
      expect(payload.actions).toBeUndefined();
    });

    it("omits buttons when no agent lookup is wired", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
      });
      expect(payload.actions).toBeUndefined();
    });

    it("stamps a Reply action for a Claude question wait", async () => {
      const payload = await deliverWaiting({
        attentionType: "question",
        getAgent: () => claudeAgent,
      });
      expect(payload.reply).toEqual({ id: "answer", label: "Reply" });
      expect(payload.actions).toBeUndefined();
    });

    it("appends buildContext text to the base body", async () => {
      const payload = await deliverWaiting({
        attentionType: "permission",
        pendingTool: "Bash",
        getAgent: () => claudeAgent,
        buildContext: async () => "Bash: rm -rf /tmp/x",
      });
      expect(payload.body).toBe("Needs permission: Bash\nBash: rm -rf /tmp/x");
    });

    it("stamps statusChangedAt as the staleness token", async () => {
      const h = createHarness();
      const notifier = new Notifier({
        ...h.deps,
        buildContext: async () => null,
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

    it("gives a finished notification no buttons, reply, or context", async () => {
      const h = createHarness();
      const notifier = new Notifier({
        ...h.deps,
        getAgent: () => claudeAgent,
        // Would append if consulted; a finished notification must skip it.
        buildContext: async () => "should not appear",
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
      expect(h.delivered[0].event).toBe("finished");
      expect(h.delivered[0].body).toBe("Finished");
      expect(h.delivered[0].actions).toBeUndefined();
      expect(h.delivered[0].reply).toBeUndefined();
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
