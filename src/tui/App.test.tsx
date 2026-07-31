import { describe, it, expect, afterEach, mock, beforeEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { MouseButtons } from "@opentui/core/testing";
import type { SSECallbacks } from "./utils/sse";
import { mockEnrichedSession, squish } from "./components/test-helpers";
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

  it("forks the selected session beside its own pane", async () => {
    const { bodies, restore } = captureSpawn();
    try {
      await renderWithSession();
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
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
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
      expect(switchToPaneSpy).toHaveBeenCalledWith("%99");
      expect(exitSpy).toHaveBeenCalled();
    } finally {
      restoreExit();
      restore();
    }
  });

  it("drops a second press while a fork is in flight", async () => {
    // One conversation, one fork: a double press must not open two panes.
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
      await setup.renderOnce();
      setup.mockInput.pressKey("F");
      await setup.renderOnce();
      expect(bodies).toHaveLength(1);
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
      setup.mockInput.pressKey("F");
      await settle();
      await setup.renderOnce();
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

  it("forks from the context menu item", async () => {
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
      expect(frame).toContain("> 2 Codex");
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
      expect(setup.captureCharFrame()).toContain("> 2 Codex");
    } finally {
      restore();
    }
  });

  it("snaps to a real agent when the row's agent isn't spawnable here", async () => {
    const { restore } = withDaemon();
    try {
      // `gemini` was detected by pane scanning but is not on PATH.
      await openDialog({}, [session({ agentType: "gemini" })]);
      expect(setup.captureCharFrame()).toContain("> 1 Claude");
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
      expect(setup.captureCharFrame()).toContain("> 2 Codex");
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
      expect(setup.captureCharFrame()).toContain("> 1 Claude");
      setup.mockInput.pressKey("j");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("> 2 Codex");
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
      expect(setup.captureCharFrame()).toContain("[Split right]");
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
      expect(setup.captureCharFrame()).toContain("[Split down]");
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
      expect(setup.captureCharFrame()).toContain("1 Claude");
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
      expect(setup.captureCharFrame()).toContain("Codex");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("offers New session here on a session row's context menu", async () => {
    const { restore } = withDaemon();
    try {
      await renderApp(120, 24, { groupBy: "none" });
      sseCallbacks!.onInit([session()], null);
      await setup.renderOnce();
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("New session here");
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
      expect(frame).not.toContain("New session here");
      expect(frame).not.toContain("Attach");
    } finally {
      restore();
    }
  });

  /** Right-click the group header on row 1 and click its "New session here"
   *  item, located by label so a menu reshuffle can't fire a different
   *  action. Returns the frame with the dialog open. */
  async function openGroupMenuNewSession(): Promise<string> {
    await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
    await setup.renderOnce();
    const menuRow = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("New session here"));
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
      expect(frame).toContain("Directory /code/work/api/src");
      expect(frame).not.toContain("Directory /code/oss/api");
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
      expect(setup.captureCharFrame()).toContain("Directory ~/dotfiles-notes");
    } finally {
      restore();
    }
  });

  it("offers New session here on a group header's context menu", async () => {
    const { restore } = withDaemon();
    try {
      await renderApp(120, 24, { groupBy: "project" });
      sseCallbacks!.onInit([session()], null);
      await setup.renderOnce();
      // Row 1 is the group header under the default grouping.
      await setup.mockMouse.click(5, 1, MouseButtons.RIGHT);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("New session here");
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
    // "Review diff" matters most: it is the only row BELOW where an
    // out-of-place item would be inserted, so leaving it out would make the
    // no-shift assertion blind to the exact regression it guards.
    const labels = [
      "Attach",
      "New session",
      "Kill",
      "Restart",
      "Review diff",
      "Move changes",
    ];
    return setup
      .captureCharFrame()
      .split("\n")
      .flatMap((line, row) => {
        const label = labels.find((l) => line.includes(l));
        return label ? [{ label, row }] : [];
      });
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

  it("does not move any row already on screen when the item lands", async () => {
    // THE invariant, and the reason the item is appended last. The answer
    // arrives after the menu is drawn, so an item inserted anywhere else
    // would shove the rows below it down under a cursor mid-travel. Asserts
    // POSITIONS rather than timing, so it outlives whatever the latency is.
    //
    // The answer is held open deliberately: a mock that resolves immediately
    // settles during the render await, so the "before" frame would already
    // contain the item and the test would prove nothing.
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
      await openMenuOnRow();
      const before = menuRows();
      expect(before.length).toBeGreaterThan(2);
      expect(before.some((r) => r.label === "Move changes")).toBe(false);

      release({ ok: true, json: async () => ({ dirty: true }) } as Response);
      await settle();
      await setup.renderOnce();
      const after = menuRows();
      expect(after.some((r) => r.label === "Move changes")).toBe(true);

      // Every row that existed before is still at exactly the same y.
      for (const row of before) {
        const moved = after.find((r) => r.label === row.label);
        expect(`${row.label}@${moved?.row}`).toBe(`${row.label}@${row.row}`);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("never gates one row's menu with another row's answer", async () => {
    // A slow answer for a dismissed menu must not resurrect the item
    // somewhere else.
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
        expect(frame).toContain("[Move]");
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
        expect(setup.captureCharFrame()).toContain("[Leave here]");

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
