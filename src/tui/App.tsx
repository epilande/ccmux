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
  untrack,
} from "solid-js";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import type { KeyEvent, MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import type { EnrichedSession } from "../types/session";
import { createTUIStore, TickContext, type NewSessionPlacement } from "./store";
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
  notifyActivePane,
  openAgentsWindow,
  openAgentAttachWindow,
  resolveLaunchPane,
  type OpenAgentsResult,
} from "./utils/tmux";
import { isSameServerCached, setDaemonSocketPath } from "./utils/server-guard";
import { getDaemonUrl, resolvedHomeDir, STATE_FILE } from "../lib/config";
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
import {
  NewSessionDialog,
  DESTINATION_OPTIONS,
  PLACEMENT_OPTIONS,
  UNTRACKED_OPTIONS,
} from "./components/NewSessionDialog";
import { slugFromPrompt } from "../daemon/worktree-create";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { PruneDialog } from "./components/PruneDialog";
import { HelpOverlay } from "./components/HelpOverlay";
import type { SpawnableAgent } from "../lib/spawnable-agents";
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
import { createWindowVisibility } from "./utils/window-visibility";
import { createFlashScheduler } from "./utils/pane-flash";
import { createIdleGcScheduler } from "./utils/idle-gc";
import { setSpinnerPaused } from "./utils/useStatusIcon";
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
  lastSpawnAgent?: string;
  reviewHandback?: Preferences["reviewHandback"];
  /**
   * Agents that declare a `forkCommand` (see `forkableAgentNames`). Gates the
   * Fork action, which is otherwise hidden rather than offered-then-refused.
   */
  forkableAgents?: string[];
}

/** Message text for a rejected fetch/parse, for a toast. */
function errText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** The directory a session stands for: its pane's cwd when the daemon has
 *  one, since that follows the agent as it cds, else where it started. */
function sessionCwd(session: EnrichedSession): string {
  return session.paneCwd ?? session.cwd;
}

/** Shown when the daemon predates `GET /agents`. Exported for the test that
 *  pins the wording to the restart the fix actually needs. */
export const STALE_DAEMON_HINT =
  "Daemon is out of date - run `ccmux daemon restart`";

/** Groupings whose header stands for one directory, so a new session opened
 *  over it can inherit that directory. `session` and `window` group by tmux
 *  location, which says nothing about where their members live. */
const GROUPINGS_BY_DIRECTORY = new Set<GroupBy>(["project", "cwd"]);

/** `POST /spawn`'s `split` for each placement: a new window is no split. */
const SPAWN_SPLIT: Record<NewSessionPlacement, "h" | "v" | false> = {
  window: false,
  "split-h": "h",
  "split-v": "v",
};

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
    lastSpawnAgent: props.lastSpawnAgent,
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
    const cwd = sessionCwd(session);
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

  /**
   * Whether this row can be forked.
   *
   * Two conditions are about knowing WHAT to continue: the agent has to
   * declare how it forks, and ccmux has to know which conversation the pane
   * holds — a pane-tracked row with no hooks installed has an agent but no
   * session id.
   *
   * Background rows are excluded even though they satisfy both. They are
   * created with `agentType: "claude"` and a `nativeSessionId` (see
   * `createBackgroundSession` and the background source), so without this
   * they would qualify — but they are PANELESS, which makes "fork into a
   * pane beside the original" meaningless: the fork would land in an
   * unrelated new window. `sessionMenuItems` already returns early for them,
   * so the key would otherwise do something the menu deliberately refuses.
   */
  function canForkSession(
    session:
      | {
          agentType: string;
          nativeSessionId?: string;
          trackingMode?: string;
        }
      | undefined,
  ): boolean {
    if (!session?.nativeSessionId) return false;
    if (session.trackingMode === "background") return false;
    return (props.forkableAgents ?? []).includes(session.agentType);
  }

  /**
   * Why this row can't be forked, for the key path. The menu hides the item
   * instead, but a keybinding has no way to hide itself and the help overlay
   * advertises `F` on every row, so silence reads as a broken key.
   */
  function forkRefusalReason(session: {
    agentType: string;
    nativeSessionId?: string;
    trackingMode?: string;
  }): string {
    if (session.trackingMode === "background") {
      return "Fork: background agents have no pane to fork beside";
    }
    if (!session.nativeSessionId) {
      // Same reason the daemon gives, which the client gate would otherwise
      // never let the user see.
      return `Fork: ccmux doesn't know which conversation this pane holds. Install hooks with 'ccmux setup'.`;
    }
    return `Fork: ${session.agentType} has no verified fork command`;
  }

  /** Drops re-activations while a fork is pending, so a double press can't
   * open two panes off one conversation. */
  let forkInFlight = false;

  /** Ceiling on a fork request. Without one, a daemon that accepts the
   * connection and never answers latches `forkInFlight` for the rest of the
   * picker's life, and `F` silently stops working. */
  const FORK_TIMEOUT_MS = 15_000;

  /**
   * Fork a session into a pane beside its own: same agent, same directory,
   * conversation continued from the source's history, original untouched.
   *
   * The picker only chooses the DESTINATION here (`split` + `target` /
   * `callerPane`); how to continue the conversation is the daemon's
   * `forkCommand` template. No cwd is sent, which the daemon reads as "the
   * source's directory" — a product choice (a fork sits beside its original),
   * not a constraint: the daemon accepts an explicit cwd for a fork.
   */
  async function forkSession(session: EnrichedSession) {
    if (!canForkSession(session)) return;
    if (forkInFlight) {
      // Say so rather than dropping it silently, which is indistinguishable
      // from a dead key.
      store.actions.showToast("Fork already in progress");
      return;
    }
    forkInFlight = true;
    try {
      // Beside the source when it has a pane to sit beside. Otherwise a new
      // window in the CALLER's session: sending no placement at all leaves
      // the daemon running a bare `new-window`, and since the daemon has no
      // client, tmux picks its own MRU session — so the window lands
      // somewhere unrelated and the jump below then drags the user there.
      const target = session.tmuxPane ?? undefined;
      const callerPane = target ? undefined : await resolveSpawnPane();
      const response = await fetch(`${getDaemonUrl()}/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fork: session.id,
          split: target ? "h" : false,
          target,
          callerPane: callerPane ?? undefined,
          // The jump below is this component's own exit path (it flashes the
          // pane and closes a one-shot picker); letting the daemon switch too
          // would race it.
          detach: true,
        }),
        signal: AbortSignal.timeout(FORK_TIMEOUT_MS),
      });
      const data = (await response.json().catch(() => null)) as {
        paneId?: string;
        error?: string;
      } | null;
      if (!response.ok || !data?.paneId) {
        store.actions.showToast(
          `Fork failed: ${data?.error ?? response.statusText}`,
        );
        return;
      }
      selectPane(data.paneId);
    } catch (err: unknown) {
      store.actions.showToast(`Fork failed: ${errText(err)}`);
    } finally {
      // In `finally`, not on each exit path: a throw between the guard and
      // the response (an aborted fetch, a rejected json parse) used to leave
      // the latch set forever.
      forkInFlight = false;
    }
  }

  /**
   * Whether an overlay currently owns the screen.
   *
   * The keyboard handler returns early for each of these before it reaches
   * the main switch, so they are already modal for keys. The mouse handlers
   * read the SAME predicate rather than repeating the list, because the
   * repeated list is what let two overlays ship modal for the keyboard and
   * transparent to clicks: neither this dialog nor the prune dialog was
   * added to it. A centered dialog leaves rows visible above and below, so
   * a click landing on one is a real click on a real row — in the one-shot
   * picker that meant switching panes and exiting, silently discarding a
   * half-filled dialog.
   */
  function modalOverlayOpen(): boolean {
    return (
      store.state.showHelp ||
      store.state.confirmMode ||
      store.state.previewFocused ||
      store.state.newSession !== null ||
      store.state.prune !== null
    );
  }

  function handleRowActivate(item: FlatItem, index: number) {
    if (modalOverlayOpen()) {
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

  /**
   * Whether the row whose menu is open has uncommitted work, once the daemon
   * has said. Null while unknown, and KEYED BY SESSION so a previous row's
   * answer can never gate a different row's menu.
   *
   * Asked lazily, per menu-open, rather than enriched onto every row: this is
   * one `git status` on an explicit, human-paced action, so it costs nothing
   * until someone asks and can never be stale. A dirty flag on the board
   * would mean a git spawn per session per scan, which is the cost the PR
   * resolver's cache and sweep exist to avoid.
   */
  const [menuDirty, setMenuDirty] = createSignal<{
    sessionId: string;
    dirty: boolean;
  } | null>(null);

  /**
   * Ask whether a row's checkout is dirty, for the menu gate.
   *
   * The answer arrives after the menu is already on screen, so the item it
   * gates is APPENDED LAST (see `sessionMenuItems`). Anywhere else and a row
   * the user is already reaching for would slide down as this lands — the
   * same hazard that moved Fork below Restart. There is deliberately no
   * placeholder or "checking…" row in the meantime: the item is simply
   * absent, so the menu never shows something that isn't actionable.
   */
  function refreshMenuDirty(sessionId: string): void {
    setMenuDirty(null);
    fetch(`${getDaemonUrl()}/sessions/${sessionId}/dirty`, {
      signal: AbortSignal.timeout(5_000),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { dirty?: boolean };
        // Only apply it if that row's menu is STILL the one open. A slow
        // answer for a menu the user already dismissed (or reopened on
        // another row) must not resurrect an item there.
        if (store.state.contextMenu?.sessionId !== sessionId) return;
        setMenuDirty({ sessionId, dirty: data.dirty === true });
      })
      .catch(() => {
        // Unreachable daemon, timeout, malformed body: leave it unknown, so
        // the item stays hidden rather than offering a move that can't run.
      });
  }

  function handleRowContextMenu(
    item: FlatItem,
    index: number,
    event: MouseEvent,
  ) {
    if (modalOverlayOpen()) {
      return;
    }
    store.actions.setSelectedIndex(index);
    if (item.type === "session") {
      store.actions.showContextMenu(
        item.filteredSession.session.id,
        event.x,
        event.y,
      );
      refreshMenuDirty(item.filteredSession.session.id);
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

  /**
   * Repo to scope a prune scan to: the selected session's, or — when a group
   * header is selected — one from the group. The repo comes off a session
   * rather than the group key because a group key is a display label, while
   * `mainRepoRoot` is the same value for a worktree and its main checkout,
   * which is exactly what the scan keys off. Null scans every known repo.
   */
  function selectedRepoRoot(): string | null {
    return (
      store.selectedSession()?.mainRepoRoot ??
      store.selectedGroupSessions().find((s) => s.mainRepoRoot)?.mainRepoRoot ??
      null
    );
  }

  function groupContextMenuPrune() {
    const cm = store.state.groupContextMenu;
    if (!cm) return;
    const repo = selectedRepoRoot();
    store.actions.hideGroupContextMenu();
    store.actions.showPrune(repo);
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

  function contextMenuFork() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (session) void forkSession(session);
  }

  function contextMenuNewSession() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (!session) return;
    // Works for paneless background rows too: their cwd is known, and
    // placement is resolved from the picker's launch pane, not the row's.
    openNewSession({ cwd: sessionCwd(session), agent: session.agentType });
  }

  /**
   * "Move changes to worktree": open the new-session dialog over this row's
   * checkout, in move-changes mode.
   *
   * The mode carries the rest of the prefill (destination locked to a new
   * worktree, the untracked-files choice), so this stays what it always was:
   * the row's cwd and agent, plus the one flag that says what the dialog is
   * for. Name and prompt are left editable, which is the point of routing
   * through the dialog rather than moving on the click.
   */
  function contextMenuMoveChanges() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (!session) return;
    openNewSession({
      cwd: sessionCwd(session),
      agent: session.agentType,
      moveChanges: true,
    });
  }

  function groupContextMenuNewSession() {
    const cm = store.state.groupContextMenu;
    if (!cm) return;
    // Through `newSessionContext`, the same resolver the `n` key uses: this
    // path used to take the first member's cwd unconditionally, so a header
    // grouped by tmux session or window answered one way to the keyboard and
    // another to the mouse. Located by the menu's own group key rather than
    // the selection, which SSE re-sorts underneath an open menu.
    const header = store
      .flatItems()
      .find((item) => item.type === "header" && item.groupKey === cm.groupKey);
    store.actions.hideGroupContextMenu();
    openNewSession(newSessionContext(header ?? null));
  }

  function contextMenuReview() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (session) reviewSession(session);
  }

  function sessionMenuItems(): ContextMenuItem[] {
    // Paneless background rows get the launch actions (per-agent attach + the
    // global agent view) plus Kill, which stops the worker through the agent's
    // own supervisor CLI. Restart stays out: it is a pane-session concept that
    // does not apply.
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
    const newSessionItem: ContextMenuItem = {
      label: "New session here",
      hint: "n",
      color: theme.text,
      action: contextMenuNewSession,
    };
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
        newSessionItem,
        {
          label: "Kill",
          hint: "x",
          color: theme.red,
          action: () => contextMenuConfirm("kill"),
        },
        ...reviewItem,
      ];
    }
    // Only once the daemon has confirmed this row has uncommitted work.
    // Absent while unknown, and absent when clean: an item that offers to
    // move nothing, or that refuses on click, is the "reads as broken"
    // outcome hide-don't-disable exists to avoid.
    const dirty = menuDirty();
    const moveChangesItem: ContextMenuItem[] =
      session && dirty?.sessionId === session.id && dirty.dirty
        ? [
            {
              // Must fit ContextMenu's fixed 22-col box on ONE line: the
              // component computes its height as `items.length + 2`, so a
              // label that wraps renders two rows and silently breaks the
              // height (and therefore the clamping) for the whole menu. The
              // full phrase lives in the dialog this opens.
              label: "Move changes",
              hint: "",
              color: theme.peach,
              action: contextMenuMoveChanges,
            },
          ]
        : [];
    // Hidden rather than disabled when the agent or the row can't be forked:
    // an item that is only ever there for Claude rows with hooks installed
    // would otherwise read as broken on every other row.
    const forkItem: ContextMenuItem[] = canForkSession(session)
      ? [
          {
            label: "Fork",
            hint: "F",
            color: theme.blue,
            action: contextMenuFork,
          },
        ]
      : [];
    return [
      {
        label: "Attach",
        hint: "enter",
        color: theme.green,
        action: contextMenuAttach,
      },
      newSessionItem,
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
      // Last of the always-present actions on purpose. This item appears and
      // disappears reactively (an SSE update that drops `nativeSessionId`
      // removes it), and anything above Kill would slide Kill under a cursor
      // already hovering the old position.
      ...forkItem,
      ...reviewItem,
      // ABSOLUTE LAST, and that position is the whole design. Unlike every
      // item above it, this one arrives ASYNCHRONOUSLY: the menu is already
      // on screen when the dirty answer lands, so anywhere else it would
      // shove the items below it down under a cursor that is already moving.
      // Last means the only thing that can change is empty space.
      ...moveChangesItem,
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
        label: "New session here",
        hint: "n",
        color: theme.text,
        action: groupContextMenuNewSession,
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
        label: "Prune Worktrees",
        hint: "W",
        color: theme.peach,
        action: groupContextMenuPrune,
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
   *  (see killActionPath). A non-OK response (e.g. the daemon refusing to
   *  kill a background row with no stop command) surfaces via the same
   *  action-result toast as the other failure paths above, rather than
   *  silently dropping the failure. */
  function killOrCancelSession(id: string) {
    const session = store.state.sessions.find((s) => s.id === id);
    const path = session ? killActionPath(session) : `/sessions/${id}/kill`;
    fetch(`${getDaemonUrl()}${path}`, { method: "POST" })
      .then(async (response) => {
        if (response.ok) {
          // Every other row dies with its pane, which is feedback enough. A
          // background row is removed only once the supervisor drops it from
          // the roster, so without this `x` reads as having done nothing and
          // invites a retry.
          if (session?.trackingMode === "background") {
            store.actions.showToast("Stopping agent...");
          }
          return;
        }
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        store.actions.showToast(
          `Kill failed: ${body?.error ?? response.statusText}`,
        );
      })
      .catch((err: unknown) => {
        store.actions.showToast(`Kill failed: ${errText(err)}`);
      });
  }

  // --- New session dialog (issue #65) ---

  /** Spawnable agents from the daemon; null until `/agents` answers. */
  const [spawnableAgents, setSpawnableAgents] = createSignal<
    SpawnableAgent[] | null
  >(null);
  const [agentsError, setAgentsError] = createSignal<string | null>(null);
  /** In-flight `/agents` fetch, so opening the dialog twice in quick
   *  succession doesn't issue two. Cleared when it settles, so each open
   *  refreshes — a days-old sidebar would otherwise never notice an agent
   *  installed since it started. */
  let agentsInFlight: Promise<void> | null = null;
  /** Drops a second Enter while a spawn is in flight, which would otherwise
   *  open two panes for one intent. */
  let spawnInFlight = false;

  /**
   * The pane to place the new session against. The sidebar must never target
   * its own rail (it persists, and splitting it halves the strip); an inline
   * picker must target exactly its own pane, because it vacates it on spawn
   * and anything else halves a bystander's pane instead.
   */
  const resolveSpawnPane = (): Promise<string | null> =>
    resolveLaunchPane({ excludeSelf: props.sidebar === true }).catch(
      () => null,
    );

  /**
   * Where the picker itself was launched from. `bin/ccmux` cds into the
   * package root for module resolution and carries the real invocation
   * directory in `CCMUX_CALLER_PWD`, so `process.cwd()` alone would start
   * every agent inside the ccmux install (same restoration as
   * `commands/spawn.ts`).
   */
  const pickerCwd = (): string => process.env.CCMUX_CALLER_PWD ?? process.cwd();

  /**
   * Refresh the agent list. Called on every dialog open, and kept off the
   * launch path: the picker is startup-sensitive and most launches never
   * open the dialog. Re-fetching per open is what lets a long-lived sidebar
   * pick up an agent installed since it started.
   */
  function ensureSpawnableAgents(): void {
    if (agentsInFlight) return;
    // Back to "loading" rather than leaving the previous error on screen: a
    // retry that still shows the old red line reads as not having retried.
    if (agentsError() !== null) {
      batch(() => {
        setAgentsError(null);
        setSpawnableAgents(null);
      });
    }
    agentsInFlight = fetch(`${getDaemonUrl()}/agents`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          agents?: SpawnableAgent[];
          error?: string;
        } | null;
        if (!response.ok) {
          // The daemon is machine-wide and long-lived, so "new client, old
          // daemon" is the likeliest failure right after an upgrade — and
          // it presents as a 404, since `/agents` simply isn't routed yet.
          // A bare "HTTP 404" in the Agent field just looks broken, so name
          // the cause and the one-line fix (the same restart requirement
          // docs/architecture.md states for config-added agents).
          if (response.status === 404) {
            throw new Error(STALE_DAEMON_HINT);
          }
          throw new Error(body?.error ?? `HTTP ${response.status}`);
        }
        batch(() => {
          setAgentsError(null);
          setSpawnableAgents(body?.agents ?? []);
        });
      })
      .catch((err: unknown) => {
        // A daemon restarted mid-session must not leave the dialog
        // permanently empty, and the next open retries.
        batch(() => {
          setAgentsError(errText(err));
          setSpawnableAgents([]);
        });
      })
      .finally(() => {
        agentsInFlight = null;
      });
  }

  /**
   * The context a dialog opened over `item` inherits.
   *
   * cwd is derived, never asked: a session row means that session's
   * directory, a group header means the directory the group stands for, and
   * no selection at all falls back to where the picker was launched.
   *
   * A header only stands for a directory under a directory-shaped grouping.
   * Grouped by tmux session or window, its members can span unrelated
   * repositories, so the first member's cwd would be an arbitrary pick —
   * the picker's own directory is at least a defensible default.
   *
   * Every entry point (the `n` key, both context menus) routes through here,
   * so key and mouse cannot answer the same question differently.
   */
  function newSessionContext(item: FlatItem | null): {
    cwd: string;
    agent?: string;
  } {
    if (item?.type === "session") {
      const session = item.filteredSession.session;
      return { cwd: sessionCwd(session), agent: session.agentType };
    }
    if (
      item?.type === "header" &&
      GROUPINGS_BY_DIRECTORY.has(store.state.groupBy)
    ) {
      const members = item.members.map((member) => member.session);
      // A project group is repo-level: it holds the main checkout AND every
      // worktree hanging off it, and members are sorted by status then
      // activity, so `members[0]` is an arbitrary sibling worktree that can
      // change between two opens. The repo root is the directory the group
      // stands for, but only when the group PROVES it, which takes two
      // conditions:
      //
      // - Unanimous. The group key is a repo NAME (a basename), so ~/work/api
      //   and ~/oss/api share one group; picking whichever member carried a
      //   root would answer with one of two unrelated repositories depending
      //   on the sort.
      // - Not the home directory. A literal ~/.git (dotfiles initialized in
      //   $HOME) resolves every member's `mainRepoRoot` to $HOME while the
      //   group is labelled after a subdirectory, so "agreement" there means
      //   opening at the top of the user's home.
      //
      // Anything else falls back to a member's own cwd, which is at least a
      // directory one of the sessions is really in. `cwd` grouping keys off
      // the directory itself, so it always takes the member's.
      if (store.state.groupBy === "project") {
        const roots = new Set(
          members
            .map((member) => member.mainRepoRoot)
            .filter((root): root is string => Boolean(root)),
        );
        const [repoRoot] = roots;
        if (roots.size === 1 && repoRoot && repoRoot !== resolvedHomeDir()) {
          return { cwd: repoRoot };
        }
      }
      const first = members[0];
      if (first) return { cwd: sessionCwd(first) };
    }
    return { cwd: pickerCwd() };
  }

  function openNewSession(context: {
    cwd: string;
    agent?: string;
    moveChanges?: boolean;
  }): void {
    // Mirrors `reviewSession`: refuse at the point of intent rather than
    // opening a dialog with a blank Directory row whose Enter round-trips
    // to a 400 from the daemon.
    if (!context.cwd) {
      store.actions.showToast("Can't start here: no working directory");
      return;
    }
    ensureSpawnableAgents();
    store.actions.openNewSessionDialog({
      cwd: context.cwd,
      // The row's own agent, else whatever was spawned last (persisted, so
      // it survives the one-shot picker exiting), else the first listed.
      agent:
        context.agent ??
        store.state.lastSpawnAgent ??
        spawnableAgents()?.[0]?.name ??
        "claude",
      moveChanges: context.moveChanges,
    });
  }

  // The dialog opens before `/agents` answers, and the row's own agent may
  // not even be spawnable here (detected by pane scanning, absent from
  // PATH). Reconcile once the list lands rather than leaving a draft that
  // would 400 on Enter.
  createEffect(() => {
    const list = spawnableAgents();
    const draft = store.state.newSession;
    if (!list || list.length === 0 || !draft) return;
    if (list.some((agent) => agent.name === draft.agent)) return;
    store.actions.setNewSessionAgent(list[0]!.name);
  });

  /**
   * The choices j/k and the number keys apply to, for whichever field has
   * focus: its options, the one currently held, and how to select another.
   * Null for a field with no options (the prompt, which owns its own keys).
   * Every option field goes through this one path, so the worktree
   * destination field (#69) needs only its own case here.
   */
  function focusedOptionField(): {
    options: string[];
    value: string;
    select: (value: string) => void;
  } | null {
    const draft = store.state.newSession;
    if (!draft) return null;
    switch (draft.field) {
      case "agent":
        return {
          options: (spawnableAgents() ?? []).map((agent) => agent.name),
          value: draft.agent,
          select: store.actions.setNewSessionAgent,
        };
      case "placement":
        return {
          options: PLACEMENT_OPTIONS.map((option) => option.value),
          value: draft.placement,
          // Looked up rather than cast: only a real option gets through.
          select: (value) => {
            const option = PLACEMENT_OPTIONS.find((o) => o.value === value);
            if (option) store.actions.setNewSessionPlacement(option.value);
          },
        };
      case "destination":
        // Locked in move-changes mode, where the field is not reachable by
        // Tab either; the store refuses the write regardless.
        if (draft.moveChanges) return null;
        return {
          options: DESTINATION_OPTIONS.map((option) => option.value),
          value: draft.destination,
          select: (value) => {
            const option = DESTINATION_OPTIONS.find((o) => o.value === value);
            if (option) store.actions.setNewSessionDestination(option.value);
          },
        };
      case "untracked":
        return {
          options: UNTRACKED_OPTIONS.map((option) => option.value),
          value: draft.untracked,
          select: (value) => {
            const option = UNTRACKED_OPTIONS.find((o) => o.value === value);
            if (option) store.actions.setNewSessionUntracked(option.value);
          },
        };
      default:
        return null;
    }
  }

  /** Clamped, not wrapping: in a three-item list, `k` teleporting to the
   *  bottom reads as a misfire rather than a nicety. */
  function moveNewSessionOption(delta: number): void {
    const field = focusedOptionField();
    if (!field || field.options.length === 0) return;
    const current = Math.max(0, field.options.indexOf(field.value));
    const next = Math.min(
      Math.max(current + delta, 0),
      field.options.length - 1,
    );
    field.select(field.options[next]!);
  }

  function pickNewSessionOption(index: number): void {
    const field = focusedOptionField();
    if (!field) return;
    const value = field.options[index];
    if (value !== undefined) field.select(value);
  }

  async function submitNewSession(): Promise<void> {
    const draft = store.state.newSession;
    if (!draft || spawnInFlight) return;

    const list = spawnableAgents();
    if (list === null) {
      store.actions.showToast("Still loading agents...");
      return;
    }
    const agent = list.find((a) => a.name === draft.agent);
    if (!agent) {
      store.actions.showToast(
        agentsError() ?? "No agents available to spawn",
        3000,
      );
      return;
    }
    const prompt = draft.prompt.trim();
    if (prompt && !agent.supportsPrompt) {
      store.actions.showToast(
        `${agent.displayName} can't start with a prompt`,
        3000,
      );
      return;
    }
    // The dialog has no name field, so the prompt is the only name it can
    // offer. Refuse here rather than posting: the daemon's own refusal reads
    // "pass one explicitly", which is advice for the CLI and not something
    // this dialog can act on.
    if (draft.destination === "worktree" && !slugFromPrompt(prompt)) {
      store.actions.showToast(
        "Type a prompt to name the worktree, or use ccmux spawn --worktree <name>",
        4000,
      );
      return;
    }
    // Placement carries a `%N` from OUR tmux server; against a daemon
    // watching a different one it would resolve to an unrelated pane, and
    // the agent would start where nobody is looking.
    if (!ensureSameServer()) return;

    // The sidebar spawns without stealing focus; the picker's whole purpose
    // is to put you in the new pane, so it jumps and gets out of the way.
    const detach = props.sidebar === true;
    spawnInFlight = true;
    let spawned: { paneId?: string } | null = null;
    try {
      const callerPane = await resolveSpawnPane();
      // A sidebar alone in its window has nothing to split but itself, and
      // the daemon's placement-less `split-window` would halve the rail.
      // Degrade to a new window and say so, rather than mangling the board.
      let split = SPAWN_SPLIT[draft.placement];
      if (split !== false && callerPane === null && props.sidebar) {
        split = false;
        store.actions.showToast("No pane to split here; opened a window");
      }
      const response = await fetch(`${getDaemonUrl()}/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: agent.name,
          cwd: draft.cwd,
          split,
          // `callerPane`, not `target`: the daemon reads an explicit target
          // as "insert a window right here", which renumbers every later
          // window in the session and breaks `select-window -t N` muscle
          // memory. The picker only means "my session/pane" — which for a
          // split is still exactly this pane.
          callerPane: callerPane ?? undefined,
          prompt: prompt || undefined,
          detach,
          // The daemon derives the name from the prompt when none is given,
          // which is the same rule the row previews, so the two cannot drift.
          // In move-changes mode the same field carries the move: the daemon
          // routes creation through it, so the worktree is made once, with
          // the changes already in it.
          worktree:
            draft.destination === "worktree"
              ? draft.moveChanges
                ? { withChanges: true, untracked: draft.untracked }
                : {}
              : undefined,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        paneId?: string;
        error?: string;
      } | null;
      if (response.ok) {
        spawned = body ?? {};
      } else {
        // Leave the dialog open: every 400 here (agent can't take a prompt,
        // cwd is gone) is something the user can fix in place.
        store.actions.showToast(
          `Spawn failed: ${body?.error ?? response.statusText}`,
          4000,
        );
      }
    } catch (err: unknown) {
      store.actions.showToast(`Spawn failed: ${errText(err)}`, 4000);
    } finally {
      // Released only on the paths that leave the dialog open. A landed spawn
      // holds the guard until the draft is gone: the state write below is a
      // real file read, write and rename, and an Enter delivered during it
      // would otherwise pass BOTH guards and open a second pane.
      if (!spawned) spawnInFlight = false;
    }
    if (!spawned) return;

    // The pane EXISTS from here on, so nothing below may report a spawn
    // failure. Remembering the agent is best-effort for exactly that reason:
    // an unwritable ~/.config would otherwise surface as "Spawn failed", and
    // the user — reasonably — would press Enter again and get a second pane.
    try {
      await store.actions.setLastSpawnAgent(agent.name).catch(() => {});
    } finally {
      store.actions.closeNewSessionDialog();
      spawnInFlight = false;
    }
    if (detach) {
      store.actions.showToast(`Spawned ${agent.displayName}`);
      return;
    }
    // The daemon already selected the new pane's window; tell the other
    // boards so their active-row highlight doesn't lag a scan behind.
    if (spawned.paneId) notifyActivePane(spawned.paneId);
    if (!props.persistent) process.exit(0);
  }

  function handleNewSessionKey(event: KeyEvent): void {
    const draft = store.state.newSession;
    if (!draft) return;
    const key = event.name;

    if (key === "escape") {
      store.actions.closeNewSessionDialog();
      event.preventDefault();
      return;
    }
    if (key === "return" || key === "enter") {
      void submitNewSession();
      event.preventDefault();
      return;
    }
    if (key === "tab" || key === "backtab") {
      store.actions.moveNewSessionField(
        key === "backtab" || event.shift ? -1 : 1,
      );
      event.preventDefault();
      return;
    }

    // The prompt input owns every remaining key while it has focus, so a
    // prompt can contain `j`, `3`, or anything else a field shortcut would
    // otherwise swallow. Field movement there is limited to the keys the
    // input doesn't consume, exactly as in search mode.
    if (draft.field === "prompt") {
      if (key === "down" || (key === "n" && event.ctrl)) {
        store.actions.moveNewSessionField(1);
        event.preventDefault();
      } else if (key === "up" || (key === "p" && event.ctrl)) {
        store.actions.moveNewSessionField(-1);
        event.preventDefault();
      }
      return;
    }

    if (key === "j" || key === "down") {
      moveNewSessionOption(1);
    } else if (key === "k" || key === "up") {
      moveNewSessionOption(-1);
    } else if (key >= "1" && key <= "9") {
      pickNewSessionOption(parseInt(key, 10) - 1);
    }
    // Everything else is swallowed: the dialog is modal, and letting `q`
    // through would quit the picker mid-edit.
    event.preventDefault();
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

  // Sidebar only: `ccmux sidebar` runs one full TUI process per tmux window,
  // but at most one window per attached session is on screen. Everything the
  // rest of this component gates on `isVisible()` is work whose only product
  // is pixels — spinner frames (a full-buffer redraw each), the tick that
  // refreshes relative time labels, the selected-pane flash.
  //
  // Trade-off: a refresh costs one `tmux display-message` spawn per sidebar
  // process, so every pane/window switch (an `active_pane` event) now pays N
  // debounced spawns — bounded by how fast a human switches panes — in
  // exchange for eliminating continuous redraws in every background window.
  // The picker is never gated: it is by definition what the user is looking at.
  //
  // Four signals drive a re-check, and it takes all four to cover every way a
  // window goes on or off screen: SSE `active_pane` events (the common case,
  // but the daemon suppresses them for ccmux-titled panes), terminal dimension
  // changes (a client attach/detach resizes panes without a select hook),
  // keypresses in the sidebar (the heal for the suppressed-event case, since a
  // keypress means someone is looking at it), and the 30s safety poll inside
  // the primitive (catches an attach/detach that changed no dimension).
  const visibility = props.sidebar ? createWindowVisibility() : null;
  const isVisible = (): boolean => visibility?.visible() ?? true;

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
      onDaemonHealth: (health) => {
        store.actions.setDaemonHealth(health);
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
        // The daemon broadcasts this on every pane/window switch, which is
        // also every moment a sidebar can become visible or hidden. Debounced
        // inside the primitive.
        visibility?.refresh();
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
  // Debounced to avoid spawning tmux processes on every rapid j/k keypress,
  // and skipped outright while this window is off screen (an invisible flash
  // is pure cost). Tracks only the pane ID (not the full session object) so
  // SSE session data updates don't re-trigger the flash; visibility is read
  // untracked so regaining focus doesn't flash a pane the user didn't select.
  if (props.sidebar) {
    const flasher = createFlashScheduler({
      visible: () => untrack(isVisible),
    });
    const selectedPaneId = createMemo(() => {
      const id = store.state.selectedSessionId;
      if (!id) return null;
      return store.state.sessions.find((s) => s.id === id)?.tmuxPane ?? null;
    });
    createEffect(() => {
      const pane = selectedPaneId();
      if (!pane) return;
      flasher.schedule(pane);
    });
    onCleanup(() => flasher.cancel());
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
        () => `${dims().width}x${dims().height}`,
        () => {
          // A client attaching or detaching resizes panes but fires no tmux
          // select hook, so a dimension change is one of the few in-process
          // signals that visibility may have flipped.
          visibility?.refresh();
        },
        { defer: true },
      ),
    );
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

  // Sidebar: react to visibility changes.
  //   - A spinner frame bump is a full-buffer redraw, so a background sidebar
  //     animating `working` sessions burns CPU on an invisible surface. The
  //     refcount survives the pause, so icons resume in place.
  //   - Collect the heap once the window has stayed hidden: with the redraws
  //     gone, the process allocates too little for JSC's allocation-driven GC
  //     to ever run, so it can strand its boot-time high-water mark.
  if (props.sidebar) {
    const idleGc = createIdleGcScheduler();
    createEffect(() => {
      const visible = isVisible();
      setSpinnerPaused(!visible);
      idleGc.setVisible(visible);
    });
    onCleanup(() => {
      setSpinnerPaused(false);
      idleGc.cancel();
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
  const FAST_TICK_MS = 1000;
  const SLOW_TICK_MS = 10_000;
  let currentTickMs = FAST_TICK_MS;
  let tickTimerId: Timer | undefined;

  function desiredTickMs(): number {
    // Nobody can read a background sidebar's time labels, and each tick
    // repaints the whole buffer. Stay on the slow cadence until it is on
    // screen again (which bumps the tick immediately, so labels catch up).
    if (!isVisible()) return SLOW_TICK_MS;

    const now = Date.now();
    const needsFastTick = store.state.sessions.some((s) => {
      const ts = s.lastUserInputAt ?? s.lastActivityAt;
      return ts && now - Date.parse(ts) < 60_000;
    });
    return needsFastTick ? FAST_TICK_MS : SLOW_TICK_MS;
  }

  function scheduleTick(ms: number) {
    if (tickTimerId) untrackInterval(tickTimerId);
    currentTickMs = ms;
    tickTimerId = trackInterval(runTick, ms);
  }

  function runTick() {
    store.bumpTick();
    const desiredMs = desiredTickMs();
    if (desiredMs !== currentTickMs) scheduleTick(desiredMs);
  }

  scheduleTick(currentTickMs);

  if (props.sidebar) {
    createEffect(
      on(
        () => isVisible(),
        (visible) => {
          if (!visible) return;
          // Catch up the relative time labels that the slow cadence let go
          // stale, then re-arm at whatever cadence the data now wants.
          runTick();
        },
        { defer: true },
      ),
    );
  }

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
    // The daemon suppresses `active_pane` for ccmux-titled panes, so a sidebar
    // that is its own window's active pane never gets the event that would
    // unhide it; a keypress is the only signal that it is being looked at.
    // Only the hidden gate needs healing: a sidebar already believed visible
    // would spend a `tmux display-message` per keystroke to re-confirm it.
    if (visibility && !visibility.visible()) visibility.refresh();

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

    // The prune overlay owns every key while it is up (it registers its own
    // handler), so nothing here may also act on them.
    if (store.state.prune) {
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

    if (store.state.newSession) {
      handleNewSessionKey(event);
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
      // The search input owns the text keys, so selection movement is limited
      // to the keys it does not consume: ctrl-n/ctrl-p and the arrows.
      if (key === "down" || (key === "n" && event.ctrl)) {
        store.actions.moveSelection(1);
        event.preventDefault();
        return;
      }
      if (key === "up" || (key === "p" && event.ctrl)) {
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
        } else if (!event.shift) {
          openNewSession(newSessionContext(store.selectedFlatItem()));
        }
        // Shift+N falls through deliberately: every other capital in this
        // switch is its own action, so silently treating `N` as `n` would
        // claim a key some later feature wants.
        event.preventDefault();
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

      case "W":
      case "w":
        // Shift+W only, like every other capital action in this switch. Both
        // spellings are matched because the key arrives as name `"w"` with
        // `shift` set rather than as `"W"`; gating on the modifier is what
        // keeps a bare `w` from opening a destructive surface.
        if (key !== "W" && !event.shift) break;
        // Scoped to the selected row's repo when there is one, so `W` on a
        // group behaves like the group menu's item; global otherwise.
        store.actions.showPrune(selectedRepoRoot());
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

      case "F":
      case "f":
        // Shift+F forks, bare `f` filters. Both spellings of the capital are
        // matched because terminals deliver it as name `"f"` with `shift`
        // set rather than as `"F"`; without the lowercase case the binding
        // would be unreachable.
        if (key === "F" || event.shift) {
          const sessionToFork = store.selectedSession();
          // Silent on a group header, like `r` and `x`; but on a real row
          // that can't be forked, say why. The help overlay lists `F`
          // unconditionally, so silence there reads as a broken key.
          if (sessionToFork) {
            if (canForkSession(sessionToFork)) void forkSession(sessionToFork);
            else store.actions.showToast(forkRefusalReason(sessionToFork));
          }
        } else {
          store.actions.toggleHideIdle();
        }
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
          daemonDegraded={store.state.daemonHealth.degraded}
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
            newSessionMode={store.state.newSession !== null}
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

        <Show when={store.state.newSession}>
          {(draft: () => NonNullable<typeof store.state.newSession>) => (
            <NewSessionDialog
              draft={draft()}
              agents={spawnableAgents()}
              agentsError={agentsError()}
              onFocusField={store.actions.setNewSessionField}
              onSelectAgent={store.actions.setNewSessionAgent}
              onSelectPlacement={store.actions.setNewSessionPlacement}
              onSelectDestination={store.actions.setNewSessionDestination}
              onSelectUntracked={store.actions.setNewSessionUntracked}
              onPromptInput={store.actions.setNewSessionPrompt}
              onSubmit={() => void submitNewSession()}
              onCancel={store.actions.closeNewSessionDialog}
              showKeyHints={props.sidebar === true}
            />
          )}
        </Show>

        <Show when={store.state.prune}>
          {(prune: () => NonNullable<typeof store.state.prune>) => (
            <PruneDialog
              repo={prune().repo}
              compact={props.sidebar}
              onClose={store.actions.hidePrune}
            />
          )}
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
            pickers need the switch-failure toast too, not just the sidebar. */}
        <Show when={store.state.toastMessage}>
          <Toast message={store.state.toastMessage!} />
        </Show>
      </box>
    </TickContext.Provider>
  );
}
