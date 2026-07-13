import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeLogAdapter } from "./log-adapter";
import { SessionManager } from "../../sessions";
import type { SessionState } from "../../../types/session";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const ENCODED_PROJECT = "-Users-test-proj";

function parentState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    ...overrides,
  };
}

/**
 * A subagent transcript whose tail derives `working`: a tool_use followed
 * by its tool_result (all pending tools resolved → working).
 */
function workingLogContent(timestamp: string): string {
  const toolUse = JSON.stringify({
    type: "assistant",
    uuid: "a1",
    parentUuid: null,
    timestamp,
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }],
    },
  });
  const toolResult = JSON.stringify({
    type: "user",
    uuid: "u1",
    parentUuid: "a1",
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
    },
  });
  return `${toolUse}\n${toolResult}\n`;
}

/** Poll until `check` passes or the timeout elapses (chokidar is async). */
async function waitFor(
  check: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe("ClaudeLogAdapter subagent watching", () => {
  let projectsDir: string;
  let subagentDir: string;
  let manager: SessionManager;
  let adapter: ClaudeLogAdapter;

  const watchedDirs = () =>
    (adapter as unknown as { watchedSubagentDirs: Set<string> })
      .watchedSubagentDirs;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "ccmux-subagent-test-"));
    const projectDir = join(projectsDir, ENCODED_PROJECT);
    subagentDir = join(projectDir, SESSION_ID, "subagents");
    mkdirSync(subagentDir, { recursive: true });

    manager = new SessionManager();
    manager.createSession(
      SESSION_ID,
      join(projectDir, `${SESSION_ID}.jsonl`),
      "claude",
    );

    adapter = new ClaudeLogAdapter(manager, projectsDir);
  });

  afterEach(async () => {
    await adapter.stop();
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it("attaches on subagents-dir activity without hasActiveSubagent and populates working subagents", async () => {
    // Background teammates: the parent log has no Task bookkeeping, only
    // the actively-written subagent file signals their existence.
    const file = join(subagentDir, "agent-aabc123.jsonl");
    writeFileSync(file, workingLogContent(new Date().toISOString()));

    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ hasActiveSubagent: false }),
    );

    expect(watchedDirs().has(subagentDir)).toBe(true);
    const populated = await waitFor(
      () => manager.getSession(SESSION_ID)!.subagents.length === 1,
    );
    expect(populated).toBe(true);
    const sub = manager.getSession(SESSION_ID)!.subagents[0];
    expect(sub.agentId).toBe("aabc123");
    expect(sub.status).toBe("working");
  });

  it("records startedAt from the first transcript entry (runtime since spawn)", async () => {
    // The preview shows runtime since spawn, so the subagent's startedAt
    // must come from the head of the transcript, not the latest (tail)
    // activity. Fresh timestamps so the stale-seed cap keeps the working
    // subagent; the spawn (head) is earlier than the latest (tail) write.
    const now = Date.now();
    const spawn = new Date(now - 5 * 60_000).toISOString();
    const latest = new Date(now).toISOString();
    const head = JSON.stringify({
      type: "user",
      uuid: "head",
      parentUuid: null,
      timestamp: spawn,
      message: { role: "user", content: "go" },
    });
    const file = join(subagentDir, "agent-astarted.jsonl");
    writeFileSync(file, `${head}\n${workingLogContent(latest)}`);

    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ hasActiveSubagent: false }),
    );

    const populated = await waitFor(
      () => manager.getSession(SESSION_ID)!.subagents.length === 1,
    );
    expect(populated).toBe(true);
    const sub = manager.getSession(SESSION_ID)!.subagents[0];
    expect(sub.startedAt).toBe(spawn);
    expect(sub.lastActivityAt).toBe(latest);
  });

  it("tracks named teammate files (agent-a<name>-<hex>.jsonl)", async () => {
    // Teammates embed the agent name in the filename; the extraction regex
    // must accept more than bare hex (regression: named teammates were
    // silently ignored).
    const file = join(
      subagentDir,
      "agent-areviewer-functionality-962e7b6779826138.jsonl",
    );
    writeFileSync(file, workingLogContent(new Date().toISOString()));

    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ hasActiveSubagent: false }),
    );

    const populated = await waitFor(
      () => manager.getSession(SESSION_ID)!.subagents.length === 1,
    );
    expect(populated).toBe(true);
    expect(manager.getSession(SESSION_ID)!.subagents[0].agentId).toBe(
      "areviewer-functionality-962e7b6779826138",
    );
  });

  it("attaches via onReconcileTick when the parent log has gone quiet", async () => {
    // Regression from live e2e: teammates spawn, the parent ends its turn,
    // and no further parent parses ever fire — the reconciler tick must
    // pick up the active dir on its own.
    const file = join(subagentDir, "agent-asleeper-one-8c2e4613a97d4ec9.jsonl");
    writeFileSync(file, workingLogContent(new Date().toISOString()));

    adapter.onReconcileTick(manager.getSession(SESSION_ID)!);

    expect(watchedDirs().has(subagentDir)).toBe(true);
    const populated = await waitFor(
      () => manager.getSession(SESSION_ID)!.subagents.length === 1,
    );
    expect(populated).toBe(true);
    expect(manager.getSession(SESSION_ID)!.subagents[0].status).toBe("working");
  });

  it("does not attach when subagent files are older than the staleness threshold", () => {
    const file = join(subagentDir, "agent-aabc123.jsonl");
    writeFileSync(file, workingLogContent(new Date().toISOString()));
    const oldTime = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, oldTime, oldTime);

    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ hasActiveSubagent: false }),
    );

    expect(watchedDirs().has(subagentDir)).toBe(false);
  });

  it("still attaches via hasActiveSubagent (blocking Task path)", () => {
    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ status: "working", hasActiveSubagent: true }),
    );

    expect(watchedDirs().has(subagentDir)).toBe(true);
  });

  it("caps a stale working seed to idle so finished logs don't resurrect", async () => {
    // Fresh mtime (attach probe passes) but old entry timestamps: seeding
    // must cap the derived `working` to idle, and updateSubagent filters
    // idle entries out, so the array stays empty.
    const file = join(subagentDir, "agent-aabc123.jsonl");
    const oldTimestamp = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(file, workingLogContent(oldTimestamp));

    const seenStatuses: string[] = [];
    const originalUpdate = manager.updateSubagent.bind(manager);
    manager.updateSubagent = (sessionId, subagent) => {
      seenStatuses.push(subagent.status);
      return originalUpdate(sessionId, subagent);
    };

    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ hasActiveSubagent: false }),
    );

    expect(watchedDirs().has(subagentDir)).toBe(true);
    const seeded = await waitFor(() => seenStatuses.length > 0);
    expect(seeded).toBe(true);
    expect(seenStatuses).toEqual(["idle"]);
    expect(manager.getSession(SESSION_ID)!.subagents).toHaveLength(0);
  });

  it("does not tear down while live subagents remain, even when the parent reads idle", async () => {
    const file = join(subagentDir, "agent-aabc123.jsonl");
    writeFileSync(file, workingLogContent(new Date().toISOString()));

    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ hasActiveSubagent: false }),
    );
    await waitFor(() => manager.getSession(SESSION_ID)!.subagents.length === 1);

    // Parent goes idle (teammate mode: lead sits at its prompt).
    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ status: "idle", hasActiveSubagent: false }),
    );

    expect(watchedDirs().has(subagentDir)).toBe(true);
    expect(manager.getSession(SESSION_ID)!.subagents).toHaveLength(1);
  });

  it("tears down once subagents are gone and the dir is inactive", () => {
    // Attach via the blocking-Task flag so the activity probe result is
    // not cached as active (the flag short-circuits the probe).
    const file = join(subagentDir, "agent-aabc123.jsonl");
    writeFileSync(file, workingLogContent(new Date().toISOString()));
    const oldTime = new Date(Date.now() - 10 * 60_000);
    utimesSync(file, oldTime, oldTime);

    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ status: "working", hasActiveSubagent: true }),
    );
    expect(watchedDirs().has(subagentDir)).toBe(true);

    adapter.onSessionStateUpdated(
      SESSION_ID,
      parentState({ status: "idle", hasActiveSubagent: false }),
    );

    expect(watchedDirs().has(subagentDir)).toBe(false);
  });
});
