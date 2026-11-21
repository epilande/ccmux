import { waitForIdleMarker, waitForMarkerState } from "./marker-test-helpers";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { makeExtension } from "./ccmux.js";
import type { OmpExtensionApi, OmpExtensionContext } from "./ccmux.js";

const tempRoot = join(
  tmpdir(),
  `ccmux-omp-ext-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const markersDir = join(tempRoot, "markers");

type Handler = (
  event: unknown,
  ctx: OmpExtensionContext,
) => void | Promise<void>;

type Fire = (
  event: string,
  payload?: unknown,
  ctx?: OmpExtensionContext,
  opts?: { settleIdle?: boolean },
) => void | Promise<void>;

function makeCtx(
  sessionId: string | undefined,
  file?: string,
  cwd = "/repo",
): OmpExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => file,
    },
  };
}

/**
 * A ctx whose managed-timer and isIdle surface is fake but controllable:
 * `tick()` runs every reconcile callback that has not been cleared and
 * awaits the marker write each one queues.
 */
function makeTimedCtx(
  sessionId: string | undefined,
  file?: string,
  cwd = "/repo",
) {
  const timers: Array<(() => void) | undefined> = [];
  const live = { idle: true };
  const ctx: OmpExtensionContext = {
    ...makeCtx(sessionId, file, cwd),
    isIdle: () => live.idle,
    setInterval: (fn: () => void, _ms: number) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimer: (id: unknown) => {
      if (typeof id === "number") timers[id] = undefined;
    },
  };
  return {
    ctx,
    setIdle: (idle: boolean) => {
      live.idle = idle;
    },
    tick: async () => {
      for (const fn of [...timers]) await fn?.();
    },
  };
}

/**
 * Register the extension against a fake omp and return a dispatcher for its
 * handlers. Events default to a null payload on session `S1`; pass a ctx to
 * target a different session id, transcript path, or cwd.
 */
function startExtension(now?: () => number): Fire {
  const handlers = new Map<string, Handler>();
  const omp: OmpExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  };
  makeExtension({ markersDir, version: "1.0.0", now })(omp);
  const defaultCtx = makeCtx("S1");
  return async (event, payload = null, ctx = defaultCtx, opts) => {
    await handlers.get(event)!(payload, ctx);
    if (event === "agent_end" && opts?.settleIdle !== false) {
      await waitForIdleMarker(markersDir, ctx.sessionManager.getSessionId()!);
    }
  };
}

/** The event names the extension subscribes to, for registration guards. */
function registeredEvents(): string[] {
  const names: string[] = [];
  makeExtension({ markersDir, version: "1.0.0" })({
    on: (event) => {
      names.push(event);
    },
  });
  return names;
}

function markerPath(sessionId: string): string {
  return join(markersDir, `omp-${sessionId}.json`);
}

function readMarker(sessionId: string) {
  return JSON.parse(readFileSync(markerPath(sessionId), "utf-8"));
}

describe("omp ccmux extension", () => {
  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(markersDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes an idle marker with full identity on session_start", async () => {
    const fire = startExtension(() => 1_700_000_000_000);
    const ctx = makeCtx("S1", "/home/u/.omp/agent/sessions/x/abc.jsonl");

    await fire("session_start", null, ctx);

    const marker = readMarker("S1");
    expect(marker.agent_type).toBe("omp");
    expect(marker.session_id).toBe("S1");
    expect(marker.pid).toBe(process.pid);
    expect(marker.state).toBe("idle");
    expect(marker.directory).toBe("/repo");
    expect(marker.transcript_path).toBe(
      "/home/u/.omp/agent/sessions/x/abc.jsonl",
    );
    expect(marker.state_timestamp).toBe(1_700_000_000);
  });

  it("flips working on agent_start and idle on agent_end", async () => {
    const fire = startExtension();

    await fire("session_start");
    await fire("agent_start");
    expect(readMarker("S1").state).toBe("working");

    await fire("agent_end");
    expect(readMarker("S1").state).toBe("idle");
  });

  it("captures the prompt from before_agent_start and preserves it across state flips", async () => {
    const fire = startExtension();

    await fire("session_start");
    await fire("before_agent_start", { prompt: "  fix the bug  " });
    await fire("agent_start");

    const marker = readMarker("S1");
    expect(marker.last_prompt).toBe("fix the bug");
    expect(marker.state).toBe("working");
  });

  it("removes the marker on session_shutdown", async () => {
    const fire = startExtension();

    await fire("session_start");
    expect(existsSync(markerPath("S1"))).toBe(true);

    await fire("session_shutdown");
    expect(existsSync(markerPath("S1"))).toBe(false);
  });

  it("no-ops when no session id is available", async () => {
    const fire = startExtension();

    await fire("session_start", null, makeCtx(undefined));
    // No marker file written for an absent session id.
    expect(existsSync(markerPath("undefined"))).toBe(false);
  });

  describe("tool approval tracking", () => {
    it("writes waiting_permission with the gated tool name on tool_approval_requested", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", {
        type: "tool_approval_requested",
        sessionId: "S1",
        toolCallId: "call-1",
        toolName: "bash",
        approvalMode: "default",
      });

      const marker = readMarker("S1");
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("bash");
    });

    it("returns to working and clears pending_tool once the approval resolves", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      await fire("tool_approval_resolved", {
        toolCallId: "call-1",
        toolName: "bash",
        approved: true,
      });

      const marker = readMarker("S1");
      expect(marker.state).toBe("working");
      expect(marker.pending_tool).toBeUndefined();
    });

    it("resumes working on a DENIED resolve too (the agent loop continues either way)", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      await fire("tool_approval_resolved", {
        toolCallId: "call-1",
        toolName: "bash",
        approved: false,
      });

      expect(readMarker("S1").state).toBe("working");
    });

    it("stays waiting until the LAST of several overlapping approvals resolves", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      await fire("tool_approval_requested", {
        toolCallId: "call-2",
        toolName: "write",
      });
      // pending_tool names the OLDEST outstanding request: omp's dialog
      // surface is FIFO, so call-1's prompt is the one on screen.
      expect(readMarker("S1").pending_tool).toBe("bash");

      await fire("tool_approval_resolved", {
        toolCallId: "call-1",
        approved: true,
      });
      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S1").pending_tool).toBe("write");

      await fire("tool_approval_resolved", {
        toolCallId: "call-2",
        approved: true,
      });
      expect(readMarker("S1").state).toBe("working");
    });

    it("publishes the FIRST tool while a later request is still queued behind it", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      expect(readMarker("S1").pending_tool).toBe("bash");

      await fire("tool_approval_requested", {
        toolCallId: "call-2",
        toolName: "web_fetch",
      });

      const marker = readMarker("S1");
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("bash");
    });

    it("re-publishes the next tool name when the head approval resolves", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      await fire("tool_approval_requested", {
        toolCallId: "call-2",
        toolName: "web_fetch",
      });
      await fire("tool_approval_resolved", {
        toolCallId: "call-1",
        toolName: "bash",
        approved: true,
      });

      // Still waiting, but named after the prompt now on screen.
      const marker = readMarker("S1");
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("web_fetch");
    });

    it("keeps naming the head tool when approvals resolve out of order", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      await fire("tool_approval_requested", {
        toolCallId: "call-2",
        toolName: "web_fetch",
      });
      // The second request resolves first (the fail-closed no-UI path can
      // land on any outstanding id).
      await fire("tool_approval_resolved", {
        toolCallId: "call-2",
        approved: false,
      });

      const marker = readMarker("S1");
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("bash");

      await fire("tool_approval_resolved", {
        toolCallId: "call-1",
        approved: true,
      });
      const after = readMarker("S1");
      expect(after.state).toBe("working");
      expect(after.pending_tool).toBeUndefined();
    });

    it("clears the pending set on agent_end so a leaked id can't pin the next turn", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      // Aborted turn: agent_end lands with the id still outstanding.
      await fire("agent_end");
      expect(readMarker("S1").state).toBe("idle");
      expect(readMarker("S1").pending_tool).toBeUndefined();

      // A late resolve for the abandoned id must not drag the idle row back
      // up to working.
      await fire("tool_approval_resolved", {
        toolCallId: "call-1",
        approved: false,
      });
      expect(readMarker("S1").state).toBe("idle");

      // The next turn's approval still works.
      await fire("agent_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-2",
        toolName: "edit",
      });
      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S1").pending_tool).toBe("edit");
    });

    it("ignores an approval request with no correlatable tool call id", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", { toolName: "bash" });

      // No waiting marker: nothing to resolve it later.
      expect(readMarker("S1").state).toBe("working");
    });

    it("resolves everything outstanding when a resolve carries no tool call id", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      await fire("tool_approval_resolved", { approved: true });

      // Fail-open on the wait, not the state: drop everything outstanding
      // rather than risk a row stuck at waiting; the live turn's reason
      // keeps the row working.
      expect(readMarker("S1").state).toBe("working");
    });

    it("keys pending approvals per session id", async () => {
      const fire = startExtension();
      const ctxA = makeCtx("S1");
      const ctxB = makeCtx("S2");

      await fire("session_start", null, ctxA);
      await fire("session_start", null, ctxB);
      await fire(
        "tool_approval_requested",
        { toolCallId: "call-1", toolName: "bash" },
        ctxA,
      );

      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S2").state).toBe("idle");

      // Resolving S1's id against S2 must not touch either row's wait.
      await fire(
        "tool_approval_resolved",
        { toolCallId: "call-1", approved: true },
        ctxB,
      );
      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S2").state).toBe("idle");
    });
  });

  describe("session_switch", () => {
    // omp's /new and /resume mutate the session in place and emit
    // session_switch, not pi's shutdown/start pair.
    const switchEvent = (reason: "new" | "resume") => ({
      type: "session_switch",
      reason,
      previousSessionFile: "/home/u/.omp/agent/sessions/x/old.jsonl",
    });

    it("reaps the old session's marker and seeds an idle marker for the new id", async () => {
      const fire = startExtension(() => 1_700_000_000_000);
      const oldCtx = makeCtx("S1", "/home/u/.omp/agent/sessions/x/old.jsonl");

      await fire("session_start", null, oldCtx);
      await fire("before_agent_start", { prompt: "old work" }, oldCtx);
      expect(existsSync(markerPath("S1"))).toBe(true);

      // /new installs the new id before emitting, so the handler's ctx
      // already reports S2.
      const newCtx = makeCtx("S2", "/home/u/.omp/agent/sessions/x/new.jsonl");
      await fire("session_switch", switchEvent("new"), newCtx);

      expect(existsSync(markerPath("S1"))).toBe(false);
      const marker = readMarker("S2");
      expect(marker.agent_type).toBe("omp");
      expect(marker.session_id).toBe("S2");
      expect(marker.pid).toBe(process.pid);
      expect(marker.state).toBe("idle");
      expect(marker.directory).toBe("/repo");
      expect(marker.transcript_path).toBe(
        "/home/u/.omp/agent/sessions/x/new.jsonl",
      );
      expect(marker.state_timestamp).toBe(1_700_000_000);
      // The old session's prompt must not ride along onto the new row.
      expect(marker.last_prompt).toBeUndefined();
    });

    it("drops the old session's in-memory state so its marker is not rewritten", async () => {
      const fire = startExtension();
      const oldCtx = makeCtx("S1");

      await fire("session_start", null, oldCtx);
      const newCtx = makeCtx("S2");
      await fire("session_switch", switchEvent("resume"), newCtx);

      // A stray late event for the abandoned session must not resurrect its
      // marker file.
      await fire(
        "tool_approval_resolved",
        { toolCallId: "call-1", approved: true },
        oldCtx,
      );
      expect(existsSync(markerPath("S1"))).toBe(false);
      expect(readMarker("S2").state).toBe("idle");
    });

    it("clears approvals left outstanding by the switched-away session", async () => {
      const fire = startExtension();
      const oldCtx = makeCtx("S1");

      await fire("session_start", null, oldCtx);
      await fire("agent_start", null, oldCtx);
      await fire(
        "tool_approval_requested",
        { toolCallId: "call-1", toolName: "bash" },
        oldCtx,
      );
      expect(readMarker("S1").state).toBe("waiting_permission");

      // The switch aborts the turn while the prompt is still open.
      const newCtx = makeCtx("S2");
      await fire("session_switch", switchEvent("new"), newCtx);

      // The new session starts from a clean slate: the abandoned id cannot
      // pin it at waiting, and its late resolve cannot drag it up to working.
      await fire(
        "tool_approval_resolved",
        { toolCallId: "call-1", approved: false },
        newCtx,
      );
      expect(readMarker("S2").state).toBe("idle");

      await fire("agent_start", null, newCtx);
      await fire(
        "tool_approval_requested",
        { toolCallId: "call-2", toolName: "edit" },
        newCtx,
      );
      expect(readMarker("S2").state).toBe("waiting_permission");
      expect(readMarker("S2").pending_tool).toBe("edit");
    });

    it("clears a same-id switch's pending approval (reload re-enters switchSession)", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });

      await fire("session_switch", switchEvent("resume"));

      const marker = readMarker("S1");
      expect(marker.state).toBe("idle");
      expect(marker.pending_tool).toBeUndefined();

      // A late resolve for the aborted approval must not write working.
      await fire("tool_approval_resolved", {
        toolCallId: "call-1",
        approved: true,
      });
      expect(readMarker("S1").state).toBe("idle");
    });

    it("no-ops when the switch lands with no resolvable session id", async () => {
      const fire = startExtension();

      await fire("session_start");
      // Bailing (rather than treating every tracked id as stale) keeps an
      // unreadable session id from deleting the live session's marker.
      await fire("session_switch", switchEvent("new"), makeCtx(undefined));

      expect(existsSync(markerPath("S1"))).toBe(true);
    });
  });

  describe("session_branch", () => {
    // `/branch` and `app.session.fork` mint a fresh session id exactly the
    // way /new and /resume do, but emit `session_branch` instead of
    // `session_switch`.
    const branchEvent = () => ({
      type: "session_branch",
      previousSessionFile: "/home/u/.omp/agent/sessions/x/old.jsonl",
    });

    it("reaps the old session's marker and seeds an idle marker for the branched id", async () => {
      const fire = startExtension(() => 1_700_000_000_000);
      const oldCtx = makeCtx("S1", "/home/u/.omp/agent/sessions/x/old.jsonl");

      await fire("session_start", null, oldCtx);
      await fire("before_agent_start", { prompt: "pre-branch work" }, oldCtx);
      expect(existsSync(markerPath("S1"))).toBe(true);

      const newCtx = makeCtx("S2", "/home/u/.omp/agent/sessions/x/new.jsonl");
      await fire("session_branch", branchEvent(), newCtx);

      expect(existsSync(markerPath("S1"))).toBe(false);
      const marker = readMarker("S2");
      expect(marker.session_id).toBe("S2");
      expect(marker.state).toBe("idle");
      expect(marker.transcript_path).toBe(
        "/home/u/.omp/agent/sessions/x/new.jsonl",
      );
      // The pre-branch prompt must not ride along onto the branched row.
      expect(marker.last_prompt).toBeUndefined();
    });

    it("clears approvals left outstanding by the branched-away session", async () => {
      const fire = startExtension();
      const oldCtx = makeCtx("S1");

      await fire("session_start", null, oldCtx);
      await fire("agent_start", null, oldCtx);
      await fire(
        "tool_approval_requested",
        { toolCallId: "call-1", toolName: "bash" },
        oldCtx,
      );
      expect(readMarker("S1").state).toBe("waiting_permission");

      const newCtx = makeCtx("S2");
      await fire("session_branch", branchEvent(), newCtx);

      // The abandoned approval cannot pin the branched session at waiting.
      await fire(
        "tool_approval_resolved",
        { toolCallId: "call-1", approved: false },
        newCtx,
      );
      expect(readMarker("S2").state).toBe("idle");
    });

    it("no-ops when the branch lands with no resolvable session id", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("session_branch", branchEvent(), makeCtx(undefined));

      expect(existsSync(markerPath("S1"))).toBe(true);
    });

    it("rebinds on the post-rename session_fork alias too", async () => {
      // Upstream renamed session_branch -> session_fork; omp still emits the
      // old name but tracks upstream, so both must rebind.
      const fire = startExtension();

      await fire("session_start", null, makeCtx("S1"));
      expect(existsSync(markerPath("S1"))).toBe(true);

      await fire(
        "session_fork",
        { type: "session_fork", previousSessionFile: undefined },
        makeCtx("S2"),
      );

      expect(existsSync(markerPath("S1"))).toBe(false);
      expect(readMarker("S2").state).toBe("idle");
    });

    it("subscribes to every id-changing rebind event, but not session_tree", () => {
      const events = registeredEvents();

      expect(events).toContain("session_switch");
      expect(events).toContain("session_branch");
      expect(events).toContain("session_fork");
      // `session_tree` moves a leaf within the current session, so the id is
      // untouched and rebinding would be wrong.
      expect(events).not.toContain("session_tree");
    });
  });

  describe("compaction and retry activity", () => {
    it("tracks a manual compaction as working until it ends", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("manual_compaction_start");
      expect(readMarker("S1").state).toBe("working");

      // The start shapes overlap (session.compacting fires from the shared
      // foreground path); the named reason keeps that idempotent.
      await fire("session.compacting");
      expect(readMarker("S1").state).toBe("working");

      await fire("manual_compaction_end");
      expect(readMarker("S1").state).toBe("idle");
    });

    it("stays working across auto-compaction that outlives the turn", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("auto_compaction_start");
      // The turn ends while the compaction is still running.
      await fire("agent_end", null, undefined, { settleIdle: false });
      await waitForMarkerState(markersDir, "S1", "working");

      await fire("auto_compaction_end");
      expect(readMarker("S1").state).toBe("idle");
    });

    it("marks auto-compaction started after a turn as working", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("agent_end");
      expect(readMarker("S1").state).toBe("idle");

      // The headline gap: post-turn auto-compaction used to read as idle
      // while the session was busy compacting.
      await fire("auto_compaction_start");
      expect(readMarker("S1").state).toBe("working");

      await fire("auto_compaction_end");
      expect(readMarker("S1").state).toBe("idle");
    });

    it("stays working across retry backoff between turns", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("agent_start");
      await fire("agent_end");
      await fire("auto_retry_start");
      expect(readMarker("S1").state).toBe("working");

      await fire("auto_retry_end");
      expect(readMarker("S1").state).toBe("idle");
    });

    it("keeps an approval wait on top of running activity", async () => {
      const fire = startExtension();

      await fire("session_start");
      await fire("auto_compaction_start");
      await fire("tool_approval_requested", {
        toolCallId: "call-1",
        toolName: "bash",
      });
      const waiting = readMarker("S1");
      expect(waiting.state).toBe("waiting_permission");
      expect(waiting.pending_tool).toBe("bash");

      // The resolve lands while the compaction is still running.
      await fire("tool_approval_resolved", {
        toolCallId: "call-1",
        approved: true,
      });
      expect(readMarker("S1").state).toBe("working");

      // The compaction ends, but the re-armed turn keeps the row working.
      await fire("session_compact");
      expect(readMarker("S1").state).toBe("working");

      await fire("agent_end");
      expect(readMarker("S1").state).toBe("idle");
    });

    it("clears activity on rebind so the fresh row starts idle", async () => {
      const fire = startExtension();
      const oldCtx = makeCtx("S1");

      await fire("session_start", null, oldCtx);
      await fire("auto_compaction_start", null, oldCtx);
      expect(readMarker("S1").state).toBe("working");

      const newCtx = makeCtx("S2");
      await fire(
        "session_switch",
        { type: "session_switch", reason: "new" },
        newCtx,
      );
      expect(readMarker("S2").state).toBe("idle");

      // A late end event carried by the new ctx must not resurrect the
      // abandoned row's state.
      await fire("auto_compaction_end", null, newCtx);
      expect(readMarker("S2").state).toBe("idle");
      expect(existsSync(markerPath("S1"))).toBe(false);
    });

    it("subscribes to the compaction and retry pairs, but not session_before_compact", () => {
      const events = registeredEvents();

      for (const name of [
        "session.compacting",
        "auto_compaction_start",
        "manual_compaction_start",
        "session_compact",
        "auto_compaction_end",
        "manual_compaction_end",
        "auto_retry_start",
        "auto_retry_end",
      ]) {
        expect(events).toContain(name);
      }
      // omp skips speculative and mid-turn compaction when an extension
      // registers that hook; observing it would cost users background
      // compaction.
      expect(events).not.toContain("session_before_compact");
    });
  });

  describe("reconcile", () => {
    it("heals a turn reason whose agent_end was lost", async () => {
      const fire = startExtension();
      const { ctx, setIdle, tick } = makeTimedCtx("S1");

      await fire("session_start", null, ctx);
      await fire("agent_start", null, ctx);
      expect(readMarker("S1").state).toBe("working");

      // agent_end never arrives; the session is idle in truth.
      setIdle(true);
      await tick();
      expect(readMarker("S1").state).toBe("idle");
    });

    it("keeps a compaction reason alive across idle ticks", async () => {
      const fire = startExtension();
      const { ctx, setIdle, tick } = makeTimedCtx("S1");

      await fire("session_start", null, ctx);
      await fire("auto_compaction_start", null, ctx);
      expect(readMarker("S1").state).toBe("working");

      // `ctx.isIdle()` is `!isStreaming`, which stays true through a
      // compaction; a long one must outlive any number of reconcile
      // ticks. Only its own end event delivers idle.
      setIdle(true);
      await tick();
      await tick();
      expect(readMarker("S1").state).toBe("working");

      await fire("auto_compaction_end", null, ctx);
      expect(readMarker("S1").state).toBe("idle");
    });

    it("keeps an approval wait visible when a busy tick has no reasons", async () => {
      const fire = startExtension();
      const { ctx, setIdle, tick } = makeTimedCtx("S1");

      await fire("session_start", null, ctx);
      await fire("agent_start", null, ctx);
      await fire("agent_end", null, ctx);
      await fire(
        "tool_approval_requested",
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );

      // The turn is gone but omp still reads busy when the approval lands;
      // the busy fallback must not bury the wait under `working`.
      setIdle(false);
      await tick();
      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S1").pending_tool).toBe("bash");
    });

    it("leaves an approval wait alone when the context reads idle", async () => {
      const fire = startExtension();
      const { ctx, setIdle, tick } = makeTimedCtx("S1");

      await fire("session_start", null, ctx);
      await fire("agent_start", null, ctx);
      await fire(
        "tool_approval_requested",
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      setIdle(true);
      await tick();

      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S1").pending_tool).toBe("bash");
    });

    it("keeps an explicitly continuing turn across idle ticks", async () => {
      const fire = startExtension();
      const { ctx, setIdle, tick } = makeTimedCtx("S1");

      await fire("session_start", null, ctx);
      await fire("agent_start", null, ctx);
      // omp waits on async work before continuing the turn; nothing is
      // streaming, so the context reads idle while it waits.
      await fire(
        "agent_end",
        { willContinue: true, awaitingAsyncWork: true },
        ctx,
        { settleIdle: false },
      );
      setIdle(true);
      await tick();
      await tick();
      expect(readMarker("S1").state).toBe("working");

      // The continuation runs and finishes; only the terminal end (or a
      // rebind) clears the parked reason.
      await fire("agent_start", null, ctx);
      await fire("agent_end", null, ctx);
      expect(readMarker("S1").state).toBe("idle");
    });

    it("leans a busy session with no reason on record toward working", async () => {
      const fire = startExtension();
      const { ctx, setIdle, tick } = makeTimedCtx("S1");

      await fire("session_start", null, ctx);
      await fire("agent_start", null, ctx);
      await fire("agent_end", null, ctx);
      expect(readMarker("S1").state).toBe("idle");

      // omp is running again but no event said so (a continuation the
      // event model cannot see): lift the row rather than leave it idle.
      setIdle(false);
      await tick();
      expect(readMarker("S1").state).toBe("working");

      // And settle it back once the context reads idle, disarming itself.
      setIdle(true);
      await tick();
      expect(readMarker("S1").state).toBe("idle");
    });
  });
});
