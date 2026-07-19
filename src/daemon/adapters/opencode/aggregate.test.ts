import { describe, expect, it } from "bun:test";

import { aggregateOpenCodeMarkers } from "./aggregate";
import type { SessionPidMarker } from "../../session-markers";

function marker(overrides: Partial<SessionPidMarker>): SessionPidMarker {
  return {
    agent_type: "opencode",
    pid: 10_000,
    session_id: "s",
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

describe("aggregateOpenCodeMarkers", () => {
  it("returns idle/null/null for zero markers", () => {
    expect(aggregateOpenCodeMarkers([])).toEqual({
      status: "idle",
      attentionType: null,
      pendingTool: null,
      ambiguousWait: false,
    });
  });

  it("one idle marker: status idle, cwd from that marker", () => {
    const m = marker({
      session_id: "s1",
      state: "idle",
      state_timestamp: 1_700_000_100,
      directory: "/repo/a",
    });
    const agg = aggregateOpenCodeMarkers([m]);
    expect(agg.status).toBe("idle");
    expect(agg.attentionType).toBeNull();
    expect(agg.pendingTool).toBeNull();
    expect(agg.cwd).toBe("/repo/a");
    expect(agg.nativeSessionId).toBe("s1");
  });

  it("one working marker produces status working", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({ session_id: "s1", state: "working", directory: "/x" }),
    ]);
    expect(agg.status).toBe("working");
    expect(agg.attentionType).toBeNull();
    expect(agg.pendingTool).toBeNull();
  });

  it("one waiting marker produces status waiting with permission attention", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({
        session_id: "s1",
        state: "waiting_permission",
        pending_tool: "bash",
        directory: "/x",
      }),
    ]);
    expect(agg.status).toBe("waiting");
    expect(agg.attentionType).toBe("permission");
    expect(agg.pendingTool).toBe("bash");
    expect(agg.ambiguousWait).toBe(false);
  });

  it("two idle markers: status idle, metadata from newer", () => {
    const older = marker({
      session_id: "old",
      state: "idle",
      state_timestamp: 1_700_000_100,
      directory: "/older",
    });
    const newer = marker({
      session_id: "new",
      state: "idle",
      state_timestamp: 1_700_000_200,
      directory: "/newer",
    });
    const agg = aggregateOpenCodeMarkers([older, newer]);
    expect(agg.status).toBe("idle");
    expect(agg.cwd).toBe("/newer");
    expect(agg.nativeSessionId).toBe("new");
  });

  it("idle + working: status working", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({
        session_id: "a",
        state: "idle",
        state_timestamp: 1_700_000_300,
      }),
      marker({
        session_id: "b",
        state: "working",
        state_timestamp: 1_700_000_200,
      }),
    ]);
    expect(agg.status).toBe("working");
    expect(agg.attentionType).toBeNull();
  });

  it("idle + waiting: status waiting, pendingTool from the waiting marker", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({
        session_id: "a",
        state: "idle",
        state_timestamp: 1_700_000_200,
      }),
      marker({
        session_id: "b",
        state: "waiting_permission",
        pending_tool: "edit",
        state_timestamp: 1_700_000_100,
      }),
    ]);
    expect(agg.status).toBe("waiting");
    expect(agg.attentionType).toBe("permission");
    expect(agg.pendingTool).toBe("edit");
  });

  it("two waiting markers: pendingTool from the newer waiting one", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({
        session_id: "a",
        state: "waiting_permission",
        pending_tool: "bash",
        state_timestamp: 1_700_000_100,
      }),
      marker({
        session_id: "b",
        state: "waiting_permission",
        pending_tool: "edit",
        state_timestamp: 1_700_000_200,
      }),
    ]);
    expect(agg.status).toBe("waiting");
    expect(agg.pendingTool).toBe("edit");
    expect(agg.nativeSessionId).toBe("b");
    expect(agg.ambiguousWait).toBe(true);
  });

  it("working + waiting + idle: waiting wins", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({
        session_id: "a",
        state: "working",
        state_timestamp: 1_700_000_100,
      }),
      marker({
        session_id: "b",
        state: "waiting_permission",
        pending_tool: "bash",
        state_timestamp: 1_700_000_150,
      }),
      marker({
        session_id: "c",
        state: "idle",
        state_timestamp: 1_700_000_200,
      }),
    ]);
    expect(agg.status).toBe("waiting");
    expect(agg.pendingTool).toBe("bash");
  });

  it("lastActivityAt reflects the max state_timestamp across markers", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({
        session_id: "a",
        state: "idle",
        state_timestamp: 1_700_000_100,
      }),
      marker({
        session_id: "b",
        state: "idle",
        state_timestamp: 1_700_000_250,
      }),
    ]);
    expect(agg.lastActivityAt).toBe(
      new Date(1_700_000_250 * 1000).toISOString(),
    );
  });

  it("falls back to timestamp when state_timestamp is missing", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({
        session_id: "a",
        state: "idle",
        timestamp: 1_700_000_400,
      }),
    ]);
    expect(agg.lastActivityAt).toBe(
      new Date(1_700_000_400 * 1000).toISOString(),
    );
  });

  it("omits cwd when no marker has directory set", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({ session_id: "s1", state: "idle" }),
    ]);
    expect(agg.cwd).toBeUndefined();
    expect(agg.nativeSessionId).toBe("s1");
  });

  it("propagates last_prompt from a single marker", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({
        session_id: "s1",
        state: "idle",
        state_timestamp: 1_700_000_100,
        last_prompt: "do the thing",
      }),
    ]);
    expect(agg.lastPrompt).toBe("do the thing");
  });

  it("multi-marker: lastPrompt comes from the newest by activity", () => {
    const older = marker({
      session_id: "old",
      state: "idle",
      state_timestamp: 1_700_000_100,
      last_prompt: "stale prompt",
    });
    const newer = marker({
      session_id: "new",
      state: "idle",
      state_timestamp: 1_700_000_300,
      last_prompt: "fresh prompt",
    });
    const agg = aggregateOpenCodeMarkers([older, newer]);
    expect(agg.lastPrompt).toBe("fresh prompt");
  });

  it("emits lastPrompt=null when newest has none, even if an older sibling has one", () => {
    // Sticky-prompt regression guard: a fresh session in a multi-session
    // server must not inherit the previously-newest sibling's prompt. Null
    // is the explicit clear signal SessionManager.updateSession honors.
    const older = marker({
      session_id: "old",
      state: "idle",
      state_timestamp: 1_700_000_100,
      last_prompt: "old prompt",
    });
    const newer = marker({
      session_id: "new",
      state: "idle",
      state_timestamp: 1_700_000_300,
    });
    const agg = aggregateOpenCodeMarkers([older, newer]);
    expect(agg.lastPrompt).toBeNull();
  });

  it("emits lastPrompt=null when no marker has one", () => {
    const agg = aggregateOpenCodeMarkers([
      marker({ session_id: "s1", state: "idle" }),
    ]);
    expect(agg.lastPrompt).toBeNull();
  });
});
