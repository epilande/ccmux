import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it.each([false, true])("preserves pane selection during sidebar startup (early capabilities: %s)", async (earlyCapabilities) => {
  // Module mocks stay in a subprocess because other TUI tests share these modules.
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
        import { mock, vi } from "bun:test";
        import { EventEmitter } from "node:events";
        import assert from "node:assert/strict";

        import * as core from "@opentui/core";
        import * as solid from "@opentui/solid";

        vi.useFakeTimers();
        let activePane = "%work";
        const started = Promise.withResolvers();
        const ready = Promise.withResolvers();
        const renderer = new EventEmitter();
        renderer.destroy = () => {};
        mock.module("@opentui/core", () => ({
          ...core,
          createCliRenderer: async () => {
            started.resolve();
            await ready.promise;
            if (${earlyCapabilities}) renderer.emit(core.CliRenderEvents.CAPABILITIES, {});
            return renderer;
          },
        }));
        mock.module("@opentui/solid", () => ({ ...solid, render: async () => {} }));
        mock.module("./src/tui/App", () => ({ App: () => null }));
        mock.module("./src/tui/utils/tmux", () => ({
          findRestorePane: async () => activePane,
          selectPane: async pane => { activePane = pane; return true; },
        }));

        // Load after module mocks; a static import would bind the real renderer.
        const { launchTUI } = await import("./src/tui/index");
        const launched = launchTUI({ sidebar: true });
        await started.promise;
        assert.equal(activePane, "%work", "sidebar setup stole input focus");
        activePane = "%chosen-by-user";
        ready.resolve();
        await launched;
        assert.equal(activePane, "%chosen-by-user", "startup overwrote the user's selection");
        vi.advanceTimersByTime(5001);
        assert.equal(activePane, "%chosen-by-user", "missing capabilities restored a stale pane");
        renderer.emit(core.CliRenderEvents.CAPABILITIES, {});
        renderer.emit(core.CliRenderEvents.CAPABILITIES, {});
        vi.advanceTimersByTime(5001);
        assert.equal(activePane, "%chosen-by-user", "late capabilities restored a stale pane");
      `,
    ],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, TMUX_PANE: "%sidebar" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});
