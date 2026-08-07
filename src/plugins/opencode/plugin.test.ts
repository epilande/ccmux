import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { makePlugin } from "./plugin.js";
import type {
  OpencodeBusEvent,
  OpencodePluginHooks,
  OpencodePluginInput,
} from "./plugin.js";

interface StubClient {
  session: {
    list: OpencodePluginInput["client"]["session"]["list"];
    status: OpencodePluginInput["client"]["session"]["status"];
  };
}

function makeClient(
  sessions: Array<{ id: string; directory: string; title: string }>,
  statuses: Record<string, { type: "idle" | "busy" | "retry" } | undefined>,
): StubClient {
  return {
    session: {
      list: async () => ({ data: sessions }),
      status: async () => ({ data: statuses }),
    },
  };
}

function readMarker(markersDir: string, sessionId: string) {
  const path = join(markersDir, `opencode-${sessionId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

async function drainQueues(): Promise<void> {
  // Writes go through a microtask queue inside the plugin. Await a few
  // resolved promises to flush pending work the test scheduled.
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/**
 * The plugin's `_seedReady` promise resolves once `client.session.list` +
 * `client.session.status` have settled and every queued seed write has been
 * flushed. Tests that inspect seed-written markers MUST await it: the plugin
 * itself does not (boot deadlock if OpenCode awaits it).
 */
interface HooksWithSeedReady extends OpencodePluginHooks {
  _seedReady?: Promise<void>;
}
async function awaitSeed(hooks: OpencodePluginHooks): Promise<void> {
  const ready = (hooks as HooksWithSeedReady)._seedReady;
  if (ready) await ready;
  await drainQueues();
}

async function dispatchAll(
  hooks: OpencodePluginHooks,
  events: OpencodeBusEvent[],
): Promise<void> {
  for (const event of events) {
    await hooks.event({ event });
  }
  await drainQueues();
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return {
    now: () => ++t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

let tempRoot: string;
let markersDir: string;

beforeEach(() => {
  tempRoot = join(
    tmpdir(),
    `ccmux-plugin-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  markersDir = join(tempRoot, "session-pids");
  mkdirSync(tempRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("makePlugin: eager seed", () => {
  it("writes one marker per persisted session with status-derived state", async () => {
    const client = makeClient(
      [
        { id: "s1", directory: "/tmp/a", title: "Alpha" },
        { id: "s2", directory: "/tmp/b", title: "Beta" },
        { id: "s3", directory: "/tmp/c", title: "Gamma" },
      ],
      {
        s1: { type: "idle" },
        s2: { type: "busy" },
        s3: { type: "retry" },
      },
    );

    const plugin = makePlugin({
      markersDir,
      version: "1.2.3",
      now: makeClock().now,
    });
    const hooks = await plugin({ client, directory: "/tmp" });
    await awaitSeed(hooks);

    const m1 = readMarker(markersDir, "s1");
    const m2 = readMarker(markersDir, "s2");
    const m3 = readMarker(markersDir, "s3");

    expect(m1).toMatchObject({
      agent_type: "opencode",
      session_id: "s1",
      state: "idle",
      directory: "/tmp/a",
      title: "Alpha",
      pid: process.pid,
    });
    expect(m2).toMatchObject({ state: "working", title: "Beta" });
    expect(m3).toMatchObject({ state: "working", title: "Gamma" });
  });

  it("writes state_timestamp with sub-second precision from the injected clock", async () => {
    // Regression guard: floored integer-second timestamps make two sibling
    // sessions written within the same wall-clock second tie in
    // aggregate.ts's newest-marker sort. Float seconds keep them ordered.
    const client = makeClient(
      [{ id: "s1", directory: "/tmp/a", title: "Alpha" }],
      { s1: { type: "idle" } },
    );
    const plugin = makePlugin({
      markersDir,
      version: "1.0.0",
      now: () => 1_700_000_000_123,
    });
    const hooks = await plugin({ client });
    await awaitSeed(hooks);

    const m1 = readMarker(markersDir, "s1");
    expect(m1?.state_timestamp).toBeCloseTo(1_700_000_000.123, 3);
    expect(m1?.timestamp).toBeCloseTo(1_700_000_000.123, 3);
  });

  it("defaults to idle when a session has no status entry", async () => {
    const client = makeClient(
      [{ id: "s1", directory: "/tmp/a", title: "Alpha" }],
      {},
    );
    const plugin = makePlugin({ markersDir, version: "1.0.0" });
    const hooks = await plugin({ client });
    await awaitSeed(hooks);

    expect(readMarker(markersDir, "s1")).toMatchObject({ state: "idle" });
  });

  it("logs-and-continues when session.list rejects", async () => {
    const client: StubClient = {
      session: {
        list: async () => {
          throw new Error("boom");
        },
        status: async () => ({ data: {} }),
      },
    };
    const plugin = makePlugin({ markersDir, version: "1.0.0" });
    const hooks = await plugin({ client });
    expect(hooks).toBeDefined();
    await awaitSeed(hooks);
    // Directory is created even though seed failed (subsequent events
    // can still land markers).
    expect(existsSync(markersDir)).toBe(true);
  });

  it("creates the markers directory on load", async () => {
    const client = makeClient([], {});
    const plugin = makePlugin({ markersDir, version: "1.0.0" });
    expect(existsSync(markersDir)).toBe(false);
    await plugin({ client });
    expect(existsSync(markersDir)).toBe(true);
  });

  /**
   * Deadlock regression (found live against real OpenCode): `session.list`
   * and `session.status` are served by in-process handlers whose runtime
   * state isn't ready until plugins finish loading, so `await`ing the seed
   * inside `plugin()` deadlocks OpenCode's bootstrap. Returning hooks
   * immediately has to hold even when the SDK calls never resolve.
   */
  it("returns hooks immediately even if the seed SDK calls never resolve", async () => {
    const hangingClient: StubClient = {
      session: {
        list: () =>
          new Promise(() => {
            /* never resolves */
          }),
        status: () =>
          new Promise(() => {
            /* never resolves */
          }),
      },
    };
    const plugin = makePlugin({ markersDir, version: "1.0.0" });
    const hooks = await Promise.race([
      plugin({ client: hangingClient }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("plugin() awaited the seed")), 300),
      ),
    ]);
    expect(hooks).toBeDefined();
    expect(typeof hooks.event).toBe("function");
  });
});

describe("makePlugin: bus event dispatch", () => {
  async function setup() {
    const client = makeClient([], {});
    const plugin = makePlugin({
      markersDir,
      version: "1.0.0",
      now: makeClock().now,
    });
    const hooks = await plugin({ client });
    return { hooks };
  }

  it("session.created writes an idle marker with info", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: {
          info: { id: "s1", directory: "/repo", title: "New session" },
        },
      },
    ]);
    expect(readMarker(markersDir, "s1")).toMatchObject({
      state: "idle",
      directory: "/repo",
      title: "New session",
    });
  });

  it("session.updated refreshes title without clobbering state", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: {
          info: { id: "s1", directory: "/repo", title: "Old" },
        },
      },
      {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      },
      {
        type: "session.updated",
        properties: {
          info: { id: "s1", directory: "/repo", title: "Renamed" },
        },
      },
    ]);
    expect(readMarker(markersDir, "s1")).toMatchObject({
      state: "working",
      title: "Renamed",
    });
  });

  it("session.status idle -> working -> idle transitions propagate", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      },
    ]);
    expect(readMarker(markersDir, "s1")?.state).toBe("working");

    await dispatchAll(hooks, [
      {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "idle" } },
      },
    ]);
    expect(readMarker(markersDir, "s1")?.state).toBe("idle");
  });

  it("permission.asked sets waiting_permission with tool + context", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      {
        type: "permission.asked",
        properties: {
          id: "p1",
          sessionID: "s1",
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: { command: "rm -rf /" },
          always: [],
        },
      },
    ]);
    const m = readMarker(markersDir, "s1");
    expect(m).toMatchObject({
      state: "waiting_permission",
      pending_tool: "bash",
      permission_context: "rm -rf /",
    });
  });

  it("permission.replied clears waiting and flips to working", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      {
        type: "permission.asked",
        properties: {
          id: "p1",
          sessionID: "s1",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
        },
      },
      {
        type: "permission.replied",
        properties: { sessionID: "s1", requestID: "p1", reply: "once" },
      },
    ]);
    const m = readMarker(markersDir, "s1");
    expect(m).toMatchObject({
      state: "working",
      pending_tool: null,
      permission_context: null,
    });
  });

  it("session.deleted unlinks the marker", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
    ]);
    expect(readMarker(markersDir, "s1")).not.toBeNull();
    await dispatchAll(hooks, [
      {
        type: "session.deleted",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
    ]);
    expect(readMarker(markersDir, "s1")).toBeNull();
  });

  it("ignores unknown event types without throwing", async () => {
    const { hooks } = await setup();
    await expect(
      hooks.event({
        event: { type: "totally.unknown", properties: {} },
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores malformed events missing required fields", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      { type: "session.status", properties: { status: { type: "idle" } } },
      { type: "permission.asked", properties: { id: "p", permission: "bash" } },
    ]);
    // Nothing should have been written.
    expect(readdirSync(markersDir)).toEqual([]);
  });
});

describe("makePlugin: user prompt capture", () => {
  async function setup() {
    const client = makeClient([], {});
    const plugin = makePlugin({
      markersDir,
      version: "1.0.0",
      now: makeClock().now,
    });
    const hooks = await plugin({ client });
    return { hooks };
  }

  function messageEvent(
    sessionId: string,
    messageId: string,
    role: "user" | "assistant",
  ): OpencodeBusEvent {
    return {
      type: "message.updated",
      properties: {
        sessionID: sessionId,
        info: {
          id: messageId,
          sessionID: sessionId,
          role,
          time: { created: 1 },
          agent: "build",
          model: { providerID: "p", modelID: "m" },
        },
      },
    };
  }

  function textPartEvent(
    sessionId: string,
    messageId: string,
    text: string,
    extras: Record<string, unknown> = {},
  ): OpencodeBusEvent {
    return {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        time: 2,
        part: {
          id: `pt-${messageId}`,
          sessionID: sessionId,
          messageID: messageId,
          type: "text",
          text,
          ...extras,
        },
      },
    };
  }

  it("user message → text part writes last_prompt", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      messageEvent("s1", "m1", "user"),
      textPartEvent("s1", "m1", "summarize this repo"),
    ]);
    expect(readMarker(markersDir, "s1")).toMatchObject({
      last_prompt: "summarize this repo",
    });
  });

  it("text part for an unknown messageID is ignored", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      textPartEvent("s1", "m-unknown", "stray text"),
    ]);
    expect(readMarker(markersDir, "s1")?.last_prompt).toBeUndefined();
  });

  it("assistant message text part does not write last_prompt", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      messageEvent("s1", "m1", "assistant"),
      textPartEvent("s1", "m1", "I am the assistant"),
    ]);
    expect(readMarker(markersDir, "s1")?.last_prompt).toBeUndefined();
  });

  it("synthetic text parts are skipped", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      messageEvent("s1", "m1", "user"),
      textPartEvent("s1", "m1", "compaction summary", { synthetic: true }),
    ]);
    expect(readMarker(markersDir, "s1")?.last_prompt).toBeUndefined();
  });

  it("empty/whitespace-only text is skipped", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      messageEvent("s1", "m1", "user"),
      textPartEvent("s1", "m1", "   \n\t  "),
    ]);
    expect(readMarker(markersDir, "s1")?.last_prompt).toBeUndefined();
  });

  it("text >1024 bytes is truncated to 1024", async () => {
    const { hooks } = await setup();
    const longText = "x".repeat(2000);
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      messageEvent("s1", "m1", "user"),
      textPartEvent("s1", "m1", longText),
    ]);
    const stored = readMarker(markersDir, "s1")?.last_prompt;
    expect(typeof stored).toBe("string");
    expect((stored as string).length).toBe(1024);
    expect((stored as string)[0]).toBe("x");
  });

  it("session.deleted clears tracked user message IDs", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      messageEvent("s1", "m1", "user"),
      {
        type: "session.deleted",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
    ]);
    expect(readMarker(markersDir, "s1")).toBeNull();

    // Re-create the session and replay the same messageId without a fresh
    // message.updated. Without the cleanup, the old set would still match.
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      textPartEvent("s1", "m1", "should not stick"),
    ]);
    expect(readMarker(markersDir, "s1")?.last_prompt).toBeUndefined();
  });

  it("non-text part for a registered user messageID does not clobber", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      messageEvent("s1", "m1", "user"),
      textPartEvent("s1", "m1", "real prompt"),
      // Subsequent file-type part on the same user message should not touch
      // last_prompt. Build the file part inline since textPartEvent is
      // text-typed by definition.
      {
        type: "message.part.updated",
        properties: {
          sessionID: "s1",
          time: 3,
          part: {
            id: "pf",
            sessionID: "s1",
            messageID: "m1",
            type: "file",
            filename: "foo.txt",
            mime: "text/plain",
            url: "file://foo.txt",
          },
        },
      },
    ]);
    expect(readMarker(markersDir, "s1")?.last_prompt).toBe("real prompt");
  });

  it("multi-turn: second user prompt overwrites the first", async () => {
    const { hooks } = await setup();
    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
      messageEvent("s1", "m1", "user"),
      textPartEvent("s1", "m1", "first prompt"),
    ]);
    expect(readMarker(markersDir, "s1")?.last_prompt).toBe("first prompt");

    await dispatchAll(hooks, [
      messageEvent("s1", "m2", "user"),
      textPartEvent("s1", "m2", "second prompt"),
    ]);
    expect(readMarker(markersDir, "s1")?.last_prompt).toBe("second prompt");
  });
});

describe("makePlugin: concurrent write ordering", () => {
  it("serializes permission.asked and session.status arriving same-tick", async () => {
    const client = makeClient([], {});
    const clock = makeClock();
    const plugin = makePlugin({
      markersDir,
      version: "1.0.0",
      now: clock.now,
    });
    const hooks = await plugin({ client });

    await dispatchAll(hooks, [
      {
        type: "session.created",
        properties: { info: { id: "s1", directory: "/r", title: "t" } },
      },
    ]);

    // Fire waiting then immediately working, in the same tick.
    const p1 = hooks.event({
      event: {
        type: "permission.asked",
        properties: {
          id: "p1",
          sessionID: "s1",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
        },
      },
    });
    const p2 = hooks.event({
      event: {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      },
    });
    await Promise.all([p1, p2]);
    await drainQueues();

    // Final state is the LATER event (working), not interleaved.
    const m = readMarker(markersDir, "s1");
    expect(m?.state).toBe("working");
  });
});
