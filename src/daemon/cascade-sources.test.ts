import { describe, expect, it } from "bun:test";
import type { Session } from "../types/session";
import {
  genericMarkerSource,
  logSource,
  nativeLogSource,
  nativeMarkerSource,
  openCodeMarkerSource,
  terminalSource,
} from "./cascade-evaluator";
import type { SessionPidMarker } from "./session-markers";

function mkMarker(overrides: Partial<SessionPidMarker> = {}): SessionPidMarker {
  return {
    agent_type: "claude",
    pid: 1234,
    session_id: "sess-1",
    timestamp: 1_700_000_000,
    state_timestamp: 1_700_000_500,
    state: "idle",
    ...overrides,
  };
}

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    agentType: "claude",
    trackingMode: "native",
    project: "proj",
    cwd: "/x",
    logPath: null,
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    tmuxPane: null,
    updatedAt: new Date("2026-05-17T10:00:00Z"),
    lastActivityAt: null,
    lastUserInputAt: null,
    subagents: [],
    gitBranch: null,
    version: null,
    pid: null,
    statusChangedAt: null,
    previousStatus: null,
    attentionState: null,
    lastSeenAt: null,
    lastPrompt: null,
    prompts: [],
    ...overrides,
  };
}

describe("genericMarkerSource", () => {
  it("maps marker.state=idle to status: idle with null attention", () => {
    const built = genericMarkerSource(mkMarker({ state: "idle" }));
    expect(built.source.state.status).toBe("idle");
    expect(built.source.state.attentionType).toBeNull();
    expect(built.source.state.pendingTool).toBeNull();
    expect(built.metadata).toEqual({});
  });

  it("maps marker.state=working to status: working with null attention", () => {
    const built = genericMarkerSource(mkMarker({ state: "working" }));
    expect(built.source.state.status).toBe("working");
    expect(built.source.state.attentionType).toBeNull();
    expect(built.source.state.pendingTool).toBeNull();
  });

  it("maps marker.state=waiting_permission to status: waiting + permission", () => {
    const built = genericMarkerSource(
      mkMarker({ state: "waiting_permission", pending_tool: "Bash" }),
    );
    expect(built.source.state.status).toBe("waiting");
    expect(built.source.state.attentionType).toBe("permission");
    expect(built.source.state.pendingTool).toBe("Bash");
  });

  it("waiting_permission without pending_tool falls back to null pendingTool", () => {
    const built = genericMarkerSource(
      mkMarker({ state: "waiting_permission", pending_tool: undefined }),
    );
    expect(built.source.state.pendingTool).toBeNull();
  });

  it("source.timestamp is state_timestamp * 1000 (ms since epoch)", () => {
    const built = genericMarkerSource(
      mkMarker({ state_timestamp: 1_700_000_500 }),
    );
    expect(built.source.timestamp).toBe(1_700_000_500 * 1000);
  });

  it("undefined state_timestamp: timestamp=0 and state.lastActivityAt omitted", () => {
    const built = genericMarkerSource(mkMarker({ state_timestamp: undefined }));
    expect(built.source.timestamp).toBe(0);
    expect(built.source.state.lastActivityAt).toBeUndefined();
  });

  it("state.lastActivityAt is ISO of state_timestamp * 1000", () => {
    const built = genericMarkerSource(
      mkMarker({ state_timestamp: 1_700_000_500 }),
    );
    expect(built.source.state.lastActivityAt).toBe(
      new Date(1_700_000_500 * 1000).toISOString(),
    );
  });

  it("metadata.lastPrompt omitted when marker.last_prompt is undefined (sticky semantic)", () => {
    const built = genericMarkerSource(mkMarker({ last_prompt: undefined }));
    expect(built.metadata).toEqual({});
    expect("lastPrompt" in built.metadata).toBe(false);
  });

  it("metadata.lastPrompt set when marker.last_prompt is a string", () => {
    const built = genericMarkerSource(mkMarker({ last_prompt: "hello" }));
    expect(built.metadata.lastPrompt).toBe("hello");
  });

  it("source.name is 'marker'", () => {
    const built = genericMarkerSource(mkMarker());
    expect(built.source.name).toBe("marker");
  });

  it("source has no canUpgrade (baseline)", () => {
    const built = genericMarkerSource(mkMarker());
    expect(built.source.canUpgrade).toBeUndefined();
  });
});

describe("openCodeMarkerSource", () => {
  const baseSibling = (
    overrides: Partial<SessionPidMarker>,
  ): SessionPidMarker => ({
    agent_type: "opencode",
    pid: 9000,
    session_id: overrides.session_id ?? "oc-sess",
    timestamp: 1_700_000_000,
    state_timestamp: 1_700_000_100,
    state: "idle",
    ...overrides,
  });

  it("empty siblings list folds [marker] alone", () => {
    const marker = baseSibling({ state: "working" });
    const built = openCodeMarkerSource(marker, []);
    expect(built.source.state.status).toBe("working");
  });

  it("aggregates worst-of: any waiting -> waiting", () => {
    const marker = baseSibling({ session_id: "a", state: "idle" });
    const siblings = [
      marker,
      baseSibling({ session_id: "b", state: "working" }),
      baseSibling({
        session_id: "c",
        state: "waiting_permission",
        pending_tool: "Edit",
      }),
    ];
    const built = openCodeMarkerSource(marker, siblings);
    expect(built.source.state.status).toBe("waiting");
    expect(built.source.state.attentionType).toBe("permission");
    expect(built.source.state.pendingTool).toBe("Edit");
  });

  it("siblings of only working -> working", () => {
    const marker = baseSibling({ session_id: "a", state: "working" });
    const built = openCodeMarkerSource(marker, [
      marker,
      baseSibling({ session_id: "b", state: "working" }),
    ]);
    expect(built.source.state.status).toBe("working");
    expect(built.source.state.attentionType).toBeNull();
  });

  it("metadata picks up cwd from the aggregator's newest sibling", () => {
    const marker = baseSibling({
      session_id: "a",
      state: "working",
      directory: "/home/u/proj",
    });
    const built = openCodeMarkerSource(marker, [marker]);
    expect(built.metadata.cwd).toBe("/home/u/proj");
  });

  it("metadata always emits lastPrompt (including null) for stale-clear semantics", () => {
    const marker = baseSibling({ session_id: "a", state: "working" });
    const built = openCodeMarkerSource(marker, [marker]);
    expect("lastPrompt" in built.metadata).toBe(true);
    expect(built.metadata.lastPrompt).toBeNull();
  });

  it("drops nativeSessionId from metadata (owned by the plugin adapter)", () => {
    const marker = baseSibling({ session_id: "a", state: "working" });
    const built = openCodeMarkerSource(marker, [marker]);
    expect("nativeSessionId" in built.metadata).toBe(false);
  });

  it("source.timestamp is the passed marker's state_timestamp * 1000", () => {
    const marker = baseSibling({ state_timestamp: 1_700_000_999 });
    const built = openCodeMarkerSource(marker, [marker]);
    expect(built.source.timestamp).toBe(1_700_000_999 * 1000);
  });
});

describe("logSource", () => {
  it("emits explicit null attention/pendingTool (Option Y baseline contract)", () => {
    const session = mkSession({
      status: "working",
      lastActivityAt: "2026-05-17T10:00:00.000Z",
    });
    const src = logSource(session);
    expect(src.state.attentionType).toBeNull();
    expect(src.state.pendingTool).toBeNull();
  });

  it("timestamp is parsed ms of session.lastActivityAt", () => {
    const session = mkSession({
      status: "working",
      lastActivityAt: "2026-05-17T10:00:00.000Z",
    });
    const src = logSource(session);
    expect(src.timestamp).toBe(new Date("2026-05-17T10:00:00.000Z").getTime());
  });

  it("null session.lastActivityAt -> timestamp=0", () => {
    const session = mkSession({ status: "idle", lastActivityAt: null });
    const src = logSource(session);
    expect(src.timestamp).toBe(0);
  });

  // Pinned regression: emitting any lastActivityAt key (even with
  // undefined value) flips `"lastActivityAt" in state` to true at
  // SessionManager.updateSession, which suppresses the auto-stamp on
  // status change. The log cascade source must contribute status only;
  // the LogWatcher already owns `session.lastActivityAt`.
  it("state never carries lastActivityAt (LogWatcher owns it; SessionManager auto-stamps)", () => {
    const withActivity = logSource(
      mkSession({
        status: "working",
        lastActivityAt: "2026-05-17T10:00:00.000Z",
      }),
    );
    const withoutActivity = logSource(
      mkSession({ status: "idle", lastActivityAt: null }),
    );
    expect("lastActivityAt" in withActivity.state).toBe(false);
    expect("lastActivityAt" in withoutActivity.state).toBe(false);
  });

  it("source.name is 'log' with no canUpgrade", () => {
    const src = logSource(mkSession());
    expect(src.name).toBe("log");
    expect(src.canUpgrade).toBeUndefined();
  });

  it("state.status mirrors session.status", () => {
    const src = logSource(mkSession({ status: "waiting" }));
    expect(src.state.status).toBe("waiting");
  });
});

describe("terminalSource", () => {
  const rule = {
    status: "waiting" as const,
    attentionType: "permission" as const,
    pendingTool: "Bash",
  };

  it("upgradeOnly: true sets canUpgrade=['waiting']", () => {
    const src = terminalSource(rule, { upgradeOnly: true });
    expect(src.canUpgrade).toEqual(["waiting"]);
  });

  it("upgradeOnly: false leaves canUpgrade undefined (baseline)", () => {
    const src = terminalSource(rule, { upgradeOnly: false });
    expect(src.canUpgrade).toBeUndefined();
  });

  it("source.state mirrors the rule's status/attention/pendingTool", () => {
    const src = terminalSource(rule, { upgradeOnly: true });
    expect(src.state).toEqual({
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
    });
  });

  it("timestamp defaults to now() when omitted", () => {
    const before = Date.now();
    const src = terminalSource(rule, { upgradeOnly: true });
    const after = Date.now();
    expect(src.timestamp).toBeGreaterThanOrEqual(before);
    expect(src.timestamp).toBeLessThanOrEqual(after);
  });

  it("timestamp override is honored (for deterministic tests)", () => {
    const src = terminalSource(rule, { upgradeOnly: true }, 12_345);
    expect(src.timestamp).toBe(12_345);
  });

  it("source.name is 'terminal'", () => {
    const src = terminalSource(rule, { upgradeOnly: true });
    expect(src.name).toBe("terminal");
  });
});

describe("nativeMarkerSource", () => {
  it("marker.state=waiting_permission peeks session.pendingTool", () => {
    const built = nativeMarkerSource(
      mkMarker({ state: "waiting_permission" }),
      mkSession({ pendingTool: "Bash" }),
    );
    expect(built.source.state.status).toBe("waiting");
    expect(built.source.state.attentionType).toBe("permission");
    expect(built.source.state.pendingTool).toBe("Bash");
  });

  it("waiting_permission with null session.pendingTool yields null pendingTool", () => {
    const built = nativeMarkerSource(
      mkMarker({ state: "waiting_permission" }),
      mkSession({ pendingTool: null }),
    );
    expect(built.source.state.pendingTool).toBeNull();
  });

  it("prefers marker.pending_tool over session.pendingTool", () => {
    // Claude's Notification hook now parses the tool out of the notification
    // message and writes pending_tool (the log can't populate it during a
    // permission wait), so the marker wins.
    const built = nativeMarkerSource(
      mkMarker({
        state: "waiting_permission",
        pending_tool: "MarkerSays",
      }),
      mkSession({ pendingTool: "LogSays" }),
    );
    expect(built.source.state.pendingTool).toBe("MarkerSays");
  });

  it("falls back to session.pendingTool when the marker omits pending_tool", () => {
    const built = nativeMarkerSource(
      mkMarker({ state: "waiting_permission" }),
      mkSession({ pendingTool: "LogSays" }),
    );
    expect(built.source.state.pendingTool).toBe("LogSays");
  });

  it("marker.state=idle clears attention regardless of session.pendingTool", () => {
    const built = nativeMarkerSource(
      mkMarker({ state: "idle" }),
      mkSession({ pendingTool: "Bash", attentionType: "permission" }),
    );
    expect(built.source.state.status).toBe("idle");
    expect(built.source.state.attentionType).toBeNull();
    expect(built.source.state.pendingTool).toBeNull();
  });

  it("source.timestamp is state_timestamp * 1000", () => {
    const built = nativeMarkerSource(
      mkMarker({ state_timestamp: 1_700_000_500 }),
      mkSession(),
    );
    expect(built.source.timestamp).toBe(1_700_000_500 * 1000);
  });

  it("state.lastActivityAt is ISO of state_timestamp * 1000", () => {
    const built = nativeMarkerSource(
      mkMarker({ state_timestamp: 1_700_000_500 }),
      mkSession(),
    );
    expect(built.source.state.lastActivityAt).toBe(
      new Date(1_700_000_500 * 1000).toISOString(),
    );
  });

  it("metadata is empty (native markers don't carry cwd/lastPrompt)", () => {
    const built = nativeMarkerSource(
      mkMarker({ state: "waiting_permission" }),
      mkSession({ pendingTool: "Bash" }),
    );
    expect(built.metadata).toEqual({});
  });

  it("source.name is 'marker' with no canUpgrade", () => {
    const built = nativeMarkerSource(mkMarker(), mkSession());
    expect(built.source.name).toBe("marker");
    expect(built.source.canUpgrade).toBeUndefined();
  });
});

describe("nativeLogSource", () => {
  it("propagates session.attentionType (unlike logSource which hardcodes null)", () => {
    const src = nativeLogSource(
      mkSession({ status: "waiting", attentionType: "question" }),
    );
    expect(src.state.attentionType).toBe("question");
  });

  it("propagates session.pendingTool", () => {
    const src = nativeLogSource(mkSession({ pendingTool: "Bash" }));
    expect(src.state.pendingTool).toBe("Bash");
  });

  it("state.status mirrors session.status", () => {
    const src = nativeLogSource(mkSession({ status: "working" }));
    expect(src.state.status).toBe("working");
  });

  // Pinned regression: matches the logSource contract. Including
  // lastActivityAt in state suppresses SessionManager's auto-stamp on
  // status changes; for native agents the LogWatcher writes
  // session.lastActivityAt directly on every parse, so the cascade source
  // must not clobber it with a stale value.
  it("state never carries lastActivityAt (LogWatcher owns it; SessionManager auto-stamps)", () => {
    const withActivity = nativeLogSource(
      mkSession({
        status: "working",
        lastActivityAt: "2026-05-17T10:00:00.000Z",
      }),
    );
    const withoutActivity = nativeLogSource(
      mkSession({ status: "idle", lastActivityAt: null }),
    );
    expect("lastActivityAt" in withActivity.state).toBe(false);
    expect("lastActivityAt" in withoutActivity.state).toBe(false);
  });

  it("timestamp is parsed ms of session.lastActivityAt", () => {
    const src = nativeLogSource(
      mkSession({ lastActivityAt: "2026-05-17T10:00:00.000Z" }),
    );
    expect(src.timestamp).toBe(new Date("2026-05-17T10:00:00.000Z").getTime());
  });

  it("null session.lastActivityAt -> timestamp=0", () => {
    const src = nativeLogSource(mkSession({ lastActivityAt: null }));
    expect(src.timestamp).toBe(0);
  });

  it("source.name is 'log' with no canUpgrade", () => {
    const src = nativeLogSource(mkSession());
    expect(src.name).toBe("log");
    expect(src.canUpgrade).toBeUndefined();
  });
});
