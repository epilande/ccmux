import { watch } from "fs";
import {
  batch,
  on,
  onMount,
  onCleanup,
  Show,
  createSignal,
  createEffect,
  createMemo,
} from "solid-js";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import type { KeyEvent, MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import type { EnrichedSession } from "../types/session";
import { createTUIStore, TickContext } from "./store";
import { killActionPath, restartActionPath } from "./utils/invoke-actions";
import {
  formatReviewPrompt,
  HUNK_INSTALL_HINT,
  isHunkAvailable,
  runHunkReview,
  type HunkReviewNote,
} from "./utils/review";
import { SSEClient } from "./utils/sse";
import {
  switchToPane,
  sendKeys,
  flashPane,
  flashPaneDetached,
  isPaneInCurrentWindow,
  notifyActivePane,
  openAgentsWindow,
  openAgentAttachWindow,
  type OpenAgentsResult,
} from "./utils/tmux";
import { isSameServerCached, setDaemonSocketPath } from "./utils/server-guard";
import { getDaemonUrl, STATE_FILE } from "../lib/config";
import { getUIState } from "../lib/state";
import {
  PERF_ENABLED,
  trackInterval,
  untrackInterval,
  startPerfReporter,
  stopPerfReporter,
} from "./utils/perf";
import { Header } from "./components/Header";
import { Footer } from "./components/Footer";
import { SessionList } from "./components/SessionList";
import { SearchInput } from "./components/SearchInput";
import { Preview } from "./components/Preview";
import { Toast } from "./components/Toast";
import { GroupPreview } from "./components/GroupPreview";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { HelpOverlay } from "./components/HelpOverlay";
import { theme } from "./theme";
import type { IconStyle } from "../lib/icons";
import type {
  ColumnsConfig,
  BreakpointConfig,
  PromptDisplay,
  Preferences,
} from "../lib/preferences";
import type { FlatItem, GroupBy } from "./utils/grouping";
import {
  createSidebarWidthPersister,
  WIDTH_SETTLE_MS,
} from "./utils/sidebar-width";
import { markStartup, reportStartup } from "../lib/startup-timing";

interface AppProps {
  initialPreview?: boolean;
  iconStyle?: IconStyle;
  previewWidth?: number;
  columns?: ColumnsConfig;
  breakpoints?: BreakpointConfig;
  searchPaneContent?: boolean;
  searchPaneLines?: number;
  searchTranscript?: boolean;
  groupBy?: GroupBy;
  collapsedGroups?: string[];
  pinnedGroups?: string[];
  hideIdle?: boolean;
  promptDisplay?: PromptDisplay;
  persistent?: boolean;
  sidebar?: boolean;
  reviewHandback?: Preferences["reviewHandback"];
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  // Probed once at launch (cheap `which`, no need to react to hunk being
  // installed mid-session): gates the footer hint and help row. `d` itself
  // re-probes live so a hunk installed after launch works without restart.
  const hunkAtLaunch = isHunkAvailable();
  // Both operands are fixed for the component's lifetime, so this is a plain
  // constant, not a reactive accessor.
  const reviewEnabled = !props.sidebar && hunkAtLaunch;
  const store = createTUIStore({
    initialPreview: props.initialPreview,
    iconStyle: props.iconStyle,
    previewWidth: props.previewWidth,
    columns: props.columns,
    breakpoints: props.breakpoints,
    searchPaneContent: props.searchPaneContent,
    searchPaneLines: props.searchPaneLines,
    searchTranscript: props.searchTranscript,
    groupBy: props.groupBy,
    collapsedGroups: props.collapsedGroups,
    pinnedGroups: props.pinnedGroups,
    hideIdle: props.hideIdle,
    promptDisplay: props.promptDisplay,
    sidebar: props.sidebar,
  });
  markStartup("store_created");

  /** Guard a tmux-targeting action: toast and return false when the pane is on
   *  a different server, so we refuse rather than hit the wrong pane. Reads the
   *  verdict cached in utils/server-guard.ts, shared with the read-only
   *  consumers (preview capture, search pane cache, sidebar flash). */
  function ensureSameServer(): boolean {
    if (isSameServerCached()) return true;
    store.actions.showToast("Target pane is on a different tmux server");
    return false;
  }

  /** (Re)learn the daemon's tmux socket, on every SSE (re)connect: a daemon
   *  restarted onto a different socket would otherwise leave the guard comparing
   *  a stale one. Fail-open until it resolves. */
  function refreshServerInfo(): void {
    fetch(`${getDaemonUrl()}/server-info`)
      .then((r) => r.json() as Promise<{ socketPath: string | null }>)
      .then((d) => {
        setDaemonSocketPath(d.socketPath ?? null);
      })
      .catch(() => {});
  }

  function selectPane(pane: string) {
    if (!ensureSameServer()) return;
    notifyActivePane(pane);
    if (props.persistent || props.sidebar) {
      flashPane(pane);
    } else {
      flashPaneDetached(pane);
    }
    switchToPane(pane).then((ok) => {
      if (!ok) {
        // Pane is gone (daemon holds the stale row until its liveness sweep).
        // Surface it instead of exiting the one-shot picker as if it worked.
        store.actions.showToast("Failed to switch: pane is gone");
        return;
      }
      if (!props.persistent && !props.sidebar) process.exit(0);
    });
  }

  function activateItem(item: FlatItem) {
    if (item.type === "header") {
      store.actions.toggleGroupCollapse(item.groupKey);
      return;
    }
    const session = item.filteredSession.session;
    if (session.tmuxPane) {
      store.actions.setActiveSessionId(session.id);
      selectPane(session.tmuxPane);
      return;
    }
    // Paneless background (background-agent) rows: attach to THAT agent
    // (`claude attach`, the place a blocked agent can be answered); the
    // context menu also offers the global agent view. ccmux stays read-only
    // on Claude's state.
    if (session.trackingMode === "background") {
      attachBackgroundAgent(session);
    }
  }

  function attachBackgroundAgent(session: { id: string; cwd: string }) {
    launchBackgroundWindow("Attach", () =>
      openAgentAttachWindow(session.id, session.cwd),
    );
  }

  /** Drops re-activations while a launch is pending: a rapid double-Enter
   * would otherwise race two list-then-spawn sequences past the window-name
   * dedupe and open two windows. */
  let backgroundLaunchInFlight = false;

  /**
   * Shared exit semantics for the background launchers (per-agent attach and
   * the global agent view). Mirrors selectPane: the picker exits after
   * switching, the sidebar/persistent board stays. On failure, stay and
   * surface a toast.
   */
  function launchBackgroundWindow(
    label: string,
    launch: () => Promise<OpenAgentsResult>,
  ) {
    if (backgroundLaunchInFlight) return;
    backgroundLaunchInFlight = true;
    launch().then((result) => {
      backgroundLaunchInFlight = false;
      if (!result.ok) {
        store.actions.showToast(`${label} failed: ${result.error}`);
        return;
      }
      if (!props.persistent && !props.sidebar) process.exit(0);
    });
  }

  /** Drops re-activations while a review is pending: a rapid double-`d` would
   * otherwise race two suspend/spawn/resume cycles against the same renderer. */
  let reviewInFlight = false;
  let pendingReviewNotes: {
    sessionId: string;
    notes: HunkReviewNote[];
  } | null = null;

  const pendingReviewNoteCount = () => pendingReviewNotes?.notes.length ?? 0;

  async function deliverReviewNotes(
    sessionId: string,
    notes: HunkReviewNote[],
    mode: "auto" | "confirm" | "fill",
  ) {
    const session = store.state.sessions.find((item) => item.id === sessionId);
    const agent = session?.agentType ?? "agent";
    try {
      const response = await fetch(
        `${getDaemonUrl()}/sessions/${sessionId}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: formatReviewPrompt(notes),
            enter: mode !== "fill",
          }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Re-capture the preview so the delivered prompt is visible in the
      // agent's pane; an unfocused preview never polls, so without this the
      // only feedback would be the transient toast. Bump twice: the paste has
      // landed when /send resolves, but the agent's TUI paints it a beat
      // later, so an immediate-only capture usually still shows the empty
      // composer (observed live with Claude Code).
      setPreviewRefreshKey((key) => key + 1);
      setTimeout(() => setPreviewRefreshKey((key) => key + 1), 500);
      if (mode === "fill") {
        store.actions.showToast(
          `Prompt filled in ${agent}'s composer, press Enter to jump`,
          3_000,
        );
      } else {
        store.actions.showToast(
          `Sent ${notes.length} comment${notes.length === 1 ? "" : "s"} to ${agent}`,
        );
      }
    } catch {
      store.actions.showToast(`Failed to send review comments to ${agent}`);
    }
  }

  function reviewSession(session: EnrichedSession) {
    if (reviewInFlight) return;
    const cwd = session.paneCwd ?? session.cwd;
    if (!cwd) {
      store.actions.showToast("Review failed: no working directory");
      return;
    }
    // Re-probe live (not the launch-time `hunkAtLaunch`) so a hunk installed
    // after the picker started works without a restart.
    if (!isHunkAvailable()) {
      store.actions.showToast(HUNK_INSTALL_HINT);
      return;
    }
    reviewInFlight = true;
    runHunkReview(renderer, cwd)
      .then((result) => {
        reviewInFlight = false;
        if (!result.ok) {
          store.actions.showToast(`Review failed: ${result.error}`);
          return;
        }
        if (result.notes.length === 0) return;
        if (session.trackingMode === "background" || session.tmuxPane == null) {
          store.actions.showToast(
            `${result.notes.length} review note${result.notes.length === 1 ? "" : "s"} captured (no pane to send to)`,
          );
          return;
        }
        // Only an explicit auto/fill skips the dialog; every other value
        // (undefined, or an unvalidated config typo like "Fill") falls through
        // to confirm rather than silently auto-submitting to the agent.
        if (
          props.reviewHandback === "auto" ||
          props.reviewHandback === "fill"
        ) {
          void deliverReviewNotes(
            session.id,
            result.notes,
            props.reviewHandback,
          );
        } else {
          pendingReviewNotes = { sessionId: session.id, notes: result.notes };
          store.actions.showConfirmDialog(session.id, "send-review");
        }
      })
      .catch(() => {
        // runHunkReview resolves on every expected failure; this guards an
        // unexpected reject (e.g. resume() throwing in its finally) so a stuck
        // reviewInFlight flag can't disable `d` for the rest of the session.
        reviewInFlight = false;
        store.actions.showToast("Review failed");
      });
  }

  function handleRowActivate(item: FlatItem, index: number) {
    if (
      store.state.showHelp ||
      store.state.confirmMode ||
      store.state.previewFocused
    ) {
      return;
    }
    if (store.state.contextMenu || store.state.groupContextMenu) {
      store.actions.hideContextMenu();
      store.actions.hideGroupContextMenu();
      return;
    }
    store.actions.setSelectedIndex(index);
    activateItem(item);
  }

  function handleRowContextMenu(
    item: FlatItem,
    index: number,
    event: MouseEvent,
  ) {
    if (
      store.state.showHelp ||
      store.state.confirmMode ||
      store.state.previewFocused
    ) {
      return;
    }
    store.actions.setSelectedIndex(index);
    if (item.type === "session") {
      store.actions.showContextMenu(
        item.filteredSession.session.id,
        event.x,
        event.y,
      );
    } else {
      store.actions.showGroupContextMenu(item.groupKey, event.x, event.y);
    }
  }

  function contextMenuAttach() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (session?.tmuxPane) {
      store.actions.setActiveSessionId(session.id);
      selectPane(session.tmuxPane);
    }
  }

  function contextMenuConfirm(action: "kill" | "restart") {
    const cm = store.state.contextMenu;
    if (!cm) return;
    store.actions.hideContextMenu();
    store.actions.showConfirmDialog(cm.sessionId, action);
  }

  function groupContextMenuPin(edge: "top" | "bottom") {
    const cm = store.state.groupContextMenu;
    if (!cm) return;
    store.actions.hideGroupContextMenu();
    store.actions.moveGroupToEdge(cm.groupKey, edge);
  }

  function groupContextMenuKill() {
    const cm = store.state.groupContextMenu;
    if (!cm) return;
    const ids = store.selectedGroupSessions().map((s) => s.id);
    store.actions.hideGroupContextMenu();
    if (ids.length > 0) {
      store.actions.showConfirmDialog(null, "kill-group", ids);
    }
  }

  function groupContextMenuToggleCollapse() {
    const cm = store.state.groupContextMenu;
    if (!cm) return;
    store.actions.hideGroupContextMenu();
    store.actions.toggleGroupCollapse(cm.groupKey);
  }

  function contextMenuAttachAgent() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (session?.trackingMode === "background") {
      attachBackgroundAgent(session);
    }
  }

  function contextMenuOpenAgentView() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (session?.trackingMode === "background") {
      launchBackgroundWindow("Agent view", () => openAgentsWindow(session.cwd));
    }
  }

  function contextMenuReview() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (session) reviewSession(session);
  }

  function sessionMenuItems(): ContextMenuItem[] {
    // Paneless read-only background rows get the launch actions (per-agent
    // attach + the global agent view); Kill/Restart are pane-session
    // concepts that do not apply.
    const cm = store.state.contextMenu;
    const session = cm
      ? store.state.sessions.find((s) => s.id === cm.sessionId)
      : undefined;
    const reviewItem: ContextMenuItem[] = reviewEnabled
      ? [
          {
            label: "Review diff",
            hint: "d",
            color: theme.text,
            action: contextMenuReview,
          },
        ]
      : [];
    if (session?.trackingMode === "background") {
      return [
        {
          label: "Attach agent",
          hint: "enter",
          color: theme.green,
          action: contextMenuAttachAgent,
        },
        {
          label: "Open agent view",
          hint: "",
          color: theme.text,
          action: contextMenuOpenAgentView,
        },
        ...reviewItem,
      ];
    }
    return [
      {
        label: "Attach",
        hint: "enter",
        color: theme.green,
        action: contextMenuAttach,
      },
      {
        label: "Kill",
        hint: "x",
        color: theme.red,
        action: () => contextMenuConfirm("kill"),
      },
      {
        label: "Restart",
        hint: "r",
        color: theme.peach,
        action: () => contextMenuConfirm("restart"),
      },
      ...reviewItem,
    ];
  }

  function groupMenuItems(): ContextMenuItem[] {
    const cm = store.state.groupContextMenu;
    const isCollapsed = cm ? store.collapsedGroups().has(cm.groupKey) : false;
    return [
      {
        label: isCollapsed ? "Expand" : "Collapse",
        hint: "space",
        color: theme.text,
        action: groupContextMenuToggleCollapse,
      },
      {
        label: "Pin to Top",
        hint: "<",
        color: theme.blue,
        action: () => groupContextMenuPin("top"),
      },
      {
        label: "Pin to Bottom",
        hint: ">",
        color: theme.blue,
        action: () => groupContextMenuPin("bottom"),
      },
      {
        label: "Kill Group",
        hint: "X",
        color: theme.red,
        action: groupContextMenuKill,
      },
    ];
  }

  /** Kill a normal session, but cancel an invoke-driven row cleanly
   *  (see killActionPath). */
  function killOrCancelSession(id: string) {
    const session = store.state.sessions.find((s) => s.id === id);
    if (!session) {
      fetch(`${getDaemonUrl()}/sessions/${id}/kill`, { method: "POST" });
      return;
    }
    fetch(`${getDaemonUrl()}${killActionPath(session)}`, { method: "POST" });
  }

  function confirmDialogAction() {
    const action = store.state.confirmAction;
    const sessionId = store.state.confirmSessionId;
    if (action === "send-review" && sessionId) {
      const pending = pendingReviewNotes;
      pendingReviewNotes = null;
      if (pending?.sessionId === sessionId) {
        void deliverReviewNotes(sessionId, pending.notes, "confirm");
      }
    } else if (action === "kill-all") {
      // The daemon reaps in-flight invoke workers itself (it owns the
      // authoritative in-flight set); the client only needs to ask once.
      fetch(`${getDaemonUrl()}/sessions/kill-all`, { method: "POST" });
    } else if (action === "kill-group") {
      for (const id of store.state.confirmSessionIds) {
        killOrCancelSession(id);
      }
    } else if (action === "restart" && sessionId) {
      const session = store.state.sessions.find((s) => s.id === sessionId);
      // A one-shot invoke has no meaningful restart; cancel it instead.
      const path = session
        ? restartActionPath(session)
        : `/sessions/${sessionId}/restart`;
      fetch(`${getDaemonUrl()}${path}`, { method: "POST" });
    } else if (sessionId) {
      killOrCancelSession(sessionId);
    }
    store.actions.hideConfirmDialog();
  }

  let sseClient: SSEClient | null = null;
  let previewScrollbox: ScrollBoxRenderable | undefined;
  let helpScrollbox: ScrollBoxRenderable | undefined;
  const [previewRefreshKey, setPreviewRefreshKey] = createSignal(0);
  const [initialDataReceived, setInitialDataReceived] = createSignal(false);

  onMount(() => {
    sseClient = new SSEClient({
      onInit: (sessions, activePaneId, invocations) => {
        markStartup("first_data");
        reportStartup();
        store.actions.setSessions(sessions);
        if (activePaneId) {
          store.actions.setActivePaneId(activePaneId);
          const active = sessions.find((s) => s.tmuxPane === activePaneId);
          if (active) {
            store.actions.setActiveSessionId(active.id);
            store.actions.setSelectedSessionId(active.id);
          }
        }
        setInitialDataReceived(true);
        // Reconcile invoke state against the daemon's init snapshot on every
        // (re)connect. SSE has no replay, so an `invocation_finished` missed
        // while the socket was down would otherwise strand the synthetic row
        // and inflate the in-flight count. Driven synchronously from `init`
        // (not a separate fetch) so it lands strictly before any later
        // `invocation_started`, leaving no window to prune a fresh worker.
        store.actions.reconcileInvocations(invocations ?? []);
      },
      onSessionCreated: (session) => {
        store.actions.addSession(session);
      },
      onSessionUpdated: (session) => {
        store.actions.updateSession(session);
      },
      onSessionRemoved: (sessionId) => {
        store.actions.removeSession(sessionId);
      },
      onInvocationStarted: (event) => {
        store.actions.startInvocation(event);
      },
      onInvocationFinished: (event) => {
        store.actions.finishInvocation(event);
      },
      onConnectionStateChange: (state) => {
        batch(() => {
          store.actions.setConnectionState(state);
          if (state === "connected") {
            store.actions.setError(null);
          }
        });
        // A reconnect can mean the daemon restarted onto a different server.
        if (state === "connected") refreshServerInfo();
      },
      onActivePane: (sessionId, paneId) => {
        store.actions.setActivePaneId(paneId);
        store.actions.setActiveSessionId(sessionId);
      },
      onSidebarState: (selectedSessionId, selectedHeaderKey, version) => {
        // Ignore echo-back of our own broadcasts (stale version)
        if (!store.isSidebarVersionNewer(version)) return;
        store.actions.applySidebarSelection(
          selectedSessionId,
          selectedHeaderKey,
        );
      },
      onError: (error) => {
        store.actions.setError(error);
      },
    });

    sseClient.connect();
    markStartup("sse_connected");

    // Learn the daemon's tmux server up front (also refreshed on SSE reconnect).
    refreshServerInfo();

    // Hydrate sidebar selection from daemon so new instances sync with existing ones.
    // Skip if the daemon has nothing to share so we don't clobber the active-pane default.
    if (props.sidebar) {
      fetch(`${getDaemonUrl()}/sidebar-state`)
        .then((r) => r.json() as Promise<Record<string, unknown>>)
        .then((data) => {
          const sessionId =
            typeof data.selectedSessionId === "string"
              ? data.selectedSessionId
              : null;
          const headerKey =
            typeof data.selectedHeaderKey === "string"
              ? data.selectedHeaderKey
              : null;
          if (sessionId === null && headerKey === null) return;
          store.actions.applySidebarSelection(sessionId, headerKey);
        })
        .catch(() => {});
    }
  });

  // Sidebar: flash selected pane if it's visible in the current window.
  // Debounced to avoid spawning tmux processes on every rapid j/k keypress.
  // Tracks only the pane ID (not the full session object) so SSE session
  // data updates don't re-trigger the flash.
  if (props.sidebar) {
    let flashDebounce: Timer | null = null;
    const selectedPaneId = createMemo(() => {
      const id = store.state.selectedSessionId;
      if (!id) return null;
      return store.state.sessions.find((s) => s.id === id)?.tmuxPane ?? null;
    });
    createEffect(() => {
      const pane = selectedPaneId();
      if (!pane) return;
      if (flashDebounce) clearTimeout(flashDebounce);
      flashDebounce = setTimeout(() => {
        flashDebounce = null;
        // Cross-server `%N` collision: this pane id belongs to the daemon's
        // server, so "visible here" would be a different pane. Skip silently;
        // a toast per j/k keypress would spam.
        if (!isSameServerCached()) return;
        isPaneInCurrentWindow(pane).then((visible) => {
          if (visible) flashPane(pane);
        });
      }, 80);
    });
    onCleanup(() => {
      if (flashDebounce) clearTimeout(flashDebounce);
    });
  }

  // Sidebar: persist a manually dragged pane width as the new sidebar.width
  // preference and propagate it to every other sidebar. Width changes settle
  // through a debounce; the persister itself tells user drags apart from
  // window resizes (which the window-resized hook re-pins).
  if (props.sidebar) {
    const dims = useTerminalDimensions();
    const persistWidth = createSidebarWidthPersister();
    let widthSettleTimer: Timer | null = null;
    createEffect(
      on(
        () => dims().width,
        (width) => {
          if (widthSettleTimer) clearTimeout(widthSettleTimer);
          widthSettleTimer = setTimeout(() => {
            widthSettleTimer = null;
            persistWidth(width);
          }, WIDTH_SETTLE_MS);
        },
        { defer: true },
      ),
    );
    onCleanup(() => {
      if (widthSettleTimer) clearTimeout(widthSettleTimer);
    });
  }

  // Sync state across TUI instances (sidebar reads state.json changes made by picker)
  if (props.sidebar) {
    onMount(() => {
      let disposed = false;
      let stateWatchDebounce: Timer | null = null;
      try {
        const watcher = watch(STATE_FILE, { persistent: false }, () => {
          if (stateWatchDebounce) clearTimeout(stateWatchDebounce);
          stateWatchDebounce = setTimeout(async () => {
            const freshState = await getUIState();
            if (!disposed) store.actions.reloadUIState(freshState);
          }, 200);
        });
        onCleanup(() => {
          disposed = true;
          watcher.close();
          if (stateWatchDebounce) clearTimeout(stateWatchDebounce);
        });
      } catch {
        // state.json may not exist yet; watcher will be set up on next launch
      }
    });
  }

  // Adaptive tick: 1s when any session has a timestamp under 60s (seconds display),
  // 10s otherwise (minutes display only changes every 60s).
  // Re-evaluates the interval on each tick rather than on every session change.
  let currentTickMs = 1000;
  let tickTimerId: Timer;

  function onTick() {
    store.bumpTick();

    const now = Date.now();
    const needsFastTick = store.state.sessions.some((s) => {
      const ts = s.lastUserInputAt ?? s.lastActivityAt;
      return ts && now - Date.parse(ts) < 60_000;
    });
    const desiredMs = needsFastTick ? 1000 : 10_000;

    if (desiredMs !== currentTickMs) {
      currentTickMs = desiredMs;
      untrackInterval(tickTimerId);
      tickTimerId = trackInterval(onTick, currentTickMs);
    }
  }

  tickTimerId = trackInterval(onTick, currentTickMs);

  // Performance metrics (only when CCMUX_PERF=1)
  if (PERF_ENABLED) {
    startPerfReporter(renderer);
  }

  onCleanup(() => {
    sseClient?.disconnect();
    if (tickTimerId) untrackInterval(tickTimerId);
    stopPerfReporter();
  });

  const getSessionById = (id: string) => {
    return store.state.sessions.find((s) => s.id === id) || null;
  };

  /** Extract group context from the selected item for group move operations */
  const getGroupMoveContext = (item: FlatItem | null) => {
    if (!item?.groupKey) return null;
    return {
      groupKey: item.groupKey,
      sessionId:
        item.type === "session" ? item.filteredSession.session.id : undefined,
    };
  };

  let pendingG = false;
  let pendingZ = false;

  useKeyboard((event: KeyEvent) => {
    const key = event.name;

    if (store.state.showHelp) {
      if (key === "?" || key === "q" || key === "escape") {
        store.actions.hideHelp();
        event.preventDefault();
        return;
      }
      if (helpScrollbox && (key === "j" || key === "k")) {
        const delta = key === "j" ? 1 : -1;
        helpScrollbox.scrollTo(helpScrollbox.scrollTop + delta);
      }
      event.preventDefault();
      return;
    }

    if (store.state.confirmMode) {
      if (key === "y" || key === "Y" || key === "return" || key === "enter") {
        confirmDialogAction();
        event.preventDefault();
        return;
      }
      if (key === "n" || key === "N" || key === "escape") {
        pendingReviewNotes = null;
        store.actions.hideConfirmDialog();
        event.preventDefault();
        return;
      }
      event.preventDefault();
      return;
    }

    if (store.state.contextMenu || store.state.groupContextMenu) {
      store.actions.hideContextMenu();
      store.actions.hideGroupContextMenu();
      if (key === "escape") {
        event.preventDefault();
        return;
      }
    }

    if (store.state.searchMode) {
      if (key === "n" && event.ctrl) {
        store.actions.moveSelection(1);
        event.preventDefault();
        return;
      }
      if (key === "p" && event.ctrl) {
        store.actions.moveSelection(-1);
        event.preventDefault();
        return;
      }
      if (key === "escape") {
        store.actions.exitSearchMode();
        event.preventDefault();
        return;
      }
      if (key === "return" || key === "enter") {
        const session = store.selectedSession();
        if (session?.tmuxPane) {
          selectPane(session.tmuxPane);
        }
        event.preventDefault();
        return;
      }
      return;
    }

    // Preview focus mode: forward keys to tmux pane
    if (store.state.previewFocused) {
      if (key === "tab" || key === "escape") {
        store.actions.exitPreviewFocus();
      } else if (event.ctrl && (key === "n" || key === "p")) {
        store.actions.moveSelection(key === "n" ? 1 : -1);
      } else if (event.meta && (key === "h" || key === "l")) {
        store.actions.resizePreview(key === "h" ? 5 : -5);
      } else if (
        event.ctrl &&
        (key === "d" || key === "u") &&
        previewScrollbox
      ) {
        const halfPage = Math.floor(
          (previewScrollbox.viewport?.height ?? 10) / 2,
        );
        const delta = key === "d" ? halfPage : -halfPage;
        previewScrollbox.scrollTo(previewScrollbox.scrollTop + delta);
      } else {
        const session = store.selectedSession();
        if (session?.tmuxPane && ensureSameServer()) {
          sendKeys(session.tmuxPane, event);
          setPreviewRefreshKey((k) => k + 1);
        }
      }
      event.preventDefault();
      return;
    }

    // Clear pending g/z on any non-matching key
    if (key !== "g" && pendingG) {
      pendingG = false;
    }
    if (pendingZ) {
      pendingZ = false;
      if (key === "m" && store.state.groupBy !== "none") {
        store.actions.collapseAll();
        event.preventDefault();
        return;
      }
      if (key === "r" && store.state.groupBy !== "none") {
        store.actions.expandAll();
        event.preventDefault();
        return;
      }
    }

    switch (key) {
      case "J":
      case "j":
      case "down":
        if ((key === "J" || event.shift) && key !== "down") {
          const ctx = getGroupMoveContext(store.selectedFlatItem());
          if (ctx) store.actions.moveGroupDown(ctx.groupKey, ctx.sessionId);
        } else {
          store.actions.moveSelection(1);
        }
        event.preventDefault();
        break;

      case "K":
      case "k":
      case "up":
        if ((key === "K" || event.shift) && key !== "up") {
          const ctx = getGroupMoveContext(store.selectedFlatItem());
          if (ctx) store.actions.moveGroupUp(ctx.groupKey, ctx.sessionId);
        } else {
          store.actions.moveSelection(-1);
        }
        event.preventDefault();
        break;

      case "<": {
        const ctx = getGroupMoveContext(store.selectedFlatItem());
        if (ctx)
          store.actions.moveGroupToEdge(ctx.groupKey, "top", ctx.sessionId);
        event.preventDefault();
        break;
      }

      case ">": {
        const ctx = getGroupMoveContext(store.selectedFlatItem());
        if (ctx)
          store.actions.moveGroupToEdge(ctx.groupKey, "bottom", ctx.sessionId);
        event.preventDefault();
        break;
      }

      case "n":
        if (event.ctrl) {
          store.actions.moveSelection(1);
          event.preventDefault();
        }
        break;

      case "G":
      case "g":
        if (key === "G" || event.shift) {
          store.actions.setSelectedIndex(store.flatItems().length - 1);
          pendingG = false;
        } else if (pendingG) {
          store.actions.setSelectedIndex(0);
          pendingG = false;
        } else {
          pendingG = true;
        }
        event.preventDefault();
        break;

      case "return":
      case "enter": {
        const item = store.selectedFlatItem();
        if (item) activateItem(item);
        event.preventDefault();
        break;
      }

      case "space":
      case " ": {
        const item = store.selectedFlatItem();
        if (item?.type === "header") {
          store.actions.toggleGroupCollapse(item.groupKey);
        }
        event.preventDefault();
        break;
      }

      case "X":
      case "x":
        if (key === "X" || event.shift) {
          if (store.filteredSessions().length > 0) {
            store.actions.showConfirmDialog(null, "kill-all");
          }
        } else {
          const sessionToKill = store.selectedSession();
          if (sessionToKill) {
            store.actions.showConfirmDialog(sessionToKill.id, "kill");
          } else if (store.selectedGroupHeader()) {
            const ids = store.selectedGroupSessions().map((s) => s.id);
            store.actions.showConfirmDialog(null, "kill-group", ids);
          }
        }
        event.preventDefault();
        break;

      case "/":
        store.actions.enterSearchMode();
        event.preventDefault();
        break;

      case "R":
      case "r":
        if (key === "R" || event.shift) {
          sseClient?.disconnect();
          sseClient?.connect();
        } else {
          const sessionToRestart = store.selectedSession();
          if (sessionToRestart) {
            store.actions.showConfirmDialog(sessionToRestart.id, "restart");
          }
        }
        event.preventDefault();
        break;

      case "P":
      case "p":
        if (event.ctrl) {
          store.actions.moveSelection(-1);
          event.preventDefault();
        } else if (key === "P" || event.shift) {
          store.actions.togglePreview();
          event.preventDefault();
        } else {
          store.actions.cyclePrompt();
          event.preventDefault();
        }
        break;

      case "f":
        store.actions.toggleHideIdle();
        event.preventDefault();
        break;

      case "b":
        store.actions.cycleGroupBy();
        event.preventDefault();
        break;

      case "d":
      case "u":
        if (event.ctrl && previewScrollbox && store.state.showPreview) {
          const halfPage = Math.floor(
            (previewScrollbox.viewport?.height ?? 10) / 2,
          );
          const delta = key === "d" ? halfPage : -halfPage;
          previewScrollbox.scrollTo(previewScrollbox.scrollTop + delta);
          event.preventDefault();
        } else if (key === "d" && !event.ctrl && !props.sidebar) {
          const session = store.selectedSession();
          if (session) reviewSession(session);
          event.preventDefault();
        }
        break;

      case "tab":
        if (
          store.state.showPreview &&
          !store.selectedGroupHeader() &&
          store.selectedSession()?.tmuxPane
        ) {
          store.actions.enterPreviewFocus();
          event.preventDefault();
        }
        break;

      case "h":
        if (event.meta && store.state.showPreview) {
          store.actions.resizePreview(5);
          event.preventDefault();
        } else if (!event.meta && store.state.groupBy !== "none") {
          // Collapse: on a session, collapse parent group; on a header, collapse it
          const item = store.selectedFlatItem();
          if (item?.type === "session") {
            store.actions.collapseParent();
          } else if (item?.type === "header" && !item.collapsed) {
            store.actions.toggleGroupCollapse(item.groupKey);
          }
          event.preventDefault();
        }
        break;

      case "l":
        if (event.meta && store.state.showPreview) {
          store.actions.resizePreview(-5);
          event.preventDefault();
        } else if (!event.meta && store.state.groupBy !== "none") {
          // Expand: on a collapsed header, expand it; on expanded header, move to first child
          const item = store.selectedFlatItem();
          if (item?.type === "header") {
            if (item.collapsed) {
              store.actions.expandGroup(item.groupKey);
            } else {
              // Move to first child session
              store.actions.moveSelection(1);
            }
          }
          event.preventDefault();
        }
        break;

      case "-":
        if (store.state.groupBy !== "none") {
          store.actions.collapseAll();
          event.preventDefault();
        }
        break;

      case "=":
        if (store.state.groupBy !== "none") {
          store.actions.expandAll();
          event.preventDefault();
        }
        break;

      case "z":
        pendingZ = true;
        event.preventDefault();
        break;

      case "?":
        store.actions.toggleHelp();
        event.preventDefault();
        break;

      case "q":
      case "escape":
        if (key === "escape" && props.sidebar) break;
        if (props.sidebar) {
          const selfPane = process.env.TMUX_PANE;
          if (selfPane) {
            Bun.spawn(["tmux", "kill-pane", "-t", selfPane]);
          }
        }
        process.exit(0);

      default:
        if (key >= "1" && key <= "9") {
          const idx = parseInt(key) - 1;
          const sessions = store
            .flatItems()
            .filter((i) => i.type === "session");
          if (idx < sessions.length) {
            const target = sessions[idx];
            if (
              target.type === "session" &&
              target.filteredSession.session.tmuxPane
            ) {
              selectPane(target.filteredSession.session.tmuxPane);
            }
          }
          event.preventDefault();
        }
        break;
    }
  });

  return (
    <TickContext.Provider
      value={{
        tick: store.tick,
      }}
    >
      <box flexDirection="column" width="100%" height="100%">
        <Header
          sessionCount={store.filteredSessions().length}
          totalCount={
            store.state.hideIdle ||
            (store.state.searchMode && store.state.searchQuery)
              ? store.sortedSessions().length
              : undefined
          }
          hideIdle={store.state.hideIdle}
          connectionState={store.state.connectionState}
          dimmed={store.state.previewFocused}
          invokeInFlight={store.invocationInFlightCount()}
        />

        <Show when={store.state.searchMode}>
          <SearchInput
            value={store.state.searchQuery}
            onChange={(value) => store.actions.setSearchQuery(value)}
            onSubmit={() => {
              const session = store.selectedSession();
              if (session?.tmuxPane) {
                selectPane(session.tmuxPane);
              }
            }}
          />
        </Show>

        <Show when={store.state.error}>
          <box paddingLeft={1} height={1}>
            <text fg={theme.red}>Error: {store.state.error}</text>
          </box>
        </Show>

        <box flexDirection="row" flexGrow={1}>
          <SessionList
            items={store.flatItems()}
            selectedIndex={store.selectedIndex()}
            iconStyle={store.state.iconStyle}
            showPreview={store.state.showPreview}
            previewWidth={store.state.previewWidth}
            activePaneId={store.state.activePaneId}
            activeSessionId={store.state.activeSessionId}
            columns={store.state.columns}
            breakpoints={store.state.breakpoints}
            dimmed={store.state.previewFocused}
            sidebar={props.sidebar}
            promptDisplay={store.state.promptDisplay}
            loading={!initialDataReceived()}
            onActivate={handleRowActivate}
            onContextMenu={handleRowContextMenu}
          />
          <Show when={!props.sidebar && store.state.showPreview}>
            <Show
              when={store.selectedGroupHeader()}
              fallback={
                <Preview
                  session={store.selectedSession()}
                  onScrollboxRef={(ref) => (previewScrollbox = ref)}
                  iconStyle={store.state.iconStyle}
                  width={store.state.previewWidth}
                  focused={store.state.previewFocused}
                  refreshKey={previewRefreshKey()}
                  searchQuery={
                    store.state.searchMode ? store.state.searchQuery : undefined
                  }
                />
              }
            >
              {(header: () => Extract<FlatItem, { type: "header" }>) => (
                <GroupPreview
                  header={header()}
                  sessions={store.selectedGroupSessions()}
                  onScrollboxRef={(ref) => (previewScrollbox = ref)}
                  iconStyle={store.state.iconStyle}
                  width={store.state.previewWidth}
                />
              )}
            </Show>
          </Show>
        </box>

        <Show when={!props.sidebar}>
          <Footer
            searchMode={store.state.searchMode}
            confirmMode={store.state.confirmMode}
            helpMode={store.state.showHelp}
            previewFocused={store.state.previewFocused}
            persistent={props.persistent}
            groupBy={store.state.groupBy}
            reviewable={reviewEnabled}
          />
        </Show>

        <Show when={store.state.showHelp}>
          <HelpOverlay
            sidebar={props.sidebar}
            reviewable={reviewEnabled}
            onScrollboxRef={(ref) => (helpScrollbox = ref)}
          />
        </Show>

        <Show when={store.state.confirmMode}>
          <ConfirmationDialog
            session={getSessionById(store.state.confirmSessionId || "")}
            action={store.state.confirmAction}
            sessionCount={
              store.state.confirmAction === "send-review"
                ? pendingReviewNoteCount()
                : store.state.confirmAction === "kill-group"
                  ? store.state.confirmSessionIds.length
                  : store.filteredSessions().length
            }
            groupLabel={store.selectedGroupHeader()?.label}
            onConfirm={confirmDialogAction}
            onCancel={() => {
              pendingReviewNotes = null;
              store.actions.hideConfirmDialog();
            }}
          />
        </Show>

        <Show when={store.state.contextMenu}>
          {(cm: () => NonNullable<typeof store.state.contextMenu>) => (
            <ContextMenu
              x={cm().x}
              y={cm().y}
              items={sessionMenuItems()}
              onClose={store.actions.hideContextMenu}
            />
          )}
        </Show>

        <Show when={store.state.groupContextMenu}>
          {(cm: () => NonNullable<typeof store.state.groupContextMenu>) => (
            <ContextMenu
              x={cm().x}
              y={cm().y}
              items={groupMenuItems()}
              onClose={store.actions.hideGroupContextMenu}
            />
          )}
        </Show>

        {/* Transient feedback, rendered in every mode: the one-shot and persistent
            pickers need the switch-failure toast too, not just the sidebar. The
            pill paints above every other overlay via its own zIndex. */}
        <Show when={store.state.toastMessage}>
          <Toast message={store.state.toastMessage!} />
        </Show>
      </box>
    </TickContext.Provider>
  );
}
