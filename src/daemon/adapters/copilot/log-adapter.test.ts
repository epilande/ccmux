import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CopilotLogAdapter } from "./log-adapter";
import { permissionToolLabel } from "./parse";

function line(type: string, data: unknown, timestamp: string): string {
  return JSON.stringify({ type, data, timestamp, id: type, parentId: null });
}

const sessionStart = (cwd = "/tmp/project") =>
  line(
    "session.start",
    {
      sessionId: "426640a2-80a1-466a-ab94-e4caec32340e",
      copilotVersion: "1.0.71",
      startTime: "2026-07-18T08:29:43.715Z",
      context: { cwd },
    },
    "2026-07-18T08:29:43.734Z",
  );

describe("CopilotLogAdapter", () => {
  let testDir: string;
  let adapter: CopilotLogAdapter;
  let logPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ccmux-copilot-adapter-"));
    adapter = new CopilotLogAdapter();
    logPath = join(testDir, "events.jsonl");
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  describe("metadata", () => {
    it("declares copilot agentType, the session-state directory, and depth 2", () => {
      expect(adapter.agentType).toBe("copilot");
      expect(adapter.logDirGlob).toMatch(/\.copilot\/session-state$/);
      expect(adapter.watchDepth).toBe(2);
    });
  });

  describe("resolveSessionIdFromPath", () => {
    it("extracts the UUID from an events.jsonl path", () => {
      const path =
        "/Users/test/.copilot/session-state/426640a2-80a1-466a-ab94-e4caec32340e/events.jsonl";
      expect(adapter.resolveSessionIdFromPath(path)).toBe(
        "426640a2-80a1-466a-ab94-e4caec32340e",
      );
    });

    it("returns null for non-session paths", () => {
      expect(
        adapter.resolveSessionIdFromPath("/tmp/session-state/x/session.db"),
      ).toBeNull();
    });
  });

  describe("parseSessionMetadata", () => {
    it("returns metadata from a session.start line", () => {
      expect(adapter.parseSessionMetadata(sessionStart())).toEqual({
        nativeSessionId: "426640a2-80a1-466a-ab94-e4caec32340e",
        cwd: "/tmp/project",
        timestamp: Date.parse("2026-07-18T08:29:43.715Z"),
        version: "1.0.71",
      });
    });

    it("returns null when the first line is not session.start", () => {
      expect(
        adapter.parseSessionMetadata(
          line("user.message", {}, "2026-01-01T00:00:00Z"),
        ),
      ).toBeNull();
    });

    it("returns null on malformed JSON", () => {
      expect(adapter.parseSessionMetadata("not json")).toBeNull();
    });
  });

  describe("deriveFullState", () => {
    it("reports working after a user.message and captures the prompt", async () => {
      writeFileSync(
        logPath,
        [
          sessionStart(),
          line(
            "user.message",
            { content: "run the build" },
            "2026-07-18T08:30:00.000Z",
          ),
          line(
            "assistant.turn_start",
            { turnId: "0" },
            "2026-07-18T08:30:01.000Z",
          ),
        ].join("\n") + "\n",
      );
      const { state } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("working");
      expect(state.lastPrompt).toBe("run the build");
      expect(state.prompts).toEqual(["run the build"]);
      expect(state.cwd).toBe("/tmp/project");
      expect(state.version).toBe("1.0.71");
    });

    it("reports waiting/permission on permission.requested", async () => {
      writeFileSync(
        logPath,
        [
          sessionStart(),
          line(
            "assistant.turn_start",
            { turnId: "0" },
            "2026-07-18T08:30:01.000Z",
          ),
          line(
            "permission.requested",
            {
              requestId: "r1",
              permissionRequest: { kind: "shell", fullCommandText: "touch x" },
            },
            "2026-07-18T08:30:02.000Z",
          ),
        ].join("\n") + "\n",
      );
      const { state } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingTool).toBe("Command");
    });

    it("returns to idle on assistant.turn_end / session.shutdown", async () => {
      writeFileSync(
        logPath,
        [
          sessionStart(),
          line(
            "assistant.turn_start",
            { turnId: "0" },
            "2026-07-18T08:30:01.000Z",
          ),
          line(
            "assistant.turn_end",
            { turnId: "0" },
            "2026-07-18T08:30:05.000Z",
          ),
          line(
            "session.shutdown",
            { shutdownType: "routine" },
            "2026-07-18T08:30:06.000Z",
          ),
        ].join("\n") + "\n",
      );
      const { state } = await adapter.deriveFullState(logPath);
      expect(state.status).toBe("idle");
      expect(state.attentionType).toBeNull();
    });
  });

  describe("deriveIncrementalState", () => {
    it("advances from working to idle as new lines are appended", async () => {
      writeFileSync(
        logPath,
        [
          sessionStart(),
          line(
            "assistant.turn_start",
            { turnId: "0" },
            "2026-07-18T08:30:01.000Z",
          ),
        ].join("\n") + "\n",
      );
      const full = await adapter.deriveFullState(logPath);
      expect(full.state.status).toBe("working");

      appendFileSync(
        logPath,
        line(
          "assistant.turn_end",
          { turnId: "0" },
          "2026-07-18T08:30:05.000Z",
        ) + "\n",
      );
      const inc = await adapter.deriveIncrementalState(
        logPath,
        full.newOffset,
        full.state,
      );
      expect(inc.hasNewEntries).toBe(true);
      expect(inc.state.status).toBe("idle");
    });

    it("reports no new entries when the offset is at EOF", async () => {
      writeFileSync(logPath, sessionStart() + "\n");
      const full = await adapter.deriveFullState(logPath);
      const inc = await adapter.deriveIncrementalState(
        logPath,
        full.newOffset,
        full.state,
      );
      expect(inc.hasNewEntries).toBe(false);
      expect(inc.newOffset).toBe(full.newOffset);
    });
  });

  describe("permissionToolLabel", () => {
    it("maps shell to Command and title-cases other kinds", () => {
      expect(permissionToolLabel("shell")).toBe("Command");
      expect(permissionToolLabel("write")).toBe("Write");
      expect(permissionToolLabel(undefined)).toBeNull();
    });
  });
});
