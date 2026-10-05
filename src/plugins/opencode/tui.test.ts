import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { describeForm, describePermission, makeTuiPlugin } from "./tui.js";
import type { OpencodeRoute, OpencodeTuiContext } from "./tui.js";

const PID = 4242;
const OTHER_PID = 5151;

/**
 * A stand-in for OpenCode 2's TUI plugin context: the route, the session
 * stores the plugin reads, and the event stream. Mutate the fields, then
 * `emit` an event (or call `tick`) the way OpenCode would.
 */
function makeCtx() {
  const listeners: Array<(e: { details: { type: string; data?: unknown } }) => void> = [];
  // Seed syncs resolve at once unless a test holds them.
  let holdSyncs = false;
  const heldSyncs: Array<() => void> = [];
  const sync = async () => {
    if (holdSyncs) await new Promise<void>((resolve) => heldSyncs.push(resolve));
  };
  const fake = {
    route: { type: "home" } as OpencodeRoute,
    status: new Map<string, "idle" | "running">(),
    permissions: new Map<string, unknown[]>(),
    forms: new Map<string, unknown[]>(),
    messages: new Map<string, unknown[]>(),
    family: new Map<string, string[]>(),
    parent: new Map<string, string>(),
    info: new Map<string, { title?: string; location?: { directory?: string } }>(),
    synced: [] as string[],
    emit(type: string, data: unknown = {}) {
      for (const listener of listeners) listener({ details: { type, data } });
    },
    /** Keep seed syncs pending until `releaseSyncs()`. */
    holdSyncs() {
      holdSyncs = true;
    },
    releaseSyncs() {
      for (const resolve of heldSyncs.splice(0)) resolve();
    },
  };
  const ctx: OpencodeTuiContext = {
    ui: { router: { current: () => fake.route } },
    data: {
      listen(handler) {
        listeners.push(handler);
        return () => listeners.splice(listeners.indexOf(handler), 1);
      },
      session: {
        get: (id) => fake.info.get(id),
        root: (id) => fake.parent.get(id) ?? id,
        family: (id) => fake.family.get(id) ?? [id],
        status: (id) => fake.status.get(id) ?? "idle",
        message: { list: (id) => fake.messages.get(id) },
        permission: {
          list: (id) => fake.permissions.get(id),
          sync: async (id) => {
            fake.synced.push(`permission:${id}`);
            await sync();
          },
        },
        form: {
          list: (id) => fake.forms.get(id),
          sync: async (id) => {
            fake.synced.push(`form:${id}`);
            await sync();
          },
        },
      },
    },
  };
  return { ctx, fake };
}

/** Let the plugin's `setTimeout(refresh, 0)` and seed promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

let markersDir: string;
let alive: Set<number>;
let cleanups: Array<() => void>;

function start(opts: { pid?: number; pollMs?: number } = {}) {
  const { ctx, fake } = makeCtx();
  const plugin = makeTuiPlugin({
    markersDir,
    version: "0.0.0-test",
    now: () => 1_790_000_000_000,
    pid: opts.pid ?? PID,
    isAlive: (pid) => alive.has(pid),
    pollMs: opts.pollMs ?? 0,
  });
  const cleanup = plugin.setup(ctx);
  cleanups.push(cleanup);
  return { ctx, fake, cleanup };
}

function marker(sessionId: string): Record<string, unknown> | null {
  const path = join(markersDir, `opencode-${sessionId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeForeignMarker(sessionId: string, pid: number) {
  writeFileSync(
    join(markersDir, `opencode-${sessionId}.json`),
    JSON.stringify({ agent_type: "opencode", pid, session_id: sessionId }),
  );
}

beforeEach(() => {
  markersDir = mkdtempSync(join(tmpdir(), "ccmux-oc-tui-"));
  alive = new Set([PID, OTHER_PID]);
  cleanups = [];
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  rmSync(markersDir, { recursive: true, force: true });
});

describe("OpenCode 2 TUI plugin", () => {
  it("writes nothing while the pane is on the home screen", async () => {
    start();
    await settle();
    expect(existsSync(join(markersDir, "opencode-ses_a.json"))).toBe(false);
  });

  it("writes nothing while --continue has no session to continue", async () => {
    // OpenCode starts `--continue` on a placeholder session id and stays on
    // it when the directory has no session; it must not become a marker.
    const { fake } = start();
    fake.route = { type: "session", sessionID: "dummy" };
    fake.emit("session.execution.started", { sessionID: "ses_other" });
    await settle();
    expect(marker("dummy")).toBeNull();
    expect(fake.synced).toEqual([]);

    // Once --continue lands on a real session, that one is reported.
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.execution.started", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")?.session_id).toBe("ses_a");
  });

  it("reports the session on screen with the 1.x marker schema", async () => {
    const { fake } = start();
    fake.info.set("ses_a", {
      title: "Fix the tests",
      location: { directory: "/repo" },
    });
    fake.status.set("ses_a", "running");
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.execution.started", { sessionID: "ses_a" });
    await settle();

    expect(marker("ses_a")).toMatchObject({
      agent_type: "opencode",
      pid: PID,
      session_id: "ses_a",
      state: "working",
      directory: "/repo",
      title: "Fix the tests",
      pending_tool: null,
      permission_context: null,
      timestamp: 1_790_000_000,
      state_timestamp: 1_790_000_000,
    });
  });

  it("follows the turn from working back to idle", async () => {
    const { fake } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.status.set("ses_a", "running");
    fake.emit("session.execution.started", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")?.state).toBe("working");

    fake.status.set("ses_a", "idle");
    fake.emit("session.execution.succeeded", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")?.state).toBe("idle");
  });

  it("seeds pending prompts when it starts showing a session", async () => {
    const { fake } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    expect(fake.synced).toEqual(["permission:ses_a", "form:ses_a"]);
  });

  it("is waiting on a permission, naming the action and the command", async () => {
    const { fake } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.status.set("ses_a", "running");
    fake.permissions.set("ses_a", [
      { id: "per_1", action: "shell", resources: ["rm -rf build"], save: ["rm *"] },
    ]);
    fake.emit("permission.asked", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")).toMatchObject({
      state: "waiting_permission",
      pending_tool: "shell",
      permission_context: "rm -rf build",
    });

    fake.permissions.set("ses_a", []);
    fake.emit("permission.replied", { sessionID: "ses_a", reply: "reject" });
    await settle();
    expect(marker("ses_a")).toMatchObject({
      state: "working",
      pending_tool: null,
      permission_context: null,
    });
  });

  it("is waiting on a question while the question tool's form is open", async () => {
    const { fake } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.status.set("ses_a", "running");
    fake.forms.set("ses_a", [
      {
        id: "frm_1",
        title: "Questions",
        fields: [{ key: "q0", title: "Beverage", description: "Tea or coffee?" }],
      },
    ]);
    fake.emit("form.created", { form: { sessionID: "ses_a" } });
    await settle();
    expect(marker("ses_a")).toMatchObject({
      state: "waiting_question",
      permission_context: "Tea or coffee?",
    });
  });

  it("folds a subagent's prompt into its root session", async () => {
    const { fake } = start();
    fake.route = { type: "session", sessionID: "ses_child" };
    fake.parent.set("ses_child", "ses_root");
    fake.family.set("ses_root", ["ses_root", "ses_child"]);
    fake.permissions.set("ses_child", [{ action: "edit", resources: ["a.ts"] }]);
    fake.emit("permission.asked", { sessionID: "ses_child" });
    await settle();
    expect(marker("ses_child")).toBeNull();
    expect(marker("ses_root")).toMatchObject({
      session_id: "ses_root",
      state: "waiting_permission",
      pending_tool: "edit",
    });
  });

  it("records the last prompt from the inbox, falling back to loaded messages", async () => {
    const { fake } = start();
    fake.messages.set("ses_a", [
      { type: "user", text: "older prompt" },
      { type: "assistant" },
    ]);
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")?.last_prompt).toBe("older prompt");

    fake.emit("session.inbox.enqueued", {
      sessionID: "ses_a",
      item: { type: "user", payload: { text: "  newest prompt  " } },
    });
    await settle();
    expect(marker("ses_a")?.last_prompt).toBe("newest prompt");
  });

  it("moves its marker when the pane switches sessions, and drops it on home", async () => {
    const { fake } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")).not.toBeNull();

    fake.route = { type: "session", sessionID: "ses_b" };
    fake.emit("session.renamed", { sessionID: "ses_b" });
    await settle();
    expect(marker("ses_a")).toBeNull();
    expect(marker("ses_b")?.pid).toBe(PID);

    fake.route = { type: "home" };
    fake.emit("session.renamed", { sessionID: "ses_b" });
    await settle();
    expect(marker("ses_b")).toBeNull();
  });

  it("notices a route change on its own poll, with no event", async () => {
    const { fake } = start({ pollMs: 5 });
    fake.route = { type: "session", sessionID: "ses_a" };
    await new Promise((r) => setTimeout(r, 40));
    expect(marker("ses_a")?.pid).toBe(PID);
  });

  it("rewrites its marker if the file goes missing while state is unchanged", async () => {
    const { fake } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    rmSync(join(markersDir, "opencode-ses_a.json"));

    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")?.pid).toBe(PID);
  });

  it("removes its marker when the session is deleted", async () => {
    const { fake } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    fake.emit("session.deleted", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")).toBeNull();
  });

  it("does not bring a deleted session's marker back while the route still names it", async () => {
    // OpenCode can keep the deleted session's route for a moment before it
    // navigates away; the next poll must not treat it as a new session.
    const { fake } = start({ pollMs: 5 });
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")).not.toBeNull();

    fake.emit("session.deleted", { sessionID: "ses_a" });
    await new Promise((r) => setTimeout(r, 40));
    expect(marker("ses_a")).toBeNull();
  });

  it("lets go of a session another pane deleted, even though it never owned it", async () => {
    writeForeignMarker("ses_a", OTHER_PID);
    const { fake } = start({ pollMs: 5 });
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();

    // The owner goes away with the session; this pane must not claim it.
    alive.delete(OTHER_PID);
    rmSync(join(markersDir, "opencode-ses_a.json"));
    fake.emit("session.deleted", { sessionID: "ses_a" });
    await new Promise((r) => setTimeout(r, 40));
    expect(marker("ses_a")).toBeNull();
  });

  it("removes its own marker on cleanup", async () => {
    const { fake, cleanup } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    cleanup();
    expect(marker("ses_a")).toBeNull();
  });

  // OpenCode can dispose the plugin while the TUI keeps running, and the
  // exit hook goes with it: a marker written after cleanup would stay
  // until the process dies, keeping every other pane from claiming it.
  it("writes nothing after cleanup when a seed resolves late", async () => {
    const { fake, cleanup } = start();
    fake.holdSyncs();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();
    expect(marker("ses_a")).not.toBeNull();

    cleanup();
    fake.releaseSyncs();
    await settle();
    expect(marker("ses_a")).toBeNull();
  });

  it("writes nothing after cleanup when an event refresh is still queued", async () => {
    const { fake, cleanup } = start();
    fake.route = { type: "session", sessionID: "ses_a" };
    fake.emit("session.renamed", { sessionID: "ses_a" });
    await settle();

    fake.status.set("ses_a", "running");
    fake.emit("session.execution.started", { sessionID: "ses_a" });
    cleanup();
    await settle();
    expect(marker("ses_a")).toBeNull();
  });

  it("logs a failure that lasts across polls once", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fake } = start({ pollMs: 5 });
      fake.route = { type: "session", sessionID: "ses_a" };
      // A file where the markers dir should be: every write fails.
      rmSync(markersDir, { recursive: true, force: true });
      writeFileSync(markersDir, "");
      await new Promise((r) => setTimeout(r, 40));
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  describe("two panes showing the same session", () => {
    it("leaves a live TUI's marker alone", async () => {
      writeForeignMarker("ses_a", OTHER_PID);
      const { fake, cleanup } = start();
      fake.route = { type: "session", sessionID: "ses_a" };
      fake.status.set("ses_a", "running");
      fake.emit("session.execution.started", { sessionID: "ses_a" });
      await settle();
      expect(marker("ses_a")?.pid).toBe(OTHER_PID);

      // Nor does it delete a marker it never owned.
      cleanup();
      expect(marker("ses_a")?.pid).toBe(OTHER_PID);
    });

    it("takes over once the owning TUI has exited", async () => {
      writeForeignMarker("ses_a", OTHER_PID);
      alive.delete(OTHER_PID);
      const { fake } = start();
      fake.route = { type: "session", sessionID: "ses_a" };
      fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();
      expect(marker("ses_a")?.pid).toBe(PID);
    });

    it("hands over through the file: the owner leaves, the other claims", async () => {
      const a = start({ pid: PID });
      a.fake.route = { type: "session", sessionID: "ses_a" };
      a.fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();

      const b = start({ pid: OTHER_PID });
      b.fake.route = { type: "session", sessionID: "ses_a" };
      b.fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();
      expect(marker("ses_a")?.pid).toBe(PID);

      a.fake.route = { type: "home" };
      a.fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();
      b.fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();
      expect(marker("ses_a")?.pid).toBe(OTHER_PID);
    });

    it("yields when another TUI won a simultaneous claim", async () => {
      const { fake, cleanup } = start();
      fake.route = { type: "session", sessionID: "ses_a" };
      fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();
      writeForeignMarker("ses_a", OTHER_PID);

      fake.status.set("ses_a", "running");
      fake.emit("session.execution.started", { sessionID: "ses_a" });
      await settle();
      expect(marker("ses_a")?.pid).toBe(OTHER_PID);
      cleanup();
      expect(marker("ses_a")?.pid).toBe(OTHER_PID);
    });

    it("notices a lost simultaneous claim while its state holds steady", async () => {
      const { fake } = start();
      fake.route = { type: "session", sessionID: "ses_a" };
      fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();
      // The other TUI's write landed last.
      writeForeignMarker("ses_a", OTHER_PID);
      fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();
      expect(marker("ses_a")?.pid).toBe(OTHER_PID);

      // Without a state change, it still takes over once the winner exits.
      alive.delete(OTHER_PID);
      fake.emit("session.renamed", { sessionID: "ses_a" });
      await settle();
      expect(marker("ses_a")?.pid).toBe(PID);
    });
  });
});

describe("describePermission", () => {
  it("prefers the request's message, then metadata, then the first resource", () => {
    expect(describePermission({ message: "Run the migration", resources: ["x"] })).toBe(
      "Run the migration",
    );
    expect(describePermission({ metadata: { command: "ls" }, resources: ["x"] })).toBe("ls");
    expect(describePermission({ action: "shell", resources: ["echo hi"] })).toBe("echo hi");
    expect(describePermission({ action: "question", resources: [] })).toBe("question");
    // The question tool asks for itself with a bare wildcard resource.
    expect(describePermission({ action: "question", resources: ["*"] })).toBe("question");
    expect(describePermission(null)).toBeNull();
  });
});

describe("describeForm", () => {
  it("names the first question and counts the rest", () => {
    expect(
      describeForm({
        fields: [
          { title: "A", description: "First?" },
          { title: "B", description: "Second?" },
        ],
      }),
    ).toBe("First? (+1 more)");
    expect(describeForm({ title: "Questions", fields: [{ title: "Only title" }] })).toBe(
      "Only title",
    );
    expect(describeForm({ title: "Questions", fields: [] })).toBe("Questions");
    expect(describeForm({})).toBeNull();
  });
});
