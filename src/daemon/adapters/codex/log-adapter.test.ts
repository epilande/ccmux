import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CodexLogAdapter } from "./log-adapter";
import type { SessionState } from "../../../types/session";
import {
  jsonl,
  codexSessionMeta as sessionMeta,
  codexEventMsg as eventMsg,
  codexResponseItem as responseItem,
} from "./test-helpers";

describe("CodexLogAdapter", () => {
  let testDir: string;
  let adapter: CodexLogAdapter;
  let logPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ccmux-codex-adapter-"));
    adapter = new CodexLogAdapter();
    logPath = join(testDir, "rollout.jsonl");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("declares codex agentType, the sessions directory, and a depth bounded by YYYY/MM/DD", () => {
      expect(adapter.agentType).toBe("codex");
      expect(adapter.logDirGlob).toMatch(/\.codex\/sessions$/);
      expect(adapter.watchDepth).toBe(4);
    });
  });

  describe("resolveSessionIdFromPath", () => {
    it("extracts the UUID from a real Codex rollout filename", () => {
      const path =
        "/Users/test/.codex/sessions/2026/02/20/rollout-2026-02-20T17-33-56-019c7dd4-ff41-79c0-8270-d030bb51cd90.jsonl";
      expect(adapter.resolveSessionIdFromPath(path)).toBe(
        "019c7dd4-ff41-79c0-8270-d030bb51cd90",
      );
    });

    it("returns null for non-rollout filenames", () => {
      expect(
        adapter.resolveSessionIdFromPath("/tmp/some-other-file.jsonl"),
      ).toBeNull();
    });
  });

  describe("parseSessionMetadata", () => {
    it("returns metadata from a session_meta line", () => {
      const meta = adapter.parseSessionMetadata(JSON.stringify(sessionMeta()));
      expect(meta).toEqual({
        nativeSessionId: "019c7dd4-ff41-79c0-8270-d030bb51cd90",
        cwd: "/Users/test/project",
        timestamp: Date.parse("2026-04-01T12:00:00.000Z"),
        version: "0.57.0",
        gitBranch: "main",
      });
    });

    it("returns null when first line is not session_meta", () => {
      const line = JSON.stringify(eventMsg("2026-01-01T00:00:00Z", {}));
      expect(adapter.parseSessionMetadata(line)).toBeNull();
    });

    it("returns null on malformed JSON", () => {
      expect(adapter.parseSessionMetadata("not json")).toBeNull();
    });

    it("returns null on missing required payload fields", () => {
      const line = JSON.stringify({
        timestamp: "2026-04-01T12:00:00Z",
        type: "session_meta",
        payload: { id: "abc", cwd: "/x" }, // missing timestamp
      });
      expect(adapter.parseSessionMetadata(line)).toBeNull();
    });

    it("returns null when payload.timestamp is not a parseable date", () => {
      const line = JSON.stringify(sessionMeta({ timestamp: "not-a-date" }));
      expect(adapter.parseSessionMetadata(line)).toBeNull();
    });

    it("omits version and gitBranch when absent", () => {
      const line = JSON.stringify(
        sessionMeta({ cli_version: undefined, git: undefined }),
      );
      const meta = adapter.parseSessionMetadata(line);
      expect(meta?.version).toBeUndefined();
      expect(meta?.gitBranch).toBeUndefined();
    });
  });

  describe("deriveFullState - happy path", () => {
    it("seeds metadata, transitions through working, captures lastPrompt, settles to idle", async () => {
      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", {
            type: "task_started",
            turn_id: "t1",
          }),
          eventMsg("2026-04-01T12:00:02Z", {
            type: "user_message",
            message: "hello world",
          }),
          eventMsg("2026-04-01T12:00:03Z", {
            type: "agent_message",
            message: "ack",
          }),
          eventMsg("2026-04-01T12:00:04Z", {
            type: "task_complete",
            turn_id: "t1",
          }),
        ),
      );

      const { state, newOffset } = await adapter.deriveFullState(logPath);

      expect(state.status).toBe("idle");
      expect(state.cwd).toBe("/Users/test/project");
      expect(state.version).toBe("0.57.0");
      expect(state.gitBranch).toBe("main");
      expect(state.lastPrompt).toBe("hello world");
      expect(state.prompts).toEqual(["hello world"]);
      expect(state.lastUserInputAt).toBe("2026-04-01T12:00:02Z");
      expect(state.lastActivityAt).toBe("2026-04-01T12:00:04Z");
      expect(newOffset).toBeGreaterThan(0);
    });

    it("accumulates every user_message into the prompt index, oldest to newest", async () => {
      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", {
            type: "user_message",
            message: "first prompt",
          }),
          eventMsg("2026-04-01T12:00:02Z", {
            type: "agent_message",
            message: "ack",
          }),
          eventMsg("2026-04-01T12:00:03Z", {
            type: "user_message",
            message: "second prompt",
          }),
        ),
      );

      const { state } = await adapter.deriveFullState(logPath);

      expect(state.prompts).toEqual(["first prompt", "second prompt"]);
      expect(state.lastPrompt).toBe("second prompt");
    });
  });

  describe("deriveFullState - interrupted final turn", () => {
    it("leaves status as working when task_started has no matching task_complete", async () => {
      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", {
            type: "task_started",
            turn_id: "t1",
          }),
          eventMsg("2026-04-01T12:00:02Z", { type: "agent_reasoning" }),
        ),
      );

      const { state } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("working");
    });
  });

  describe("deriveFullState - turn_aborted", () => {
    it("settles to idle after turn_aborted and recovers on next task_started", async () => {
      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", { type: "task_started" }),
          eventMsg("2026-04-01T12:00:02Z", { type: "turn_aborted" }),
        ),
      );

      let { state } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("idle");

      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", { type: "task_started" }),
          eventMsg("2026-04-01T12:00:02Z", { type: "turn_aborted" }),
          eventMsg("2026-04-01T12:00:03Z", {
            type: "user_message",
            message: "retry",
          }),
          eventMsg("2026-04-01T12:00:04Z", { type: "task_started" }),
        ),
      );

      ({ state } = await adapter.deriveFullState(logPath));
      expect(state.status).toBe("working");
      expect(state.lastPrompt).toBe("retry");
    });
  });

  describe("deriveFullState - degraded inputs", () => {
    it("returns initial state on empty file", async () => {
      writeFileSync(logPath, "");
      const { state, newOffset } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("idle");
      expect(state.lastPrompt).toBeUndefined();
      expect(newOffset).toBe(0);
    });

    it("returns a default state when the file does not exist", async () => {
      const missing = join(testDir, "missing.jsonl");
      const { state, newOffset } = await adapter.deriveFullState(missing);
      expect(state.status).toBe("idle");
      expect(newOffset).toBe(0);
    });

    it("skips malformed JSON lines and applies surrounding entries", async () => {
      const validHeader = JSON.stringify(sessionMeta());
      const garbage = "this is not json {{}";
      const taskComplete = JSON.stringify(
        eventMsg("2026-04-01T12:00:05Z", { type: "task_complete" }),
      );
      writeFileSync(
        logPath,
        [validHeader, garbage, taskComplete].join("\n") + "\n",
      );

      const { state } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("idle");
      expect(state.cwd).toBe("/Users/test/project");
      expect(state.lastActivityAt).toBe("2026-04-01T12:00:05Z");
    });

    it("treats unknown event_msg payload types as activity-only", async () => {
      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", { type: "task_started" }),
          eventMsg("2026-04-01T12:00:02Z", { type: "token_count" }),
          responseItem("2026-04-01T12:00:03Z", { type: "function_call" }),
        ),
      );

      const { state } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("working");
      expect(state.lastActivityAt).toBe("2026-04-01T12:00:03Z");
    });
  });

  describe("deriveIncrementalState", () => {
    it("matches full derivation when applied across two reads", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));

      const first = await adapter.deriveFullState(logPath);
      expect(first.state.status).toBe("idle");
      expect(first.state.cwd).toBe("/Users/test/project");

      appendFileSync(
        logPath,
        jsonl(
          eventMsg("2026-04-01T12:00:01Z", {
            type: "user_message",
            message: "do the thing",
          }),
          eventMsg("2026-04-01T12:00:02Z", { type: "task_started" }),
          eventMsg("2026-04-01T12:00:03Z", { type: "task_complete" }),
        ),
      );

      const incremental = await adapter.deriveIncrementalState(
        logPath,
        first.newOffset,
        first.state,
      );

      expect(incremental.hasNewEntries).toBe(true);
      expect(incremental.state.status).toBe("idle");
      expect(incremental.state.lastPrompt).toBe("do the thing");
      expect(incremental.state.lastActivityAt).toBe("2026-04-01T12:00:03Z");

      const fullAgain = await adapter.deriveFullState(logPath);
      expect(incremental.state.status).toBe(fullAgain.state.status);
      expect(incremental.state.lastPrompt).toBe(fullAgain.state.lastPrompt);
      expect(incremental.state.lastActivityAt).toBe(
        fullAgain.state.lastActivityAt,
      );
      expect(incremental.newOffset).toBe(fullAgain.newOffset);
    });

    it("returns the prior state and offset when no new bytes are present", async () => {
      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", { type: "task_complete" }),
        ),
      );
      const first = await adapter.deriveFullState(logPath);

      const noop = await adapter.deriveIncrementalState(
        logPath,
        first.newOffset,
        first.state,
      );
      expect(noop.hasNewEntries).toBe(false);
      expect(noop.newOffset).toBe(first.newOffset);
      expect(noop.state).toBe(first.state);
    });

    it("waits for a complete line before consuming partial writes", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));
      const first = await adapter.deriveFullState(logPath);

      // Append a partial line (no trailing newline).
      appendFileSync(
        logPath,
        JSON.stringify(
          eventMsg("2026-04-01T12:00:01Z", { type: "task_started" }),
        ),
      );

      const partial = await adapter.deriveIncrementalState(
        logPath,
        first.newOffset,
        first.state,
      );
      expect(partial.hasNewEntries).toBe(false);
      expect(partial.newOffset).toBe(first.newOffset);

      // Complete the line; subsequent read picks it up.
      appendFileSync(logPath, "\n");
      const complete = await adapter.deriveIncrementalState(
        logPath,
        partial.newOffset,
        partial.state,
      );
      expect(complete.hasNewEntries).toBe(true);
      expect(complete.state.status).toBe("working");
    });

    it("never sets attentionType or pendingTool from log events (terminal overlay owns those)", async () => {
      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", { type: "task_started" }),
        ),
      );
      const { state } = await adapter.deriveFullState(logPath);
      expect(state.attentionType).toBeNull();
      expect(state.pendingTool).toBeNull();
    });
  });

  describe("permission-wait resolution via response_item outputs", () => {
    // These simulate the marker-written waiting state the reconciler feeds
    // back in as `prev` — the log adapter never sets attentionType/
    // pendingTool itself (see above), only clears them. `statusChangedAt`
    // is the store's stamp of when the wait was established, which the
    // stale-output gate compares entry timestamps against; omitting it
    // (the default) exercises the fail-open compat path.
    function waitingPrev(statusChangedAt?: string): SessionState {
      return {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
        inPlanMode: false,
        ...(statusChangedAt ? { statusChangedAt } : {}),
      };
    }

    it("flips waiting to working on a function_call_output entry", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));
      const seeded = await adapter.deriveFullState(logPath);

      appendFileSync(
        logPath,
        jsonl(
          responseItem("2026-04-01T12:00:05Z", {
            type: "function_call_output",
            call_id: "call-1",
          }),
        ),
      );

      const { state, hasNewEntries } = await adapter.deriveIncrementalState(
        logPath,
        seeded.newOffset,
        waitingPrev(),
      );

      expect(hasNewEntries).toBe(true);
      expect(state.status).toBe("working");
      expect(state.attentionType).toBeNull();
      expect(state.pendingTool).toBeNull();
    });

    it("flips waiting to working on a custom_tool_call_output entry", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));
      const seeded = await adapter.deriveFullState(logPath);

      appendFileSync(
        logPath,
        jsonl(
          responseItem("2026-04-01T12:00:05Z", {
            type: "custom_tool_call_output",
            call_id: "call-1",
          }),
        ),
      );

      const { state, hasNewEntries } = await adapter.deriveIncrementalState(
        logPath,
        seeded.newOffset,
        waitingPrev(),
      );

      expect(hasNewEntries).toBe(true);
      expect(state.status).toBe("working");
      expect(state.attentionType).toBeNull();
      expect(state.pendingTool).toBeNull();
    });

    it("leaves waiting alone on request-side response_item types (they can flush before the prompt resolves)", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));
      const seeded = await adapter.deriveFullState(logPath);

      appendFileSync(
        logPath,
        jsonl(responseItem("2026-04-01T12:00:05Z", { type: "reasoning" })),
      );

      const { state } = await adapter.deriveIncrementalState(
        logPath,
        seeded.newOffset,
        waitingPrev(),
      );

      expect(state.status).toBe("waiting");
    });

    it("is a no-op on a non-waiting prev status", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));
      const seeded = await adapter.deriveFullState(logPath);

      appendFileSync(
        logPath,
        jsonl(
          responseItem("2026-04-01T12:00:05Z", {
            type: "function_call_output",
            call_id: "call-1",
          }),
        ),
      );

      const workingPrev: SessionState = {
        status: "working",
        attentionType: null,
        pendingTool: null,
        inPlanMode: false,
      };

      const { state } = await adapter.deriveIncrementalState(
        logPath,
        seeded.newOffset,
        workingPrev,
      );

      expect(state.status).toBe("working");
    });

    it("leaves waiting intact when the output predates the wait (stale buffered entry)", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));
      const seeded = await adapter.deriveFullState(logPath);

      // Output flushed at 12:00:05, but the wait was established at
      // 12:00:15: this is a buffered leftover from a PRIOR call that the
      // watcher delivered late, not resolution evidence. Without the gate
      // this flip would retract the delivered permission banner, and the
      // cascade's later correction lands inside the notifier's renotify
      // cooldown, permanently losing it.
      appendFileSync(
        logPath,
        jsonl(
          responseItem("2026-04-01T12:00:05Z", {
            type: "custom_tool_call_output",
            call_id: "call-stale",
          }),
        ),
      );

      const { state } = await adapter.deriveIncrementalState(
        logPath,
        seeded.newOffset,
        waitingPrev("2026-04-01T12:00:15Z"),
      );

      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingTool).toBe("Bash");
    });

    it("flips on an output newer than the wait establishment", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));
      const seeded = await adapter.deriveFullState(logPath);

      appendFileSync(
        logPath,
        jsonl(
          responseItem("2026-04-01T12:00:20Z", {
            type: "function_call_output",
            call_id: "call-1",
          }),
        ),
      );

      const { state } = await adapter.deriveIncrementalState(
        logPath,
        seeded.newOffset,
        waitingPrev("2026-04-01T12:00:15Z"),
      );

      expect(state.status).toBe("working");
      expect(state.attentionType).toBeNull();
    });

    it("flips on an output slightly older than the wait stamp (inside the slack window)", async () => {
      writeFileSync(logPath, jsonl(sessionMeta()));
      const seeded = await adapter.deriveFullState(logPath);

      // The daemon stamps statusChangedAt after the hook observed the
      // request, so a genuine resolving output from an instant
      // auto-approval can predate the stamp by clock/stamp lag. Inside
      // the slack the gate must fail open and flip.
      appendFileSync(
        logPath,
        jsonl(
          responseItem("2026-04-01T12:00:14.500Z", {
            type: "function_call_output",
            call_id: "call-1",
          }),
        ),
      );

      const { state } = await adapter.deriveIncrementalState(
        logPath,
        seeded.newOffset,
        waitingPrev("2026-04-01T12:00:15Z"),
      );

      expect(state.status).toBe("working");
    });

    it("full-derivation ordering: task_started, function_call request, function_call_output, task_complete settles to idle", async () => {
      writeFileSync(
        logPath,
        jsonl(
          sessionMeta(),
          eventMsg("2026-04-01T12:00:01Z", { type: "task_started" }),
          responseItem("2026-04-01T12:00:02Z", {
            type: "function_call",
            call_id: "call-1",
            name: "shell",
          }),
          responseItem("2026-04-01T12:00:03Z", {
            type: "function_call_output",
            call_id: "call-1",
          }),
          eventMsg("2026-04-01T12:00:04Z", { type: "task_complete" }),
        ),
      );

      const { state } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("idle");
    });
  });
});
