import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { OmpExtension, OmpExtensionContext } from "../../../plugins/omp/ccmux.js";
import { waitForMarker, waitUntil } from "../../../plugins/omp/marker-test-helpers";
import { renderOmpExtension } from "./extension-script";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("renderOmpExtension", () => {
  it("keeps the installed ownership sentinel versioned", () => {
    const out = renderOmpExtension({ markersDir: "/tmp/markers", version: "1.2.3" });
    expect(out.split("\n", 1)[0]).toBe("// ccmux-extension v1.2.3");
  });

  it.each(["markers", 'with "quote"/markers'])(
    "writes OMP lifecycle and permission markers to %s",
    async relativeMarkersDir => {
      const root = mkdtempSync(join(tmpdir(), "ccmux-rendered-omp-"));
      const markersDir = join(root, relativeMarkersDir);
      const sessionId = "rendered-session";
      const markerPath = join(markersDir, `omp-${sessionId}.json`);
      const handlers = new Map<
        string,
        (event: unknown, ctx: OmpExtensionContext) => void | Promise<void>
      >();
      const ctx: OmpExtensionContext = {
        cwd: root,
        mode: "rpc",
        hasUI: true,
        agent: { id: "rendered-main", kind: "main" },
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => join(root, "transcript.jsonl"),
        },
      };
      cleanup = async () => {
        await handlers.get("session_shutdown")?.({}, ctx);
        await waitUntil(() => !existsSync(markerPath), "rendered OMP shutdown");
        rmSync(root, { recursive: true, force: true });
      };

      const file = join(root, "ccmux.mjs");
      writeFileSync(file, renderOmpExtension({ markersDir, version: "1.2.3" }));
      // The rendered module exists only at runtime; this tests its loading boundary.
      const installed: { default: OmpExtension } = await import(pathToFileURL(file).href);
      const approval = Promise.withResolvers<void>();
      const ui = { approve: () => approval.promise };
      const session = {
        sessionManager: ctx.sessionManager,
        isRunActive: false,
        extensionRunner: { getUIContext: () => ui, hasUI: () => true },
      };
      installed.default({
        pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) } },
        on: (event, handler) => { handlers.set(event, handler); },
      });

      await handlers.get("session_start")?.({}, ctx);
      const idle = await waitForMarker(markersDir, sessionId, marker => marker.state === "idle");
      expect(idle).toMatchObject({
        agent_type: "omp",
        session_id: sessionId,
        pid: process.pid,
        transcript_path: join(root, "transcript.jsonl"),
      });

      session.isRunActive = true;
      await handlers.get("tool_approval_requested")?.({
        toolCallId: "approval",
        toolName: "bash",
      }, ctx);
      const pending = ui.approve();
      const waiting = await waitForMarker(markersDir, sessionId, marker => marker.state === "waiting_permission");
      expect(waiting.pending_tool).toBe("bash");

      session.isRunActive = false;
      approval.resolve();
      await pending;
      await handlers.get("tool_approval_resolved")?.({ toolCallId: "approval" }, ctx);
      await waitForMarker(markersDir, sessionId, marker => marker.state === "idle");
    },
  );
});
