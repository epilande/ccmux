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

function makeFakeOmp() {
  const handlers = new Map<string, Handler>();
  const omp: OmpExtensionApi = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
  };
  return { omp, handlers };
}

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
    const { omp, handlers } = makeFakeOmp();
    makeExtension({
      markersDir,
      version: "1.0.0",
      now: () => 1_700_000_000_000,
    })(omp);
    const ctx = makeCtx("S1", "/home/u/.omp/agent/sessions/x/abc.jsonl");

    await handlers.get("session_start")!(null, ctx);

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
    const { omp, handlers } = makeFakeOmp();
    makeExtension({ markersDir, version: "1.0.0" })(omp);
    const ctx = makeCtx("S1");

    await handlers.get("session_start")!(null, ctx);
    await handlers.get("agent_start")!(null, ctx);
    expect(readMarker("S1").state).toBe("working");

    await handlers.get("agent_end")!(null, ctx);
    expect(readMarker("S1").state).toBe("idle");
  });

  it("captures the prompt from before_agent_start and preserves it across state flips", async () => {
    const { omp, handlers } = makeFakeOmp();
    makeExtension({ markersDir, version: "1.0.0" })(omp);
    const ctx = makeCtx("S1");

    await handlers.get("session_start")!(null, ctx);
    await handlers.get("before_agent_start")!(
      { prompt: "  fix the bug  " },
      ctx,
    );
    await handlers.get("agent_start")!(null, ctx);

    const marker = readMarker("S1");
    expect(marker.last_prompt).toBe("fix the bug");
    expect(marker.state).toBe("working");
  });

  it("removes the marker on session_shutdown", async () => {
    const { omp, handlers } = makeFakeOmp();
    makeExtension({ markersDir, version: "1.0.0" })(omp);
    const ctx = makeCtx("S1");

    await handlers.get("session_start")!(null, ctx);
    expect(existsSync(markerPath("S1"))).toBe(true);

    await handlers.get("session_shutdown")!(null, ctx);
    expect(existsSync(markerPath("S1"))).toBe(false);
  });

  it("no-ops when no session id is available", async () => {
    const { omp, handlers } = makeFakeOmp();
    makeExtension({ markersDir, version: "1.0.0" })(omp);
    const ctx = makeCtx(undefined);

    await handlers.get("session_start")!(null, ctx);
    // No marker file written for an absent session id.
    expect(existsSync(markerPath("undefined"))).toBe(false);
  });

  describe("tool approval tracking", () => {
    it("writes waiting_permission with the gated tool name on tool_approval_requested", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("agent_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        {
          type: "tool_approval_requested",
          sessionId: "S1",
          toolCallId: "call-1",
          toolName: "bash",
          approvalMode: "default",
        },
        ctx,
      );

      const marker = readMarker("S1");
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("bash");
    });

    it("returns to working and clears pending_tool once the approval resolves", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", toolName: "bash", approved: true },
        ctx,
      );

      const marker = readMarker("S1");
      expect(marker.state).toBe("working");
      expect(marker.pending_tool).toBeUndefined();
    });

    it("resumes working on a DENIED resolve too (the agent loop continues either way)", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", toolName: "bash", approved: false },
        ctx,
      );

      expect(readMarker("S1").state).toBe("working");
    });

    it("stays waiting until the LAST of several overlapping approvals resolves", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-2", toolName: "write" },
        ctx,
      );
      // pending_tool names the OLDEST outstanding request: omp's dialog
      // surface is FIFO, so call-1's prompt is the one on screen.
      expect(readMarker("S1").pending_tool).toBe("bash");

      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", approved: true },
        ctx,
      );
      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S1").pending_tool).toBe("write");

      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-2", approved: true },
        ctx,
      );
      expect(readMarker("S1").state).toBe("working");
    });

    it("publishes the FIRST tool while a later request is still queued behind it", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("agent_start")!(null, ctx);
      // Two shared-concurrency bash calls: both request before either
      // resolves, and omp shows call-1's dialog first.
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      expect(readMarker("S1").pending_tool).toBe("bash");

      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-2", toolName: "web_fetch" },
        ctx,
      );

      const marker = readMarker("S1");
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("bash");
    });

    it("re-publishes the next tool name when the head approval resolves", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-2", toolName: "web_fetch" },
        ctx,
      );
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", toolName: "bash", approved: true },
        ctx,
      );

      // Answering the first prompt retargets the row at the second, which is
      // now the dialog on screen. Still waiting, new name.
      const marker = readMarker("S1");
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("web_fetch");
    });

    it("keeps naming the head tool when approvals resolve out of order", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-2", toolName: "web_fetch" },
        ctx,
      );
      // The second request resolves first (omp's fail-closed no-UI path can
      // land on any outstanding id).
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-2", approved: false },
        ctx,
      );

      const marker = readMarker("S1");
      expect(marker.state).toBe("waiting_permission");
      expect(marker.pending_tool).toBe("bash");

      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", approved: true },
        ctx,
      );
      const after = readMarker("S1");
      expect(after.state).toBe("working");
      expect(after.pending_tool).toBeUndefined();
    });

    it("clears the pending set on agent_end so a leaked id can't pin the next turn", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      // Turn aborted while the prompt was open: agent_end lands with the id
      // still outstanding.
      await handlers.get("agent_end")!(null, ctx);
      expect(readMarker("S1").state).toBe("idle");
      expect(readMarker("S1").pending_tool).toBeUndefined();

      // A late resolve for the abandoned id must not drag the idle row back
      // up to working.
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", approved: false },
        ctx,
      );
      expect(readMarker("S1").state).toBe("idle");

      // The next turn's approval still works.
      await handlers.get("agent_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-2", toolName: "edit" },
        ctx,
      );
      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S1").pending_tool).toBe("edit");
    });

    it("ignores an approval request with no correlatable tool call id", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("agent_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!({ toolName: "bash" }, ctx);

      // No waiting marker: nothing to resolve it later.
      expect(readMarker("S1").state).toBe("working");
    });

    it("resolves everything outstanding when a resolve carries no tool call id", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );
      await handlers.get("tool_approval_resolved")!({ approved: true }, ctx);

      // Fail-open on the state, not the wait: a row stuck at waiting forever
      // is worse than one turn of optimistic working.
      expect(readMarker("S1").state).toBe("working");
    });

    it("keys pending approvals per session id", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctxA = makeCtx("S1");
      const ctxB = makeCtx("S2");

      await handlers.get("session_start")!(null, ctxA);
      await handlers.get("session_start")!(null, ctxB);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctxA,
      );

      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S2").state).toBe("idle");

      // Resolving S1's id against S2 must not touch either row's wait.
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", approved: true },
        ctxB,
      );
      expect(readMarker("S1").state).toBe("waiting_permission");
      expect(readMarker("S2").state).toBe("idle");
    });
  });

  describe("session_switch", () => {
    // omp's /new and /resume mutate the session in place and emit only
    // session_before_switch + session_switch, so this handler (not a
    // shutdown/start pair) is what reaps the old marker and seeds the new one.
    const switchEvent = (reason: "new" | "resume") => ({
      type: "session_switch",
      reason,
      previousSessionFile: "/home/u/.omp/agent/sessions/x/old.jsonl",
    });

    it("reaps the old session's marker and seeds an idle marker for the new id", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({
        markersDir,
        version: "1.0.0",
        now: () => 1_700_000_000_000,
      })(omp);
      const oldCtx = makeCtx("S1", "/home/u/.omp/agent/sessions/x/old.jsonl");

      await handlers.get("session_start")!(null, oldCtx);
      await handlers.get("before_agent_start")!({ prompt: "old work" }, oldCtx);
      expect(existsSync(markerPath("S1"))).toBe(true);

      // /new installs the new id BEFORE emitting, so the handler's ctx
      // already reports S2.
      const newCtx = makeCtx("S2", "/home/u/.omp/agent/sessions/x/new.jsonl");
      await handlers.get("session_switch")!(switchEvent("new"), newCtx);

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
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const oldCtx = makeCtx("S1");

      await handlers.get("session_start")!(null, oldCtx);
      const newCtx = makeCtx("S2");
      await handlers.get("session_switch")!(switchEvent("resume"), newCtx);

      // A stray late event for the abandoned session must not resurrect its
      // marker file.
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", approved: true },
        oldCtx,
      );
      expect(existsSync(markerPath("S1"))).toBe(false);
      expect(readMarker("S2").state).toBe("idle");
    });

    it("clears approvals left outstanding by the switched-away session", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const oldCtx = makeCtx("S1");

      await handlers.get("session_start")!(null, oldCtx);
      await handlers.get("agent_start")!(null, oldCtx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        oldCtx,
      );
      expect(readMarker("S1").state).toBe("waiting_permission");

      // The switch aborts the turn while the prompt is still open.
      const newCtx = makeCtx("S2");
      await handlers.get("session_switch")!(switchEvent("new"), newCtx);

      // The next turn on the NEW session starts from a clean slate: the
      // abandoned id cannot pin it at waiting, and its late resolve cannot
      // drag the idle row up to working.
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", approved: false },
        newCtx,
      );
      expect(readMarker("S2").state).toBe("idle");

      await handlers.get("agent_start")!(null, newCtx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-2", toolName: "edit" },
        newCtx,
      );
      expect(readMarker("S2").state).toBe("waiting_permission");
      expect(readMarker("S2").pending_tool).toBe("edit");
    });

    it("clears a same-id switch's pending approval (reload re-enters switchSession)", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      await handlers.get("agent_start")!(null, ctx);
      await handlers.get("tool_approval_requested")!(
        { toolCallId: "call-1", toolName: "bash" },
        ctx,
      );

      await handlers.get("session_switch")!(switchEvent("resume"), ctx);

      const marker = readMarker("S1");
      expect(marker.state).toBe("idle");
      expect(marker.pending_tool).toBeUndefined();

      // A late resolve for the aborted approval must not write working.
      await handlers.get("tool_approval_resolved")!(
        { toolCallId: "call-1", approved: true },
        ctx,
      );
      expect(readMarker("S1").state).toBe("idle");
    });

    it("no-ops when the switch lands with no resolvable session id", async () => {
      const { omp, handlers } = makeFakeOmp();
      makeExtension({ markersDir, version: "1.0.0" })(omp);
      const ctx = makeCtx("S1");

      await handlers.get("session_start")!(null, ctx);
      // Bailing (rather than treating every tracked id as stale) keeps an
      // unreadable session id from deleting the live session's marker.
      await handlers.get("session_switch")!(
        switchEvent("new"),
        makeCtx(undefined),
      );

      expect(existsSync(markerPath("S1"))).toBe(true);
    });
  });
});
