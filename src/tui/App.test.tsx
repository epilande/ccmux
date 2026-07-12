import { describe, it, expect, afterEach, mock, beforeEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { MouseButtons } from "@opentui/core/testing";
import type { SSECallbacks } from "./utils/sse";
import { mockEnrichedSession, squish } from "./components/test-helpers";

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

mock.module("../lib/startup-timing", () => ({
  markStartup: () => {},
  reportStartup: () => {},
  getStartupMarks: () => [],
  resetStartupMarks: () => {},
}));

const { App } = await import("./App");
const { setDaemonSocketPath } = await import("./utils/server-guard");

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
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      json: async () => ({
        selectedSessionId: null,
        selectedHeaderKey: null,
      }),
    })) as unknown as typeof fetch;
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
      // Let the hydration fetch promise resolve before we probe selection.
      await new Promise((r) => setTimeout(r, 10));
      await setup.renderOnce();

      setup.mockInput.pressKey("x");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Kill Session?");
      expect(frame).toContain("beta");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sidebar hydration with non-null state overrides active-pane default", async () => {
    const originalFetch = globalThis.fetch;
    // Daemon reports another instance has selected s1 (alpha). That should win
    // over our active-pane default of s2 (beta).
    globalThis.fetch = (async () => ({
      json: async () => ({
        selectedSessionId: "s1",
        selectedHeaderKey: null,
      }),
    })) as unknown as typeof fetch;
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
      // Let the hydration fetch promise resolve so its applySidebarSelection runs.
      await new Promise((r) => setTimeout(r, 10));
      await setup.renderOnce();

      setup.mockInput.pressKey("x");
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Kill Session?");
      expect(frame).toContain("alpha");
    } finally {
      globalThis.fetch = originalFetch;
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

  // Stub process.exit so a one-shot picker's exit is observable, not fatal.
  function withExitSpy() {
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;
    return { exitSpy, restore: () => (process.exit = originalExit) };
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
