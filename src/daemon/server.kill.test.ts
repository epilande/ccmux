/**
 * `POST /sessions/:id/kill` for a normal (non-background) row: the daemon
 * waits for the process to actually die and only then removes the session, so
 * every attached client learns about it through the ordinary
 * `session_removed` broadcast instead of each one guessing locally.
 *
 * A file of its own, for the reason `server.handoff.test.ts` is: these cases
 * drive REAL child processes (a `sleep`, a SIGTERM-immune `bash`, an
 * already-reaped pid) rather than a `process.kill` spy, so what is proved is
 * the poll's actual behavior against a real process table — and
 * `server.test.ts` is already contended.
 */

import { describe, it, expect, mock } from "bun:test";
import { DaemonServer } from "./server";
import { SessionManager } from "./sessions";
import type { SessionEvent } from "./sessions";
import { AttentionTracker } from "./attention-tracker";
import { InvocationManager } from "./invocation-manager";
import { InvocationRegistry } from "./invokers/registry";
import { stubInvoker } from "./invokers/test-helpers";
import { BUILTIN_AGENTS } from "../lib/agents";
import type { TmuxPane } from "../types/session";

type Internals = {
  handleKillSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<Response>;
  sseClients: Map<
    string,
    { id: string; controller: { enqueue: (data: string) => void } }
  >;
  visibleSessions: Set<string>;
};

const LOG_PATH = "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl";

function createServer() {
  const manager = new SessionManager();
  const paneCache = new Map<string, TmuxPane>();
  const server = new DaemonServer(
    manager,
    () => paneCache,
    (agentType: string) => BUILTIN_AGENTS.find((a) => a.name === agentType),
    new AttentionTracker(5_000),
    new InvocationManager(
      manager,
      new InvocationRegistry(
        stubInvoker("claude-interactive"),
        stubInvoker("subprocess"),
      ),
    ),
    () => null,
    {
      sendLiteralToPane: mock(async () => true),
      sendPromptToPane: mock(async () => true),
    },
    null,
    null,
  );

  const events: SessionEvent[] = [];
  manager.on("change", (event: SessionEvent) => events.push(event));

  const frames: string[] = [];
  const internals = server as unknown as Internals;
  internals.sseClients.set("test-client", {
    id: "test-client",
    controller: { enqueue: (data: string) => frames.push(data) },
  });

  return { manager, internals, events, frames };
}

/** The SSE fan-out listener is async; give it up to `ms` to run. */
async function waitFor(
  predicate: () => boolean,
  ms = 1000,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(10);
  }
  return predicate();
}

describe("POST /sessions/:id/kill removes the session daemon-side", () => {
  it("waits for the process to die, then removes the row and broadcasts it", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    const { manager, internals, events, frames } = createServer();

    manager.createSession("kill-live", LOG_PATH, "claude");
    manager.setPid("kill-live", child.pid);
    // Precondition for the wire assertion: the row is SSE-visible, so its
    // removal is a frame a client would actually receive.
    expect(await waitFor(() => internals.visibleSessions.has("kill-live"))).toBe(
      true,
    );
    events.length = 0;
    frames.length = 0;

    const started = performance.now();
    const response = await internals.handleKillSession("kill-live", {});
    const elapsedMs = performance.now() - started;
    const body = (await response.json()) as {
      success: boolean;
      killed: boolean;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, killed: true });
    expect(manager.getSession("kill-live")).toBeUndefined();
    expect(
      events.some((e) => e.type === "removed" && e.sessionId === "kill-live"),
    ).toBe(true);
    // The whole point of the wait: a real SIGTERM-able process is gone well
    // inside the 2s cap, so the user does not sit on a spinner.
    expect(elapsedMs).toBeLessThan(1500);

    expect(
      await waitFor(() =>
        frames.some(
          (f) => f.includes('"session_removed"') && f.includes("kill-live"),
        ),
      ),
    ).toBe(true);

    await child.exited;
  });

  it("keeps the row when the process ignores SIGTERM, capped at ~2s", async () => {
    // `trap "" TERM` before the marker line, so reading "ready" proves the
    // trap is installed and the SIGTERM below cannot race it.
    const child = Bun.spawn(
      ["bash", "-c", 'trap "" TERM; echo ready; sleep 30'],
      { stdout: "pipe" },
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    reader.releaseLock();

    const { manager, internals, events, frames } = createServer();
    manager.createSession("kill-immune", LOG_PATH, "claude");
    manager.setPid("kill-immune", child.pid);
    expect(
      await waitFor(() => internals.visibleSessions.has("kill-immune")),
    ).toBe(true);
    events.length = 0;
    frames.length = 0;

    try {
      const started = performance.now();
      const response = await internals.handleKillSession("kill-immune", {});
      const elapsedMs = performance.now() - started;
      const body = (await response.json()) as {
        success: boolean;
        killed: boolean;
      };

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true, killed: false });
      // The trap really held: the process the poll gave up on is still alive.
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      // A row whose process survived must NOT vanish — the client is told
      // nothing was killed, and the next scan owns whatever happens next.
      expect(manager.getSession("kill-immune")).toBeDefined();
      expect(events.some((e) => e.type === "removed")).toBe(false);
      expect(frames.some((f) => f.includes('"session_removed"'))).toBe(false);
      // The cap, measured: ~2s of polling, not an unbounded wait.
      expect(elapsedMs).toBeGreaterThanOrEqual(1900);
      expect(elapsedMs).toBeLessThan(3000);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  it("removes an already-dead session immediately (ESRCH, no poll)", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    child.kill("SIGKILL");
    // The reap, not just the death: an unreaped zombie still answers
    // `kill(pid, 0)`, which would send the handler into the 2s poll.
    await child.exited;

    const { manager, internals, events, frames } = createServer();
    manager.createSession("kill-dead", LOG_PATH, "claude");
    manager.setPid("kill-dead", child.pid);
    expect(await waitFor(() => internals.visibleSessions.has("kill-dead"))).toBe(
      true,
    );
    events.length = 0;
    frames.length = 0;

    const started = performance.now();
    const response = await internals.handleKillSession("kill-dead", {});
    const elapsedMs = performance.now() - started;
    const body = (await response.json()) as {
      success: boolean;
      killed: boolean;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, killed: true });
    expect(manager.getSession("kill-dead")).toBeUndefined();
    expect(
      events.some((e) => e.type === "removed" && e.sessionId === "kill-dead"),
    ).toBe(true);
    expect(elapsedMs).toBeLessThan(500);

    expect(
      await waitFor(() =>
        frames.some(
          (f) => f.includes('"session_removed"') && f.includes("kill-dead"),
        ),
      ),
    ).toBe(true);
  });
});
