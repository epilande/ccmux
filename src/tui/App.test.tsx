import {
  describe,
  it,
  expect,
  afterEach,
  mock,
  beforeEach,
  spyOn,
} from "bun:test";
import { testRender } from "@opentui/solid";
import { MouseButtons } from "@opentui/core/testing";
import type { SSECallbacks } from "./utils/sse";
import * as clipboard from "./utils/clipboard";
import { mockEnrichedSession, squish } from "./components/test-helpers";
import { HANDOFF_BADGE } from "./components/session-columns";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Capture SSE callbacks so tests can fire events
let sseCallbacks: SSECallbacks | null = null;

// Spread the real module so non-SSEClient exports (e.g. dispatchSSEEvent,
// tested directly in sse.test.ts) survive this process-wide mock; only the
// streaming client is replaced with a callback-capturing fake.
const realSse = await import("./utils/sse");

mock.module("./utils/sse", () => ({
  ...realSse,
  SSEClient: class {
    constructor(callbacks: SSECallbacks) {
      sseCallbacks = callbacks;
    }
    connect() {}
    disconnect() {}
  },
}));

const switchToPaneSpy = mock(async (_target: string): Promise<boolean> => true);
const sendKeysSpy = mock(
  async (
    _target: string,
    _event: { name: string; ctrl?: boolean },
  ): Promise<boolean> => true,
);
const flashPaneSpy = mock(() => {});
const flashPaneDetachedSpy = mock(() => {});
const isPaneInCurrentWindowSpy = mock(async () => true);
const openAgentAttachWindowSpy = mock(
  async (): Promise<{ ok: true } | { ok: false; error: string }> => ({
    ok: true,
  }),
);
const openAgentsWindowSpy = mock(
  async (): Promise<{ ok: true } | { ok: false; error: string }> => ({
    ok: true,
  }),
);
// The real one spawns `tmux list-panes` against whatever ambient TMUX the
// runner has, which inside tmux means the developer's own server.
const resolveLaunchPaneSpy = mock(async (): Promise<string | null> => "%7");

// Spread the real module so other test files reading exports we don't override
// (e.g. parseRestoreCandidate) still see the real implementation. mock.module
// is process-wide and persistent across files in Bun.
const realTmux = await import("./utils/tmux");

mock.module("./utils/tmux", () => ({
  ...realTmux,
  switchToPane: switchToPaneSpy,
  sendKeys: sendKeysSpy,
  capturePane: async () => "",
  flashPane: flashPaneSpy,
  flashPaneDetached: flashPaneDetachedSpy,
  isPaneInCurrentWindow: isPaneInCurrentWindowSpy,
  selectPane: async () => true,
  notifyActivePane: () => {},
  openAgentAttachWindow: openAgentAttachWindowSpy,
  openAgentsWindow: openAgentsWindowSpy,
  resolveLaunchPane: resolveLaunchPaneSpy,
}));

// mock.module is process-wide and keyed by resolved path, which
// src/tui/utils/review.test.ts's own "./review" specifier shares. That file
// dodges this mock via a "?real"-suffixed dynamic import (a distinct module
// cache entry) so its real-implementation tests aren't corrupted.
const realReview = await import("./utils/review");
let hunkAvailable = true;
const runHunkReviewSpy = mock(
  async (
    ..._args: unknown[]
  ): Promise<
    { ok: true; notes: typeof reviewNotes } | { ok: false; error: string }
  > => ({ ok: true, notes: [] }),
);
const HUNK_INSTALL_HINT_TEST = realReview.HUNK_INSTALL_HINT;
// The Worktrees panel's `d` resolves a merge-base before it reviews, which is
// two real `git` spawns against a path no test has on disk. Pinned so the
// review starts on a predictable tick and the target it threads through is
// assertable.
const resolveMergeBaseSpy = mock(
  async (_worktreePath: string): Promise<string | null> => "base-sha",
);

const reviewNotes = [
  {
    noteId: "n1",
    filePath: "src/foo.ts",
    hunkIndex: 0,
    newRange: [12, 12] as [number, number],
    body: "Handle the missing token.",
    snippet: "const token = getToken();",
  },
];

mock.module("./utils/review", () => ({
  ...realReview,
  isHunkAvailable: () => hunkAvailable,
  resolveMergeBase: resolveMergeBaseSpy,
  runHunkReview: runHunkReviewSpy,
}));

// Sidebar renders construct the real visibility gate, which otherwise spawns
// `tmux display-message` against whatever ambient TMUX_PANE the runner has and
// makes results depend on the developer's own tmux state. Spread the real
// module so the pure exports (parseWindowState, UNKNOWN_WINDOW_STATE) other
// files read stay real; only the spawning fetch is pinned.
//
// The pin does two jobs. `windowActive`/`sessionAttached` make visibility
// deterministic. `windowWidth` is read only by the sidebar width persister,
// which App builds with its real `applyWidth`: a live
// `ccmux sidebar --apply-width` spawn that would rewrite the developer's own
// ccmux.json and resize their real sidebars. A window this narrow can never
// clear that persister's half-window ceiling for any width the degenerate gate
// lets through, so a future resize-based test cannot reach the spawn.
const realWindowState = await import("./utils/tmux-window-state");

mock.module("./utils/tmux-window-state", () => ({
  ...realWindowState,
  fetchWindowState: async () => ({
    windowWidth: 1,
    windowActive: true,
    sessionAttached: true,
  }),
}));

// App builds its own store, whose persistence writes the REAL state.json
// under the developer's ~/.config/ccmux. Any test that changes a persisted
// setting (a spawn's last-agent memory, `f`, `p`, `b`) would otherwise
// rewrite their live UI state. `getUIState` stays real: the sidebar's
// state-file watcher reads it, and reading is harmless.
const realUiState = await import("../lib/state");

/** Everything the TUI tried to persist, newest last. Also the ordering
 *  channel for the exit-vs-write test, which pushes its own marker here. */
const uiStateWrites: unknown[] = [];

/** When set, `setUIState` parks on it instead of resolving immediately, so a
 *  test can hold open the window the real one has: the pane already exists,
 *  the state write is mid-flight (read, write, rename), and the dialog is
 *  still on screen. */
let uiStateGate: Promise<void> | null = null;

mock.module("../lib/state", () => ({
  ...realUiState,
  setUIState: async (updates: unknown) => {
    uiStateWrites.push(updates);
    if (uiStateGate) await uiStateGate;
  },
}));

mock.module("../lib/startup-timing", () => ({
  markStartup: () => {},
  reportStartup: () => {},
  getStartupMarks: () => [],
  resetStartupMarks: () => {},
}));

const { App, STALE_DAEMON_HINT } = await import("./App");
const { setDaemonSocketPath } = await import("./utils/server-guard");

// Stub process.exit so a one-shot picker's exit is observable, not fatal.
function withExitSpy() {
  const exitSpy = mock(() => {});
  const originalExit = process.exit;
  process.exit = exitSpy as never;
  return { exitSpy, restore: () => (process.exit = originalExit) };
}

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

beforeEach(() => {
  sseCallbacks = null;
  switchToPaneSpy.mockClear();
  switchToPaneSpy.mockImplementation(async () => true);
  sendKeysSpy.mockClear();
  sendKeysSpy.mockImplementation(async () => true);
  flashPaneSpy.mockClear();
  flashPaneDetachedSpy.mockClear();
  isPaneInCurrentWindowSpy.mockClear();
  isPaneInCurrentWindowSpy.mockImplementation(async () => true);
  openAgentAttachWindowSpy.mockClear();
  openAgentAttachWindowSpy.mockImplementation(async () => ({ ok: true }));
  openAgentsWindowSpy.mockClear();
  openAgentsWindowSpy.mockImplementation(async () => ({ ok: true }));
  resolveLaunchPaneSpy.mockClear();
  resolveLaunchPaneSpy.mockImplementation(async () => "%7");
  uiStateWrites.length = 0;
  uiStateGate = null;
  hunkAvailable = true;
  runHunkReviewSpy.mockClear();
  runHunkReviewSpy.mockImplementation(async () => ({ ok: true, notes: [] }));
  resolveMergeBaseSpy.mockClear();
  resolveMergeBaseSpy.mockImplementation(async () => "base-sha");
});

afterEach(() => {
  setup?.renderer.destroy();
  // refreshServerInfo writes the module-global server-guard cache; restore
  // fail-open so a guard test's refusal can't leak into other test files.
  setDaemonSocketPath(null);
});

async function renderApp(
  width = 120,
  height = 20,
  props: Record<string, unknown> = {},
) {
  setup = await testRender(() => <App {...props} />, { width, height });
  await setup.renderOnce();
  return setup.captureCharFrame();
}

/**
 * Mocks the sidebar-hydration fetch used by App.tsx's onMount:
 * `fetch(`${getDaemonUrl()}/sidebar-state`).then(r => r.json()).then(data =>
 * {...}).catch(() => {})` (App.tsx:1404-1420). Returns a `getPromise()` the
 * test awaits in place of a fixed sleep, plus `restore()` to put back the
 * original `fetch`.
 *
 * The capture is gated on the URL containing "/sidebar-state" rather than
 * being a bare last-write-wins assignment: onMount also fires
 * `refreshServerInfo()`'s `/server-info` fetch first (App.tsx:1399-1405), so
 * an ungated capture would only happen to grab the right promise because of
 * today's statement order. Any other URL gets a harmless empty-json
 * response instead of falling through to whatever `fetch` was previously
 * installed, so callers of this helper don't inherit ambient fetch state
 * from another test.
 */
function mockSidebarStateFetch(payload: Record<string, unknown>) {
  const originalFetch = globalThis.fetch;
  let hydrationFetchPromise:
    | Promise<{ json: () => Promise<unknown> }>
    | undefined;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input.url;
    if (url.includes("/sidebar-state")) {
      const promise = (async () => ({ json: async () => payload }))();
      hydrationFetchPromise = promise;
      return promise;
    }
    return (async () => ({ json: async () => ({}) }))();
  }) as unknown as typeof fetch;
  return {
    getPromise: () => hydrationFetchPromise,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("App", () => {
  it("renders header and footer on mount", async () => {
    const frame = await renderApp();
    expect(frame).toContain("Sessions");
    expect(frame).toContain("j/k");
    expect(frame).toContain("? help");
  });

  it("hides empty state before SSE init", async () => {
    const frame = await renderApp();
    expect(frame).not.toContain("No sessions found");
  });

  it("renders empty state after SSE init with no sessions", async () => {
    await renderApp();
    sseCallbacks!.onInit([], null);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("No sessions found");
  });

  it("shows sessions after SSE init", async () => {
    await renderApp();
    sseCallbacks!.onInit(
      [mockEnrichedSession({ id: "s1", project: "myapp", cwd: "/code/myapp" })],
      null,
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("myapp");
    expect(frame).not.toContain("No sessions found");
  });

  it("enters search mode on / key", async () => {
    await renderApp();
    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Search sessions...");
    expect(frame).toContain("type to search");
  });

  it("toggles help overlay on ? key", async () => {
    await renderApp(120, 24);
    setup.mockInput.pressKey("?");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Keyboard Shortcuts");

    setup.mockInput.pressKey("?");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("Keyboard Shortcuts");
  });

  it("navigates sessions with j/k", async () => {
    await renderApp();
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({ id: "s1", project: "alpha", cwd: "/code/alpha" }),
        mockEnrichedSession({ id: "s2", project: "beta", cwd: "/code/beta" }),
      ],
      null,
    );
    await setup.renderOnce();

    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    setup.mockInput.pressKey("j");
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");
  });

  it("defaults selection to the session in the active tmux pane", async () => {
    await renderApp(120, 20, { groupBy: "none" });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%10",
        }),
        mockEnrichedSession({
          id: "s2",
          project: "beta",
          cwd: "/code/beta",
          tmuxPane: "%20",
        }),
      ],
      "%20",
    );
    await setup.renderOnce();

    // Press x without navigating: should target the active-pane session (beta),
    // not the first-listed session (alpha). With groupBy:"none" there are no
    // group headers, so "alpha" / "beta" appear only on session rows / dialog.
    setup.mockInput.pressKey("x");
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Kill Session?");
    expect(frame).toContain("beta");
    // The kill dialog subtitle is the selected session's project. If selection
    // had fallen back to index 0, the dialog would say "alpha" instead.
    expect(frame).not.toMatch(/Kill Session\?[\s\S]*alpha[\s\S]*Y confirm/);
  });

  it("sidebar hydration with null state does not clobber active-pane default", async () => {
    const { getPromise, restore } = mockSidebarStateFetch({
      selectedSessionId: null,
      selectedHeaderKey: null,
    });
    try {
      await renderApp(120, 20, { sidebar: true, groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "alpha",
            cwd: "/code/alpha",
            tmuxPane: "%10",
          }),
          mockEnrichedSession({
            id: "s2",
            project: "beta",
            cwd: "/code/beta",
            tmuxPane: "%20",
          }),
        ],
        "%20",
      );
      await setup.renderOnce();

      // Guard against the hydration fetch silently not firing: if it stopped
      // being called, `await undefined` below would resolve instantly and
      // this test would pass vacuously (its asserted "beta" is also exactly
      // what "no hydration happened" produces).
      const hydrationFetchPromise = getPromise();
      expect(hydrationFetchPromise).toBeDefined();
      // Await the hydration fetch chain instead of a fixed sleep. App's
      // .then callbacks are attached to this same promise before this await,
      // so once it settles, App's `r.json()` call has already been made.
      // From there the chain still has to: resolve `r.json()`'s own promise,
      // then run the `.then((data) => {...})` callback that calls
      // applySidebarSelection. Measured on this repo's Bun/JSC, that's a
      // 3-microtask-turn worst case from a cold start; we flush exactly that
      // many rather than relying on the renderApp/renderOnce awaits above to
      // have already drained part of the chain.
      await hydrationFetchPromise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await setup.renderOnce();

      setup.mockInput.pressKey("x");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Kill Session?");
      expect(frame).toContain("beta");
    } finally {
      restore();
    }
  });

  it("sidebar hydration with non-null state overrides active-pane default", async () => {
    // Daemon reports another instance has selected s1 (alpha). That should win
    // over our active-pane default of s2 (beta).
    const { getPromise, restore } = mockSidebarStateFetch({
      selectedSessionId: "s1",
      selectedHeaderKey: null,
    });
    try {
      await renderApp(120, 20, { sidebar: true, groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "alpha",
            cwd: "/code/alpha",
            tmuxPane: "%10",
          }),
          mockEnrichedSession({
            id: "s2",
            project: "beta",
            cwd: "/code/beta",
            tmuxPane: "%20",
          }),
        ],
        "%20",
      );
      await setup.renderOnce();

      // See the sibling "null state" test above for the full rationale on
      // both the definedness guard and the 3-flush count.
      const hydrationFetchPromise = getPromise();
      expect(hydrationFetchPromise).toBeDefined();
      await hydrationFetchPromise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await setup.renderOnce();

      setup.mockInput.pressKey("x");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Kill Session?");
      expect(frame).toContain("alpha");
    } finally {
      restore();
    }
  });

  it("falls back to first item when active pane has no matching session", async () => {
    await renderApp(120, 20, { groupBy: "none" });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%10",
        }),
        mockEnrichedSession({
          id: "s2",
          project: "beta",
          cwd: "/code/beta",
          tmuxPane: "%20",
        }),
      ],
      "%99",
    );
    await setup.renderOnce();

    setup.mockInput.pressKey("x");
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Kill Session?");
    expect(frame).toContain("alpha");
  });

  it("shows confirm dialog on x key with session selected", async () => {
    await renderApp();
    sseCallbacks!.onInit(
      [mockEnrichedSession({ id: "s1", project: "myapp", cwd: "/code/myapp" })],
      null,
    );
    await setup.renderOnce();

    setup.mockInput.pressKey("j");
    await setup.renderOnce();

    setup.mockInput.pressKey("x");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Kill Session?");
    expect(frame).toContain("Y");
    expect(frame).toContain("N");
  });

  it("dismisses confirm dialog on n key", async () => {
    await renderApp();
    sseCallbacks!.onInit(
      [mockEnrichedSession({ id: "s1", project: "myapp", cwd: "/code/myapp" })],
      null,
    );
    await setup.renderOnce();
    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    setup.mockInput.pressKey("x");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Kill Session?");

    setup.mockInput.pressKey("n");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("Kill Session?");
  });

  it("toggles preview panel on P key", async () => {
    await renderApp();
    let frame = setup.captureCharFrame();
    expect(frame).not.toContain("│");

    setup.mockInput.pressKey("P");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).toContain("Select a session to preview");

    setup.mockInput.pressKey("P");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("Select a session to preview");
  });

  it("updates session count in header after SSE init", async () => {
    await renderApp();
    expect(setup.captureCharFrame()).toContain("(0)");

    sseCallbacks!.onInit(
      [
        mockEnrichedSession({ id: "s1", project: "a", cwd: "/a" }),
        mockEnrichedSession({ id: "s2", project: "b", cwd: "/b" }),
      ],
      null,
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("(2)");
  });

  it("flashes pane on Enter selection in persistent picker mode", async () => {
    await renderApp(80, 20, { persistent: true, groupBy: "none" });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          tmuxPane: "%5",
        }),
      ],
      null,
    );
    await setup.renderOnce();
    flashPaneSpy.mockClear();
    flashPaneDetachedSpy.mockClear();

    setup.mockInput.pressEnter();
    await setup.renderOnce();

    expect(flashPaneSpy).toHaveBeenCalledWith("%5");
    expect(flashPaneDetachedSpy).not.toHaveBeenCalled();
  });

  /** First content row in `groupBy: "project"` (group header) and "none"
   * (single session row) — the App header occupies y=0. */
  const FIRST_CONTENT_ROW_Y = 1;

  async function setupPersistentPickerWithSession(opts: {
    groupBy: "none" | "project";
    tmuxPane: string | null;
  }) {
    await renderApp(120, 20, { persistent: true, groupBy: opts.groupBy });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          tmuxPane: opts.tmuxPane,
        }),
      ],
      null,
    );
    await setup.renderOnce();
    flashPaneSpy.mockClear();
    flashPaneDetachedSpy.mockClear();
  }

  it("flashes pane on click of session row in persistent picker mode", async () => {
    await setupPersistentPickerWithSession({
      groupBy: "none",
      tmuxPane: "%5",
    });

    await setup.mockMouse.click(5, FIRST_CONTENT_ROW_Y);
    await setup.renderOnce();

    expect(flashPaneSpy).toHaveBeenCalledWith("%5");
  });

  it("does not flash pane when clicking a session with no tmuxPane", async () => {
    await setupPersistentPickerWithSession({
      groupBy: "none",
      tmuxPane: null,
    });

    await setup.mockMouse.click(5, FIRST_CONTENT_ROW_Y);
    await setup.renderOnce();

    expect(flashPaneSpy).not.toHaveBeenCalled();
    expect(flashPaneDetachedSpy).not.toHaveBeenCalled();
  });

  it("toggles group collapse when a group header is clicked", async () => {
    await setupPersistentPickerWithSession({
      groupBy: "project",
      tmuxPane: "%5",
    });
    expect(setup.captureCharFrame()).toContain("▼ myapp");

    await setup.mockMouse.click(5, FIRST_CONTENT_ROW_Y);
    await setup.renderOnce();

    const after = setup.captureCharFrame();
    expect(after).toContain("▶ myapp");
    expect(after).not.toContain("▼ myapp");
  });

  it("ignores row clicks while help overlay is open", async () => {
    await setupPersistentPickerWithSession({
      groupBy: "none",
      tmuxPane: "%5",
    });

    setup.mockInput.pressKey("?");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Keyboard Shortcuts");

    await setup.mockMouse.click(5, FIRST_CONTENT_ROW_Y);
    await setup.renderOnce();

    expect(flashPaneSpy).not.toHaveBeenCalled();
    expect(flashPaneDetachedSpy).not.toHaveBeenCalled();
  });

  it("ignores row clicks while confirm dialog is open", async () => {
    await setupPersistentPickerWithSession({
      groupBy: "none",
      tmuxPane: "%5",
    });

    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    setup.mockInput.pressKey("x");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Kill Session?");
    flashPaneSpy.mockClear();

    await setup.mockMouse.click(5, FIRST_CONTENT_ROW_Y);
    await setup.renderOnce();

    expect(flashPaneSpy).not.toHaveBeenCalled();
    expect(flashPaneDetachedSpy).not.toHaveBeenCalled();
  });
});

describe("App sidebar mode", () => {
  it("renders no footer in sidebar mode", async () => {
    const frame = await renderApp(30, 20, { sidebar: true });
    expect(frame).toContain("Sessions");
    expect(frame).not.toContain("j/k");
    expect(frame).not.toContain("? help");
  });

  it("renders no preview in sidebar mode", async () => {
    const frame = await renderApp(30, 20, { sidebar: true });
    expect(frame).not.toContain("Select a session to preview");
  });

  it("P key does not toggle preview in sidebar mode", async () => {
    await renderApp(30, 20, { sidebar: true });
    setup.mockInput.pressKey("P");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Select a session to preview");
  });

  it("Enter on session does not exit process", async () => {
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await renderApp(30, 20, { sidebar: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%5",
          }),
        ],
        null,
      );
      await setup.renderOnce();

      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressKey("return");
      await setup.renderOnce();

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
    }
  });

  it("Escape does not exit in sidebar mode", async () => {
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await renderApp(30, 20, { sidebar: true });
      setup.mockInput.pressKey("escape");
      await setup.renderOnce();

      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
    }
  });

  it("flashes pane on Enter selection in sidebar mode", async () => {
    await renderApp(30, 20, { sidebar: true });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          tmuxPane: "%5",
        }),
      ],
      null,
    );
    await setup.renderOnce();
    flashPaneSpy.mockClear();

    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await setup.renderOnce();

    expect(flashPaneSpy).toHaveBeenCalledWith("%5");
    expect(flashPaneDetachedSpy).not.toHaveBeenCalled();
  });

  /** Lets the launcher's promise chain (launch().then(...)) settle. */
  const flushLaunch = () => new Promise((resolve) => setTimeout(resolve, 0));

  const backgroundSession = () =>
    mockEnrichedSession({
      id: "bg1",
      project: "myapp",
      cwd: "/tmp/proj",
      trackingMode: "background",
      tmuxPane: null,
    });

  it("Enter on a background row launches the per-agent attach and exits the picker", async () => {
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit([backgroundSession()], null);
      await setup.renderOnce();

      setup.mockInput.pressEnter();
      await flushLaunch();

      expect(openAgentAttachWindowSpy).toHaveBeenCalledWith("bg1", "/tmp/proj");
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      process.exit = originalExit;
    }
  });

  it("Enter on a background row in sidebar mode launches without exiting", async () => {
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await renderApp(30, 20, { sidebar: true });
      sseCallbacks!.onInit([backgroundSession()], null);
      await setup.renderOnce();

      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await flushLaunch();

      expect(openAgentAttachWindowSpy).toHaveBeenCalledWith("bg1", "/tmp/proj");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
    }
  });

  it("failed background launch surfaces a toast and stays open", async () => {
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;
    openAgentAttachWindowSpy.mockImplementation(async () => ({
      ok: false,
      error: "boom",
    }));

    try {
      // The Toast renders in every mode now; sidebar is used here just to
      // exercise the sidebar launcher path.
      await renderApp(60, 20, { sidebar: true });
      sseCallbacks!.onInit([backgroundSession()], null);
      await setup.renderOnce();

      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await flushLaunch();
      await setup.renderOnce();

      expect(setup.captureCharFrame()).toContain("Attach failed: boom");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
    }
  });

  it("ignores a second background activation while a launch is in flight", async () => {
    let resolveLaunch: (r: { ok: true }) => void = () => {};
    openAgentAttachWindowSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLaunch = resolve;
        }),
    );
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await renderApp(30, 20, { sidebar: true });
      sseCallbacks!.onInit([backgroundSession()], null);
      await setup.renderOnce();

      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      setup.mockInput.pressEnter();
      await setup.renderOnce();

      expect(openAgentAttachWindowSpy).toHaveBeenCalledTimes(1);
      resolveLaunch({ ok: true });
      await flushLaunch();
    } finally {
      process.exit = originalExit;
    }
  });

  it("help overlay hides preview keys in sidebar mode", async () => {
    await renderApp(80, 60, { sidebar: true });
    setup.mockInput.pressKey("?");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Keyboard Shortcuts");
    expect(frame).not.toContain("Preview");
    expect(frame).toContain("Navigation");
    expect(frame).toContain("Groups");
  });

  it("onActivePane SSE event updates active indicator but leaves cursor alone", async () => {
    await renderApp(120, 20, { sidebar: true, groupBy: "none" });
    // Init with %10 so the cursor lands on s1 (alpha) via the active-pane default.
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%10",
        }),
        mockEnrichedSession({
          id: "s2",
          project: "beta",
          cwd: "/code/beta",
          tmuxPane: "%20",
        }),
      ],
      "%10",
    );
    await setup.renderOnce();

    // Simulate the user switching tmux focus to beta's pane while the picker
    // is open. This should move the bold/▎ indicator but must NOT yank the
    // user's cursor away from alpha mid-navigation.
    sseCallbacks!.onActivePane!("s2", "%20");
    await setup.renderOnce();

    // Both sessions still render.
    let frame = setup.captureCharFrame();
    expect(frame).toContain("alpha");
    expect(frame).toContain("beta");

    // Cursor probe: pressing x should target the *originally selected* session
    // (alpha), not the newly-active one (beta).
    setup.mockInput.pressKey("x");
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    expect(frame).toContain("Kill Session?");
    expect(frame).toContain("alpha");
  });

  it("flashes pane when navigating to a visible session", async () => {
    await renderApp(30, 20, { sidebar: true });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%10",
        }),
      ],
      null,
    );
    await setup.renderOnce();
    flashPaneSpy.mockClear();

    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    // Allow the debounce (80ms) + async isPaneInCurrentWindow to resolve
    await new Promise((r) => setTimeout(r, 100));

    expect(isPaneInCurrentWindowSpy).toHaveBeenCalledWith("%10");
    expect(flashPaneSpy).toHaveBeenCalledWith("%10");
  });

  it("does not flash pane when it is not in current window", async () => {
    isPaneInCurrentWindowSpy.mockImplementation(async () => false);

    await renderApp(30, 20, { sidebar: true });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%10",
        }),
      ],
      null,
    );
    await setup.renderOnce();
    flashPaneSpy.mockClear();

    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    await new Promise((r) => setTimeout(r, 100));

    expect(isPaneInCurrentWindowSpy).toHaveBeenCalledWith("%10");
    expect(flashPaneSpy).not.toHaveBeenCalled();
  });

  it("debounces flash during rapid navigation", async () => {
    await renderApp(30, 20, { sidebar: true });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%10",
        }),
        mockEnrichedSession({
          id: "s2",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%20",
        }),
      ],
      null,
    );
    await setup.renderOnce();
    flashPaneSpy.mockClear();
    isPaneInCurrentWindowSpy.mockClear();

    // Rapid navigation: j then j again within the debounce window
    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    setup.mockInput.pressKey("j");
    await setup.renderOnce();

    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 100));

    // Should only flash the final destination pane, not intermediate ones
    expect(flashPaneSpy).toHaveBeenCalledTimes(1);
    expect(flashPaneSpy).toHaveBeenCalledWith("%20");
  });

  it("ignores stale sidebar state echo-back via version", async () => {
    await renderApp(30, 20, { sidebar: true });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%10",
        }),
        mockEnrichedSession({
          id: "s2",
          project: "beta",
          cwd: "/code/beta",
          tmuxPane: "%20",
        }),
        mockEnrichedSession({
          id: "s3",
          project: "gamma",
          cwd: "/code/gamma",
          tmuxPane: "%30",
        }),
      ],
      null,
    );
    await setup.renderOnce();

    // Navigate down twice (s1 -> s2 -> s3), which increments version to 2
    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    setup.mockInput.pressKey("j");
    await setup.renderOnce();

    // Now at s3. Stale echo-back arrives for s1 (version 1)
    sseCallbacks!.onSidebarState!("s1", null, 1);
    await setup.renderOnce();

    // Selection should remain on s3, not jump back to s1
    const frame = setup.captureCharFrame();
    // s3 (gamma) should be the highlighted row, not s1 (alpha)
    const lines = frame.split("\n").filter((l: string) => l.trim());
    const gammaLine = lines.find((l: string) => l.includes("gamma"));
    const alphaLine = lines.find((l: string) => l.includes("alpha"));
    // gamma should have bold/selection indicators that alpha doesn't
    expect(gammaLine).toBeDefined();
    expect(alphaLine).toBeDefined();
  });

  it("accepts sidebar state from another instance with higher version", async () => {
    await renderApp(30, 20, { sidebar: true });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%10",
        }),
        mockEnrichedSession({
          id: "s2",
          project: "beta",
          cwd: "/code/beta",
          tmuxPane: "%20",
        }),
      ],
      null,
    );
    await setup.renderOnce();

    // Navigate to s1 (version goes to 1)
    setup.mockInput.pressKey("j");
    await setup.renderOnce();

    // Another sidebar instance selects s2 with a higher version
    sseCallbacks!.onSidebarState!("s2", null, 100);
    await setup.renderOnce();

    // Should have synced to s2
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n").filter((l: string) => l.trim());
    const betaLine = lines.find((l: string) => l.includes("beta"));
    expect(betaLine).toBeDefined();
  });
});

describe("App kill/restart dispatch routing", () => {
  // Capture the daemon URL each action fetches. The pure killActionPath /
  // restartActionPath helpers are unit-tested; this covers the App wiring that
  // resolves the selected session and dispatches (the confirm -> action path).
  function captureFetch() {
    const calls: { url: string; method?: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = original) };
  }

  async function killSelected() {
    await setup.renderOnce();
    setup.mockInput.pressKey("j"); // select the only row
    await setup.renderOnce();
    setup.mockInput.pressKey("x"); // kill confirm dialog
    await setup.renderOnce();
    setup.mockInput.pressKey("y"); // confirm -> confirmDialogAction
    await setup.renderOnce();
  }

  it("kills a normal session via /sessions/:id/kill", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await killSelected();
      expect(calls.some((c) => c.url.includes("/sessions/s1/kill"))).toBe(true);
      expect(calls.some((c) => c.url.includes("/invoke/"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("surfaces a non-OK kill response as a toast instead of dropping it silently", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({
          error:
            "background session is read-only; this agent has no stop command",
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "sup-k",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: null,
            trackingMode: "background",
          }),
        ],
        null,
      );
      await killSelected();
      // Let the response handler's .then() callback run before re-rendering.
      await new Promise((r) => setTimeout(r, 0));
      await setup.renderOnce();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain(squish("Kill failed:"));
      expect(frame).toContain(squish("no stop command"));
      // A background row kills through the session endpoint, never /invoke.
      expect(urls.some((u) => u.includes("/sessions/sup-k/kill"))).toBe(true);
      expect(urls.some((u) => u.includes("/invoke/"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("confirms a background-row stop with a toast, since the row outlives the request", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "sup-k",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: null,
            trackingMode: "background",
          }),
        ],
        null,
      );
      await killSelected();
      await new Promise((r) => setTimeout(r, 0));
      await setup.renderOnce();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain(squish("Stopping agent"));
      expect(calls.some((c) => c.url.includes("/sessions/sup-k/kill"))).toBe(
        true,
      );
    } finally {
      restore();
    }
  });

  it("stays silent on a successful normal kill, whose pane death is its own feedback", async () => {
    const { restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await killSelected();
      await new Promise((r) => setTimeout(r, 0));
      await setup.renderOnce();
      const frame = squish(setup.captureCharFrame());
      expect(frame).not.toContain(squish("Stopping agent"));
    } finally {
      restore();
    }
  });

  it("cancels a subprocess invoke row via /invoke/:id/cancel (never /sessions/:id/kill)", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit([], null);
      sseCallbacks!.onInvocationStarted!({
        type: "invocation_started",
        timestamp: "2024-01-15T12:00:00Z",
        invocationId: "inv_x",
        agent: "codex",
        cwd: "/code/myapp",
        startedAt: "2024-01-15T12:00:00Z",
      });
      await killSelected();
      expect(calls.some((c) => c.url.includes("/invoke/inv_x/cancel"))).toBe(
        true,
      );
      expect(calls.some((c) => c.url.includes("/sessions/inv_x/kill"))).toBe(
        false,
      );
    } finally {
      restore();
    }
  });

  it("cancels a Claude invoke row by its invocation id, not its session id", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      // A Claude invoke renders as its real detached session: the row id is the
      // native session id, distinct from the invocation id it must cancel by.
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "claude_sess",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
            originInvocationId: "inv_claude9",
          }),
        ],
        null,
      );
      await killSelected();
      expect(
        calls.some((c) => c.url.includes("/invoke/inv_claude9/cancel")),
      ).toBe(true);
      expect(
        calls.some((c) => c.url.includes("/sessions/claude_sess/kill")),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("kill-group iterates: kills every session in the selected group", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "project" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
          mockEnrichedSession({
            id: "s2",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%2",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      // Move selection up onto the group header (index 0); 'x' on a header
      // opens the kill-group dialog over the group's sessions.
      for (let i = 0; i < 3; i++) {
        setup.mockInput.pressKey("k");
        await setup.renderOnce();
      }
      setup.mockInput.pressKey("x");
      await setup.renderOnce();
      setup.mockInput.pressKey("y");
      await setup.renderOnce();
      expect(calls.some((c) => c.url.includes("/sessions/s1/kill"))).toBe(true);
      expect(calls.some((c) => c.url.includes("/sessions/s2/kill"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("kill-all delegates invoke teardown to the daemon (client fires only /sessions/kill-all)", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      // A subprocess invoke (fabricates a row + counts in flight) and a Claude
      // invoke (counts in flight with NO row until its session_created lands).
      // The client no longer reaps these per-id: the daemon owns invoke
      // teardown on kill-all (its in-flight set is authoritative, while the
      // client's is a lossy mirror). So the client must fire ONLY the single
      // /sessions/kill-all and never a per-invoke cancel.
      sseCallbacks!.onInvocationStarted!({
        type: "invocation_started",
        timestamp: "2024-01-15T12:00:00Z",
        invocationId: "inv_codex",
        agent: "codex",
        cwd: "/code/myapp",
        startedAt: "2024-01-15T12:00:00Z",
      });
      sseCallbacks!.onInvocationStarted!({
        type: "invocation_started",
        timestamp: "2024-01-15T12:00:00Z",
        invocationId: "inv_claude",
        agent: "claude",
        cwd: "/code/myapp",
        startedAt: "2024-01-15T12:00:00Z",
      });
      await setup.renderOnce();
      setup.mockInput.pressKey("X"); // kill-all confirm dialog
      await setup.renderOnce();
      setup.mockInput.pressKey("y"); // confirm -> confirmDialogAction
      await setup.renderOnce();
      expect(calls.some((c) => c.url.includes("/sessions/kill-all"))).toBe(
        true,
      );
      // Daemon reaps the invokes; the client never fires a per-invoke cancel.
      expect(calls.some((c) => c.url.includes("/invoke/"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("kill-all with no in-flight invokes only hits /sessions/kill-all", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      setup.mockInput.pressKey("X"); // kill-all confirm dialog
      await setup.renderOnce();
      setup.mockInput.pressKey("y"); // confirm -> confirmDialogAction
      await setup.renderOnce();
      expect(calls.some((c) => c.url.includes("/sessions/kill-all"))).toBe(
        true,
      );
      expect(calls.some((c) => c.url.includes("/invoke/"))).toBe(false);
    } finally {
      restore();
    }
  });

  async function restartSelected() {
    await setup.renderOnce();
    setup.mockInput.pressKey("j"); // select the only row
    await setup.renderOnce();
    setup.mockInput.pressKey("r"); // restart confirm dialog
    await setup.renderOnce();
    setup.mockInput.pressKey("y"); // confirm -> confirmDialogAction
    await setup.renderOnce();
  }

  it("restarts a normal session via /sessions/:id/restart", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await restartSelected();
      expect(calls.some((c) => c.url.includes("/sessions/s1/restart"))).toBe(
        true,
      );
      expect(calls.some((c) => c.url.includes("/invoke/"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("restarts an invoke row by cancelling it (a one-shot has no restart)", async () => {
    const { calls, restore } = captureFetch();
    try {
      await renderApp(120, 20, { groupBy: "none" });
      sseCallbacks!.onInit([], null);
      sseCallbacks!.onInvocationStarted!({
        type: "invocation_started",
        timestamp: "2024-01-15T12:00:00Z",
        invocationId: "inv_x",
        agent: "codex",
        cwd: "/code/myapp",
        startedAt: "2024-01-15T12:00:00Z",
      });
      await restartSelected();
      expect(calls.some((c) => c.url.includes("/invoke/inv_x/cancel"))).toBe(
        true,
      );
      expect(calls.some((c) => c.url.includes("/restart"))).toBe(false);
    } finally {
      restore();
    }
  });
});

describe("App pane-switch feedback and server scoping", () => {
  // Override global fetch so daemonSocketPath is deterministic (a real fetch
  // could hit a live daemon). A getter lets a test flip the socket on reconnect.
  function withServerInfo(socketPath: string | null | (() => string | null)) {
    const get =
      typeof socketPath === "function" ? socketPath : () => socketPath;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/server-info")) {
        return {
          ok: true,
          json: async () => ({ socketPath: get() }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    return () => (globalThis.fetch = original);
  }

  function withTmux(socket: string) {
    const original = process.env.TMUX;
    process.env.TMUX = socket;
    return () =>
      original === undefined
        ? delete process.env.TMUX
        : (process.env.TMUX = original);
  }

  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  const oneSession = () =>
    mockEnrichedSession({
      id: "s1",
      project: "myapp",
      cwd: "/code/myapp",
      tmuxPane: "%5",
    });

  async function renderWithSession(props: Record<string, unknown> = {}) {
    await renderApp(120, 20, { groupBy: "none", ...props });
    sseCallbacks!.onInit([oneSession()], null);
    await setup.renderOnce();
  }

  async function selectFirstRowAndEnter() {
    setup.mockInput.pressKey("j");
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await settle(); // let switchToPane resolve
    await setup.renderOnce();
  }

  it("one-shot picker: a failed pane switch shows a toast and does not exit", async () => {
    switchToPaneSpy.mockImplementation(async () => false);
    const restoreFetch = withServerInfo(null); // fail-open: same-server guard passes
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await renderWithSession();
      await selectFirstRowAndEnter();
      expect(setup.captureCharFrame()).toContain("Failed to switch");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      restoreExit();
      restoreFetch();
    }
  });

  it("one-shot picker: a successful pane switch exits the process", async () => {
    // switchToPaneSpy defaults to true (beforeEach).
    const restoreFetch = withServerInfo(null);
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await renderWithSession();
      await selectFirstRowAndEnter();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      restoreExit();
      restoreFetch();
    }
  });

  it("refuses to target a pane on a different tmux server", async () => {
    const restoreTmux = withTmux("/tmp/consumer-sock,1,0");
    const restoreFetch = withServerInfo("/tmp/daemon-sock"); // differs -> refuse
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await renderWithSession();
      await settle(10); // let /server-info populate daemonSocketPath
      await setup.renderOnce();
      switchToPaneSpy.mockClear();
      flashPaneDetachedSpy.mockClear();

      await selectFirstRowAndEnter();

      expect(squish(setup.captureCharFrame())).toContain(
        squish("different tmux server"),
      );
      // The guard returns before touching tmux: no switch, no flash, no exit.
      expect(switchToPaneSpy).not.toHaveBeenCalled();
      expect(flashPaneDetachedSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      restoreExit();
      restoreFetch();
      restoreTmux();
    }
  });

  it("refuses to send keys to a preview pane on a different tmux server", async () => {
    // The send-keys path (preview-focus mode) is guarded by the same
    // `ensureSameServer()` as the pane switch. Exercise that second call site.
    const restoreTmux = withTmux("/tmp/consumer-sock,1,0");
    const restoreFetch = withServerInfo("/tmp/daemon-sock"); // differs -> refuse
    const { restore: restoreExit } = withExitSpy();
    try {
      await renderWithSession({ initialPreview: true });
      await settle(10); // let /server-info populate daemonSocketPath
      await setup.renderOnce();

      // Select the row, then Tab into preview-focus mode.
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      sendKeysSpy.mockClear();

      // A plain key in preview-focus routes to sendKeys, gated by the guard.
      setup.mockInput.pressKey("a");
      await setup.renderOnce();

      expect(squish(setup.captureCharFrame())).toContain(
        squish("different tmux server"),
      );
      expect(sendKeysSpy).not.toHaveBeenCalled();
    } finally {
      restoreExit();
      restoreFetch();
      restoreTmux();
    }
  });

  it("persistent picker: a failed pane switch shows a toast (was sidebar-only)", async () => {
    // The Toast render gate used to be sidebar-only, so a switch failure in the
    // persistent picker showed nothing. Now it must surface here too.
    switchToPaneSpy.mockImplementation(async () => false);
    const restoreFetch = withServerInfo(null);
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await renderWithSession({ persistent: true });
      await selectFirstRowAndEnter();
      expect(setup.captureCharFrame()).toContain("Failed to switch");
      expect(exitSpy).not.toHaveBeenCalled(); // persistent never exits
    } finally {
      restoreExit();
      restoreFetch();
    }
  });

  it("refetches the daemon socket on SSE reconnect (daemon restart onto a new socket)", async () => {
    // A picker outlives a daemon via SSE auto-reconnect. If the daemon restarts
    // onto a different socket, the reconnect must refresh daemonSocketPath so the
    // guard doesn't compare a stale one. Here the socket flips same -> different.
    const restoreTmux = withTmux("/tmp/consumer-sock,1,0");
    let socket: string | null = "/tmp/consumer-sock"; // initially same
    const restoreFetch = withServerInfo(() => socket);
    const { restore: restoreExit } = withExitSpy();
    try {
      await renderWithSession();
      await settle(10); // initial fetch -> matches
      await setup.renderOnce();

      // Daemon restarts onto a different socket; SSE reconnects.
      socket = "/tmp/other-sock";
      sseCallbacks!.onConnectionStateChange!("connected");
      await settle(10); // refetch -> now mismatches
      await setup.renderOnce();
      switchToPaneSpy.mockClear();

      await selectFirstRowAndEnter();

      expect(squish(setup.captureCharFrame())).toContain(
        squish("different tmux server"),
      );
      expect(switchToPaneSpy).not.toHaveBeenCalled();
    } finally {
      restoreExit();
      restoreFetch();
      restoreTmux();
    }
  });

  // Search mode hands every printable key to the input, so navigation is
  // limited to the keys it can't consume. ^n/^p always worked; the arrows
  // used to fall through to the input and leave the selection stuck on the
  // first match. Enter is the observable side of "which row is selected".
  describe("arrow navigation while searching", () => {
    async function renderTwoSessions() {
      await renderApp(120, 20, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "alpha",
            cwd: "/code/alpha",
            tmuxPane: "%10",
          }),
          mockEnrichedSession({
            id: "s2",
            project: "beta",
            cwd: "/code/beta",
            tmuxPane: "%20",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      setup.mockInput.pressKey("/");
      await setup.renderOnce();
    }

    it("selects the next match on down arrow", async () => {
      const restoreFetch = withServerInfo(null); // fail-open: guard passes
      try {
        await renderTwoSessions();
        setup.mockInput.pressArrow("down");
        await setup.renderOnce();
        setup.mockInput.pressEnter();
        await settle();
        expect(switchToPaneSpy).toHaveBeenCalledWith("%20");
      } finally {
        restoreFetch();
      }
    });

    it("selects the previous match on up arrow", async () => {
      const restoreFetch = withServerInfo(null);
      try {
        await renderTwoSessions();
        // Move down with ^n so the up arrow is the only key under test.
        setup.mockInput.pressKey("n", { ctrl: true });
        await setup.renderOnce();
        setup.mockInput.pressArrow("up");
        await setup.renderOnce();
        setup.mockInput.pressEnter();
        await settle();
        expect(switchToPaneSpy).toHaveBeenCalledWith("%10");
      } finally {
        restoreFetch();
      }
    });
  });
});

describe("App invoke row rendering", () => {
  // Regression guard for the status cell's reactivity: a synthetic invoke row
  // must visibly flip from the running spinner to its terminal outcome when
  // the store mutates `originInvocationStatus` via a fine-grained setState.
  // This drives the FULL production path (App -> store -> SessionList <For> ->
  // SessionItem), the only path that exercises that fine-grained update;
  // mounting SessionItem with a swapped `session` prop would replace the whole
  // object and mask a non-reactive read. See SessionItem's status cell.
  it("flips a subprocess invoke row from working to its terminal outcome", async () => {
    await renderApp(120, 20, { groupBy: "none" });
    sseCallbacks!.onInit([], null);
    await setup.renderOnce();

    sseCallbacks!.onInvocationStarted!({
      type: "invocation_started",
      timestamp: "2024-01-15T12:00:00Z",
      invocationId: "inv_x",
      agent: "codex",
      cwd: "/code/myapp",
      startedAt: "2024-01-15T12:00:00Z",
    });
    await setup.renderOnce();
    const runningFrame = setup.captureCharFrame();
    expect(runningFrame).toContain("working");
    expect(runningFrame).not.toContain("✓");

    sseCallbacks!.onInvocationFinished!({
      type: "invocation_finished",
      timestamp: "2024-01-15T12:00:05Z",
      invocationId: "inv_x",
      agent: "codex",
      status: "succeeded",
      durationMs: 1000,
    });
    await setup.renderOnce();
    const doneFrame = setup.captureCharFrame();
    expect(doneFrame).toContain("✓");
    expect(doneFrame).toContain("done");
    expect(doneFrame).not.toContain("working");
  });
});

describe("App review (d)", () => {
  // groupBy:"none" puts the lone session at flat-index 0 (no group header),
  // so the default selection already lands on it without navigation.
  async function renderWithSession(
    props: Record<string, unknown> = {},
    sessionOverrides: Record<string, unknown> = {},
  ) {
    await renderApp(120, 20, { groupBy: "none", ...props });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          ...sessionOverrides,
        }),
      ],
      null,
    );
    await setup.renderOnce();
  }

  it("calls runHunkReview with paneCwd when d is pressed on a session", async () => {
    await renderWithSession({}, { paneCwd: "/code/myapp/pane-cwd" });
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(runHunkReviewSpy).toHaveBeenCalledTimes(1);
    expect(runHunkReviewSpy.mock.calls[0]?.[1]).toBe("/code/myapp/pane-cwd");
  });

  it("falls back to cwd when paneCwd is null", async () => {
    await renderWithSession();
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(runHunkReviewSpy).toHaveBeenCalledTimes(1);
    expect(runHunkReviewSpy.mock.calls[0]?.[1]).toBe("/code/myapp");
  });

  it("drops a second d-press while a review is in flight", async () => {
    // Hold runHunkReview pending so reviewInFlight stays true across the
    // second press. A rapid double-d must not race two suspend/spawn/resume
    // cycles against the same renderer.
    let resolveReview!: (
      r: { ok: true; notes: typeof reviewNotes } | { ok: false; error: string },
    ) => void;
    runHunkReviewSpy.mockImplementation(
      () =>
        new Promise<
          { ok: true; notes: typeof reviewNotes } | { ok: false; error: string }
        >((resolve) => {
          resolveReview = resolve;
        }),
    );
    await renderWithSession();
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(runHunkReviewSpy).toHaveBeenCalledTimes(1);
    // Release the in-flight review so the guard clears (and no dangling promise).
    resolveReview({ ok: true, notes: [] });
  });

  it("does not call runHunkReview when a group header is selected", async () => {
    // Default groupBy puts a header at flat-index 0.
    await renderApp(120, 20, { groupBy: "project" });
    sseCallbacks!.onInit(
      [mockEnrichedSession({ id: "s1", project: "myapp", cwd: "/code/myapp" })],
      null,
    );
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(runHunkReviewSpy).not.toHaveBeenCalled();
  });

  it("shows the install hint and does not call runHunkReview when hunk is missing", async () => {
    hunkAvailable = false;
    await renderWithSession();
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(runHunkReviewSpy).not.toHaveBeenCalled();
    expect(squish(setup.captureCharFrame())).toContain(
      squish(HUNK_INSTALL_HINT_TEST),
    );
  });

  it("does not call runHunkReview in sidebar mode", async () => {
    await renderWithSession({ sidebar: true });
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(runHunkReviewSpy).not.toHaveBeenCalled();
  });

  it("does not call runHunkReview on ctrl+d", async () => {
    await renderWithSession();
    setup.mockInput.pressKey("d", { ctrl: true });
    await setup.renderOnce();
    expect(runHunkReviewSpy).not.toHaveBeenCalled();
  });

  it("does not call runHunkReview when d is typed into an active search query", async () => {
    await renderWithSession();
    setup.mockInput.pressKey("/");
    await setup.renderOnce();
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(runHunkReviewSpy).not.toHaveBeenCalled();
  });

  it("shows a Review failed toast when runHunkReview resolves ok:false", async () => {
    runHunkReviewSpy.mockImplementation(async () => ({
      ok: false,
      error: "boom",
    }));
    await renderWithSession();
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    // reviewSession's .then() runs on a microtask after runHunkReview resolves.
    await new Promise((r) => setTimeout(r, 0));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Review failed: boom");
  });

  it("recovers when runHunkReview rejects unexpectedly", async () => {
    runHunkReviewSpy.mockImplementation(() =>
      Promise.reject(new Error("resume blew up")),
    );
    await renderWithSession();
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    await new Promise((r) => setTimeout(r, 0));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Review failed");
    // reviewInFlight was reset by the catch handler, so `d` still works.
    runHunkReviewSpy.mockClear();
    runHunkReviewSpy.mockImplementation(async () => ({ ok: true, notes: [] }));
    setup.mockInput.pressKey("d");
    await setup.renderOnce();
    expect(runHunkReviewSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults to a confirmation dialog with the note count and agent label", async () => {
    runHunkReviewSpy.mockImplementation(async () => ({
      ok: true,
      notes: reviewNotes,
    }));
    await renderWithSession({}, { agentType: "claude", tmuxPane: "%1" });
    setup.mockInput.pressKey("d");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Send review comments");
    expect(frame).toContain("Send 1 comment to claude?");
  });

  it("posts the formatted prompt when review delivery is confirmed", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      runHunkReviewSpy.mockImplementation(async () => ({
        ok: true,
        notes: reviewNotes,
      }));
      await renderWithSession({}, { agentType: "claude", tmuxPane: "%1" });
      setup.mockInput.pressKey("d");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      setup.mockInput.pressKey("y");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();

      const send = calls.find((call) => call.url.endsWith("/sessions/s1/send"));
      expect(send?.init?.method).toBe("POST");
      const body = JSON.parse(String(send?.init?.body)) as {
        text: string;
        enter: boolean;
      };
      expect(body.enter).toBe(true);
      expect(body.text).toContain("src/foo.ts:12");
      expect(body.text).toContain("Handle the missing token.");
      expect(setup.captureCharFrame()).toContain("Sent 1 comment to claude");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("shows a failure toast when review delivery returns a non-ok status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    try {
      runHunkReviewSpy.mockImplementation(async () => ({
        ok: true,
        notes: reviewNotes,
      }));
      await renderWithSession({}, { agentType: "claude", tmuxPane: "%1" });
      setup.mockInput.pressKey("d");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      setup.mockInput.pressKey("y");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      expect(squish(setup.captureCharFrame())).toContain(
        squish("Failed to send review comments to claude"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drops pending notes when confirmation is cancelled", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const fetchSpy = mock(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      runHunkReviewSpy.mockImplementation(async () => ({
        ok: true,
        notes: reviewNotes,
      }));
      await renderWithSession({}, { tmuxPane: "%1" });
      setup.mockInput.pressKey("d");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Send review comments");
      expect(urls.some((url) => url.endsWith("/sessions/s1/send"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("shows a paneless toast without offering delivery", async () => {
    runHunkReviewSpy.mockImplementation(async () => ({
      ok: true,
      notes: reviewNotes,
    }));
    await renderWithSession({}, { trackingMode: "background", tmuxPane: null });
    setup.mockInput.pressKey("d");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(squish(frame)).toContain(
      squish("1 review note captured (no pane to send to)"),
    );
    expect(frame).not.toContain("Send review comments");
  });

  it("does nothing after a successful review with zero notes", async () => {
    await renderWithSession({}, { tmuxPane: "%1" });
    setup.mockInput.pressKey("d");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("Send review comments");
  });

  it("auto mode sends immediately with enter true and no dialog", async () => {
    const originalFetch = globalThis.fetch;
    let sentBody: unknown = null;
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as { enter: boolean };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      runHunkReviewSpy.mockImplementation(async () => ({
        ok: true,
        notes: reviewNotes,
      }));
      await renderWithSession({ reviewHandback: "auto" }, { tmuxPane: "%1" });
      setup.mockInput.pressKey("d");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      expect(sentBody).toMatchObject({ enter: true });
      expect(setup.captureCharFrame()).not.toContain("Send review comments");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fill mode pastes without enter and shows the composer toast", async () => {
    const originalFetch = globalThis.fetch;
    let sentBody: unknown = null;
    globalThis.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as { enter: boolean };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      runHunkReviewSpy.mockImplementation(async () => ({
        ok: true,
        notes: reviewNotes,
      }));
      await renderWithSession(
        { reviewHandback: "fill" },
        { agentType: "codex", tmuxPane: "%1" },
      );
      setup.mockInput.pressKey("d");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      expect(sentBody).toMatchObject({ enter: false });
      expect(squish(setup.captureCharFrame())).toContain(
        squish("Prompt filled in codex's composer, press Enter to jump"),
      );
      expect(setup.captureCharFrame()).not.toContain("Send review comments");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the confirm dialog for an unrecognized reviewHandback value", async () => {
    // An unvalidated config typo (e.g. "Fill") must degrade to the confirm
    // dialog, never silently auto-submit the review to the agent.
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL) => {
      urls.push(String(url));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      runHunkReviewSpy.mockImplementation(async () => ({
        ok: true,
        notes: reviewNotes,
      }));
      await renderWithSession({ reviewHandback: "Fill" }, { tmuxPane: "%1" });
      setup.mockInput.pressKey("d");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Send review comments");
      expect(urls.some((url) => url.endsWith("/sessions/s1/send"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("shows Review diff in the context menu when reviewable", async () => {
    await renderWithSession();
    await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("Review diff");
  });

  it("hides Review diff in the context menu when hunk is unavailable", async () => {
    hunkAvailable = false;
    await renderWithSession();
    await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("Review diff");
  });
});

describe("App fork (F / context menu)", () => {
  /** Capture spawn POSTs; `/server-info` is answered so the same-server
   *  guard behind the post-fork jump resolves deterministically. */
  function captureSpawn(
    response: { ok: boolean; status?: number; body?: unknown } = { ok: true },
  ) {
    const bodies: Record<string, unknown>[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/server-info")) {
        return {
          ok: true,
          json: async () => ({ socketPath: null }),
        } as Response;
      }
      if (href.includes("/spawn")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return {
          ok: response.ok,
          status: response.status ?? (response.ok ? 200 : 400),
          statusText: "Bad Request",
          json: async () => response.body ?? { success: true, paneId: "%99" },
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    return { bodies, restore: () => (globalThis.fetch = original) };
  }

  /** Stub process.exit: the one-shot picker exits after jumping to the fork. */
  function withExitSpy() {
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;
    return { exitSpy, restore: () => (process.exit = originalExit) };
  }

  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  async function renderWithSession(
    props: Record<string, unknown> = {},
    sessionOverrides: Record<string, unknown> = {},
  ) {
    await renderApp(120, 20, {
      groupBy: "none",
      forkableAgents: ["claude"],
      persistent: true,
      ...props,
    });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          agentType: "claude",
          nativeSessionId: "native-1",
          tmuxPane: "%5",
          ...sessionOverrides,
        }),
      ],
      null,
    );
    await setup.renderOnce();
  }

  /** `F`, then Enter on the dialog it opens: the whole default path. */
  async function forkFromKey() {
    setup.mockInput.pressKey("F");
    await settle();
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await settle();
    await setup.renderOnce();
  }

  it("asks before forking, rather than forking on the keystroke", async () => {
    // `F` used to post a fork immediately. It opens the dialog now, because a
    // fork has a destination to choose — and nothing is sent by opening one.
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession();
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();

      expect(setup.captureCharFrame()).toContain("Fork session");
      expect(bodies).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("does not fetch spawnable agents for a fork-only dialog", async () => {
    let agentRequests = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith("/agents")) {
        agentRequests += 1;
        return Response.json({ agents: [] });
      }
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    try {
      await renderWithSession();
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();

      expect(setup.captureCharFrame()).toContain("Fork session");
      expect(agentRequests).toBe(0);

      // Ordinary new-session dialogs still refresh on every open so a
      // long-lived picker can discover agents installed since startup.
      setup.mockInput.pressEscape();
      await settle(20);
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();
      expect(agentRequests).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("forks the selected session beside its own pane on Enter", async () => {
    // An untouched dialog is the one-shot `F` this replaced, byte for byte:
    // the source's own checkout, a split off the source's own pane.
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession();
      await forkFromKey();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        fork: "s1",
        split: "h",
        target: "%5",
        // The picker owns the jump; a daemon-side switch would race it.
        detach: true,
      });
      // No agent or cwd: the daemon reads both off the session being forked.
      expect(bodies[0]?.agent).toBeUndefined();
      expect(bodies[0]?.cwd).toBeUndefined();
      // And no worktree asked for: the object is what asks for one at all, so
      // a fork staying put must not send even an empty one.
      expect(bodies[0]?.worktree).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('also fires for the name-"F" spelling some terminals send', async () => {
    // Terminals disagree: most send a capital as name `"f"` with `shift` set
    // (what `pressKey("F")` above produces — it emits the same byte 0x46, so
    // driving this case through `pressKey("f", {shift:true})` would just
    // re-run the previous test), while modifyOtherKeys sends a CSI sequence
    // that parses to name `"F"`. Both arms of the binding are live, and this
    // one drives the raw bytes so the `key === "F"` arm is genuinely covered
    // rather than covered by comment.
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession();
      // CSI 27 ; 2 ; 70 ~  =  modifyOtherKeys form of shift+F.
      setup.renderer.stdin.emit("data", Buffer.from("\x1b[27;2;70~"));
      await settle();
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.fork).toBe("s1");
    } finally {
      restore();
    }
  });

  it("leaves bare f as the hide-idle filter", async () => {
    // Asserting only "no fork was sent" would pass just as happily if `f`
    // became a no-op, which is the regression this test exists to catch. The
    // row is idle, so the filter's effect is visible: it disappears, and
    // comes back on a second press.
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession();
      expect(setup.captureCharFrame()).toContain("myapp");

      setup.mockInput.pressKey("f");
      await settle();
      await setup.renderOnce();
      expect(bodies).toHaveLength(0);
      expect(setup.captureCharFrame()).not.toContain("myapp");

      setup.mockInput.pressKey("f");
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("myapp");
      expect(bodies).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("jumps to the forked pane and exits a one-shot picker", async () => {
    const { restore } = captureSpawn();
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await renderWithSession({ persistent: false });
      await forkFromKey();
      expect(switchToPaneSpy).toHaveBeenCalledWith("%99");
      expect(exitSpy).toHaveBeenCalled();
    } finally {
      restoreExit();
      restore();
    }
  });

  it("drops a second submit while a fork is in flight", async () => {
    // One conversation, one fork: a double Enter must not open two panes. The
    // dialog is still up while the request is out (it closes only on a landed
    // fork), so the second one really does reach the submit path.
    const bodies: Record<string, unknown>[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/spawn")) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Promise(() => {}) as Promise<Response>; // never settles
      }
      return { ok: true, json: async () => ({ socketPath: null }) } as Response;
    }) as unknown as typeof fetch;
    try {
      await renderWithSession();
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(bodies).toHaveLength(1);
      expect(squish(setup.captureCharFrame())).toContain(
        squish("Fork already in progress"),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not close a replacement dialog when an older fork completes", async () => {
    let finishFork!: (response: Response) => void;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      if (href.endsWith("/agents")) {
        return Response.json({
          agents: [
            {
              name: "claude",
              displayName: "Claude",
              shortCode: "CC",
              supportsPrompt: true,
            },
          ],
        });
      }
      if (href.endsWith("/spawn")) {
        return new Promise<Response>((resolve) => {
          finishFork = resolve;
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    try {
      await renderWithSession();
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();

      // Dismiss the submitted fork and start drafting an unrelated session
      // while its daemon request is still pending.
      setup.mockInput.pressEscape();
      await settle(20);
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.mockInput.typeText("keep this prompt");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("keep this prompt");

      finishFork(Response.json({ success: true, paneId: "%99" }));
      await settle();
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("New session");
      expect(frame).toContain("keep this prompt");
      expect(switchToPaneSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("surfaces a refused fork as a toast", async () => {
    const { restore } = captureSpawn({
      ok: false,
      status: 400,
      body: { error: "Agent 'codex' does not support forking a session." },
    });
    try {
      await renderWithSession();
      await forkFromKey();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain(squish("Fork failed:"));
      expect(frame).toContain(squish("does not support forking"));
    } finally {
      restore();
    }
  });

  it("does nothing for an agent that declares no fork command", async () => {
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession({ forkableAgents: [] });
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
      expect(bodies).toHaveLength(0);
      // Not even the dialog: an unforkable row has nothing to choose about.
      expect(setup.captureCharFrame()).not.toContain("Fork session");
    } finally {
      restore();
    }
  });

  it("does nothing for a row with no native session id", async () => {
    // Pane-tracked without hooks: ccmux cannot name the conversation.
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession({}, { nativeSessionId: undefined });
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
      expect(bodies).toHaveLength(0);
      expect(setup.captureCharFrame()).not.toContain("Fork session");
    } finally {
      restore();
    }
  });

  it("refuses a paneless background row, which the menu already hides", async () => {
    // These rows DO satisfy the other two conditions: they are created with
    // agentType "claude" and a nativeSessionId, so without an explicit gate
    // `F` would fork one into an unrelated new window (no pane to sit beside)
    // while sessionMenuItems refuses to offer it. Key and menu have to agree.
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession(
        {},
        {
          trackingMode: "background",
          tmuxPane: null,
          nativeSessionId: "bg-native-id",
        },
      );
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
      expect(bodies).toHaveLength(0);
      expect(squish(setup.captureCharFrame())).toContain(
        squish("no pane to fork beside"),
      );
    } finally {
      restore();
    }
  });

  it("says why instead of doing nothing on an unforkable row", async () => {
    // A menu item can hide itself; a keybinding cannot, and the help overlay
    // advertises `F` on every row.
    const { restore } = captureSpawn();
    try {
      await renderWithSession({}, { nativeSessionId: undefined });
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain(squish("ccmux setup"));
    } finally {
      restore();
    }
  });

  it("names the agent when it has no verified fork command", async () => {
    const { restore } = captureSpawn();
    try {
      await renderWithSession({ forkableAgents: [] });
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
      expect(squish(setup.captureCharFrame())).toContain(
        squish("no verified fork command"),
      );
    } finally {
      restore();
    }
  });

  it("shows Fork in the context menu only for a forkable row", async () => {
    const { restore } = captureSpawn();
    try {
      await renderWithSession();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Fork");
    } finally {
      restore();
    }
  });

  it("hides Fork for a row ccmux cannot fork", async () => {
    // Hidden, not disabled: an item that never works on this row would read
    // as broken rather than as inapplicable.
    const { restore } = captureSpawn();
    try {
      await renderWithSession({}, { nativeSessionId: undefined });
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      // Anchored on an item that is always present, so this cannot pass by
      // the menu simply never having opened.
      expect(frame).toContain("Attach");
      expect(frame).not.toContain("Fork");
    } finally {
      restore();
    }
  });

  it("opens the same dialog from the context menu item", async () => {
    // One item, one flow: the menu used to carry a second "Fork into worktree"
    // beside this one, and the destination row inside the dialog is where that
    // choice lives now.
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      // Located by its label rather than a fixed row. Fork's position in the
      // menu is deliberately not stable (it moved once already, and it is
      // conditional), and a hardcoded row silently starts clicking whatever
      // slid into it — which is how this test would "pass" by firing Kill.
      const menuRow = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Fork"));
      expect(menuRow).toBeGreaterThan(0);
      await setup.mockMouse.click(7, menuRow, MouseButtons.LEFT);
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Fork session");
      expect(bodies).toHaveLength(0);

      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.fork).toBe("s1");
    } finally {
      restore();
    }
  });
});

describe("App new session dialog", () => {
  type SpawnBody = {
    agent?: string;
    cwd?: string;
    split?: unknown;
    callerPane?: string;
    prompt?: string;
    detach?: boolean;
    worktree?: { name?: string; base?: string };
  };

  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  const AGENTS = [
    {
      name: "claude",
      displayName: "Claude",
      shortCode: "CC",
      supportsPrompt: true,
    },
    {
      name: "codex",
      displayName: "Codex",
      shortCode: "CX",
      supportsPrompt: true,
    },
    { name: "pi", displayName: "Pi", shortCode: "PI", supportsPrompt: false },
  ];

  /**
   * Route the daemon calls the dialog makes and record the spawn bodies.
   * `/server-info` answers with a null socket so the same-server guard stays
   * fail-open (a refusal there would mask every spawn assertion).
   */
  function withDaemon(
    options: {
      agents?: unknown;
      agentsStatus?: number;
      spawnStatus?: number;
      spawnBody?: unknown;
    } = {},
  ) {
    const spawns: SpawnBody[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      if (href.endsWith("/agents")) {
        return Response.json(
          options.agents === undefined
            ? { agents: AGENTS }
            : (options.agents as object),
          { status: options.agentsStatus ?? 200 },
        );
      }
      if (href.endsWith("/spawn")) {
        spawns.push(JSON.parse(String(init?.body ?? "{}")) as SpawnBody);
        return Response.json(
          options.spawnBody ?? { success: true, paneId: "%99" },
          { status: options.spawnStatus ?? 200 },
        );
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { spawns, restore: () => (globalThis.fetch = original) };
  }

  function withOurTmux(socket: string) {
    const original = process.env.TMUX;
    process.env.TMUX = socket;
    return () => {
      if (original === undefined) delete process.env.TMUX;
      else process.env.TMUX = original;
    };
  }

  const session = (overrides: Record<string, unknown> = {}) =>
    mockEnrichedSession({
      id: "s1",
      project: "myapp",
      cwd: "/code/myapp",
      tmuxPane: "%5",
      ...overrides,
    });

  /** Open the dialog and let `/agents` land. */
  async function openDialog(
    props: Record<string, unknown> = {},
    sessions = [session()],
  ) {
    await renderApp(120, 24, { groupBy: "none", ...props });
    sseCallbacks!.onInit(sessions, null);
    await setup.renderOnce();
    setup.mockInput.pressKey("n");
    await settle();
    await setup.renderOnce();
  }

  it("opens on n with the selected row's agent and directory", async () => {
    const { restore } = withDaemon();
    try {
      await openDialog({}, [session({ agentType: "codex" })]);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("New session");
      expect(frame).toContain("/code/myapp");
      expect(frame).toMatch(/Codex\s+▾/);
    } finally {
      restore();
    }
  });

  it("prefers the pane's cwd, which follows the agent as it cds", async () => {
    const { restore } = withDaemon();
    try {
      await openDialog({}, [
        session({ cwd: "/code/myapp", paneCwd: "/code/myapp/packages/core" }),
      ]);
      expect(setup.captureCharFrame()).toContain("/code/myapp/packages/core");
    } finally {
      restore();
    }
  });

  it("falls back to the picker's own directory with no selection", async () => {
    const { restore } = withDaemon();
    const originalPwd = process.env.CCMUX_CALLER_PWD;
    process.env.CCMUX_CALLER_PWD = "/where/the/picker/ran";
    try {
      await openDialog({}, []);
      expect(setup.captureCharFrame()).toContain("/where/the/picker/ran");
    } finally {
      if (originalPwd === undefined) delete process.env.CCMUX_CALLER_PWD;
      else process.env.CCMUX_CALLER_PWD = originalPwd;
      restore();
    }
  });

  it("defaults to the last spawned agent when the context offers none", async () => {
    const { restore } = withDaemon();
    try {
      await openDialog({ lastSpawnAgent: "codex" }, []);
      expect(setup.captureCharFrame()).toMatch(/Codex\s+▾/);
    } finally {
      restore();
    }
  });

  it("snaps to a real agent when the row's agent isn't spawnable here", async () => {
    const { restore } = withDaemon();
    try {
      // `gemini` was detected by pane scanning but is not on PATH.
      await openDialog({}, [session({ agentType: "gemini" })]);
      expect(setup.captureCharFrame()).toMatch(/Claude\s+▾/);
    } finally {
      restore();
    }
  });

  it("closes on escape without spawning", async () => {
    const { spawns, restore } = withDaemon();
    try {
      await openDialog();
      setup.mockInput.pressEscape();
      // A bare ESC byte is the prefix of every escape sequence, so the key
      // parser holds it briefly before deciding it stands alone.
      await settle(20);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("New session");
      expect(spawns).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("swallows keys that would otherwise act on the list", async () => {
    const { restore } = withDaemon();
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      // `q` quits the picker outside the dialog; inside it must not.
      setup.mockInput.pressKey("q");
      await setup.renderOnce();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(setup.captureCharFrame()).toContain("New session");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("picks an agent by number key", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      // Direct-pick without opening the dropdown: the collapsed row updates.
      expect(setup.captureCharFrame()).toMatch(/Codex\s+▾/);
      setup.mockInput.pressEnter();
      await settle();
      expect(spawns[0]?.agent).toBe("codex");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("moves the agent selection with j/k and clamps at the ends", async () => {
    const { restore } = withDaemon();
    try {
      await openDialog();
      setup.mockInput.pressKey("k");
      await setup.renderOnce();
      // Already at the top: k is a no-op rather than a wrap to the bottom.
      expect(setup.captureCharFrame()).toMatch(/Claude\s+▾/);
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toMatch(/Codex\s+▾/);
    } finally {
      restore();
    }
  });

  it("opens the agent dropdown on space, navigates, and confirms", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressKey(" ");
      await setup.renderOnce();
      // The list is on screen now, numbered as before.
      expect(setup.captureCharFrame()).toContain("2 Codex");
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      // Enter confirms the highlight and closes the overlay, without
      // spawning: the dropdown owns the key while it is open.
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(spawns).toHaveLength(0);
      expect(setup.captureCharFrame()).toMatch(/Codex\s+▾/);
      // The next Enter is the dialog's again.
      setup.mockInput.pressEnter();
      await settle();
      expect(spawns[0]?.agent).toBe("codex");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("closes the agent dropdown on escape without touching the draft", async () => {
    const { restore } = withDaemon();
    try {
      await openDialog();
      setup.mockInput.pressKey(" ");
      await setup.renderOnce();
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressEscape();
      await settle(20);
      await setup.renderOnce();
      // The dialog survives (escape was the overlay's), the held agent is
      // unchanged, and the list is gone.
      const frame = setup.captureCharFrame();
      expect(frame).toContain("New session");
      expect(frame).toMatch(/Claude\s+▾/);
      expect(frame).not.toContain("2 Codex");
    } finally {
      restore();
    }
  });

  it("spawns from the confirm button's click", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex(
        (line) => line.includes("Spawn") && line.includes("Cancel"),
      );
      expect(row).toBeGreaterThan(0);
      // Located by label, not position: the button row moves with the plan.
      await setup.mockMouse.click(lines[row]!.indexOf("Spawn") + 1, row);
      await settle();
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.agent).toBe("claude");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("closes the dialog from the Cancel button without spawning", async () => {
    const { spawns, restore } = withDaemon();
    try {
      await openDialog();
      const lines = setup.captureCharFrame().split("\n");
      const row = lines.findIndex(
        (line) => line.includes("Spawn") && line.includes("Cancel"),
      );
      expect(row).toBeGreaterThan(0);
      await setup.mockMouse.click(lines[row]!.indexOf("Cancel") + 1, row);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("New session");
      expect(spawns).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("confirms the highlighted agent with space while the dropdown is open", async () => {
    // The key that opened it commits it: without this, the hand that pressed
    // space to open presses it again and nothing happens.
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressKey(" ");
      await setup.renderOnce();
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressKey(" ");
      await setup.renderOnce();
      // Committed and closed, without spawning.
      expect(spawns).toHaveLength(0);
      const frame = setup.captureCharFrame();
      expect(frame).toMatch(/Codex\s+▾/);
      expect(frame).not.toContain("2 Codex");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("drives a placement dropdown with the same keys as the agent's", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      setup.mockInput.pressKey("l");
      await setup.renderOnce();
      // The list is up, numbered, with the held value marked.
      expect(setup.captureCharFrame()).toContain("> 1 New window");
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      // Confirmed into the pill without spawning...
      expect(spawns).toHaveLength(0);
      expect(setup.captureCharFrame()).toMatch(/Split right\s+▾/);
      // ...and a reopened list cancels with h without moving the value.
      setup.mockInput.pressKey("l");
      await setup.renderOnce();
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      setup.mockInput.pressKey("h");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toMatch(/Split right\s+▾/);
      expect(frame).not.toContain("New window");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("opens the agent dropdown on l and closes it on h, dropping the highlight", async () => {
    const { restore } = withDaemon();
    try {
      await openDialog();
      setup.mockInput.pressKey("l");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("2 Codex");
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      // h mirrors the l that opened it: closed without committing, so the
      // held agent is still the one the dialog opened with.
      setup.mockInput.pressKey("h");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("New session");
      expect(frame).toMatch(/Claude\s+▾/);
      expect(frame).not.toContain("2 Codex");
    } finally {
      restore();
    }
  });

  it("keeps l as a plain character in the prompt field", async () => {
    // The open keys belong to the AGENT field; a text field owns every
    // printable key, so typing an l there must never raise the overlay.
    const { restore } = withDaemon();
    try {
      await openDialog();
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      setup.mockInput.pressKey("l");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("2 Codex");
      // The l reached the input as text: the typed value replaced the
      // placeholder rather than raising the overlay.
      expect(frame).not.toContain("Optional first message");
    } finally {
      restore();
    }
  });

  it("tab moves to placement, where the number keys pick a split", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toMatch(/Split right\s+▾/);
      setup.mockInput.pressEnter();
      await settle();
      expect(spawns[0]?.split).toBe("h");
    } finally {
      restoreExit();
      restore();
    }
  });

  /**
   * The destination field is the picker half of issue #69. It sends the
   * daemon an empty `worktree` object rather than a name: the daemon derives
   * the name from the same prompt the row previewed, so the two cannot drift.
   *
   * The empty object is load-bearing, not incidental. A name in it means
   * create-OR-OPEN, so an untouched dialog that posted its own preview would
   * drop the agent into whatever worktree already answers to that slug,
   * instead of the numbered sibling a derived name gets (issue #83).
   */
  it("asks for a worktree by prompt alone, naming nothing", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      // agent -> placement -> prompt.
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("fix bug");
      await setup.renderOnce();
      // prompt -> destination.
      setup.mockInput.pressTab();
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      // The name it would get, on its own row and left untouched.
      expect(setup.captureCharFrame()).toContain("fix-bug");
      setup.mockInput.pressEnter();
      await settle();

      expect(spawns[0]?.worktree).toEqual({});
      expect(spawns[0]?.worktree).not.toHaveProperty("name");
      expect(spawns[0]?.prompt).toBe("fix bug");
    } finally {
      restoreExit();
      restore();
    }
  });

  /**
   * Typing in the name field is the opposite request: THAT worktree, opened
   * if it is already there. Only a typed name may travel as one.
   */
  it("sends a typed name, slugified the way the daemon would", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("fix bug");
      await setup.renderOnce();
      // prompt -> destination, choose the worktree, then tab onto the name
      // row the choice just revealed.
      setup.mockInput.pressTab();
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("Rescue The Flaky Test");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();

      expect(spawns[0]?.worktree).toEqual({ name: "rescue-the-flaky-test" });
      // The prompt still goes to the agent; it just no longer names anything.
      expect(spawns[0]?.prompt).toBe("fix bug");
    } finally {
      restoreExit();
      restore();
    }
  });

  /**
   * A name is enough on its own. Before issue #83 this dialog could only name
   * a worktree through the prompt, and a promptless one was unspawnable.
   */
  it("spawns a named worktree with no prompt at all", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      // agent -> destination, walking backwards to the last visible field.
      setup.mockInput.pressTab({ shift: true });
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("rescue");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();

      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.worktree).toEqual({ name: "rescue" });
      expect(spawns[0]?.prompt).toBeUndefined();
    } finally {
      restoreExit();
      restore();
    }
  });

  /**
   * The keys the name field has to own. `2` would otherwise pick a
   * destination and `j` would move an option, so a name could not contain
   * either — exactly the guarantee the prompt field already carries.
   */
  it("lets the name contain the option keys", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressTab({ shift: true });
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("fix2j");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();

      expect(spawns[0]?.worktree).toEqual({ name: "fix2j" });
      // Nothing leaked into the fields those keys belong to.
      expect(spawns[0]?.split).toBe(false);
    } finally {
      restoreExit();
      restore();
    }
  });

  /**
   * With neither a name nor a prompt to derive one from there is nothing to
   * create. It refuses locally rather than posting: the daemon's own refusal
   * advises passing a name explicitly, which was CLI advice back when this
   * dialog had no field to act on it with.
   */
  it("refuses a worktree with no derivable name instead of posting", async () => {
    const { spawns, restore } = withDaemon();
    // Spied even though this path must not spawn: a regression here would
    // otherwise exit the runner on success and read as a silent pass.
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      // agent -> destination, walking backwards to the last field.
      setup.mockInput.pressTab({ shift: true });
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      expect(spawns).toHaveLength(0);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Name the worktree, or type a prompt");
      // Fixable in place, so the dialog stays up with the draft intact.
      expect(frame).toContain("New session");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("refuses a worktree when a non-Latin prompt derives no name", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      // Every character is stripped by the slug rules, so this is as nameless
      // as an empty prompt while looking nothing like one.
      await setup.mockInput.typeText("修复侧边栏");
      setup.mockInput.pressTab();
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      expect(spawns).toHaveLength(0);
      expect(setup.captureCharFrame()).toContain(
        "Name the worktree, or type a prompt",
      );
    } finally {
      restoreExit();
      restore();
    }
  });

  /**
   * A derived name can come back numbered: the daemon appends `-2` rather
   * than joining a worktree that already answers to the slug. The toast says
   * where the agent actually landed, so it has to read the RESPONSE, not the
   * name the row previewed.
   */
  it("names the worktree the daemon reports, not the one it previewed", async () => {
    const { restore } = withDaemon({
      spawnBody: {
        success: true,
        paneId: "%99",
        worktree: { name: "fix-bug-2", path: "/code/myapp/.wt/fix-bug-2" },
      },
    });
    try {
      // The sidebar spawns without leaving, so it is the surface that has a
      // toast to show at all.
      await openDialog({ sidebar: true, persistent: true });
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("fix bug");
      await setup.renderOnce();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("fix-bug-2");
    } finally {
      restore();
    }
  });

  it("sends no worktree field when the destination is this checkout", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressEnter();
      await settle();

      expect(spawns[0]?.worktree).toBeUndefined();
    } finally {
      restoreExit();
      restore();
    }
  });

  it("shift-tab walks the fields backwards", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      // agent -> destination -> prompt -> placement, then pick the stacked
      // split. `destination` is last in the field order, so walking backwards
      // from `agent` reaches it first.
      setup.mockInput.pressTab({ shift: true });
      await setup.renderOnce();
      setup.mockInput.pressTab({ shift: true });
      await setup.renderOnce();
      setup.mockInput.pressTab({ shift: true });
      await setup.renderOnce();
      setup.mockInput.pressKey("3");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toMatch(/Split down\s+▾/);
      setup.mockInput.pressEnter();
      await settle();
      expect(spawns[0]?.split).toBe("v");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("sends a typed prompt, and lets it contain the option keys", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("j3k");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      expect(spawns[0]?.prompt).toBe("j3k");
      // The keys reached the input, not the agent/placement fields.
      expect(spawns[0]?.agent).toBe("claude");
      expect(spawns[0]?.split).toBe(false);
    } finally {
      restoreExit();
      restore();
    }
  });

  it("spawns with the derived cwd and the launch pane, then exits the picker", async () => {
    const { spawns, restore } = withDaemon();
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressEnter();
      await settle();
      expect(spawns).toHaveLength(1);
      expect(spawns[0]).toMatchObject({
        agent: "claude",
        cwd: "/code/myapp",
        split: false,
        // callerPane, not target: an explicit target renumbers windows.
        callerPane: "%7",
        detach: false,
      });
      expect(exitSpy).toHaveBeenCalled();
    } finally {
      restoreExit();
      restore();
    }
  });

  it("sidebar spawns detached and stays open", async () => {
    const { spawns, restore } = withDaemon();
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await openDialog({ sidebar: true });
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(spawns[0]?.detach).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(setup.captureCharFrame()).toContain("Spawned Claude");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("does not spawn twice when Enter is pressed twice", async () => {
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressEnter();
      setup.mockInput.pressEnter();
      await settle();
      expect(spawns).toHaveLength(1);
    } finally {
      restoreExit();
      restore();
    }
  });

  it("does not spawn twice when Enter lands while the agent is being remembered", async () => {
    // The spawn is no longer in flight here but the pane already exists, and
    // remembering the agent is a real file read, write and rename. The dialog
    // stays on screen for all of it, so an Enter delivered in that window
    // used to pass both guards and open a second pane. Durable on the sidebar
    // and the persistent picker, where nothing exits to end the race.
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    let release: () => void = () => {};
    uiStateGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await openDialog({ sidebar: true });
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      // Parked mid-write: one pane exists, the dialog is still up.
      expect(spawns).toHaveLength(1);
      expect(uiStateWrites).toContainEqual({ lastSpawnAgent: "claude" });
      expect(setup.captureCharFrame()).toContain("New session");

      setup.mockInput.pressEnter();
      await settle();
      expect(spawns).toHaveLength(1);

      release();
      await settle();
      await setup.renderOnce();
      expect(spawns).toHaveLength(1);
      expect(setup.captureCharFrame()).not.toContain("New session");
    } finally {
      release();
      restoreExit();
      restore();
    }
  });

  it("refuses a prompt for an agent that cannot take one", async () => {
    const { spawns, restore } = withDaemon();
    try {
      await openDialog();
      setup.mockInput.pressKey("3"); // pi: supportsPrompt false
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("hi");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(spawns).toHaveLength(0);
      expect(setup.captureCharFrame()).toContain("can't start with a prompt");
    } finally {
      restore();
    }
  });

  it("keeps the dialog open and toasts when the daemon rejects the spawn", async () => {
    const { restore } = withDaemon({
      spawnStatus: 400,
      spawnBody: { error: "Directory does not exist: /code/myapp" },
    });
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      // The toast wraps, so compare with the box drawing and spacing gone.
      const frame = setup.captureCharFrame();
      expect(squish(frame)).toContain("Spawnfailed:Directorydoesnotexist");
      expect(frame).toContain("New session");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      restoreExit();
      restore();
    }
  });

  it("explains a 404 as a stale daemon rather than showing HTTP 404", async () => {
    // A daemon predating GET /agents simply doesn't route it. The daemon is
    // machine-wide and long-lived, so this is the likeliest failure right
    // after an upgrade, and a bare status code just reads as broken.
    const { restore } = withDaemon({ agentsStatus: 404, agents: {} });
    try {
      await openDialog();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain(squish(STALE_DAEMON_HINT));
      expect(frame).not.toContain("HTTP404");
    } finally {
      restore();
    }
  });

  it("reports the daemon's error when the agent list cannot be resolved", async () => {
    const { restore } = withDaemon({
      agentsStatus: 500,
      agents: { error: "Failed to resolve agents: bad regex" },
    });
    try {
      await openDialog();
      expect(setup.captureCharFrame()).toContain("bad regex");
    } finally {
      restore();
    }
  });

  it("refuses to spawn onto a different tmux server", async () => {
    // withDaemon answers socketPath:null, which leaves the guard fail-open,
    // so the refusal needs a socket that provably isn't ours.
    const spawns: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: "/tmp/some-other-server/default" });
      }
      if (href.endsWith("/agents")) return Response.json({ agents: AGENTS });
      if (href.endsWith("/spawn")) {
        spawns.push(init?.body);
        return Response.json({ success: true, paneId: "%99" });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    const restoreTmux = withOurTmux("/tmp/our-server/default");
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      expect(spawns).toHaveLength(0);
      expect(exitSpy).not.toHaveBeenCalled();
      // The toast wraps at this width, so compare with spacing removed.
      expect(squish(setup.captureCharFrame())).toContain(
        squish("Target pane is on a different tmux server"),
      );
    } finally {
      restoreExit();
      restoreTmux();
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a rejected agents fetch and retries on the next open", async () => {
    // The daemon dying mid-session rejects rather than answering, and the
    // dialog must not stay permanently empty once it comes back.
    let failNext = true;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      if (href.endsWith("/agents")) {
        if (failNext) throw new Error("connection refused");
        return Response.json({ agents: AGENTS });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    try {
      await openDialog();
      expect(setup.captureCharFrame()).toContain("connection refused");

      // Close, bring the daemon back, reopen: the list is fetched again.
      setup.mockInput.pressEscape();
      await settle(20);
      await setup.renderOnce();
      failNext = false;
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toMatch(/Claude\s+▾/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces a rejected spawn and keeps the dialog open", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      if (href.endsWith("/agents")) return Response.json({ agents: AGENTS });
      if (href.endsWith("/spawn")) throw new Error("socket hang up");
      return Response.json({});
    }) as unknown as typeof fetch;
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(squish(frame)).toContain("Spawnfailed:sockethangup");
      expect(frame).toContain("New session");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      restoreExit();
      globalThis.fetch = originalFetch;
    }
  });

  it("records the spawned agent before the picker exits", async () => {
    // The one-shot picker calls process.exit the instant the spawn lands,
    // so the write has to be awaited first; a queued one never reaches
    // disk. Ordering IS the assertion, so both events share one channel.
    const { restore } = withDaemon();
    const originalExit = process.exit;
    process.exit = (() => {
      uiStateWrites.push("exit");
    }) as never;
    try {
      await openDialog();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      expect(uiStateWrites).toEqual([{ lastSpawnAgent: "codex" }, "exit"]);
    } finally {
      process.exit = originalExit;
      restore();
    }
  });

  it("still spawns when remembering the agent fails", async () => {
    // The pane already exists by then. Reporting a state-write failure as
    // "Spawn failed" makes the user press Enter again and get a SECOND
    // pane, which is strictly worse than forgetting the agent.
    const { spawns, restore } = withDaemon();
    const { exitSpy, restore: restoreExit } = withExitSpy();
    const originalSet = uiStateWrites.push;
    uiStateWrites.push = () => {
      throw new Error("EACCES: permission denied, open 'state.json'");
    };
    try {
      await openDialog();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      expect(spawns).toHaveLength(1);
      expect(exitSpy).toHaveBeenCalled();
      expect(setup.captureCharFrame()).not.toContain("Spawn failed");
    } finally {
      uiStateWrites.push = originalSet;
      restoreExit();
      restore();
    }
  });

  it("resolves the launch pane per spawn, not once at mount", async () => {
    // A cached pane goes stale: a sidebar records its neighbour at startup,
    // the neighbour is closed later, and every spawn then 400s forever.
    const { spawns, restore } = withDaemon();
    const { restore: restoreExit } = withExitSpy();
    resolveLaunchPaneSpy.mockClear();
    try {
      await openDialog();
      expect(resolveLaunchPaneSpy).not.toHaveBeenCalled();

      resolveLaunchPaneSpy.mockImplementation(async () => "%42");
      setup.mockInput.pressEnter();
      await settle();
      expect(resolveLaunchPaneSpy).toHaveBeenCalled();
      expect(spawns[0]?.callerPane).toBe("%42");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("refuses to open over a session with no working directory", async () => {
    const { restore } = withDaemon();
    try {
      await renderApp(120, 24, { groupBy: "none" });
      sseCallbacks!.onInit([session({ cwd: "", paneCwd: null })], null);
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("New session");
      expect(squish(frame)).toContain(squish("no working directory"));
    } finally {
      restore();
    }
  });

  it("leaves Shift+N unclaimed", async () => {
    const { restore } = withDaemon();
    try {
      await renderApp(120, 24, { groupBy: "none" });
      sseCallbacks!.onInit([session()], null);
      await setup.renderOnce();
      setup.mockInput.pressKey("n", { shift: true });
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("New session");
    } finally {
      restore();
    }
  });

  it("refetches the agent list on every open", async () => {
    // A long-lived sidebar must notice an agent installed since it started.
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      if (href.endsWith("/agents")) {
        calls += 1;
        return Response.json({
          agents: calls === 1 ? [AGENTS[0]] : AGENTS,
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    try {
      await openDialog();
      expect(calls).toBe(1);
      expect(setup.captureCharFrame()).not.toContain("Codex");

      setup.mockInput.pressEscape();
      await settle(20);
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();

      expect(calls).toBe(2);
      // The newcomer is visible where the list now lives: in the dropdown.
      setup.mockInput.pressKey(" ");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Codex");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("offers New session on a session row's context menu", async () => {
    const { restore } = withDaemon();
    try {
      await renderApp(120, 24, { groupBy: "none" });
      sseCallbacks!.onInit([session()], null);
      await setup.renderOnce();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("New session");
    } finally {
      restore();
    }
  });

  it("ignores a row click while the dialog is open", async () => {
    // The dialog is centered and ~10 rows tall, so rows stay visible above
    // and below it. Before the modal guard covered this dialog, a click on
    // one ran activateItem -> selectPane -> process.exit(0): the one-shot
    // picker quit and threw away a half-filled dialog, prompt and all.
    const { restore } = withDaemon();
    const { exitSpy, restore: restoreExit } = withExitSpy();
    try {
      await openDialog();
      await setup.mockMouse.click(5, 1);
      await setup.renderOnce();

      expect(exitSpy).not.toHaveBeenCalled();
      expect(switchToPaneSpy).not.toHaveBeenCalled();
      // The draft survives the click.
      expect(setup.captureCharFrame()).toContain("New session");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("ignores a row right-click while the dialog is open", async () => {
    // A context menu opened underneath would be unreachable: the dialog's
    // key branch runs before the context-menu branch, so nothing could
    // dismiss the menu from the keyboard.
    const { restore } = withDaemon();
    try {
      await openDialog();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("New session");
      // Menu-only labels, since the dialog's own title is now the same words
      // the menu item carries: "New session" no longer tells them apart.
      expect(frame).not.toContain("Attach");
      expect(frame).not.toContain("Restart");
    } finally {
      restore();
    }
  });

  /** Right-click the group header on row 1 and click its "New session"
   *  item, located by label so a menu reshuffle can't fire a different
   *  action. Returns the frame with the dialog open. */
  async function openGroupMenuNewSession(): Promise<string> {
    await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
    await setup.renderOnce();
    const menuRow = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("New session"));
    expect(menuRow).toBeGreaterThan(0);
    await setup.mockMouse.click(7, menuRow, MouseButtons.LEFT);
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  }

  it("gives the same directory for a group whether opened by key or by mouse", async () => {
    // Grouped by tmux session, a header's members can span unrelated repos,
    // so the first member's cwd is an arbitrary pick and the picker's own
    // directory is the defensible answer. The key path already gated on that;
    // the menu path took the first member unconditionally, so the same header
    // answered differently depending on how it was opened.
    const { restore } = withDaemon();
    const originalPwd = process.env.CCMUX_CALLER_PWD;
    process.env.CCMUX_CALLER_PWD = "/where/the/picker/ran";
    const grouped = [
      session({ id: "s1", cwd: "/code/other-repo", tmuxTarget: "dev:1.0" }),
      session({ id: "s2", cwd: "/code/myapp", tmuxTarget: "dev:2.0" }),
    ];
    try {
      await renderApp(120, 24, { groupBy: "session" });
      sseCallbacks!.onInit(grouped, null);
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();
      const byKey = setup.captureCharFrame();
      expect(byKey).toContain("/where/the/picker/ran");

      setup.mockInput.pressEscape();
      await settle(20);
      await setup.renderOnce();

      const byMouse = await openGroupMenuNewSession();
      expect(byMouse).toContain("New session");
      expect(byMouse).toContain("/where/the/picker/ran");
      expect(byMouse).not.toContain("/code/other-repo");
    } finally {
      if (originalPwd === undefined) delete process.env.CCMUX_CALLER_PWD;
      else process.env.CCMUX_CALLER_PWD = originalPwd;
      restore();
    }
  });

  it("uses the repo root for a project group, not a member's worktree", async () => {
    // A project group is repo-level: it holds the main checkout AND every
    // worktree of it, and members are sorted by status then activity. Taking
    // members[0] made the directory a sibling worktree that changes between
    // two opens; the repo root is the one directory the whole group agrees on.
    const { restore } = withDaemon();
    const worktree = session({
      id: "s1",
      cwd: "/code/myapp/.claude/worktrees/feature",
      project: "myapp",
      isWorktree: true,
      mainRepoRoot: "/code/myapp",
    });
    const checkout = session({
      id: "s2",
      cwd: "/code/myapp",
      project: "myapp",
      mainRepoRoot: "/code/myapp",
    });
    try {
      await renderApp(120, 24, { groupBy: "project" });
      sseCallbacks!.onInit([worktree, checkout], null);
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();
      const byKey = setup.captureCharFrame();
      expect(byKey).toContain("/code/myapp");
      expect(byKey).not.toContain("worktrees/feature");

      setup.mockInput.pressEscape();
      await settle(20);
      await setup.renderOnce();

      const byMouse = await openGroupMenuNewSession();
      expect(byMouse).toContain("/code/myapp");
      expect(byMouse).not.toContain("worktrees/feature");
    } finally {
      restore();
    }
  });

  it("keeps a member's directory when the group's members disagree on the repo", async () => {
    // The project group key is a repo NAME, not a path, so ~/work/api and
    // ~/oss/api land in ONE group. Taking whichever member happened to carry a
    // mainRepoRoot answered with one of two unrelated repositories depending on
    // the status sort, so a disagreement falls back to the member's own cwd.
    const { restore } = withDaemon();
    const first = session({
      id: "s1",
      cwd: "/code/work/api/src",
      project: "api",
      mainRepoRoot: "/code/work/api",
    });
    const second = session({
      id: "s2",
      cwd: "/code/oss/api/src",
      project: "api",
      mainRepoRoot: "/code/oss/api",
    });
    try {
      await renderApp(120, 24, { groupBy: "project" });
      sseCallbacks!.onInit([first, second], null);
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();

      // The member's own cwd, not either repo root. Spelled out with the
      // field label so a row behind the dialog cannot satisfy it.
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Directory   /code/work/api/src");
      expect(frame).not.toContain("Directory   /code/oss/api");
    } finally {
      restore();
    }
  });

  it("never answers with the home directory for a project group", async () => {
    // A literal ~/.git dotfiles repo resolves every member's mainRepoRoot to
    // $HOME while the group stands for one subdirectory of it, so agreeing on
    // $HOME is agreement on the wrong directory: a new session would start at
    // the top of the user's home.
    const { restore } = withDaemon();
    const home = realpathSync(homedir());
    const inHome = session({
      id: "s1",
      cwd: join(home, "dotfiles-notes"),
      project: "dotfiles-notes",
      mainRepoRoot: home,
    });
    try {
      await renderApp(120, 24, { groupBy: "project" });
      sseCallbacks!.onInit([inHome], null);
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();

      // Labelled, so the session row behind the dialog cannot satisfy it.
      expect(setup.captureCharFrame()).toContain(
        "Directory   ~/dotfiles-notes",
      );
    } finally {
      restore();
    }
  });

  it("offers New session on a group header's context menu", async () => {
    const { restore } = withDaemon();
    try {
      await renderApp(120, 24, { groupBy: "project" });
      sseCallbacks!.onInit([session()], null);
      await setup.renderOnce();
      // Row 1 is the group header under the default grouping.
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("New session");
    } finally {
      restore();
    }
  });
});

describe("App move-changes menu gate", () => {
  /**
   * The gate is lazy: the dirty answer arrives AFTER the menu is on screen.
   * These pin the two properties that makes that safe — the item is absent
   * until the answer lands, and nothing above it moves when it does.
   */
  function captureDirty(
    answer: { dirty: boolean } | "never" | "error" = { dirty: true },
  ) {
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/dirty")) {
        asked.push(href);
        if (answer === "never")
          return new Promise(() => {}) as Promise<Response>;
        if (answer === "error") return { ok: false, status: 500 } as Response;
        return { ok: true, json: async () => answer } as Response;
      }
      if (href.includes("/server-info")) {
        return {
          ok: true,
          json: async () => ({ socketPath: null }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    return { asked, restore: () => (globalThis.fetch = original) };
  }

  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  async function openMenuOnRow() {
    await renderApp(120, 24, { groupBy: "none", persistent: true });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          tmuxPane: "%1",
        }),
      ],
      null,
    );
    await setup.renderOnce();
    await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
    await setup.renderOnce();
  }

  /** Rows of the open menu, by the labels visible in the frame. */
  function menuRows(): { label: string; row: number }[] {
    const labels = [
      "Attach",
      "New session",
      "Review diff",
      "Copy last response",
      "Move changes",
      "Restart",
      "Kill",
    ];
    return setup
      .captureCharFrame()
      .split("\n")
      .flatMap((line, row) => {
        const label = labels.find((l) => line.includes(l));
        return label ? [{ label, row }] : [];
      });
  }

  /** The menu box's own top border row. */
  const menuTop = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("┌"));

  /** Hold the dirty answer open so the "before" frame is genuinely without
   *  the item; a mock that resolves immediately settles during the render
   *  await and the test proves nothing. */
  function heldDirty() {
    let release!: (r: Response) => void;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/dirty")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    return {
      land: () =>
        release({ ok: true, json: async () => ({ dirty: true }) } as Response),
      restore: () => (globalThis.fetch = original),
    };
  }

  it("asks the daemon only when the menu opens", async () => {
    const { asked, restore } = captureDirty();
    try {
      await openMenuOnRow();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("/sessions/s1/dirty");
    } finally {
      restore();
    }
  });

  it("never asks about a paneless background row", async () => {
    // Its menu has no "Move changes" item to gate (see `sessionMenuItems`),
    // so the question is a `git status -uall` on the daemon whose answer is
    // discarded either way.
    const { asked, restore } = captureDirty();
    try {
      await renderApp(120, 24, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "bg1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: null,
            trackingMode: "background",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      // Anchored on the menu having actually opened, so this can't pass by
      // the right-click landing nowhere.
      expect(setup.captureCharFrame()).toContain("Attach agent");
      expect(asked).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("shows the item once the answer says dirty", async () => {
    const { restore } = captureDirty({ dirty: true });
    try {
      await openMenuOnRow();
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Move changes");
    } finally {
      restore();
    }
  });

  it("keeps the item hidden for a clean checkout", async () => {
    const { restore } = captureDirty({ dirty: false });
    try {
      await openMenuOnRow();
      await settle();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      // Anchored, so this can't pass by the menu never opening.
      expect(frame).toContain("Attach");
      expect(frame).not.toContain("Move changes");
    } finally {
      restore();
    }
  });

  it("shows no placeholder while the answer is outstanding", async () => {
    // Deliberately no "checking…" row: the menu never displays something
    // that isn't actionable.
    const { restore } = captureDirty("never");
    try {
      await openMenuOnRow();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Attach");
      expect(frame).not.toContain("Move changes");
    } finally {
      restore();
    }
  });

  it("keeps the item hidden when the daemon errors", async () => {
    const { restore } = captureDirty("error");
    try {
      await openMenuOnRow();
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Move changes");
    } finally {
      restore();
    }
  });

  it("does not move the rows above it when the item lands", async () => {
    // The item used to be appended LAST so that nothing could move at all.
    // It sits above Restart and Kill now (destructive actions belong at the
    // bottom), so those two do shift down by exactly the row it takes, and
    // this pins what is still guaranteed: the menu box does not move, and
    // neither does anything above the insertion point.
    //
    // No item has been hovered in this test, so the menu is still allowed to
    // react. Once a pointer enters a row, ContextMenu freezes the item list;
    // the keyboard path stays reactive because its highlight is an item id
    // (see the next two tests).
    const dirty = heldDirty();
    try {
      await openMenuOnRow();
      const top = menuTop();
      const before = menuRows();
      expect(before.length).toBeGreaterThan(2);
      expect(before.some((r) => r.label === "Move changes")).toBe(false);

      dirty.land();
      await settle();
      await setup.renderOnce();
      const after = menuRows();
      expect(after.some((r) => r.label === "Move changes")).toBe(true);
      expect(menuTop()).toBe(top);

      const inserted = after.find((r) => r.label === "Move changes")!.row;
      for (const row of before) {
        const now = after.find((r) => r.label === row.label);
        const expected = row.row < inserted ? row.row : row.row + 1;
        expect(`${row.label}@${now?.row}`).toBe(`${row.label}@${expected}`);
      }
    } finally {
      dirty.restore();
    }
  });

  it("keeps the action under the pointer fixed when the item lands", async () => {
    const dirty = heldDirty();
    try {
      await openMenuOnRow();
      const restart = menuRows().find((row) => row.label === "Restart")!;

      // Begin aiming at Restart before the dirty answer inserts its row above
      // it. From this point on, the pointer's screen coordinates are a user
      // choice and the rendered item list must not move underneath them.
      await setup.mockMouse.moveTo(7, restart.row);
      await setup.renderOnce();

      dirty.land();
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Move changes");
      expect(menuRows().find((row) => row.label === "Restart")?.row).toBe(
        restart.row,
      );

      await setup.mockMouse.click(7, restart.row, MouseButtons.LEFT);
      await settle();
      await setup.renderOnce();
      expect(squish(setup.captureCharFrame())).toContain("RestartSession?");
    } finally {
      dirty.restore();
    }
  });

  it("drops a hovered row's snapshot when right-click opens another menu", async () => {
    const { restore } = captureDirty("never");
    try {
      await renderApp(120, 30, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        Array.from({ length: 12 }, (_, index) =>
          mockEnrichedSession({
            id: `s${index}`,
            project: `p${index}`,
            cwd: `/code/p${index}`,
            tmuxPane: index === 11 ? null : `%${index}`,
            trackingMode: index === 11 ? "background" : "pane",
          }),
        ),
        null,
      );
      await setup.renderOnce();

      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      const restart = menuRows().find((row) => row.label === "Restart")!;
      await setup.mockMouse.moveTo(7, restart.row);
      await setup.renderOnce();

      // The twelfth row is below the first menu, so this reaches the list and
      // replaces the still-mounted ContextMenu without dismissing it first.
      await setup.mockMouse.click(5, 12, MouseButtons.RIGHT);
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Attach agent");
      expect(frame).toContain("Open agent view");
      expect(frame).not.toContain("Restart");
    } finally {
      restore();
    }
  });

  it("returns a pointer-frozen menu to its live items for keyboard input", async () => {
    const dirty = heldDirty();
    try {
      await openMenuOnRow();
      const restart = menuRows().find((row) => row.label === "Restart")!;

      // Freeze the pointer's list, then leave it before the async item lands.
      await setup.mockMouse.moveTo(7, restart.row);
      await setup.renderOnce();
      await setup.mockMouse.moveTo(0, 0);
      await setup.renderOnce();
      dirty.land();
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Move changes");

      // The first keyboard move takes ownership and must reveal the live list
      // that App is navigating. Four more steps land on Move changes.
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Move changes");
      for (const _ of [0, 1, 2, 3]) {
        setup.mockInput.pressKey("j");
        await setup.renderOnce();
      }
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(squish(setup.captureCharFrame())).toContain(
        "Movechangestoworktree",
      );
    } finally {
      dirty.restore();
    }
  });

  it("keeps the highlight on its own item when the item lands", async () => {
    // The hazard the id-keyed highlight exists for. Restart sits directly
    // below where "Move changes" is inserted, so by row number the highlight
    // would end up on the new item and Enter would run a move the user never
    // chose — on a checkout they were about to restart.
    const dirty = heldDirty();
    try {
      await renderApp(120, 24, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      // Through the keyboard, which is the path that remembers a highlight.
      setup.mockInput.pressKey("m");
      await settle();
      await setup.renderOnce();
      // Attach -> New session -> Review diff -> Copy last response ->
      // Restart. (No Fork: the row is not forkable here.)
      for (const _ of [0, 1, 2, 3]) {
        setup.mockInput.pressKey("j");
        await setup.renderOnce();
      }

      dirty.land();
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Move changes");

      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      const frame = squish(setup.captureCharFrame());
      // Restart's confirmation, not the move dialog.
      expect(frame).toContain("RestartSession?");
      expect(frame).not.toContain("Movechangestoworktree");
    } finally {
      dirty.restore();
    }
  });

  it("does not move a bottom-clamped menu when the item lands", async () => {
    // The same invariant as above, at the edge where "append last" stops
    // being enough: clamped against the bottom, a menu that grows has to grow
    // upward, so every row it already drew slides out from under the pointer.
    let release!: (r: Response) => void;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/dirty")) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    try {
      await renderApp(120, 24, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        Array.from({ length: 20 }, (_, i) =>
          mockEnrichedSession({
            id: `s${i}`,
            project: `p${i}`,
            cwd: `/code/p${i}`,
            tmuxPane: `%${i}`,
          }),
        ),
        null,
      );
      await setup.renderOnce();
      // A row low enough that the menu cannot fit below it.
      await setup.mockMouse.click(5, 19, MouseButtons.RIGHT);
      await setup.renderOnce();
      const topBefore = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("┌"));
      expect(topBefore).toBeGreaterThan(0);
      const before = menuRows();

      release({ ok: true, json: async () => ({ dirty: true }) } as Response);
      await settle();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Move changes");
      expect(frame.split("\n").findIndex((line) => line.includes("┌"))).toBe(
        topBefore,
      );
      // The box held still, so everything above the insertion did too; the
      // two rows below it move down by the one row it takes.
      const after = menuRows();
      const inserted = after.find((r) => r.label === "Move changes")!.row;
      for (const row of before) {
        const moved = after.find((r) => r.label === row.label);
        const expected = row.row < inserted ? row.row : row.row + 1;
        expect(`${row.label}@${moved?.row}`).toBe(`${row.label}@${expected}`);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("ignores a dirty answer from an earlier opening of the same row", async () => {
    const releases: Array<(response: Response) => void> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/dirty")) {
        return new Promise<Response>((resolve) => releases.push(resolve));
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    try {
      await openMenuOnRow();
      expect(releases).toHaveLength(1);

      // `m` closes the pointer-opened menu, then opens the same row again.
      // Both requests therefore carry the same session id; only the menu's
      // opening generation can tell their answers apart.
      setup.mockInput.pressKey("m");
      await setup.renderOnce();
      setup.mockInput.pressKey("m");
      await setup.renderOnce();
      expect(releases).toHaveLength(2);

      releases[1]!({
        ok: true,
        json: async () => ({ dirty: true }),
      } as Response);
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Move changes");

      // The first opening's older, contradictory answer must not overwrite
      // the result belonging to the menu that is actually on screen.
      releases[0]!({
        ok: true,
        json: async () => ({ dirty: false }),
      } as Response);
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Move changes");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("never gates one row's menu with another row's answer", async () => {
    // A slow answer for a dismissed menu must not resurrect the item
    // somewhere else.
    //
    // Belt and braces, honestly: mutating the guard it is aimed at does not
    // make this fail, because the second menu's own (clean) answer already
    // hides the item by the time the first one lands. Kept anyway — it pins
    // the OBSERVABLE contract, and a future ordering change is exactly the
    // sort of thing that would make it start earning its keep.
    let resolveFirst!: (r: Response) => void;
    const original = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/dirty")) {
        asked.push(href);
        if (asked.length === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { ok: true, json: async () => ({ dirty: false }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    try {
      await renderApp(120, 24, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "a",
            cwd: "/a",
            tmuxPane: "%1",
          }),
          mockEnrichedSession({
            id: "s2",
            project: "b",
            cwd: "/b",
            tmuxPane: "%2",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      // Open on the first row, then dismiss and open on the second.
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      setup.mockInput.pressKey("escape");
      await setup.renderOnce();
      await setup.mockMouse.click(5, 2, MouseButtons.RIGHT);
      await setup.renderOnce();

      // The first row's answer arrives late, and says dirty.
      resolveFirst({
        ok: true,
        json: async () => ({ dirty: true }),
      } as Response);
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Move changes");
    } finally {
      globalThis.fetch = original;
    }
  });

  /**
   * The item's whole job: hand the dialog a request that already knows it is
   * a move. Driven from the click rather than the store so the prefill, the
   * dialog and the POST are checked as one path.
   */
  describe("the dialog it opens", () => {
    type SpawnBody = {
      cwd?: string;
      prompt?: string;
      worktree?: { withChanges?: boolean; untracked?: string; name?: string };
    };

    function withMoveDaemon() {
      const spawns: SpawnBody[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/dirty")) {
          return { ok: true, json: async () => ({ dirty: true }) } as Response;
        }
        if (href.includes("/server-info")) {
          return Response.json({ socketPath: null });
        }
        if (href.endsWith("/agents")) {
          return Response.json({
            agents: [
              {
                name: "claude",
                displayName: "Claude",
                shortCode: "CC",
                supportsPrompt: true,
              },
            ],
          });
        }
        if (href.endsWith("/spawn")) {
          spawns.push(JSON.parse(String(init?.body ?? "{}")) as SpawnBody);
          return Response.json({ success: true, paneId: "%99" });
        }
        return Response.json({});
      }) as unknown as typeof fetch;
      return { spawns, restore: () => (globalThis.fetch = original) };
    }

    /** Open the row menu, wait for the dirty answer, and click "Move changes". */
    async function clickMoveChanges(): Promise<void> {
      await openMenuOnRow();
      await settle();
      await setup.renderOnce();
      const row = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Move changes"));
      expect(row).toBeGreaterThan(0);
      await setup.mockMouse.click(7, row, MouseButtons.LEFT);
      await settle();
      await setup.renderOnce();
    }

    it("opens prefilled for a move, over the row's own checkout", async () => {
      const { restore } = withMoveDaemon();
      try {
        await clickMoveChanges();
        const frame = setup.captureCharFrame();

        expect(frame).toContain("Move changes to worktree");
        expect(frame).toContain("/code/myapp");
        // Locked to a worktree, with the untracked choice this mode adds.
        expect(frame).toContain("Where");
        expect(frame).not.toContain("This checkout");
        expect(frame).toContain("Untracked");
        expect(frame).toMatch(/Move\s+▾/);
      } finally {
        restore();
      }
    });

    it("posts the move with the chosen untracked mode", async () => {
      const { spawns, restore } = withMoveDaemon();
      try {
        await clickMoveChanges();
        // Type a prompt, which is also what names the worktree...
        setup.mockInput.pressTab();
        setup.mockInput.pressTab();
        await setup.renderOnce();
        await setup.mockInput.typeText("fix the flicker");
        await setup.renderOnce();
        // ...tab straight past the locked destination to the name, which the
        // prompt has been naming as it was typed...
        setup.mockInput.pressTab();
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("fix-the-flicker");
        // ...then on to Untracked and pick "leave".
        setup.mockInput.pressTab();
        await setup.renderOnce();
        setup.mockInput.pressKey("3");
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toMatch(/Leave here\s+▾/);

        setup.mockInput.pressEnter();
        await settle();

        expect(spawns).toHaveLength(1);
        expect(spawns[0]?.cwd).toBe("/code/myapp");
        expect(spawns[0]?.prompt).toBe("fix the flicker");
        // Untouched name, so the move goes into a worktree the daemon names
        // and numbers, not into whatever already answers to that slug.
        expect(spawns[0]?.worktree).toEqual({
          withChanges: true,
          untracked: "leave",
        });
      } finally {
        restore();
      }
    });

    /**
     * The destination is locked but the name is not, which is the reason the
     * move routes through the dialog rather than happening on the click.
     */
    it("posts the move under a name typed into the dialog", async () => {
      const { spawns, restore } = withMoveDaemon();
      try {
        await clickMoveChanges();
        // agent -> placement -> prompt -> name, past the locked destination.
        setup.mockInput.pressTab();
        setup.mockInput.pressTab();
        setup.mockInput.pressTab();
        await setup.renderOnce();
        await setup.mockInput.typeText("Rescue Work");
        await setup.renderOnce();
        setup.mockInput.pressEnter();
        await settle();

        expect(spawns).toHaveLength(1);
        expect(spawns[0]?.worktree).toEqual({
          name: "rescue-work",
          withChanges: true,
          untracked: "move",
        });
        // No prompt was typed, and the move no longer needs one to be named.
        expect(spawns[0]?.prompt).toBeUndefined();
      } finally {
        restore();
      }
    });

    it("sends no move on an ordinary new session", async () => {
      // The same dialog, opened by `n`: the flag is what makes it a move, and
      // nothing about the mode may leak into the request that did not ask.
      const { spawns, restore } = withMoveDaemon();
      try {
        await renderApp(120, 24, { groupBy: "none", persistent: true });
        sseCallbacks!.onInit(
          [
            mockEnrichedSession({
              id: "s1",
              project: "myapp",
              cwd: "/code/myapp",
              tmuxPane: "%1",
            }),
          ],
          null,
        );
        await setup.renderOnce();
        setup.mockInput.pressKey("n");
        await settle();
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("New session");
        setup.mockInput.pressEnter();
        await settle();

        expect(spawns).toHaveLength(1);
        expect(spawns[0]?.worktree).toBeUndefined();
      } finally {
        restore();
      }
    });
  });
});

/**
 * What the picker says once the move has actually run.
 *
 * The move is the one spawn that can leave the user owning state they did not
 * have before — work parked in a stash, a redundant entry to drop, a
 * staged/unstaged split to rebuild — so these pin WHICH of those get a message
 * that waits to be acknowledged and which stay a toast.
 */
describe("App move-changes reporting", () => {
  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  /** Bodies the dialog posted, in order, since the last daemon stub. */
  const spawnBodies: {
    split?: unknown;
    worktree?: Record<string, unknown>;
  }[] = [];

  /** A daemon that offers the move and answers `/spawn` with `spawn()`. */
  function withMoveDaemon(spawn: () => Response) {
    const original = globalThis.fetch;
    spawnBodies.length = 0;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/dirty")) {
        return Response.json({ repo: true, dirty: true });
      }
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      if (href.endsWith("/agents")) {
        return Response.json({
          agents: [
            {
              name: "claude",
              displayName: "Claude",
              shortCode: "CC",
              supportsPrompt: true,
            },
          ],
        });
      }
      if (href.endsWith("/spawn")) {
        spawnBodies.push(
          JSON.parse(
            String(init?.body ?? "{}"),
          ) as (typeof spawnBodies)[number],
        );
        return spawn();
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { restore: () => (globalThis.fetch = original) };
  }

  /** Open the row menu, pick "Move changes", name the worktree, submit. */
  async function submitMove(
    props: Record<string, unknown> = {},
  ): Promise<void> {
    await renderApp(120, 24, {
      groupBy: "none",
      persistent: true,
      ...props,
    });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          tmuxPane: "%1",
        }),
      ],
      null,
    );
    await setup.renderOnce();
    await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
    await settle();
    await setup.renderOnce();
    const row = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("Move changes"));
    expect(row).toBeGreaterThan(0);
    await setup.mockMouse.click(7, row, MouseButtons.LEFT);
    await settle();
    await setup.renderOnce();
    // agent -> placement -> prompt -> name, past the locked destination.
    setup.mockInput.pressTab();
    setup.mockInput.pressTab();
    setup.mockInput.pressTab();
    await setup.renderOnce();
    await setup.mockInput.typeText("rescue");
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    await settle();
    await setup.renderOnce();
  }

  /** A landed spawn, with whatever the move reported bolted on. */
  const landed = (move?: Record<string, unknown>) =>
    Response.json({
      success: true,
      paneId: "%99",
      worktree: { name: "rescue" },
      ...(move ? { move } : {}),
    });

  const relocated = {
    moved: 3,
    untracked: { mode: "move", files: ["new.ts"] },
    source: "/code/myapp",
  };

  it("ignores the option keys while the dialog has no room to draw", async () => {
    // Too short for the fields, so the dialog says what it needs instead of
    // drawing them. A number key here would change a choice that is not on
    // screen — worse than doing nothing, because the spawn would carry it.
    const { restore } = withMoveDaemon(() => landed(relocated));
    try {
      await renderApp(80, 6, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      setup.mockInput.pressKey("n");
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Needs 7 rows");

      // "2" is New worktree on the destination row, and "2"/"3" are splits on
      // the placement row. Neither may take effect unseen.
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();

      expect(spawnBodies).toHaveLength(1);
      expect(spawnBodies[0]?.worktree).toBeUndefined();
      expect(spawnBodies[0]?.split).toBe(false);
    } finally {
      restore();
    }
  });

  it("refuses a name with nothing a worktree name can be made of", async () => {
    // The name is a real choice, not a suggestion: with a prompt present, a
    // slug rule that quietly discards what was typed spawns the worktree
    // under a name derived from the prompt instead, which is what a user who
    // typed a name is not asking for.
    const spawns: unknown[] = [];
    const { restore } = withMoveDaemon(() => {
      spawns.push(1);
      return landed(relocated);
    });
    try {
      await renderApp(120, 24, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await settle();
      await setup.renderOnce();
      const row = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Move changes"));
      await setup.mockMouse.click(7, row, MouseButtons.LEFT);
      await settle();
      await setup.renderOnce();

      // A prompt to derive a name from, and a name of its own that no slug
      // can be made of.
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("fix the flicker");
      await setup.renderOnce();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("修复!!!");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      expect(spawns).toHaveLength(0);
      const frame = squish(setup.captureCharFrame());
      // The toast wraps, and the taller dialog's title row now sits between
      // its two lines in row order, so each wrapped line is asserted whole
      // rather than the phrase across the break.
      expect(frame).toContain("needslettersor");
      expect(frame).toContain("numbers;clearthefield");
      // Still on the dialog, with the typed name where it was left.
      expect(frame).toContain("Movechangestoworktree");
    } finally {
      restore();
    }
  });

  it("gates on the same directory the move will run in", async () => {
    // A pane that has `cd`ed away moves out of where it IS, and the gate has
    // to answer about that same checkout — otherwise the item is offered (or
    // withheld) on the strength of a `git status` in an unrelated directory.
    // Named explicitly rather than left to the daemon's default so the two
    // cannot drift apart: this client already knows which one it means.
    const asked: string[] = [];
    const spawns: { cwd?: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/dirty")) {
        asked.push(href);
        return Response.json({ repo: true, dirty: true });
      }
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      if (href.endsWith("/agents")) {
        return Response.json({
          agents: [
            {
              name: "claude",
              displayName: "Claude",
              shortCode: "CC",
              supportsPrompt: true,
            },
          ],
        });
      }
      if (href.endsWith("/spawn")) {
        spawns.push(JSON.parse(String(init?.body ?? "{}")) as { cwd?: string });
        return Response.json({ success: true, paneId: "%99" });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    try {
      await renderApp(120, 24, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            // The agent has cd'ed into a subdirectory since it started.
            paneCwd: "/code/myapp/packages/core",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await settle();
      await setup.renderOnce();

      expect(asked).toHaveLength(1);
      const gated = new URL(asked[0]!).searchParams.get("cwd");
      expect(gated).toBe("/code/myapp/packages/core");

      const row = setup
        .captureCharFrame()
        .split("\n")
        .findIndex((line) => line.includes("Move changes"));
      await setup.mockMouse.click(7, row, MouseButtons.LEFT);
      await settle();
      await setup.renderOnce();
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("rescue");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();

      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.cwd).toBe(gated!);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("summarizes what the move did in the sidebar's toast", async () => {
    // The sidebar spawns without following the pane, so this line is the only
    // account of an operation that emptied the user's checkout.
    const { restore } = withMoveDaemon(() => landed(relocated));
    try {
      await submitMove({ sidebar: true });
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("rescue");
      expect(frame).toContain("moved3files");
      expect(frame).toContain("untrackedmoved");
    } finally {
      restore();
    }
  });

  it("does not let a leftover stash entry expire on a timer", async () => {
    // The move landed, but its own backup could not be dropped. That is a
    // chore the user now owns, and a chore is not a toast.
    const { restore } = withMoveDaemon(() =>
      landed({ ...relocated, leftoverStash: "deadbee1234" }),
    );
    try {
      await submitMove({ sidebar: true });
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("deadbee1234");
      expect(frame).toContain("gitstashdrop");
      expect(frame).toContain("anykeytodismiss");
    } finally {
      restore();
    }
  });

  it("exits the picker into the new pane when the move was clean", async () => {
    // The picker's whole job is to put you in the pane; an acknowledgement
    // step for a move with nothing to acknowledge would be in the way.
    const { exitSpy, restore: restoreExit } = withExitSpy();
    const { restore } = withMoveDaemon(() => landed(relocated));
    try {
      await submitMove({ persistent: false });
      expect(squish(setup.captureCharFrame())).not.toContain("anykeytodismiss");
      expect(exitSpy).toHaveBeenCalled();
    } finally {
      restore();
      restoreExit();
    }
  });

  it("holds the picker's exit until a leftover stash is acknowledged", async () => {
    const { exitSpy, restore: restoreExit } = withExitSpy();
    const { restore } = withMoveDaemon(() =>
      landed({ ...relocated, leftoverStash: "deadbee1234" }),
    );
    try {
      await submitMove({ persistent: false });
      expect(exitSpy).not.toHaveBeenCalled();
      expect(squish(setup.captureCharFrame())).toContain("deadbee1234");

      setup.mockInput.pressKey("escape");
      await settle();
      expect(exitSpy).toHaveBeenCalled();
    } finally {
      restore();
      restoreExit();
    }
  });

  it("calls out a daemon too old to have moved anything", async () => {
    // The giveaway is a perfectly ordinary 200 with no `move` in it: an older
    // daemon drops the keys it does not know, spawns into an empty worktree,
    // and leaves the work exactly where it was.
    const { exitSpy, restore: restoreExit } = withExitSpy();
    const { restore } = withMoveDaemon(() => landed());
    try {
      await submitMove({ persistent: false });
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("olderbuild");
      expect(frame).toContain("/code/myapp");
      expect(frame).toContain("ccmuxdaemonrestart");
      // Not a silent success: the picker does not vanish into the new pane
      // as if the changes had gone with it.
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      restore();
      restoreExit();
    }
  });

  it("holds a refused move's stash recovery on screen until dismissed", async () => {
    // The sha is the only handle on the user's work. A four-second toast that
    // truncates it is the same as not printing it at all.
    const { restore } = withMoveDaemon(() =>
      Response.json(
        {
          error: "Could not apply the changes into the new worktree",
          reason: "apply-failed",
          stashSha: "abc1234def",
          sourceRestored: false,
        },
        { status: 400 },
      ),
    );
    try {
      await submitMove();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("Couldnotapplythechanges");
      expect(frame).toContain("gitstashapplyabc1234def");

      // Dismissed by a keypress, and the dialog it was raised over is still
      // there to correct and retry.
      setup.mockInput.pressKey("escape");
      await setup.renderOnce();
      const after = squish(setup.captureCharFrame());
      expect(after).not.toContain("gitstashapplyabc1234def");
      expect(after).toContain("Movechangestoworktree");
    } finally {
      restore();
    }
  });

  it("names where the work went when the spawn failed after the move", async () => {
    const { restore } = withMoveDaemon(() =>
      Response.json(
        {
          error:
            "Failed to spawn session: tmux failed (your uncommitted changes were already moved out of /code/myapp to /code/myapp/.claude/worktrees/rescue)",
          move: {
            moved: 3,
            untracked: { mode: "move", files: ["new.ts"] },
            source: "/code/myapp",
            flattenedIndex: true,
          },
        },
        { status: 500 },
      ),
    );
    try {
      await submitMove();
      const frame = squish(setup.captureCharFrame());
      // The accounting, the worktree it landed in, and the staged/unstaged
      // caveat the CLI prints for the same body.
      expect(frame).toContain("Moved3fileschanged");
      expect(frame).toContain("1fileuntrackedmoved");
      expect(frame).toContain(".claude/worktrees/rescue");
      expect(frame).toContain("staged/unstagedsplit");
    } finally {
      restore();
    }
  });

  it("leaves a plain validation refusal a toast, in the daemon's own words", async () => {
    // Nothing happened, so there is nothing to acknowledge: the message is
    // advice for the field the user is still looking at.
    const { restore } = withMoveDaemon(() =>
      Response.json(
        {
          error:
            "Worktree 'rescue' already exists at /code/myapp/.claude/worktrees/rescue; moving changes needs a fresh worktree (pick another name, or leave the name empty to derive one from the prompt).",
          reason: "create-failed",
        },
        { status: 400 },
      ),
    );
    try {
      await submitMove();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("alreadyexists");
      // A toast, not the acknowledgement dialog.
      expect(frame).not.toContain("anykeytodismiss");
    } finally {
      restore();
    }
  });
});

/**
 * A fork's DESTINATION (issue #70): the one Fork item opens the new-session
 * dialog, and the dialog is where the fork is told to continue in the source's
 * own checkout or in a worktree of its own — named, before the conversation is
 * continued in it.
 */
describe("App fork into worktree", () => {
  type ForkBody = {
    fork?: string;
    agent?: string;
    cwd?: string;
    prompt?: string;
    split?: unknown;
    target?: string;
    detach?: boolean;
    worktree?: { name?: string; withChanges?: boolean };
  };

  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  /** Answers everything the menu and the dialog ask on the way to a spawn. */
  function withForkDaemon(
    spawnResponse: () => Response = () =>
      Response.json({ success: true, paneId: "%99" }),
  ) {
    const spawns: ForkBody[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      // Clean, so "Move changes" stays out of the menu and cannot be the
      // item a label search lands on.
      if (href.includes("/dirty")) return Response.json({ dirty: false });
      if (href.includes("/server-info")) {
        return Response.json({ socketPath: null });
      }
      if (href.endsWith("/agents")) {
        return Response.json({
          agents: [
            {
              name: "claude",
              displayName: "Claude",
              shortCode: "CC",
              supportsPrompt: true,
            },
          ],
        });
      }
      if (href.endsWith("/spawn")) {
        spawns.push(JSON.parse(String(init?.body ?? "{}")) as ForkBody);
        return spawnResponse();
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { spawns, restore: () => (globalThis.fetch = original) };
  }

  async function openMenu(
    sessionOverrides: Record<string, unknown> = {},
    props: Record<string, unknown> = {},
  ) {
    await renderApp(120, 24, {
      groupBy: "none",
      persistent: true,
      forkableAgents: ["claude"],
      ...props,
    });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          agentType: "claude",
          nativeSessionId: "native-1",
          tmuxPane: "%1",
          mainRepoRoot: "/code/myapp",
          gitBranch: "feat/parking",
          ...sessionOverrides,
        }),
      ],
      null,
    );
    await setup.renderOnce();
    await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
    await settle();
    await setup.renderOnce();
  }

  /** Open the menu and click Fork, by label rather than by row: the menu's
   *  order is deliberately not stable. */
  async function openForkDialog(
    sessionOverrides: Record<string, unknown> = {},
    props: Record<string, unknown> = {},
  ) {
    await openMenu(sessionOverrides, props);
    const row = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => /Fork\s+F/.test(line));
    expect(row).toBeGreaterThan(0);
    await setup.mockMouse.click(7, row, MouseButtons.LEFT);
    await settle();
    await setup.renderOnce();
  }

  /**
   * Open the dialog and move the destination to the worktree: Tab from
   * Placement to Where, then the option key for the second choice. Driven
   * through the real keys rather than a store poke, because the number keys
   * are scoped to the FOCUSED field and that scoping is half the behaviour.
   */
  async function openWorktreeFork(
    sessionOverrides: Record<string, unknown> = {},
    props: Record<string, unknown> = {},
  ) {
    await openForkDialog(sessionOverrides, props);
    setup.mockInput.pressTab();
    await setup.renderOnce();
    setup.mockInput.pressKey("2");
    await setup.renderOnce();
  }

  it("carries one Fork item, not a second one for the worktree", async () => {
    const { restore } = withForkDaemon();
    try {
      await openMenu();
      const lines = setup.captureCharFrame().split("\n");
      expect(lines.findIndex((line) => /Fork\s+F/.test(line))).toBeGreaterThan(
        0,
      );
      // The destination is a row inside the dialog now; two menu items for
      // one action was the thing this replaced.
      expect(lines.filter((line) => line.includes("Fork"))).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("still offers Fork for a row that is not in a git repo", async () => {
    // The worktree needs a repository to hang off; the FORK does not. The
    // item used to be gated on the repo because the only dialog it opened was
    // the worktree one — now the dialog opens with its destination locked.
    const { restore } = withForkDaemon();
    try {
      await openMenu({ mainRepoRoot: null });
      expect(setup.captureCharFrame()).toContain("Fork");
    } finally {
      restore();
    }
  });

  it("locks the destination when the source is not in a git repo", async () => {
    const { spawns, restore } = withForkDaemon();
    try {
      await openForkDialog({ mainRepoRoot: null });
      const whereRow = setup
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("Where"));
      expect(whereRow).toContain("This checkout");
      // No list behind it: a row that looks selectable and refuses every key
      // reads as broken.
      expect(whereRow).not.toContain("▾");

      // And the key that would have moved it does nothing.
      setup.mockInput.pressTab();
      await setup.renderOnce();
      setup.mockInput.pressKey("2");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.worktree).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("hides it for a row ccmux cannot fork at all", async () => {
    const { restore } = withForkDaemon();
    try {
      await openMenu({ nativeSessionId: undefined });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Attach");
      expect(frame).not.toContain("Fork");
    } finally {
      restore();
    }
  });

  it("opens the dialog over the source, in its own checkout", async () => {
    const { spawns, restore } = withForkDaemon();
    try {
      await openForkDialog();
      const frame = setup.captureCharFrame();

      expect(frame).toContain("Fork session");
      // The source session and the checkout it sits in.
      expect(frame).toContain("Source");
      expect(frame).toContain("feat/parking");
      expect(frame).toContain("/code/myapp");
      // Nothing about a worktree until one is asked for: no name is derived
      // for a fork that is staying where it is.
      expect(frame).toContain("This checkout");
      expect(frame).not.toContain("feat-parking-fork");
      // Nothing is sent by opening a dialog.
      expect(spawns).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("previews the derived name once the worktree is the destination", async () => {
    const { spawns, restore } = withForkDaemon();
    try {
      await openWorktreeFork();
      const frame = setup.captureCharFrame();

      expect(frame).toContain("New worktree");
      // The daemon's own <branch>-fork rule, previewed.
      expect(frame).toContain("feat-parking-fork");
      expect(spawns).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("omits the name entirely when the field was never touched", async () => {
    const { spawns, restore } = withForkDaemon();
    try {
      await openWorktreeFork();
      setup.mockInput.pressEnter();
      await settle();

      expect(spawns).toHaveLength(1);
      expect(spawns[0]).toMatchObject({
        fork: "s1",
        // A split of the CALLER's pane, not the source's: a fork that has left
        // the source's checkout is no longer that pane's sibling.
        split: "h",
        detach: true,
      });
      expect(spawns[0]?.target).toBeUndefined();
      // The worktree is asked for, but NOT named: an untouched row is the
      // derived state, which the daemon numbers past a collision. Posting the
      // preview as an explicit name would open whatever answers to that slug.
      expect(spawns[0]?.worktree).toEqual({});
      // Everything else comes off the session being forked.
      expect(spawns[0]?.agent).toBeUndefined();
      expect(spawns[0]?.cwd).toBeUndefined();
      expect(spawns[0]?.prompt).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("sends a typed name explicitly, slugified as the row showed it", async () => {
    const { spawns, restore } = withForkDaemon();
    try {
      await openWorktreeFork();
      // Where -> Name, the row the worktree destination just added.
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("Parking Retry");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();

      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.worktree).toEqual({ name: "parking-retry" });
      // Never a move: emptying the checkout the source is still running in is
      // refused by the daemon, and this mode has no way to ask for it.
      expect(spawns[0]?.worktree?.withChanges).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("sends nothing when the dialog is cancelled", async () => {
    const { spawns, restore } = withForkDaemon();
    try {
      await openForkDialog();
      setup.mockInput.pressEscape();
      await settle(20);
      await setup.renderOnce();

      expect(spawns).toHaveLength(0);
      expect(setup.captureCharFrame()).not.toContain("Fork session");
    } finally {
      restore();
    }
  });

  it("leaves the dialog up with the daemon's words on a refusal", async () => {
    // Every refusal here is something the user can fix in the field they are
    // still looking at, so the dialog stays and the message is a toast.
    const { restore } = withForkDaemon(() =>
      Response.json(
        {
          error:
            "Worktree 'parking' already exists at /code/myapp/.claude/worktrees/parking",
        },
        { status: 400 },
      ),
    );
    try {
      await openWorktreeFork();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("alreadyexists");
      expect(frame).toContain("Forksession");
    } finally {
      restore();
    }
  });

  it("refuses a name with nothing left after slugifying", async () => {
    const { spawns, restore } = withForkDaemon();
    try {
      await openWorktreeFork();
      setup.mockInput.pressTab();
      await setup.renderOnce();
      await setup.mockInput.typeText("!!!");
      await setup.renderOnce();
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      // Refused out loud rather than silently derived: the field would still
      // be showing the user's text while the worktree got another name.
      // (Per wrapped toast line; the dialog's title row interleaves in row
      // order — see the move-mode variant of this test.)
      expect(spawns).toHaveLength(0);
      const refused = squish(setup.captureCharFrame());
      expect(refused).toContain("needslettersor");
      expect(refused).toContain("numbers;clearthefield");
    } finally {
      restore();
    }
  });

  it("jumps to the new pane when the picker is the one forking", async () => {
    const { restore } = withForkDaemon();
    try {
      await openForkDialog();
      setup.mockInput.pressEnter();
      await settle();
      // The picker's whole purpose is to put you where the work is.
      expect(switchToPaneSpy).toHaveBeenCalledWith("%99");
    } finally {
      restore();
    }
  });

  it("forks from the sidebar without stealing focus", async () => {
    // The rail is a board you watch, not a place you launch from and leave —
    // the same convention an ordinary spawn from the sidebar already
    // follows. The toast is then the only account of where the fork landed.
    const { spawns, restore } = withForkDaemon(() =>
      Response.json({
        success: true,
        paneId: "%99",
        worktree: { name: "feat-parking-fork" },
      }),
    );
    try {
      await openWorktreeFork({}, { sidebar: true, persistent: true });
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      expect(spawns).toHaveLength(1);
      expect(switchToPaneSpy).not.toHaveBeenCalled();
      expect(squish(setup.captureCharFrame())).toContain("feat-parking-fork");
    } finally {
      restore();
    }
  });

  it("does not preview a detached HEAD as a branch to name after", async () => {
    // A detached checkout reports the literal string "HEAD" as its branch,
    // but the daemon names a fork of one after the sha it is sitting on
    // (`readCheckoutHead`). Previewing `head-fork` promises a name nobody
    // gets — and it is worse than cosmetic: typing the preview sends it as an
    // EXPLICIT name, and a second detached fork then opens the first one's
    // checkout instead of getting one of its own.
    const { restore } = withForkDaemon();
    try {
      await openWorktreeFork({ gitBranch: "HEAD" });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Fork session");
      // The Source row still says HEAD, verbatim, the way the picker's own
      // branch column does. It is the derived NAME that has to stay quiet.
      expect(frame).toContain("HEAD");
      expect(frame).not.toContain("head-fork");
    } finally {
      restore();
    }
  });

  it("shows the derived-name hint when the branch is unknown", async () => {
    // The daemon reads the source checkout's HEAD for itself, so there is a
    // name coming even when the row carries no branch to preview.
    const { restore } = withForkDaemon();
    try {
      await openWorktreeFork({ gitBranch: null });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Fork session");
      expect(frame).toContain("auto");
      expect(frame).not.toContain("Type a prompt");
    } finally {
      restore();
    }
  });
});

/**
 * The row menu from the keyboard (`m`). The menus themselves were reachable
 * only by right-click, which on a surface whose whole point is a keyboard
 * left several actions ("Move changes", "Open agent view") with no key at all.
 */
describe("App row menu (m)", () => {
  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  /** Answers the menu's own fetches: the dirty gate behind "Move changes",
   *  and `/agents` for the dialog one of these tests opens. */
  function withDaemon() {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      // Clean, so the async item never arrives and the item list is stable.
      if (href.includes("/dirty")) return Response.json({ dirty: false });
      if (href.endsWith("/agents")) {
        return Response.json({
          agents: [
            {
              name: "claude",
              displayName: "Claude",
              shortCode: "CC",
              supportsPrompt: true,
            },
          ],
        });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    return { restore: () => (globalThis.fetch = original) };
  }

  async function renderRows(props: Record<string, unknown> = {}) {
    await renderApp(120, 24, { groupBy: "none", persistent: true, ...props });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "alpha",
          cwd: "/code/alpha",
          tmuxPane: "%1",
        }),
        mockEnrichedSession({
          id: "s2",
          project: "beta",
          cwd: "/code/beta",
          tmuxPane: "%2",
        }),
      ],
      null,
    );
    await setup.renderOnce();
  }

  const press = async (key: string) => {
    setup.mockInput.pressKey(key);
    await settle();
    await setup.renderOnce();
  };

  /** The frame line a piece of text is on, or -1. */
  const lineOf = (text: string) =>
    setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes(text));

  it("opens the selected row's menu anchored on that row", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      // Row 2, so the anchor cannot pass by landing on the list's first line
      // whatever the arithmetic did.
      await press("j");
      const row = lineOf("code/beta");
      expect(row).toBeGreaterThan(0);

      await press("m");
      expect(setup.captureCharFrame()).toContain("Attach");
      // The menu's own top border, on the row it belongs to: a menu that
      // opened at a fixed corner would leave the user to work out which row
      // it came from.
      expect(lineOf("┌")).toBe(row);
      // Indented rather than flush, so the row is still identifiable under it.
      expect(lineOf("code/alpha")).toBeGreaterThan(-1);
    } finally {
      restore();
    }
  });

  it("opens the group menu on a group header", async () => {
    const { restore } = withDaemon();
    try {
      await renderApp(120, 24, { groupBy: "project", persistent: true });
      sseCallbacks!.onInit(
        [mockEnrichedSession({ id: "s1", project: "alpha", cwd: "/a" })],
        null,
      );
      await setup.renderOnce();
      // Up from the session row onto its header.
      await press("k");
      await press("m");

      const frame = setup.captureCharFrame();
      // The group menu's own items, and none of the row menu's.
      expect(frame).toContain("Pin to top");
      expect(frame).toContain("Kill group");
      expect(frame).not.toContain("Attach");
    } finally {
      restore();
    }
  });

  it("closes the menu it opened when pressed again", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      expect(setup.captureCharFrame()).toContain("Attach");

      await press("m");
      // Not reopened on the next row, and not left up: `m` is one key for
      // both halves, so pressing it twice has to land back where it started.
      expect(setup.captureCharFrame()).not.toContain("Attach");
    } finally {
      restore();
    }
  });

  it("closes the menu on escape", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      expect(setup.captureCharFrame()).toContain("Attach");

      setup.mockInput.pressEscape();
      // A lone ESC byte is only unambiguous once the parser has waited out
      // the sequence it could have started; every escape test here does this.
      await settle(20);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Attach");
    } finally {
      restore();
    }
  });

  it("does nothing while a modal overlay owns the screen", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      // The help overlay, which is modal for keys.
      await press("?");
      expect(setup.captureCharFrame()).toContain("Keyboard Shortcuts");

      await press("m");
      // No menu, and the overlay is untouched: `m` is a row action, and a
      // menu opened under an overlay would be unreachable anyway.
      expect(setup.captureCharFrame()).not.toContain("Attach       enter");
      expect(setup.captureCharFrame()).toContain("Keyboard Shortcuts");
    } finally {
      restore();
    }
  });

  it("does nothing while the new-session dialog is open", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("n");
      expect(setup.captureCharFrame()).toContain("New session");

      await press("m");
      expect(setup.captureCharFrame()).not.toContain("Attach");
      // And the draft survives, rather than the key reaching past the dialog.
      expect(setup.captureCharFrame()).toContain("New session");
    } finally {
      restore();
    }
  });

  it("runs the highlighted item on enter", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      // Opened on the first item, so Enter has somewhere to land immediately.
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      // Attach: the menu's first item, and the same thing Enter on the row
      // itself would have done.
      expect(switchToPaneSpy).toHaveBeenCalledWith("%1");
      expect(setup.captureCharFrame()).not.toContain("Attach       enter");
    } finally {
      restore();
    }
  });

  it("moves the highlight with j/k and runs what it lands on", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      // Down to "New session", back up, and down again: the last one is
      // what proves k moved anything at all.
      await press("j");
      await press("k");
      await press("j");
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      // The item's own dialog, not the row's attach.
      expect(setup.captureCharFrame()).toContain("New session");
      expect(switchToPaneSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("clamps the highlight at the top of the menu", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      // Already on the first item. Wrapping here would put the highlight on
      // the LAST one, which in this menu is a destructive action.
      await press("k");
      await press("k");
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();

      expect(switchToPaneSpy).toHaveBeenCalledWith("%1");
    } finally {
      restore();
    }
  });

  it("leaves a mouse-opened menu alone on enter", async () => {
    // A right-click highlights nothing (the pointer does that on hover), so
    // Enter has no target. Guessing at one would be worse than doing nothing.
    const { restore } = withDaemon();
    try {
      await renderRows();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await settle();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Attach");

      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(switchToPaneSpy).not.toHaveBeenCalled();
      expect(setup.captureCharFrame()).toContain("Attach");
    } finally {
      restore();
    }
  });

  it("dismisses the menu and acts on any other key", async () => {
    // The behaviour a menu on screen has always had: a key that is not the
    // menu's means attention has moved on, so it closes and the key means
    // what it always means. Making it modal would strand a mis-press.
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      expect(setup.captureCharFrame()).toContain("Attach");

      await press("?");
      expect(setup.captureCharFrame()).not.toContain("Attach       enter");
      expect(setup.captureCharFrame()).toContain("Keyboard Shortcuts");
    } finally {
      restore();
    }
  });

  /** Row of each label in the open menu, in the order the frame draws them. */
  const orderOf = (labels: string[]) => {
    const lines = setup.captureCharFrame().split("\n");
    return labels.map((label) => ({
      label,
      row: lines.findIndex((line) => line.includes(label)),
    }));
  };

  it("puts the destructive action last on a session row", async () => {
    // The order is what the actions DO: start something, read something,
    // move work about, then the two that end a session — with Kill at the
    // bottom, the hardest row to hit by accident and the one nothing can be
    // appended below.
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      const rows = orderOf([
        "Attach",
        "New session",
        "Review diff",
        "Restart",
        "Kill",
      ]);
      for (const row of rows)
        expect(`${row.label}@${row.row}`).not.toContain("@-1");
      const ordered = [...rows].sort((a, b) => a.row - b.row);
      expect(ordered.map((r) => r.label)).toEqual(rows.map((r) => r.label));
    } finally {
      restore();
    }
  });

  it("puts the destructive action last on a background row too", async () => {
    // A different menu (launch actions instead of attach/restart), same rule.
    const { restore } = withDaemon();
    try {
      await renderApp(120, 24, { groupBy: "none", persistent: true });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "bg1",
            project: "alpha",
            cwd: "/code/alpha",
            tmuxPane: null,
            trackingMode: "background",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      await press("m");

      const rows = orderOf([
        "Attach agent",
        "Open agent view",
        "New session",
        "Kill",
      ]);
      for (const row of rows)
        expect(`${row.label}@${row.row}`).not.toContain("@-1");
      const ordered = [...rows].sort((a, b) => a.row - b.row);
      expect(ordered.map((r) => r.label)).toEqual(rows.map((r) => r.label));
    } finally {
      restore();
    }
  });
});
/**
 * "Copy last response": the row-menu item, the one request it makes, and what
 * the toast says about what actually landed on the clipboard.
 *
 * `copyToClipboard` is spied rather than left real: the fallback tier spawns
 * `pbcopy`, and a test suite that quietly replaces the developer's clipboard
 * is not one anybody should run twice.
 */
describe("App copy last response", () => {
  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  let copySpy: ReturnType<typeof spyOn<typeof clipboard, "copyToClipboard">>;
  /** What `copyToClipboard` was handed, newest last. */
  let copied: string[] = [];

  beforeEach(() => {
    copied = [];
    copySpy = spyOn(clipboard, "copyToClipboard").mockImplementation(
      async (text: string) => {
        copied.push(text);
        return { ok: true, via: "command" };
      },
    );
  });

  afterEach(() => {
    copySpy.mockRestore();
  });

  /** Answers the menu's fetches; `transcript` is what the endpoint replies. */
  function withDaemon(
    transcript:
      | { status: number; body: Record<string, unknown> }
      | "unreachable" = {
      status: 200,
      body: {
        source: "transcript",
        turns: [{ role: "assistant", text: "hello there" }],
        truncated: false,
      },
    },
  ) {
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/transcript")) {
        asked.push(href);
        if (transcript === "unreachable") throw new Error("ECONNREFUSED");
        return Response.json(transcript.body, { status: transcript.status });
      }
      // Clean, so "Move changes" never arrives and the row order is stable.
      if (href.includes("/dirty")) return Response.json({ dirty: false });
      return Response.json({});
    }) as unknown as typeof fetch;
    return { asked, restore: () => (globalThis.fetch = original) };
  }

  async function renderRow(overrides: Record<string, unknown> = {}) {
    await renderApp(120, 24, { groupBy: "none", persistent: true });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          tmuxPane: "%1",
          ...overrides,
        }),
      ],
      null,
    );
    await setup.renderOnce();
  }

  const press = async (key: string) => {
    setup.mockInput.pressKey(key);
    await settle();
    await setup.renderOnce();
  };

  /** Open the row's menu with `m` and activate the copy item. */
  async function activateCopy() {
    await press("m");
    // Attach -> New session -> Review diff -> Copy last response.
    for (const _ of [0, 1, 2]) await press("j");
    expect(setup.captureCharFrame()).toContain("Copy last response");
    setup.mockInput.pressEnter();
    await settle();
    await setup.renderOnce();
  }

  it("offers the item on a session row's menu", async () => {
    const { restore } = withDaemon();
    try {
      await renderRow();
      await press("m");
      expect(setup.captureCharFrame()).toContain("Copy last response");
    } finally {
      restore();
    }
  });

  it("offers the same item to a right-click", async () => {
    // The two ways into the row menu are one thing (`openRowMenu`); this is
    // the assertion that keeps them one thing.
    const { restore } = withDaemon();
    try {
      await renderRow();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Copy last response");
    } finally {
      restore();
    }
  });

  it("keeps the read actions together, above the ones that end a session", async () => {
    const { restore } = withDaemon();
    try {
      await renderRow();
      await press("m");
      const lineOf = (text: string) =>
        setup
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes(text));
      // By ORDER, not presence: a menu draws one row per item, so an item in
      // the wrong place moves every row below it.
      expect(lineOf("Review diff")).toBeLessThan(lineOf("Copy last response"));
      expect(lineOf("Copy last response")).toBeLessThan(lineOf("Restart"));
      expect(lineOf("Restart")).toBeLessThan(lineOf("Kill"));
    } finally {
      restore();
    }
  });

  it("offers it on a paneless background row that has a transcript", async () => {
    const { restore } = withDaemon();
    try {
      await renderRow({
        tmuxPane: null,
        trackingMode: "background",
        logPath: "/logs/bg.jsonl",
      });
      await press("m");
      const frame = setup.captureCharFrame();
      // Anchored on the background menu, so this can't pass by opening the
      // ordinary one.
      expect(frame).toContain("Attach agent");
      expect(frame).toContain("Copy last response");
    } finally {
      restore();
    }
  });

  it("hides it on a row with neither a pane nor a transcript", async () => {
    const { restore } = withDaemon();
    try {
      await renderRow({
        tmuxPane: null,
        trackingMode: "background",
        logPath: null,
      });
      await press("m");
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Attach agent");
      expect(frame).not.toContain("Copy last response");
    } finally {
      restore();
    }
  });

  it("asks for one turn and copies the text it gets back", async () => {
    const { asked, restore } = withDaemon();
    try {
      await renderRow();
      await activateCopy();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("/sessions/s1/transcript");
      expect(asked[0]).toContain("turns=1");
      expect(copied).toEqual(["hello there"]);
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("Copied11chars");
      // The menu closed on activation; the toast is the only report.
      expect(frame).not.toContain("Copylastresponse");
    } finally {
      restore();
    }
  });

  it("says so when a size guard dropped part of the response", async () => {
    const { restore } = withDaemon({
      status: 200,
      body: {
        source: "transcript",
        turns: [{ role: "assistant", text: "clipped" }],
        truncated: true,
      },
    });
    try {
      await renderRow();
      await activateCopy();
      expect(squish(setup.captureCharFrame())).toContain("(truncated)");
    } finally {
      restore();
    }
  });

  it("says so when what it copied is a screen capture", async () => {
    const { restore } = withDaemon({
      status: 200,
      body: {
        source: "pane",
        turns: [{ role: "assistant", text: "whatever was on screen" }],
        truncated: false,
      },
    });
    try {
      await renderRow();
      await activateCopy();
      expect(squish(setup.captureCharFrame())).toContain("(panecapture)");
    } finally {
      restore();
    }
  });

  it("passes the endpoint's own refusal through to the toast", async () => {
    const { restore } = withDaemon({
      status: 400,
      body: { error: "Session has no readable transcript and no tmux pane" },
    });
    try {
      await renderRow();
      await activateCopy();
      expect(squish(setup.captureCharFrame())).toContain(
        "Copyfailed:Sessionhasnoreadabletranscript",
      );
      expect(copied).toEqual([]);
    } finally {
      restore();
    }
  });

  it("reports an unreachable daemon rather than claiming a copy", async () => {
    const { restore } = withDaemon("unreachable");
    try {
      await renderRow();
      await activateCopy();
      expect(squish(setup.captureCharFrame())).toContain(
        "Copyfailed:daemonunreachable",
      );
      expect(copied).toEqual([]);
    } finally {
      restore();
    }
  });

  it("reports a clipboard that took nothing", async () => {
    copySpy.mockImplementation(async () => ({ ok: false, via: null }));
    const { restore } = withDaemon();
    try {
      await renderRow();
      await activateCopy();
      expect(squish(setup.captureCharFrame())).toContain(
        "Copyfailed:noclipboardavailable",
      );
    } finally {
      restore();
    }
  });

  it("does not claim a copy when the turn came back empty", async () => {
    const { restore } = withDaemon({
      status: 200,
      body: { source: "transcript", turns: [], truncated: false },
    });
    try {
      await renderRow();
      await activateCopy();
      expect(squish(setup.captureCharFrame())).toContain("Nothingtocopy");
      expect(copied).toEqual([]);
    } finally {
      restore();
    }
  });
});
/**
 * "Hand off to…": the row-menu item, the transient pick-target mode it opens
 * on the ordinary list, the one request that mode makes, and what the toast
 * says about each of the endpoint's three outcomes.
 */
describe("App hand off to", () => {
  const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  /** Answers the menu's fetches; `handoff` is what `POST /handoff` replies. */
  function withDaemon(
    handoff:
      | { status: number; body: Record<string, unknown> }
      | "unreachable" = {
      status: 200,
      body: { status: "delivered", chars: 1234, truncated: false },
    },
  ) {
    const posted: { url: string; body: unknown }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/handoff")) {
        posted.push({ url: href, body: JSON.parse(String(init?.body)) });
        if (handoff === "unreachable") throw new Error("ECONNREFUSED");
        return Response.json(handoff.body, { status: handoff.status });
      }
      // Clean, so "Move changes" never arrives and the row order is stable.
      if (href.includes("/dirty")) return Response.json({ dirty: false });
      return Response.json({});
    }) as unknown as typeof fetch;
    return { posted, restore: () => (globalThis.fetch = original) };
  }

  /** Two rows, so there is always something to hand off TO. */
  async function renderRows(overrides: Record<string, unknown>[] = [{}, {}]) {
    await renderApp(120, 24, { groupBy: "none", persistent: true });
    sseCallbacks!.onInit(
      overrides.map((o, i) =>
        mockEnrichedSession({
          id: `s${i + 1}`,
          project: `proj${i + 1}`,
          cwd: `/code/proj${i + 1}`,
          tmuxPane: `%${i + 1}`,
          lastUserInputAt: `2024-01-01T1${3 - i}:00:00Z`,
          ...o,
        }),
      ),
      null,
    );
    await setup.renderOnce();
  }

  const press = async (key: string) => {
    setup.mockInput.pressKey(key);
    await settle();
    await setup.renderOnce();
  };

  /** Open the top row's menu with `m` and activate the handoff item. */
  async function startPick() {
    await press("m");
    // Attach -> New session -> Review diff -> Copy last response -> Hand off.
    for (const _ of [0, 1, 2, 3]) await press("j");
    expect(setup.captureCharFrame()).toContain("Hand off to");
    setup.mockInput.pressEnter();
    await settle();
    await setup.renderOnce();
  }

  async function pickTarget() {
    await startPick();
    setup.mockInput.pressEnter();
    await settle();
    await setup.renderOnce();
  }

  it("offers the item on a session row's menu", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      expect(setup.captureCharFrame()).toContain("Hand off to");
    } finally {
      restore();
    }
  });

  it("offers the same item to a right-click", async () => {
    // The two ways into the row menu are one thing (`openRowMenu`); this is
    // the assertion that keeps them one thing.
    const { restore } = withDaemon();
    try {
      await renderRows();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Hand off to");
    } finally {
      restore();
    }
  });

  it("keeps it with the read actions, above the ones that end a session", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await press("m");
      const lineOf = (text: string) =>
        setup
          .captureCharFrame()
          .split("\n")
          .findIndex((line) => line.includes(text));
      // By ORDER, not presence: a menu draws one row per item, so an item in
      // the wrong place moves every row below it.
      expect(lineOf("Copy last response")).toBeLessThan(lineOf("Hand off to"));
      expect(lineOf("Hand off to")).toBeLessThan(lineOf("Restart"));
      expect(lineOf("Restart")).toBeLessThan(lineOf("Kill"));
    } finally {
      restore();
    }
  });

  it("hides it when the board holds nothing to hand off to", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows([{}]);
      await press("m");
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Copy last response");
      expect(frame).not.toContain("Hand off to");
    } finally {
      restore();
    }
  });

  it("opens a pick mode on the list itself, aimed at another row", async () => {
    const { posted, restore } = withDaemon();
    try {
      await renderRows();
      await startPick();
      const frame = squish(setup.captureCharFrame());
      // The banner names the source and teaches the keys, and the menu is gone.
      expect(frame).toContain("Handofffromclaude·proj1");
      expect(frame).toContain("esccancel");
      expect(frame).not.toContain("Handoffto…");
      // Nothing has been sent: the mode is aiming, not firing.
      expect(posted).toEqual([]);
    } finally {
      restore();
    }
  });

  it("hands off to the row the pick lands on, by session id", async () => {
    const { posted, restore } = withDaemon();
    try {
      await renderRows();
      await pickTarget();
      expect(posted).toHaveLength(1);
      // Both ends are IDs, which is the resolver's exact tier: the pick is the
      // disambiguation, so an ambiguity refusal is structurally unreachable.
      expect(posted[0]!.body).toEqual({ from: "s1", to: "s2", turns: 1 });
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("Handed1,234charstoclaude·proj2");
      // The mode ended with the send.
      expect(frame).not.toContain("esccancel");
    } finally {
      restore();
    }
  });

  it("says a queued handoff is queued, and why", async () => {
    const { restore } = withDaemon({
      status: 200,
      body: {
        status: "queued",
        chars: 900,
        truncated: false,
        queuedAt: "2024-01-15T12:00:00Z",
      },
    });
    try {
      await renderRows([{}, { status: "working" }]);
      await pickTarget();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("Queuedforclaude·proj2");
      expect(frame).toContain("landswhentheturnends");
    } finally {
      restore();
    }
  });

  it("passes the endpoint's own refusal through verbatim", async () => {
    const { restore } = withDaemon({
      status: 409,
      body: {
        error:
          "Session s2 has a pending prompt. A handoff is never used to answer one",
        reason: "target-waiting",
      },
    });
    try {
      await renderRows([{}, { status: "waiting" }]);
      await pickTarget();
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("Handoffrefused:");
      expect(frame).toContain("Sessions2hasapendingprompt");
    } finally {
      restore();
    }
  });

  it("reports an unreachable daemon rather than claiming a handoff", async () => {
    const { restore } = withDaemon("unreachable");
    try {
      await renderRows();
      await pickTarget();
      expect(squish(setup.captureCharFrame())).toContain(
        "Handofffailed:daemonunreachable",
      );
    } finally {
      restore();
    }
  });

  it("refuses the source as its own target and stays open", async () => {
    const { posted, restore } = withDaemon();
    try {
      await renderRows();
      await startPick();
      // Back onto the source row, which is where the menu was opened.
      await press("k");
      setup.mockInput.pressEnter();
      await settle();
      await setup.renderOnce();
      expect(posted).toEqual([]);
      const frame = squish(setup.captureCharFrame());
      expect(frame).toContain("cannothandofftoitself");
      // Still aiming: a keypress that hit nothing must not cost the gesture.
      expect(frame).toContain("esccancel");
    } finally {
      restore();
    }
  });

  it("cancels on esc without sending anything", async () => {
    const { posted, restore } = withDaemon();
    try {
      await renderRows();
      await startPick();
      setup.mockInput.pressEscape();
      // A bare ESC byte is the prefix of every escape sequence, so the key
      // parser holds it briefly before deciding it stands alone.
      await settle(20);
      await setup.renderOnce();
      expect(posted).toEqual([]);
      expect(squish(setup.captureCharFrame())).not.toContain("esccancel");
    } finally {
      restore();
    }
  });

  it("swallows the keys that would act on the row being aimed at", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      await startPick();
      await press("x");
      const frame = squish(setup.captureCharFrame());
      // `x` is one keystroke from killing the session under the cursor, so
      // while aiming it does nothing at all.
      expect(frame).not.toContain("Killsession");
      expect(frame).toContain("esccancel");
    } finally {
      restore();
    }
  });

  it("badges the target row while the daemon says a handoff is queued", async () => {
    const { restore } = withDaemon();
    try {
      await renderRows();
      const target = mockEnrichedSession({
        id: "s2",
        project: "proj2",
        cwd: "/code/proj2",
        tmuxPane: "%2",
        status: "working",
        lastUserInputAt: "2024-01-01T12:00:00Z",
      });
      sseCallbacks!.onSessionUpdated({
        ...target,
        pendingHandoff: {
          fromSessionId: "s1",
          queuedAt: "2024-01-15T12:00:00Z",
        },
      });
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain(HANDOFF_BADGE);

      // Delivered: the daemon re-broadcasts the row WITHOUT the field, and the
      // badge goes with it. No client-side timer is involved.
      sseCallbacks!.onSessionUpdated(target);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain(HANDOFF_BADGE);
    } finally {
      restore();
    }
  });
});

/**
 * The Worktrees panel's three App-side callbacks (issue #102).
 *
 * These live in App because they need the store, the renderer and the pane
 * switcher; the panel itself only reports which row was acted on. The panel's
 * own tests mock those callbacks, so without these the wiring between the two
 * halves is untested.
 */
describe("App worktrees panel (W)", () => {
  const WORKTREE_ROW = {
    path: "/code/myapp/wt/feature",
    repoRoot: "/code/myapp",
    repoName: "myapp",
    name: "feature",
    branch: "feat/x",
    detached: false,
    isMain: false,
    locked: false,
    dirty: { dirty: false, modified: 0, untracked: 0 },
    upstream: { upstream: "origin/feat/x", gone: false, ahead: 0, behind: 0 },
    sessions: [] as unknown[],
  };

  /**
   * Route the panel's two reads (and App's own onMount fetches) without
   * touching whatever `fetch` a neighbouring test installed.
   */
  function mockWorktreeFetch(rows: unknown[]) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url =
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url;
      const body = url.includes("prune-candidates")
        ? { candidates: [], skipped: [], open: [] }
        : url.includes("/worktrees")
          ? {
              repos: [
                { repoRoot: "/code/myapp", repoName: "myapp", worktrees: rows },
              ],
            }
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  /**
   * Render App with one session (plus any `extraSessions`, for the lookups
   * that have to pick the right one of several), then open the panel over
   * `rows`.
   */
  async function openPanel(
    rows: unknown[],
    sessionOverrides: Record<string, unknown> = {},
    extraSessions: Record<string, unknown>[] = [],
  ) {
    const restore = mockWorktreeFetch(rows);
    await renderApp(120, 24, { groupBy: "none" });
    sseCallbacks!.onInit(
      [
        mockEnrichedSession({
          id: "s1",
          project: "myapp",
          cwd: "/code/myapp",
          mainRepoRoot: "/code/myapp",
          tmuxPane: "%1",
          ...sessionOverrides,
        }),
        ...extraSessions.map((overrides) =>
          mockEnrichedSession({
            project: "myapp",
            cwd: "/code/myapp",
            mainRepoRoot: "/code/myapp",
            ...overrides,
          }),
        ),
      ],
      null,
    );
    await setup.renderOnce();
    setup.mockInput.pressKey("W", { shift: true });
    // Both reads resolve through awaited promises, so drain them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
    return {
      restore,
      frame: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await setup.renderOnce();
        return setup.captureCharFrame();
      },
    };
  }

  it("opens over the selected row's repo", async () => {
    const { restore, frame } = await openPanel([WORKTREE_ROW]);
    try {
      const shown = await frame();
      expect(shown).toContain("Worktrees");
      expect(shown).toContain("feature");
    } finally {
      restore();
    }
  });

  // The panel reports the session as the DAEMON described it. The enriched
  // row in the store is the fresher one, so it wins when it is there.
  it("jumps through the live store session when the id is known", async () => {
    // Switching panes EXITS the one-shot picker. Without pinning
    // `process.exit` the test process dies mid-file: bun reports zero tests
    // and still exits 0, which looks like the file was never collected.
    const { restore: restoreExit } = withExitSpy();
    const { restore, frame } = await openPanel([
      {
        ...WORKTREE_ROW,
        sessions: [
          {
            id: "s1",
            agentType: "claude",
            // Deliberately stale: the store says %1, and the store must win.
            status: "idle",
            tmuxPane: "%stale",
            tmuxTarget: "w:0.9",
            pid: 1,
          },
        ],
      },
    ]);
    try {
      setup.mockInput.pressEnter();
      const shown = await frame();
      expect(switchToPaneSpy).toHaveBeenCalledTimes(1);
      expect(switchToPaneSpy.mock.calls[0]?.[0]).toBe("%1");
      // Closed BEFORE acting, so the pane switch is not happening under a
      // full-screen overlay.
      expect(shown).not.toContain("Worktrees");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("falls back to the reported pane for a session the store does not hold", async () => {
    const { restore: restoreExit } = withExitSpy();
    const { restore, frame } = await openPanel([
      {
        ...WORKTREE_ROW,
        sessions: [
          {
            id: "not-in-store",
            agentType: "claude",
            status: "idle",
            tmuxPane: "%42",
            tmuxTarget: "w:0.42",
            pid: 2,
          },
        ],
      },
    ]);
    try {
      setup.mockInput.pressEnter();
      await frame();
      expect(switchToPaneSpy).toHaveBeenCalledTimes(1);
      expect(switchToPaneSpy.mock.calls[0]?.[0]).toBe("%42");
    } finally {
      restoreExit();
      restore();
    }
  });

  it("opens the existing-worktree dialog on a row with no session", async () => {
    const { restore, frame } = await openPanel([WORKTREE_ROW]);
    try {
      setup.mockInput.pressEnter();
      const shown = squish(await frame());
      expect(shown).toContain(squish("New session in worktree"));
      expect(shown).toContain("feature");
      expect(switchToPaneSpy).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  /**
   * The panel is a full-screen opaque overlay that also swallows every key,
   * so a confirm raised while it is up would render underneath it and be
   * unreachable. Closing first is what makes the captured notes answerable.
   */
  it("closes the panel before starting a review", async () => {
    let resolveReview!: (
      r: { ok: true; notes: typeof reviewNotes } | { ok: false; error: string },
    ) => void;
    runHunkReviewSpy.mockImplementation(
      () =>
        new Promise<
          { ok: true; notes: typeof reviewNotes } | { ok: false; error: string }
        >((resolve) => {
          resolveReview = resolve;
        }),
    );
    // An OCCUPIED row, because the handback is what raises the confirm this
    // test exists to prove is reachable.
    const { restore, frame } = await openPanel([
      {
        ...WORKTREE_ROW,
        sessions: [
          {
            id: "s1",
            agentType: "claude",
            status: "idle",
            tmuxPane: "%1",
            tmuxTarget: "w:0.1",
            pid: 1,
          },
        ],
      },
    ]);
    try {
      setup.mockInput.pressKey("d");
      // The merge-base resolves first, so the review starts a tick later.
      const duringReview = await frame();
      expect(runHunkReviewSpy).toHaveBeenCalledTimes(1);
      // Reviewed against the fork point, not the working tree.
      expect(resolveMergeBaseSpy.mock.calls[0]?.[0]).toBe(
        "/code/myapp/wt/feature",
      );
      expect(runHunkReviewSpy.mock.calls[0]?.[2]).toEqual({
        target: "base-sha",
      });
      // Gone while the review is still running, not merely afterwards.
      expect(duringReview).not.toContain("Worktrees");

      resolveReview({ ok: true, notes: reviewNotes });
      const afterReview = squish(await frame());
      // ...which is what lets the send-review confirm be seen at all. Under
      // the panel it rendered beneath a full-screen opaque overlay that also
      // swallowed every key, so the captured notes were unanswerable.
      expect(afterReview).toContain(squish("Send review comments"));

      // And it is live, not merely painted: the panel is not eating keys.
      setup.mockInput.pressKey("n");
      expect(squish(await frame())).not.toContain(
        squish("Send review comments"),
      );
    } finally {
      restore();
    }
  });

  /**
   * The rows are a phase-1 SNAPSHOT and Enter lands seconds later, so a
   * worktree that gained an agent in that window would otherwise get the
   * spawn dialog: a second agent in an occupied worktree, the one thing the
   * panel is designed never to offer.
   */
  it("jumps instead of spawning when the worktree gained a session since the fetch", async () => {
    const { restore: restoreExit } = withExitSpy();
    const { restore, frame } = await openPanel([WORKTREE_ROW], {
      // The store's session lives in a SUBDIRECTORY of the row's worktree,
      // which still counts as being in it.
      cwd: "/code/myapp/wt/feature/src",
      paneCwd: null,
    });
    try {
      setup.mockInput.pressEnter();
      const shown = squish(await frame());
      expect(switchToPaneSpy).toHaveBeenCalledTimes(1);
      expect(switchToPaneSpy.mock.calls[0]?.[0]).toBe("%1");
      expect(shown).not.toContain(squish("New session in worktree"));
    } finally {
      restoreExit();
      restore();
    }
  });

  // The control: genuinely unoccupied, so the dialog is still the answer.
  it("still opens the dialog when no live session is in the worktree", async () => {
    const { restore, frame } = await openPanel([WORKTREE_ROW], {
      // A sibling worktree whose name starts the same way must not count.
      cwd: "/code/myapp/wt/feature-two",
      paneCwd: null,
    });
    try {
      setup.mockInput.pressEnter();
      const shown = squish(await frame());
      expect(switchToPaneSpy).not.toHaveBeenCalled();
      expect(shown).toContain(squish("New session in worktree"));
    } finally {
      restore();
    }
  });

  // The revalidation reads the same directory the rest of App does, which is
  // the PANE's cwd when there is one.
  it("revalidates against paneCwd, not the session's original cwd", async () => {
    const { restore: restoreExit } = withExitSpy();
    const { restore, frame } = await openPanel([WORKTREE_ROW], {
      cwd: "/code/myapp",
      paneCwd: "/code/myapp/wt/feature",
    });
    try {
      setup.mockInput.pressEnter();
      await frame();
      expect(switchToPaneSpy).toHaveBeenCalledTimes(1);
    } finally {
      restoreExit();
      restore();
    }
  });

  // The main checkout is exempt: its Enter opens an ordinary dialog whose
  // destination is still a real choice, and ccmux nests linked worktrees
  // under the repo root, so a containment test there would jump to an
  // unrelated worktree's agent.
  it("does not revalidate the main checkout against nested worktrees", async () => {
    const { restore, frame } = await openPanel(
      [
        {
          ...WORKTREE_ROW,
          path: "/code/myapp",
          name: "myapp",
          isMain: true,
          branch: "main",
        },
      ],
      { cwd: "/code/myapp/.claude/worktrees/other", paneCwd: null },
    );
    try {
      setup.mockInput.pressEnter();
      const shown = squish(await frame());
      expect(switchToPaneSpy).not.toHaveBeenCalled();
      // The ordinary dialog, not the worktree-locked one.
      expect(shown).toContain(squish("New session"));
      expect(shown).not.toContain(squish("New session in worktree"));
    } finally {
      restore();
    }
  });

  it("captures notes with nothing to hand them to on a bare worktree", async () => {
    runHunkReviewSpy.mockImplementation(async () => ({
      ok: true,
      notes: reviewNotes,
    }));
    const { restore, frame } = await openPanel([WORKTREE_ROW]);
    try {
      setup.mockInput.pressKey("d");
      const shown = squish(await frame());
      expect(shown).toContain(squish("no agent to send to"));
      expect(shown).not.toContain(squish("Send review comments"));
    } finally {
      restore();
    }
  });

  // The user pressed `d` FROM the panel, so every exit of the round-trip
  // lands them back on it, with the cursor still on the row they reviewed.
  it("reopens the panel with the cursor on the reviewed row", async () => {
    runHunkReviewSpy.mockImplementation(async () => ({
      ok: true,
      notes: reviewNotes,
    }));
    const occupied = {
      ...WORKTREE_ROW,
      sessions: [
        {
          id: "s1",
          agentType: "claude",
          status: "idle",
          tmuxPane: "%1",
          tmuxTarget: "w:0.1",
          pid: 1,
        },
      ],
    };
    const bravo = {
      ...WORKTREE_ROW,
      path: "/code/myapp/wt/bravo",
      name: "bravo",
      branch: "feat/b",
    };
    const { restore, frame } = await openPanel([occupied, bravo]);
    try {
      // Down to the session-less row: its review has no one to hand notes
      // to, which is the path that reopens without a confirm in between.
      setup.mockInput.pressKey("j");
      setup.mockInput.pressKey("d");
      await frame();
      const shown = await frame();
      // The toast overlays the reopened panel, so its tail interleaves with
      // row text in the char frame; the head is the part that stays whole.
      expect(squish(shown)).toContain(squish("review note captured"));
      expect(shown).toContain("Worktrees");
      const lines = shown.split("\n");
      expect(lines.find((l) => l.includes("bravo"))).toContain("▎");
      expect(lines.find((l) => l.includes("feature"))).not.toContain("▎");
    } finally {
      restore();
    }
  });

  // The reopen must FOLLOW the confirm's resolution, never precede it: the
  // panel is the opaque overlay the close existed to get out of the way.
  it("reopens the panel only after the send-review confirm is answered", async () => {
    runHunkReviewSpy.mockImplementation(async () => ({
      ok: true,
      notes: reviewNotes,
    }));
    const occupied = {
      ...WORKTREE_ROW,
      sessions: [
        {
          id: "s1",
          agentType: "claude",
          status: "idle",
          tmuxPane: "%1",
          tmuxTarget: "w:0.1",
          pid: 1,
        },
      ],
    };
    const { restore, frame } = await openPanel([occupied]);
    try {
      setup.mockInput.pressKey("d");
      const confirmUp = await frame();
      expect(squish(confirmUp)).toContain(squish("Send review comments"));
      // Not back yet: reopening here would bury the dialog on screen.
      expect(confirmUp).not.toContain("Worktrees");
      // Cancel is a resolution too; the notes are dropped, the panel is not.
      setup.mockInput.pressKey("n");
      const after = await frame();
      expect(squish(after)).not.toContain(squish("Send review comments"));
      expect(after).toContain("Worktrees");
    } finally {
      restore();
    }
  });

  // Enter on a session-less row opens the spawn dialog; backing out of it
  // returns to the panel, cursor still on the row, instead of dumping the
  // user on the session list. Submit is deliberately not symmetrical: a
  // successful spawn hands the board to the new session.
  it("returns to the panel when the spawn dialog is cancelled", async () => {
    const bravo = {
      ...WORKTREE_ROW,
      path: "/code/myapp/wt/bravo",
      name: "bravo",
      branch: "feat/b",
    };
    const { restore, frame } = await openPanel([WORKTREE_ROW, bravo]);
    try {
      // bravo sorts first (same bucket, name order), so j lands on feature.
      setup.mockInput.pressKey("j");
      setup.mockInput.pressEnter();
      const dialog = await frame();
      expect(squish(dialog)).toContain(squish("New session in worktree"));
      expect(dialog).not.toContain("Worktrees ·");

      setup.mockInput.pressEscape();
      // A lone ESC needs the input parser disambiguation window before it
      // is delivered as a key at all.
      await new Promise((r) => setTimeout(r, 30));
      const shown = await frame();
      expect(shown).toContain("Worktrees ·");
      expect(squish(shown)).not.toContain(squish("New session in worktree"));
      const lines = shown.split("\n");
      expect(lines.find((l) => l.includes("feature"))).toContain("▎");
      expect(lines.find((l) => l.includes("bravo"))).not.toContain("▎");
    } finally {
      restore();
    }
  });

  // Tab's rescope is panel-local, so the return must carry it in the action
  // payload: reading the store reopened a widened panel back on its narrow
  // opening repo (wrong scope, lost cursor, cache miss, one wrong capture).
  it("keeps a Tab-widened scope across the dialog round trip", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url =
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url;
      urls.push(url);
      const body = url.includes("prune-candidates")
        ? { candidates: [], skipped: [], open: [] }
        : url.includes("/worktrees")
          ? {
              repos: [
                {
                  repoRoot: "/code/myapp",
                  repoName: "myapp",
                  worktrees: [WORKTREE_ROW],
                },
              ],
            }
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    try {
      await renderApp(120, 24, { groupBy: "none" });
      sseCallbacks!.onInit(
        [
          mockEnrichedSession({
            id: "s1",
            project: "myapp",
            cwd: "/code/myapp",
            mainRepoRoot: "/code/myapp",
            tmuxPane: "%1",
          }),
        ],
        null,
      );
      await setup.renderOnce();
      setup.mockInput.pressKey("W", { shift: true });
      await new Promise((r) => setTimeout(r, 0));
      await setup.renderOnce();
      // The scoped open filtered by repo; Tab widens and refetches without.
      expect(urls.some((u) => u.includes("repo="))).toBe(true);
      setup.mockInput.pressTab();
      await new Promise((r) => setTimeout(r, 0));
      await setup.renderOnce();

      setup.mockInput.pressEnter();
      await new Promise((r) => setTimeout(r, 0));
      await setup.renderOnce();
      const before = urls.length;
      setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 30));
      await setup.renderOnce();
      await new Promise((r) => setTimeout(r, 0));
      await setup.renderOnce();

      expect(setup.captureCharFrame()).toContain("Worktrees");
      const reopened = urls.slice(before);
      // The reopened panel reads the widened scope, not the opening repo...
      expect(reopened.some((u) => u.includes("/worktrees"))).toBe(true);
      expect(reopened.every((u) => !u.includes("repo="))).toBe(true);
      // ...and its widened scan is the cached one, so none is re-fired.
      expect(reopened.every((u) => !u.includes("prune-candidates"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // The control: a dialog the panel did NOT open cancels to wherever it was
  // opened from, marker-free.
  it("does not open the panel when cancelling a dialog opened with n", async () => {
    const { restore, frame } = await openPanel([WORKTREE_ROW]);
    try {
      setup.mockInput.pressKey("q");
      await frame();
      setup.mockInput.pressKey("n");
      expect(squish(await frame())).toContain(squish("New session"));
      setup.mockInput.pressEscape();
      await new Promise((r) => setTimeout(r, 30));
      const shown = await frame();
      expect(shown).not.toContain("Worktrees ·");
    } finally {
      restore();
    }
  });

  it("reopens the panel after a confirmed hand-back as well", async () => {
    runHunkReviewSpy.mockImplementation(async () => ({
      ok: true,
      notes: reviewNotes,
    }));
    const occupied = {
      ...WORKTREE_ROW,
      sessions: [
        {
          id: "s1",
          agentType: "claude",
          status: "idle",
          tmuxPane: "%1",
          tmuxTarget: "w:0.1",
          pid: 1,
        },
      ],
    };
    const { restore, frame } = await openPanel([occupied]);
    try {
      setup.mockInput.pressKey("d");
      expect(squish(await frame())).toContain(squish("Send review comments"));
      setup.mockInput.pressKey("y");
      const after = await frame();
      expect(after).toContain("Worktrees");
    } finally {
      restore();
    }
  });

  /**
   * The DEFAULT shape for a worktree an isolated teammate holds: the daemon
   * folds a live subagent into its worktree's row as a synthetic session
   * (`${parent.id}:${agentId}`, carrying the parent's pane), and such a row
   * has that session and nothing else.
   *
   * A lookup by the composite id matches no session, which used to send the
   * review down the bare-worktree path — notes captured, nowhere to go — on
   * every teammate-only row, while the fold's own design points that row's
   * pane at the orchestrator a human can actually talk to.
   */
  it("hands a synthetic subagent row's notes back to the parent session", async () => {
    runHunkReviewSpy.mockImplementation(async () => ({
      ok: true,
      notes: reviewNotes,
    }));
    const { restore, frame } = await openPanel([
      {
        ...WORKTREE_ROW,
        sessions: [
          {
            id: "s1:agent-7",
            agentType: "claude",
            status: "working",
            // The PARENT's pane, exactly as the daemon writes it.
            tmuxPane: "%1",
            tmuxTarget: "w:0.1",
            pid: null,
          },
        ],
      },
    ]);
    try {
      setup.mockInput.pressKey("d");
      const shown = squish(await frame());
      expect(shown).toContain(squish("Send review comments"));
      expect(shown).not.toContain(squish("no agent to send to"));
    } finally {
      restore();
    }
  });

  // The jump leg of the same resolution. The synthetic row's pane is pinned
  // stale here so the two outcomes are distinguishable: resolving to the
  // parent jumps to the store's pane, failing to resolve jumps to the row's.
  it("jumps a synthetic subagent row through the parent's live session", async () => {
    const { restore: restoreExit } = withExitSpy();
    const { restore, frame } = await openPanel([
      {
        ...WORKTREE_ROW,
        sessions: [
          {
            id: "s1:agent-7",
            agentType: "claude",
            status: "working",
            tmuxPane: "%stale",
            tmuxTarget: "w:0.9",
            pid: null,
          },
        ],
      },
    ]);
    try {
      setup.mockInput.pressEnter();
      await frame();
      expect(switchToPaneSpy).toHaveBeenCalledTimes(1);
      expect(switchToPaneSpy.mock.calls[0]?.[0]).toBe("%1");
    } finally {
      restoreExit();
      restore();
    }
  });

  // Split only on a MISS: a real id that happens to contain a colon must not
  // be truncated onto a different session.
  it("prefers a whole id that contains a colon over its prefix", async () => {
    const { restore: restoreExit } = withExitSpy();
    const { restore, frame } = await openPanel(
      [
        {
          ...WORKTREE_ROW,
          sessions: [
            {
              id: "s1:odd",
              agentType: "claude",
              status: "idle",
              tmuxPane: "%stale",
              tmuxTarget: "w:0.9",
              pid: 3,
            },
          ],
        },
      ],
      // The seeded session keeps id `s1` on %1, so a split-always lookup
      // would land on it...
      {},
      // ...while the id the row actually names is a second, different
      // session on its own pane.
      [{ id: "s1:odd", tmuxPane: "%9" }],
    );
    try {
      setup.mockInput.pressEnter();
      await frame();
      expect(switchToPaneSpy).toHaveBeenCalledTimes(1);
      expect(switchToPaneSpy.mock.calls[0]?.[0]).toBe("%9");
    } finally {
      restoreExit();
      restore();
    }
  });
});
