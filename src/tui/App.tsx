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
import { useKeyboard, useRenderer } from "@opentui/solid";
import type { KeyEvent, MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import type { EnrichedSession } from "../types/session";
import type { TmuxSocketError } from "../types";
import {
  createTUIStore,
  namesAWorktree,
  TickContext,
  type NewSessionDraft,
  type NewSessionField,
  type NewSessionFork,
  type NewSessionPR,
  type NewSessionPlacement,
} from "./store";
import { killActionPath, restartActionPath } from "./utils/invoke-actions";
import {
  formatReviewPrompt,
  HUNK_INSTALL_HINT,
  isHunkAvailable,
  resolveMergeBase,
  runHunkReview,
  type HunkReviewNote,
} from "./utils/review";
import { copyToClipboard } from "./utils/clipboard";
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
import { tmuxArgv } from "../lib/tmux-exec";
import { isSameServerCached, setDaemonSocketPath } from "./utils/server-guard";
import { useSharedTerminalDimensions } from "./utils/use-shared-dimensions";
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
import { type RowAnchor, SessionList } from "./components/SessionList";
import { SearchInput } from "./components/SearchInput";
import { Preview } from "./components/Preview";
import { Toast } from "./components/Toast";
import { GroupPreview } from "./components/GroupPreview";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import {
  NewSessionDialog,
  newSessionFloorRows,
} from "./components/NewSessionDialog";
import { newSessionOptions } from "./new-session-options";
import { NoticeDialog } from "./components/NoticeDialog";
import { CopyDialog } from "./components/CopyDialog";
import {
  HandoffDialog,
  type HandoffEndpoint,
} from "./components/HandoffDialog";
import { agentColorFor } from "./components/SessionItem";
import { getAgentDisplayName } from "../lib/agents";
import { applyTurnsKey } from "./turns-selection";
import { renderTurns } from "../daemon/transcript-read";
import { slugFromPrompt, slugify } from "../daemon/worktree-create";
import {
  failureNeedsAcknowledgement,
  moveNeedsAcknowledgement,
  moveReportLines,
  moveSummary,
  stashRecoveryLines,
  type MoveReport,
} from "../lib/move-report";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { HANDOFF_BADGE } from "./components/session-columns";
import {
  WorktreesPanel,
  liveEffects,
  worktreeHoldsPath,
} from "./components/WorktreesPanel";
import type { WorktreeSession } from "../daemon/worktree-prune";
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

/**
 * The live session a Worktrees-panel row's session id stands for.
 *
 * Rows can carry a SYNTHETIC id: the daemon folds a worktree-isolated subagent
 * into its worktree's row as `${parent.id}:${agentId}` with the parent's pane
 * (`worktreeSessionsByRoot`), and a teammate-only worktree's row is nothing
 * BUT that. A plain `find` by such an id matches nothing, which would strand
 * the row's actions on a session that is right there — so a miss falls back to
 * the part before the first colon, which is the orchestrator the fold already
 * routes the pane to.
 *
 * Split on MISS rather than always: a real session id could contain a colon,
 * and truncating one would resolve to the wrong session (or a stranger's).
 */
function resolveWorktreeSession(
  sessions: readonly EnrichedSession[],
  id: string,
): EnrichedSession | undefined {
  const direct = sessions.find((s) => s.id === id);
  if (direct) return direct;
  const colon = id.indexOf(":");
  if (colon === -1) return undefined;
  const parentId = id.slice(0, colon);
  return sessions.find((s) => s.id === parentId);
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
  /** The viewport, for the handful of key handlers that have to agree with
   *  what a component decided it had room to draw. */
  const appDims = useSharedTerminalDimensions();
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
      .then(
        (r) =>
          r.json() as Promise<{
            socketPath: string | null;
            socketError?: TmuxSocketError | null;
          }>,
      )
      .then((d) => {
        setDaemonSocketPath(d.socketPath ?? null);
        // A daemon predating the field omits it, which reads as "no error".
        store.actions.setTmuxSocketError(d.socketError ?? null);
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
    activateSession(item.filteredSession.session);
  }

  /**
   * Go to a session, wherever it lives. Split out of `activateItem` because
   * the Worktrees panel activates a session that was never a row in the list
   * (issue #102), and the two must not drift on what "go to" means.
   */
  function activateSession(session: EnrichedSession) {
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
    /** Runs once the confirm RESOLVES, on both its branches: the Worktrees
     *  panel's reopen rides here, and firing it any earlier would put the
     *  panel back over the very dialog the close existed to unbury. */
    onDone?: () => void;
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

  /**
   * Offer a review's notes back to the agent that owns the checkout.
   *
   * Shared by the session list's `d` and the Worktrees panel's, because the
   * rule about what reaches an agent unprompted should have one home: only an
   * explicit auto/fill skips the dialog, and every other value (undefined, or
   * an unvalidated config typo like "Fill") falls through to confirm rather
   * than silently submitting.
   */
  function handBackReviewNotes(
    session: EnrichedSession,
    notes: HunkReviewNote[],
    // Called when the hand-back is RESOLVED: immediately on the paths that
    // never raise the confirm, and from the confirm's own two exits
    // otherwise. Callers that need to run after the whole round-trip (the
    // Worktrees panel's reopen) pass it; the session list passes nothing.
    onDone?: () => void,
  ) {
    if (session.trackingMode === "background" || session.tmuxPane == null) {
      store.actions.showToast(
        `${notes.length} review note${notes.length === 1 ? "" : "s"} captured (no pane to send to)`,
      );
      onDone?.();
      return;
    }
    if (props.reviewHandback === "auto" || props.reviewHandback === "fill") {
      void deliverReviewNotes(session.id, notes, props.reviewHandback);
      onDone?.();
      return;
    }
    pendingReviewNotes = { sessionId: session.id, notes, onDone };
    store.actions.showConfirmDialog(session.id, "send-review");
  }

  /**
   * The session list's `d` (what is UNCOMMITTED) and `D` (everything this
   * checkout has changed since it forked). A fixed pair, not a default and
   * an override: which of the two questions the user wants is not something
   * the row can be read off for, and a key that means different things on
   * different rows is one the user has to check the row before pressing.
   *
   * `D` needs no case for a checkout carrying no commits of its own beyond
   * its base: the merge-base IS its HEAD, `resolveMergeBase` returns null,
   * and null falls back to the working-tree review, so `D` there behaves
   * like `d`. The base is normally `origin/main` (`resolveBaseRefs` asks
   * `origin/HEAD` first), so a main checkout with UNPUSHED commits is not
   * that case, and `D` showing them alongside the working tree is the point
   * rather than an edge of it.
   */
  function reviewSession(session: EnrichedSession, branchMode = false) {
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
    // Resolved before `runHunkReview`, which is what suspends the renderer.
    // From the CHECKOUT root rather than the pane's cwd: a pane that cd'd
    // into a subdirectory is still on the branch, and the merge-base is a
    // property of the checkout. `worktreeRoot` is that root for a linked
    // worktree and for a main checkout alike.
    const base = branchMode
      ? resolveMergeBase(session.worktreeRoot ?? cwd)
      : Promise.resolve(null);
    base
      .then((target) =>
        runHunkReview(renderer, cwd, { target: target ?? undefined }),
      )
      .then((result) => {
        reviewInFlight = false;
        if (!result.ok) {
          // The dead end the fixed pair creates, and the one row it lands on
          // most: an agent that has committed everything has nothing
          // uncommitted, and `d` alone would say so and stop. Keyed off the
          // MODE and the result's own `empty` flag rather than its wording,
          // and added here rather than in `runHunkReview`, whose other two
          // callers (the Worktrees panel, `ccmux review`) have no `D` to
          // point at.
          const hint =
            !branchMode && result.empty ? " (D reviews the branch)" : "";
          store.actions.showToast(`Review failed: ${result.error}${hint}`);
          return;
        }
        if (result.notes.length === 0) return;
        handBackReviewNotes(session, result.notes);
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
   * The Worktrees panel's `d`, which reviews a BRANCH rather than a working
   * tree: the base is the merge-base with the ref it was cut from, so a
   * worktree whose work is already committed shows what it changed instead of
   * "no changes to review". A worktree with no fork point to name (sitting on
   * the base, orphaned, or in a repo with no recognizable default branch)
   * falls back to the working-tree review the session list's `d` does.
   *
   * The handback is what the row's session buys: notes from an occupied
   * worktree go to that agent exactly as they do from the list. A bare
   * worktree still captures them, and says how many, rather than dropping
   * them silently.
   */
  function reviewWorktree(target: {
    path: string;
    sessionId: string | null;
    panelRepo: string | null;
    panelScope: string | null;
  }) {
    if (reviewInFlight) return;
    // Re-probe live (not the launch-time `hunkAtLaunch`) so a hunk installed
    // after the picker started works without a restart.
    if (!isHunkAvailable()) {
      store.actions.showToast(HUNK_INSTALL_HINT);
      return;
    }
    const session = target.sessionId
      ? resolveWorktreeSession(store.state.sessions, target.sessionId)
      : undefined;
    // Close FIRST, like every other panel action. The panel is a full-screen
    // opaque overlay that also swallows every key, so the send-review confirm
    // this review can raise would render underneath it and be unreachable —
    // captured notes with no way to answer for them. Nothing below needs the
    // panel: the row was already read into `target` and `session`.
    //
    // The scope travels IN THE PAYLOAD, not from the store: Tab's rescope is
    // panel-local state the store never sees, so reading the store here
    // reopened a widened panel back on its narrow opening repo. Every exit
    // below reopens the panel with the cursor on the reviewed row, and the
    // hand-back paths do it through `onDone` so the reopen provably follows
    // the confirm's own resolution instead of racing it back over the dialog.
    const reopen = () =>
      store.actions.showWorktrees(target.panelRepo, {
        initialCursor: target.path,
        isReturn: true,
        startWidened: target.panelRepo !== null && target.panelScope === null,
      });
    store.actions.hideWorktrees();
    reviewInFlight = true;
    // Resolved before the guard is honored so a slow git can't be raced, and
    // before `runHunkReview` because that is what suspends the renderer.
    resolveMergeBase(target.path)
      .then((base) =>
        runHunkReview(renderer, target.path, { target: base ?? undefined }),
      )
      .then((result) => {
        reviewInFlight = false;
        if (!result.ok) {
          store.actions.showToast(`Review failed: ${result.error}`);
          reopen();
          return;
        }
        if (result.notes.length === 0) {
          reopen();
          return;
        }
        if (session) {
          handBackReviewNotes(session, result.notes, reopen);
          return;
        }
        store.actions.showToast(
          `${result.notes.length} review note${result.notes.length === 1 ? "" : "s"} captured (no agent to send to)`,
        );
        reopen();
      })
      .catch(() => {
        reviewInFlight = false;
        store.actions.showToast("Review failed");
        reopen();
      });
  }

  /**
   * The Worktrees panel's Enter on an occupied row. The panel reports the
   * session as the DAEMON described it, which may be a row the picker's own
   * list never held (a repo discovered through cwd, filtered out by a search),
   * so the enriched session is preferred and the pane is the fallback.
   */
  function jumpToWorktreeSession(session: WorktreeSession) {
    store.actions.hideWorktrees();
    const enriched = resolveWorktreeSession(store.state.sessions, session.id);
    if (enriched) {
      activateSession(enriched);
      return;
    }
    if (session.tmuxPane) {
      store.actions.setActiveSessionId(session.id);
      selectPane(session.tmuxPane);
      return;
    }
    store.actions.showToast("No pane to switch to");
  }

  /**
   * The Worktrees panel's Enter on a row that had no agent in it WHEN THE
   * LIST WAS FETCHED, revalidated against the live session list before it is
   * acted on.
   *
   * The panel's rows are a snapshot: the two reads behind them can be seconds
   * old by the time Enter lands, and a worktree that gained an agent in that
   * window would otherwise open the spawn dialog — the one thing the panel is
   * designed never to offer, a second agent in an occupied worktree. The
   * decision is re-made HERE rather than in the panel because this is where
   * the live store is; the panel reports what it saw and this picks the verb.
   *
   * Only the linked-worktree case is revalidated. The main checkout's Enter
   * opens an ordinary dialog whose destination is still a real choice, so an
   * agent living there is no reason to refuse — and a containment test against
   * a repo ROOT would match every linked worktree too, since ccmux puts them
   * under `<repo>/.claude/worktrees/`. Prefix-matching there would jump to an
   * unrelated worktree's agent.
   */
  function spawnInWorktree(target: {
    cwd: string;
    existingWorktree: string | null;
    panelRepo: string | null;
    panelScope: string | null;
    /**
     * The row's own KEY, where it is not simply the worktree's path.
     *
     * Sent by the Worktrees panel's Enter on a PR that IS checked out here:
     * that row routes through this verb because the destination is the
     * worktree holding it, but the row the user was standing on is the PR,
     * and `initialView` reads the cursor to decide which view to reopen in.
     * Without it a cancelled dialog returned to the WORKTREES view while the
     * adjacent not-checked-out row returned correctly.
     *
     * The cursor and the view stay ONE decision, which is why this is a
     * cursor and not a view flag: sending the view explicitly while the
     * cursor stayed a path would reopen the PR view on a key its list cannot
     * contain, and the re-seed would drop the cursor on the first row —
     * trading a wrong view for a wrong row.
     */
    cursor?: string;
  }) {
    store.actions.hideWorktrees();
    const worktree = target.existingWorktree;
    if (worktree) {
      const live = store.state.sessions.find((session) =>
        worktreeHoldsPath(worktree, sessionCwd(session)),
      );
      if (live) {
        activateSession(live);
        return;
      }
    }
    openNewSession({
      cwd: target.cwd,
      existingWorktree: worktree ?? undefined,
      // The payload's own scope, not the store's: Tab's rescope is
      // panel-local, and a cancel must land on the view the user left.
      returnToWorktrees: {
        repo: target.panelRepo,
        scope: target.panelScope,
        cursor: target.cursor ?? worktree ?? target.cwd,
      },
    });
  }

  /**
   * The Worktrees panel's Enter on an open PR that is NOT checked out here
   * (issue #151): open the dialog that cuts a worktree from its head.
   *
   * No revalidation of its own, unlike `spawnInWorktree`: the fact that could
   * have changed is whether the PR is still open, and only GitHub knows.
   * `POST /spawn` re-runs `lookupPR` and refuses a non-OPEN one, so a stale
   * row fails safe with the daemon's own message instead of this client's
   * guess about a state it cannot see.
   *
   * `cwd` is the repo root: `gh` resolves the PR from the directory the
   * request names, and the worktree is cut under that repo.
   */
  function spawnFromPR(target: {
    number: number;
    title: string;
    repoRoot: string;
    cursor: string;
    panelRepo: string | null;
    panelScope: string | null;
  }) {
    store.actions.hideWorktrees();
    openNewSession({
      cwd: target.repoRoot,
      pr: {
        number: target.number,
        title: target.title,
        repoRoot: target.repoRoot,
      },
      // The PR row's own synthetic key, so a cancel lands the cursor back on
      // the row it was opened from rather than on the top of the list.
      returnToWorktrees: {
        repo: target.panelRepo,
        scope: target.panelScope,
        cursor: target.cursor,
      },
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
   * Whether this row's fork can be given a worktree of its own (issue #70).
   *
   * Everything the fork itself needs, plus a repository for the worktree to
   * hang off: `mainRepoRoot` is what the daemon would resolve too, so a row
   * without one has nowhere to put a linked checkout. Checked here rather
   * than left to the daemon's refusal, but only where the CHOICE is offered:
   * the Fork item and the `F` key are gated on `canForkSession` alone, and a
   * source outside a repository simply opens the dialog with its destination
   * locked to the checkout it is already in.
   */
  function canForkIntoWorktree(
    session:
      | {
          agentType: string;
          nativeSessionId?: string;
          trackingMode?: string;
          mainRepoRoot?: string | null;
        }
      | undefined,
  ): boolean {
    return canForkSession(session) && Boolean(session?.mainRepoRoot);
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

  /**
   * Identity of the latest new-session dialog opened by this App instance.
   * A fork request can outlive the dialog that submitted it; its completion
   * must not close a replacement the user opened while the request was out.
   */
  let newSessionDialogSequence = 0;

  /** Ceiling on a fork request. Without one, a daemon that accepts the
   * connection and never answers latches `forkInFlight` for the rest of the
   * picker's life, and `F` silently stops working. */
  const FORK_TIMEOUT_MS = 15_000;

  /**
   * Open the new-session dialog in fork mode over `session`: continue this
   * conversation, either beside the original or in a worktree of its own.
   *
   * The single entry point for both the `F` key and the row menu's Fork item.
   * `F` used to post a fork on the keystroke and the menu carried a second
   * item for the worktree variant; one item that always asks is fewer things
   * to learn, and the destination is the only decision a fork has.
   *
   * Everything else the request needs comes off the row, since a fork's agent
   * and directory are the source's — the dialog only carries enough of the
   * source to describe it, because the session list re-sorts under SSE while
   * a dialog is open.
   */
  function openForkDialog(session: EnrichedSession): void {
    openNewSession({
      cwd: sessionCwd(session),
      agent: session.agentType,
      fork: {
        sessionId: session.id,
        // The agent and the branch: between them they say which of a
        // directory's sessions this is, and the branch is also what a derived
        // worktree name is built from, so that preview is explained rather
        // than merely displayed.
        label: session.gitBranch
          ? `${session.agentType} · ${session.gitBranch}`
          : session.agentType,
        // A detached checkout reports the literal string "HEAD" here, which
        // is a branch column's honest answer and a naming rule's nonsense:
        // the daemon names a fork of one after the sha (`readCheckoutHead`),
        // so previewing `head-fork` promises a name nobody gets. Worse, the
        // preview is typeable — sent as an EXPLICIT name it would make the
        // second detached fork open the first one's checkout. Null instead,
        // which is the row's existing "a name is coming, just not one this
        // client can show" state. The label above keeps saying HEAD.
        branch: session.gitBranch === "HEAD" ? null : session.gitBranch,
        canWorktree: canForkIntoWorktree(session),
        pane: session.tmuxPane ?? null,
      },
    });
  }

  /**
   * Where a fork's new pane goes, in the daemon's own terms.
   *
   * The two destinations differ, and the difference is the point. A fork that
   * stays in the source's checkout is a sibling of THAT conversation, so a
   * split is taken out of the source's own pane (`target`) — which is what the
   * one-shot `F` always did. A fork into a worktree has left that context
   * behind, so it follows the ordinary spawn rule and splits the CALLER's pane
   * instead; an explicit `target` there would insert a window mid-session and
   * renumber everything after it.
   *
   * Falling back to `callerPane` also covers a source with no pane to sit
   * beside: with no placement at all the daemon runs a bare `new-window`, and
   * having no client of its own tmux picks its MRU session — so the window
   * lands somewhere unrelated and the jump afterwards drags the user there.
   */
  async function forkPlacement(
    draft: NewSessionDraft,
    fork: NewSessionFork,
  ): Promise<{
    split: "h" | "v" | false;
    target?: string;
    callerPane?: string;
  }> {
    let split = SPAWN_SPLIT[draft.placement];
    if (draft.destination !== "worktree" && split !== false && fork.pane) {
      return { split, target: fork.pane };
    }
    const callerPane = await resolveSpawnPane();
    // A sidebar alone in its window has nothing to split but itself, and the
    // daemon's placement-less `split-window` would halve the rail.
    if (split !== false && callerPane === null && props.sidebar) {
      split = false;
      store.actions.showToast("No pane to split here; opened a window");
    }
    return { split, callerPane: callerPane ?? undefined };
  }

  /**
   * Whether an overlay currently owns the screen.
   *
   * The keyboard handler returns early for each of these before it reaches
   * the main switch, so they are already modal for keys. The mouse handlers
   * read the SAME predicate rather than repeating the list, because the
   * repeated list is what let two overlays ship modal for the keyboard and
   * transparent to clicks: neither this dialog nor the Worktrees panel was
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
      store.state.worktrees !== null ||
      store.state.notice !== null ||
      store.state.copyDialog !== null ||
      store.state.handoffDialog !== null
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
    // A click while aiming a handoff picks that row, the same as Enter on it.
    // The alternative is the ordinary activation, which in the one-shot picker
    // switches panes and EXITS, losing both the pick and the surface it was
    // being made on.
    if (store.state.handoffPick) {
      commitHandoffPick();
      return;
    }
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
   * Identity of a particular row-menu opening. The menu component stays
   * mounted when one open menu is replaced by another, so row identity alone
   * is not enough: reopening the same row must also clear pointer snapshots.
   */
  const [menuOpenGeneration, setMenuOpenGeneration] = createSignal(0);

  /**
   * Ask whether a row's checkout is dirty, for the menu gate.
   *
   * The answer arrives after the menu is already on screen, so the menu
   * reserves its height and freezes its pointer targets on first hover (see
   * `sessionMenuItems` and `ContextMenu`). There is deliberately no
   * placeholder or "checking…" row in the meantime: the item is simply
   * absent, so the menu never shows something that isn't actionable.
   *
   * The directory is named explicitly rather than left to the endpoint's
   * default, even though the two rules agree today. This client is what will
   * POST the move, and it decides the source directory here, from this
   * snapshot of the row; the daemon would answer from its own pane cache,
   * which can be a tick behind. Asking about a different checkout than the one
   * the move will run in is how a gate ends up offering an action that then
   * refuses — or hiding one that would have worked.
   */
  function refreshMenuDirty(
    session: EnrichedSession,
    openGeneration: number,
  ): void {
    const sessionId = session.id;
    setMenuDirty(null);
    const url = new URL(`${getDaemonUrl()}/sessions/${sessionId}/dirty`);
    url.searchParams.set("cwd", sessionCwd(session));
    fetch(url, {
      signal: AbortSignal.timeout(5_000),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { dirty?: boolean };
        // Only apply it if this PARTICULAR opening of that row's menu is
        // still live. Session identity alone is not enough: close/reopen on
        // the same row can leave the earlier request racing the new one.
        if (
          store.state.contextMenu?.sessionId !== sessionId ||
          menuOpenGeneration() !== openGeneration
        ) {
          return;
        }
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
    if (modalOverlayOpen() || store.state.handoffPick) {
      return;
    }
    store.actions.setSelectedIndex(index);
    openRowMenu(item, event.x, event.y, false);
  }

  /**
   * Open the menu `item` owns at a screen position, lighting its first item
   * when `focusFirst` (the keyboard's way in; the pointer highlights by
   * hovering instead).
   *
   * Shared by the pointer and the `m` key so the two can only ever differ in
   * where the menu is anchored and whether a row starts lit. Everything that
   * makes a menu what it is — which menu, and the dirty question that gates
   * "Move changes" — happens once, here.
   *
   * The first item is resolved AFTER the menu is open, because the item lists
   * are built from the open menu's own state: there is no list to take a
   * first item from until the state names which row the menu belongs to.
   */
  function openRowMenu(
    item: FlatItem,
    x: number,
    y: number,
    focusFirst: boolean,
  ): void {
    const openGeneration = menuOpenGeneration() + 1;
    setMenuOpenGeneration(openGeneration);
    if (item.type === "session") {
      const session = item.filteredSession.session;
      store.actions.showContextMenu(session.id, x, y);
      // Same condition both consumers gate on (`sessionMenuItems` and
      // `sessionMenuReservedRows`): a background row has no move to offer, so
      // asking would spend a `git status -uall` on an answer nobody reads.
      if (session.trackingMode !== "background") {
        refreshMenuDirty(session, openGeneration);
      }
    } else {
      store.actions.showGroupContextMenu(item.groupKey, x, y);
    }
    if (!focusFirst) return;
    const first = menuItems()[0];
    if (first) store.actions.setMenuHighlight(first.id);
  }

  /** The open menu's items, whichever menu that is, in the order they are
   *  drawn — the one list the keys, the highlight and the render all read. */
  function menuItems(): ContextMenuItem[] {
    if (store.state.contextMenu) return sessionMenuItems();
    if (store.state.groupContextMenu) return groupMenuItems();
    return [];
  }

  /** How the list answers where a row is on screen; see `SessionList`'s
   *  `onRowAnchor`. Undefined until the list has rows to draw. */
  let rowAnchor: RowAnchor | undefined;

  /**
   * The `m` key: open the selected row's menu, or close the one that is open.
   *
   * A toggle rather than a second way in, because `m` is also the key the
   * menu itself closes on — pressing it twice has to land somewhere sensible,
   * and reopening the menu you just dismissed is not it.
   *
   * The anchor comes from the list rather than from the row: only the list
   * knows where its rows currently are, and a menu that opened at a fixed
   * corner would leave the user to work out which row it belonged to.
   */
  function toggleRowMenu(): void {
    // Every overlay in this predicate already returns before the key switch
    // reaches `m`, so this is the second lock on the same door — kept because
    // the FIRST one is an ordering, and the comment on `modalOverlayOpen`
    // exists because an ordering is exactly what two overlays have already
    // been left out of. A menu opened under a dialog would be unreachable:
    // the dialog's key branch runs first, so nothing could dismiss it.
    if (modalOverlayOpen()) return;
    if (store.state.contextMenu || store.state.groupContextMenu) {
      store.actions.hideContextMenu();
      store.actions.hideGroupContextMenu();
      return;
    }
    const item = store.selectedFlatItem();
    if (!item) return;
    const anchor = rowAnchor?.(store.selectedIndex());
    // No anchor means no drawn list to anchor in, which is also a list with
    // nothing selected — so there is nothing to open a menu about.
    if (!anchor) return;
    // The first item lit: `m` is a keyboard action, and Enter has to have
    // somewhere to land the moment the menu appears.
    openRowMenu(item, anchor.x, anchor.y, true);
  }

  /**
   * Keys while a row menu is open.
   *
   * Only the ones the menu itself answers to are taken — navigation, Enter,
   * esc/`m`, and any item's own `key` accelerator; everything else closes
   * the menu and falls through to its ordinary meaning, which is what this
   * surface has always done with a menu on screen (a keypress means
   * attention has moved on). Returning true here means the key was the
   * menu's and the caller must stop.
   */
  function handleContextMenuKey(event: KeyEvent): boolean {
    const key = event.name;
    const items = menuItems();
    if (key === "j" || key === "down") {
      store.actions.moveMenuHighlight(
        1,
        items.map((i) => i.id),
      );
      return true;
    }
    if (key === "k" || key === "up") {
      store.actions.moveMenuHighlight(
        -1,
        items.map((i) => i.id),
      );
      return true;
    }
    if (key === "return" || key === "enter") {
      const menu = store.state.contextMenu ?? store.state.groupContextMenu;
      // Nothing lit (a menu the pointer opened), or an item that has since
      // left the list, means Enter has no target. Closing, or falling back to
      // whatever now sits in that row, would be a guess at what was meant.
      const highlighted = items.find((i) => i.id === menu?.highlight);
      // The item's own action closes the menu — every one of them does, and
      // doing it here as well would hide a menu the action meant to keep.
      highlighted?.action();
      return true;
    }
    if (key === "escape" || key === "m") {
      store.actions.hideContextMenu();
      store.actions.hideGroupContextMenu();
      return true;
    }
    // An item's own accelerator, for actions whose natural key means
    // something else on the list and so cannot ride the fall-through. Gated
    // to a bare keypress so a modified chord meant for something else (e.g.
    // Alt+H resizing the preview pane) doesn't get shadowed by an item whose
    // accelerator happens to share the same base key.
    const accelerated =
      !event.ctrl && !event.meta && !event.shift && !event.option
        ? items.find((i) => i.key === key)
        : undefined;
    if (accelerated) {
      // The action closes the menu itself, exactly as it does from Enter.
      accelerated.action();
      return true;
    }
    return false;
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
   * Repo to scope the Worktrees panel to: the selected session's, or — when a
   * group header is selected — one from the group. The repo comes off a
   * session rather than the group key because a group key is a display label,
   * while `mainRepoRoot` is the same value for a worktree and its main
   * checkout, which is exactly what the panel keys off. Null lists every
   * known repo.
   */
  function selectedRepoRoot(): string | null {
    return (
      store.selectedSession()?.mainRepoRoot ??
      store.selectedGroupSessions().find((s) => s.mainRepoRoot)?.mainRepoRoot ??
      null
    );
  }

  function groupContextMenuWorktrees() {
    const cm = store.state.groupContextMenu;
    if (!cm) return;
    const repo = selectedRepoRoot();
    store.actions.hideGroupContextMenu();
    store.actions.showWorktrees(repo);
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
    if (session && canForkSession(session)) openForkDialog(session);
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

  /**
   * Whether the transcript endpoint has any chance of answering for this row.
   *
   * It reads the agent's own transcript and degrades to a capture of the
   * session's pane, so a row with neither is the one case we can rule out from
   * here. Every other row is a question only the daemon can answer, and the
   * toast is where a refusal belongs. Hidden rather than disabled, as
   * everything else in this menu is.
   */
  function canCopyLastResponse(session: EnrichedSession | undefined): boolean {
    if (!session) return false;
    return session.tmuxPane != null || session.logPath != null;
  }

  /**
   * Put `turns` of this session's conversation on the clipboard.
   *
   * Asynchronous by design: the dialog is already closed when this starts, and
   * the toast is the only thing that reports how it went. Blocking the picker
   * on a daemon read would freeze every row over one row's transcript.
   *
   * `turns=1` is exactly one assistant entry (the frozen contract), so the
   * join below is a formality that keeps this honest if the endpoint ever
   * answers with more. Past one, the text is composed by the SAME renderer
   * `ccmux last` prints, so the two surfaces cannot drift into two formats for
   * the same exchange.
   */
  async function copyLastResponse(session: EnrichedSession, turns = 1) {
    store.actions.showToast(
      turns === 1 ? "Copying last response…" : `Copying last ${turns} turns…`,
      10_000,
    );
    try {
      const url = new URL(
        `${getDaemonUrl()}/sessions/${session.id}/transcript`,
      );
      url.searchParams.set("turns", String(turns));
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await response.json()) as {
        source?: string;
        turns?: { role?: string; text?: string }[];
        truncated?: boolean;
        error?: string;
      };
      if (!response.ok) {
        // The endpoint's own refusals name the reason ("no readable transcript
        // and no tmux pane"); passing one through beats a generic failure.
        store.actions.showToast(
          `Copy failed: ${data.error ?? `HTTP ${response.status}`}`,
          4_000,
        );
        return;
      }
      const received = data.turns ?? [];
      const text =
        turns === 1
          ? received
              .map((turn) => turn.text ?? "")
              .join("\n\n")
              .trim()
          : renderTurns(
              received.map((turn) => ({
                role: turn.role === "user" ? "user" : "assistant",
                text: turn.text ?? "",
              })),
            );
      // Trimmed for the TEST only: a multi-turn payload keeps whatever
      // whitespace the CLI would have printed, byte for byte.
      if (!text.trim()) {
        store.actions.showToast("Nothing to copy: no response yet", 3_000);
        return;
      }
      const result = await copyToClipboard(text, {
        osc52: (payload) => renderer.copyToClipboardOSC52(payload),
      });
      if (!result.ok) {
        store.actions.showToast("Copy failed: no clipboard available", 4_000);
        return;
      }
      // What was copied is not always the whole clean response, and a user who
      // pastes a screen capture into a peer agent should have been told so
      // BEFORE they paste: a size guard dropped content, or there was no
      // transcript to read and this is what the pane happened to be showing.
      // Source wins over the generic flag: a pane capture is ALWAYS
      // truncated (the daemon sets both), and "(pane capture)" is the more
      // informative caveat since it implies incompleteness and names the
      // reason, so it must not be shadowed by the flag it always sets too.
      const caveat =
        data.source === "pane"
          ? " (pane capture)"
          : data.truncated
            ? " (truncated)"
            : "";
      // Short enough to stay on ONE line inside the toast's 40-column cap,
      // caveat and all: the wrap otherwise splits "(pane capture)" across two
      // lines, which is where a caveat stops reading as one.
      store.actions.showToast(
        `Copied ${text.length.toLocaleString()} chars${caveat}`,
        caveat ? 4_000 : 2_500,
      );
    } catch {
      store.actions.showToast("Copy failed: daemon unreachable", 4_000);
    }
  }

  function contextMenuCopyLastResponse() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (session) store.actions.openCopyDialog(session.id);
  }

  /** The row the open Copy dialog is copying FROM, or undefined once it has
   *  left the board (an SSE removal under an open dialog). */
  function copyDialogSession(): EnrichedSession | undefined {
    const open = store.state.copyDialog;
    if (!open) return undefined;
    return store.state.sessions.find((s) => s.id === open.sessionId);
  }

  /** Close the Copy dialog and start the copy it was configuring. */
  function commitCopyDialog(): void {
    const open = store.state.copyDialog;
    if (!open) return;
    const session = copyDialogSession();
    store.actions.closeCopyDialog();
    if (!session) {
      store.actions.showToast("The session being copied is gone", 4_000);
      return;
    }
    void copyLastResponse(session, open.turns);
  }

  /**
   * The Copy dialog's key model.
   *
   * It owns the turns selector's keys (`turns-selection.ts`: j/k, the arrows
   * and the digits), Enter and Escape; every other key closes it WITHOUT
   * copying and without acting on the board. That last half is where it parts
   * company with the row menu, whose dismissing key goes on to mean what it
   * always means: the menu is a small popup anchored beside a row, while this
   * is a modal box over the middle of the list, and a `x` that both dismissed
   * it and reached the board would be one keystroke from killing the row it
   * was copying.
   */
  function handleCopyDialogKey(
    event: KeyEvent,
    open: NonNullable<typeof store.state.copyDialog>,
  ): void {
    const key = event.name;
    event.preventDefault();

    const turns = applyTurnsKey(key, open);
    if (turns) {
      store.actions.setCopyDialogTurns(turns.turns, turns.pendingDigit);
      return;
    }
    if (key === "return" || key === "enter") {
      commitCopyDialog();
      return;
    }
    store.actions.closeCopyDialog();
  }

  /**
   * Enter the pick-a-target mode for the row whose menu is open.
   *
   * The item is only ever offered when another session is on the board, so
   * failing here is the race where the last one left between the menu being
   * drawn and this running. It is reported rather than swallowed, since the
   * mode visibly does not open.
   */
  function contextMenuHandoff() {
    const cm = store.state.contextMenu;
    if (!cm) return;
    const session = store.state.sessions.find((s) => s.id === cm.sessionId);
    store.actions.hideContextMenu();
    if (!session) return;
    if (!store.actions.beginHandoffPick(session.id)) {
      store.actions.showToast("No other session in view to hand off to", 3_000);
    }
  }

  /** The session a pick-mode handoff would come FROM, or undefined once it
   *  has left the board (an SSE removal under an open pick). */
  function handoffSource(): EnrichedSession | undefined {
    const pick = store.state.handoffPick;
    if (!pick) return undefined;
    return store.state.sessions.find((s) => s.id === pick.fromSessionId);
  }

  /** How a session is named in the handed-off toast, the Copy dialog's
   *  title, and the pick banner when the source has no pane to point at.
   *  Agent plus project is what tells two rows of the same board apart. */
  function handoffLabel(session: EnrichedSession): string {
    return session.project
      ? `${session.agentType} · ${session.project}`
      : session.agentType;
  }

  /**
   * One end of the Hand off dialog, tokenized the way the session list reads
   * a row: project:branch, agent, pane. The pane matters most where the rest
   * matters least — a same-project handoff differs by nothing else. Falls
   * back to the bare id the dialog still holds when the session has left the
   * board under it (Enter then reports the loss rather than sending).
   */
  function handoffEndpoint(
    session: EnrichedSession | undefined,
    fallbackId: string,
  ): HandoffEndpoint {
    if (!session) {
      return { context: fallbackId, agent: "", agentColor: "", pane: "" };
    }
    const project = session.project || session.id;
    return {
      context: session.gitBranch ? `${project}:${session.gitBranch}` : project,
      agent: getAgentDisplayName(session.agentType),
      agentColor: agentColorFor(session.agentType),
      pane: session.tmuxTarget ?? "",
    };
  }

  /**
   * Hand the source's last response to `to`, and say what the daemon did with
   * it.
   *
   * The three outcomes are the endpoint's, reported as they come: DELIVERED
   * (the target was idle and has the text now), QUEUED (the target was working
   * and gets it when the turn ends, which the row's own badge then shows), and
   * REFUSED. A refusal's reason is passed through verbatim rather than
   * rewritten: the guard stack refuses for reasons the user has to act on (a
   * target with a permission prompt up, a source with no readable transcript),
   * and a house-style summary of one of those is a worse sentence than the one
   * the daemon already wrote.
   *
   * An ambiguity refusal cannot happen here. Both ends are sent as session
   * IDs, which is the resolver's exact tier, so there is never a candidate
   * list to render: the pick IS the disambiguation.
   */
  async function handOffTo(
    from: EnrichedSession,
    to: EnrichedSession,
    turns: number,
    note: string,
  ) {
    const target = handoffLabel(to);
    store.actions.showToast(`Handing off to ${target}…`, 15_000);
    try {
      const response = await fetch(`${getDaemonUrl()}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `turns` is sent even when it is 1 (the endpoint's default), because
        // what this client promises is the count the dialog was showing, not
        // whatever the default becomes. A blank note is OMITTED rather than
        // sent empty: the header drops it either way, and a field that is not
        // there cannot be misread as one that was cleared.
        body: JSON.stringify({
          from: from.id,
          to: to.id,
          turns,
          ...(note.trim() ? { note } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await response.json()) as {
        status?: string;
        chars?: number;
        truncated?: boolean;
        error?: string;
      };
      if (!response.ok) {
        store.actions.showToast(
          `Handoff refused: ${data.error ?? `HTTP ${response.status}`}`,
          8_000,
        );
        return;
      }
      const size = `${(data.chars ?? 0).toLocaleString()} chars${
        data.truncated ? ", truncated" : ""
      }`;
      if (data.status === "queued") {
        store.actions.showToast(
          `Queued for ${target} (${size}); it lands when the turn ends`,
          5_000,
        );
        return;
      }
      store.actions.showToast(`Handed ${size} to ${target}`, 4_000);
    } catch {
      store.actions.showToast("Handoff failed: daemon unreachable", 4_000);
    }
  }

  /**
   * Pick the selected row as the handoff target and open the dialog that says
   * how much to send with it.
   *
   * Nothing is delivered here. Aiming settles WHO, and the dialog settles what
   * they get, which is why the pick mode ends at this point rather than at
   * delivery: one gesture, one Escape to leave it.
   *
   * The two rows the selection can be sitting on that are not a target (a
   * group header, and the source itself) keep the mode open: leaving it on a
   * keypress that was aimed at nothing would cost the user the whole gesture.
   */
  function commitHandoffPick(): void {
    const from = handoffSource();
    if (!from) {
      store.actions.endHandoffPick();
      store.actions.showToast("The session being handed off is gone", 4_000);
      return;
    }
    const to = store.selectedSession();
    if (!to) return;
    if (to.id === from.id) {
      store.actions.showToast("A session cannot hand off to itself", 3_000);
      return;
    }
    store.actions.openHandoffDialog(from.id, to.id);
  }

  /**
   * End a pick whose gesture has lost its meaning under it, and say why.
   *
   * Both reasons arrive as an SSE update with no keypress behind them: the
   * source leaving the board (killed from a pane, or closed elsewhere), and
   * the last row that was not the source leaving it. The banner naming the
   * source disappears with the row either way, while the mode itself would
   * stay armed and go on swallowing every key until the next Enter or Escape,
   * which reads as a hung picker. Ending it here is what hands the list back
   * to the keyboard; the toast is what explains a mode that closed itself.
   */
  createEffect(() => {
    const pick = store.state.handoffPick;
    if (!pick) return;
    if (!store.state.sessions.some((s) => s.id === pick.fromSessionId)) {
      store.actions.endHandoffPick();
      store.actions.showToast("The session being handed off is gone", 4_000);
      return;
    }
    // Measured over the VISIBLE rows, the same list the pick was opened
    // against: a target the board is not showing is not one the user can aim
    // at, so a mode with none left is the dead end `beginHandoffPick` refuses
    // to open in the first place.
    const hasTarget = store
      .flatItems()
      .some(
        (item) =>
          item.type === "session" &&
          item.filteredSession.session.id !== pick.fromSessionId,
      );
    if (hasTarget) return;
    store.actions.endHandoffPick();
    store.actions.showToast("No other session left to hand off to", 4_000);
  });

  /** An end of the open Hand off dialog, or undefined once that row has left
   *  the board (an SSE removal under an open dialog). */
  function handoffDialogSession(
    end: "fromSessionId" | "toSessionId",
  ): EnrichedSession | undefined {
    const open = store.state.handoffDialog;
    if (!open) return undefined;
    return store.state.sessions.find((s) => s.id === open[end]);
  }

  /** Close the Hand off dialog and send what it was configuring. */
  function commitHandoffDialog(): void {
    const open = store.state.handoffDialog;
    if (!open) return;
    const from = handoffDialogSession("fromSessionId");
    const to = handoffDialogSession("toSessionId");
    store.actions.closeHandoffDialog();
    // Either end can leave the board while the dialog is up. Reported rather
    // than sent by id anyway: the daemon would refuse it, and this says which
    // half of the gesture is gone before a round trip does.
    if (!from) {
      store.actions.showToast("The session being handed off is gone", 4_000);
      return;
    }
    if (!to) {
      store.actions.showToast("The session being handed off to is gone", 4_000);
      return;
    }
    void handOffTo(from, to, open.turns, open.note);
  }

  /**
   * The Hand off dialog's key model.
   *
   * Escape cancels the WHOLE handoff (the pick mode is already over by the
   * time this is open, so one Escape leaves the gesture entirely) and Enter
   * sends from either row, so the fast path stays the pick plus Enter. Tab is
   * the only field switch: the turns row binds the arrows to the count, the
   * same way the Copy dialog does, and rebinding them here would make two
   * identical-looking rows answer the same key differently. From the note the
   * keys an input does not consume (down/up, ctrl-n/ctrl-p) move as well,
   * exactly as they do in the new-session dialog's text fields.
   *
   * While the note has focus every remaining key is the input's, `j` and `3`
   * included; while the turns row has focus every unclaimed key is SWALLOWED
   * rather than dismissing the dialog (the Copy dialog's rule), because a
   * stray key next to a text field is far more likely to be someone starting
   * to type their note on the wrong row than someone asking to leave.
   */
  function handleHandoffDialogKey(
    event: KeyEvent,
    open: NonNullable<typeof store.state.handoffDialog>,
  ): void {
    const key = event.name;

    if (key === "escape") {
      store.actions.closeHandoffDialog();
      event.preventDefault();
      return;
    }
    if (key === "return" || key === "enter") {
      commitHandoffDialog();
      event.preventDefault();
      return;
    }
    if (key === "tab" || key === "backtab") {
      store.actions.toggleHandoffDialogField();
      event.preventDefault();
      return;
    }

    if (open.field === "note") {
      if (key === "down" || (key === "n" && event.ctrl)) {
        store.actions.setHandoffDialogField("turns");
        event.preventDefault();
      } else if (key === "up" || (key === "p" && event.ctrl)) {
        store.actions.setHandoffDialogField("turns");
        event.preventDefault();
      }
      // Everything else belongs to the input, which needs the key left alone.
      return;
    }

    const turns = applyTurnsKey(key, open);
    if (turns) {
      store.actions.setHandoffDialogTurns(turns.turns, turns.pendingDigit);
    }
    event.preventDefault();
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
            id: "review",
            label: "Review diff",
            hint: "d",
            color: theme.text,
            action: contextMenuReview,
          },
        ]
      : [];
    const copyItem: ContextMenuItem[] = canCopyLastResponse(session)
      ? [
          {
            // The id stays what it always was: it is identity, not copy, and
            // the keyboard highlight is stored as one (see `ContextMenuItem`).
            id: "copy-last-response",
            // The action it opens asks HOW MUCH to copy, so the item is the
            // verb alone; the dialog says the rest in full sentences it has
            // the width for.
            label: "Copy",
            hint: "y",
            color: theme.text,
            action: contextMenuCopyLastResponse,
          },
        ]
      : [];
    // Offered on every row that has somewhere to hand off TO, which is the
    // only half of the question this side can answer. Whether the SOURCE can
    // be read at all is the daemon's (nine readers, two of which find their
    // transcript from the cwd with no `logPath` on the row to check), so a
    // source it refuses is reported in the toast rather than guessed at here.
    const handoffItem: ContextMenuItem[] =
      session && store.state.sessions.some((s) => s.id !== session.id)
        ? [
            {
              id: "handoff-to",
              label: "Hand off",
              // Menu-local (`key`), unlike its neighbours' hints: on the
              // list itself `h` collapses a group.
              hint: "h",
              key: "h",
              color: theme.text,
              action: contextMenuHandoff,
            },
          ]
        : [];
    const newSessionItem: ContextMenuItem = {
      id: "new-session",
      label: "New session",
      hint: "n",
      color: theme.text,
      action: contextMenuNewSession,
    };
    const killItem: ContextMenuItem = {
      id: "kill",
      label: "Kill",
      hint: "x",
      color: theme.red,
      action: () => contextMenuConfirm("kill"),
    };
    if (session?.trackingMode === "background") {
      return [
        {
          id: "attach-agent",
          label: "Attach agent",
          hint: "enter",
          color: theme.green,
          action: contextMenuAttachAgent,
        },
        {
          id: "agent-view",
          label: "Open agent view",
          hint: "",
          color: theme.text,
          action: contextMenuOpenAgentView,
        },
        newSessionItem,
        ...reviewItem,
        ...copyItem,
        ...handoffItem,
        // Last here too: the destructive action is the one that must never
        // slide under a pointer (or a highlight) reaching for something else,
        // and the bottom is the only position nothing can be appended below.
        killItem,
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
              id: "move-changes",
              // Must fit ContextMenu's fixed 22-col box on ONE line: the
              // component computes its height as `items.length + 2`, so a
              // label that wraps renders two rows and silently breaks the
              // height (and therefore the clamping) for the whole menu. The
              // full phrase lives in the dialog this opens.
              label: "Move changes",
              hint: "",
              color: theme.text,
              action: contextMenuMoveChanges,
            },
          ]
        : [];
    // Hidden rather than disabled when the agent or the row can't be forked:
    // an item that is only ever there for Claude rows with hooks installed
    // would otherwise read as broken on every other row. Where the fork can
    // GO is the dialog's question, not this item's — a row outside a
    // repository still forks, just with nowhere to put a worktree.
    const forkItem: ContextMenuItem[] = canForkSession(session)
      ? [
          {
            id: "fork",
            label: "Fork",
            hint: "F",
            color: theme.text,
            action: contextMenuFork,
          },
        ]
      : [];
    // Ordered by what the actions DO, not by when they arrive: the things
    // that start something (attach, spawn, fork), then the things that read
    // (review the diff, copy the last response, hand that response to another
    // session), then the ones that move work about, and the two that end a
    // session last — Kill at the bottom, where a destructive action is hardest
    // to hit by accident.
    //
    // Two of these come and go under an open menu. "Move changes" appears
    // when the dirty check answers, and Fork disappears on an SSE update that
    // drops `nativeSessionId`. Neither is last any more, so each shifts the
    // rows below it. The keyboard highlight is stored as an item ID so it
    // follows the same action through that shift; once the pointer enters a
    // row, ContextMenu freezes the rendered list instead, because a pointer
    // addresses a screen coordinate and must never find a different action
    // there on mouse-down.
    return [
      {
        id: "attach",
        label: "Attach",
        hint: "enter",
        color: theme.green,
        action: contextMenuAttach,
      },
      newSessionItem,
      ...forkItem,
      ...reviewItem,
      ...copyItem,
      ...handoffItem,
      ...moveChangesItem,
      {
        id: "restart",
        label: "Restart",
        hint: "r",
        color: theme.text,
        action: () => contextMenuConfirm("restart"),
      },
      killItem,
    ];
  }

  /**
   * Rows the row menu holds for the "Move changes" item that may still
   * arrive. See `ContextMenu`'s `reservedRows`: this is what keeps a
   * bottom-clamped menu from sliding up as the dirty answer lands.
   *
   * About the BOX, not the item's own position, which is why it still reads
   * the same way now that the item lands mid-list rather than at the end: the
   * menu grows by one row whichever slot the row goes into, and a menu
   * clamped against the bottom edge grows upward — moving every row it
   * already had.
   *
   * Held from the moment the menu opens until it closes, and released only
   * once the item is actually IN the list — a menu that never gets the item
   * keeps the row of air, because taking it back moves the menu just as
   * surely as growing into it would.
   */
  function sessionMenuReservedRows(): number {
    const cm = store.state.contextMenu;
    const session = cm
      ? store.state.sessions.find((s) => s.id === cm.sessionId)
      : undefined;
    // Background rows never offer the move, so they have nothing to hold.
    if (!session || session.trackingMode === "background") return 0;
    const dirty = menuDirty();
    const shown = dirty?.sessionId === session.id && dirty.dirty;
    return shown ? 0 : 1;
  }

  function groupMenuItems(): ContextMenuItem[] {
    const cm = store.state.groupContextMenu;
    const isCollapsed = cm ? store.collapsedGroups().has(cm.groupKey) : false;
    return [
      {
        // One id for both labels: it is one action whose name reflects the
        // group's current state, and a highlight must not drop off it because
        // the group collapsed underneath.
        id: "collapse",
        label: isCollapsed ? "Expand" : "Collapse",
        hint: "space",
        color: theme.text,
        action: groupContextMenuToggleCollapse,
      },
      {
        id: "new-session",
        label: "New session",
        hint: "n",
        color: theme.text,
        action: groupContextMenuNewSession,
      },
      {
        id: "pin-top",
        label: "Pin to top",
        hint: "<",
        color: theme.text,
        action: () => groupContextMenuPin("top"),
      },
      {
        id: "pin-bottom",
        label: "Pin to bottom",
        hint: ">",
        color: theme.text,
        action: () => groupContextMenuPin("bottom"),
      },
      {
        id: "worktrees",
        label: "Worktrees",
        hint: "W",
        color: theme.text,
        action: groupContextMenuWorktrees,
      },
      {
        id: "kill-group",
        label: "Kill group",
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
    fork?: NewSessionFork;
    /** Start in this worktree, which is already on disk (issue #102). The
     *  Worktrees panel's own entry point; it is the working directory too, so
     *  `cwd` may simply repeat it. */
    existingWorktree?: string;
    /** Cut a worktree from this pull request's head (issue #151). The
     *  Worktrees panel's Enter on a PR row that is not checked out here. */
    pr?: NewSessionPR;
    /** Origin marker set ONLY by the Worktrees panel's Enter: a cancel of
     *  this dialog returns to the panel, cursor on `cursor`, scoped to the
     *  live filter the panel had (`scope`, null when Tab had widened it). */
    returnToWorktrees?: {
      repo: string | null;
      scope: string | null;
      cursor: string;
    };
  }): void {
    // Mirrors `reviewSession`: refuse at the point of intent rather than
    // opening a dialog with a blank Directory row whose Enter round-trips
    // to a 400 from the daemon. A FORK is exempt: it sends no cwd at all (the
    // daemon reads the source's), so a row whose directory never reached this
    // client is still perfectly forkable, and refusing would break the `F`
    // key on it for the sake of one blank row.
    if (!context.cwd && !context.fork) {
      store.actions.showToast("Can't start here: no working directory");
      return;
    }
    // Fork mode inherits its agent from the source session and neither draws
    // nor submits the Agent field. Keep the per-open refresh for every mode
    // that actually offers that field, but do not pay for preferences/PATH
    // resolution on a fork dialog that cannot consume the answer.
    if (!context.fork) ensureSpawnableAgents();
    newSessionDialogSequence += 1;
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
      fork: context.fork,
      existingWorktree: context.existingWorktree,
      pr: context.pr,
      returnToWorktrees: context.returnToWorktrees,
    });
  }

  /**
   * Escape/cancel on the new-session dialog. A dialog the Worktrees panel
   * opened returns there with the cursor back on its row; every other origin
   * (n, the row menus) just closes, and SUBMIT never comes back here at all,
   * because a successful spawn hands the board to the new session.
   */
  function cancelNewSession(): void {
    const marker = store.state.newSession?.returnToWorktrees ?? null;
    store.actions.closeNewSessionDialog();
    if (marker) {
      store.actions.showWorktrees(marker.repo, {
        initialCursor: marker.cursor,
        isReturn: true,
        startWidened: marker.repo !== null && marker.scope === null,
      });
    }
  }

  // The dialog opens before `/agents` answers, and the row's own agent may
  // not even be spawnable here (detected by pane scanning, absent from
  // PATH). Reconcile once the list lands rather than leaving a draft that
  // would 400 on Enter.
  createEffect(() => {
    const list = spawnableAgents();
    const draft = store.state.newSession;
    if (!list || list.length === 0 || !draft) return;
    // Except in fork mode, where the agent is the SOURCE's and the request
    // never carries one. Reconciling there would rewrite the draft to name a
    // different agent than the session actually running — invisibly, since
    // the mode has no agent row.
    if (draft.fork) return;
    if (list.some((agent) => agent.name === draft.agent)) return;
    store.actions.setNewSessionAgent(list[0]!.name);
  });

  /**
   * The shared option accessor (`newSessionOptions`) with this surface's own
   * context filled in: the draft, the fetched agent list, and the same
   * height floor the dialog sizes itself against — below it the fields are
   * not on screen, and a number key must not act on choices nobody can see.
   */
  function optionFieldFor(
    field: NewSessionField,
  ): ReturnType<typeof newSessionOptions> {
    const draft = store.state.newSession;
    if (!draft) return null;
    return newSessionOptions(field, {
      draft,
      agents: spawnableAgents(),
      tooShort:
        appDims().height <
        newSessionFloorRows({
          moveChanges: draft.moveChanges,
          fork: draft.fork !== null,
          namesAWorktree: namesAWorktree(draft),
          existingWorktree: draft.existingWorktree !== null,
          pr: draft.pr !== null,
        }),
    });
  }

  /** `optionFieldFor` at the focused field, which is what the collapsed-mode
   *  keys act on. */
  function focusedOptionField(): ReturnType<typeof optionFieldFor> {
    const draft = store.state.newSession;
    return draft ? optionFieldFor(draft.field) : null;
  }

  /** Which key set the dialog is listening to, for the Footer's hint line —
   *  the same accessor the keys read, so the copy can never promise a key
   *  the routing would refuse. */
  const newSessionOptionMode = createMemo<"focused" | "dropdown" | undefined>(
    () => {
      const draft = store.state.newSession;
      if (!draft) return undefined;
      if (draft.dropdown) return "dropdown";
      return focusedOptionField() ? "focused" : undefined;
    },
  );

  /**
   * Commit `field`'s option at `index` and close its dropdown: the ONE write
   * path — the confirm keys, both 1-9 arms, the overlay's row clicks, and
   * the button row's confirm all funnel here. An index off the list commits
   * nothing and leaves any open dropdown up, so a `9` in a three-option list
   * stays a no-op.
   */
  function commitDropdown(field: NewSessionField, index: number): void {
    const resolved = optionFieldFor(field);
    const option = resolved?.options[index];
    if (!option) return;
    store.actions.setNewSessionOption(field, option.value);
    store.actions.closeNewSessionDropdown();
  }

  /** Clamped, not wrapping: in a three-item list, `k` teleporting to the
   *  bottom reads as a misfire rather than a nicety. */
  function moveNewSessionOption(delta: number): void {
    const draft = store.state.newSession;
    const resolved = focusedOptionField();
    if (!draft || !resolved) return;
    const next = Math.min(
      Math.max(resolved.selectedIndex + delta, 0),
      resolved.options.length - 1,
    );
    commitDropdown(draft.field, next);
  }

  /**
   * What to do once the current notice has been read — the picker's handover
   * to a pane that already exists, held back so the message is not carried
   * off screen by the exit it precedes. Null when the notice reports
   * something that has no next step.
   */
  let afterNotice: (() => void) | null = null;

  /** Acknowledge whatever the notice was reporting, then do what it was
   *  holding up. */
  function dismissNotice(): void {
    const next = afterNotice;
    afterNotice = null;
    store.actions.dismissNotice();
    next?.();
  }

  /**
   * What `POST /spawn` answers with, success or failure.
   *
   * One shape for both, because the halves overlap: a spawn that failed AFTER
   * relocating the changes carries the same `move` report a successful one
   * does, and it is the only place that says the user's work has left their
   * checkout. `stashSha`/`sourceRestored` describe a move that was refused
   * before that point. Every field is optional — an older daemon answers
   * without any of them (see the stale-daemon check in `reportMove`).
   */
  interface SpawnBody {
    paneId?: string;
    error?: string;
    worktree?: { name?: string };
    stashSha?: string;
    sourceRestored?: boolean;
    move?: MoveReport;
  }

  /**
   * The name a worktree-bound draft will travel under, or "" for an untouched
   * field. Settled by the daemon's own slug rule so that what the row showed
   * is what gets created.
   *
   * Empty is not "no name": it is the DERIVED state, which the daemon numbers
   * past a collision instead of opening what is already there. Only a typed
   * name travels.
   */
  function draftWorktreeName(draft: NewSessionDraft): string {
    return draft.worktreeName !== null ? slugify(draft.worktreeName) : "";
  }

  /**
   * A name was typed and nothing survives the slug rule (punctuation, a
   * non-Latin script). Refused rather than derived: the field would still be
   * showing the user's text while the worktree got a name they never chose.
   * The rule is named, because "why not" is the next question and the answer
   * is not guessable from the refusal.
   */
  function refuseUnslugifiableName(draft: NewSessionDraft): boolean {
    if (draft.worktreeName === null || draft.worktreeName.trim() === "") {
      return false;
    }
    if (draftWorktreeName(draft)) return false;
    store.actions.showToast(
      "A worktree name needs letters or numbers; clear the field to derive one",
      4000,
    );
    return true;
  }

  /**
   * Continue the dialog's source session (issue #70): the same conversation,
   * in the checkout it is already in or in a worktree of its own.
   *
   * Split from the spawn path rather than folded into it, because almost none
   * of that path applies: there is no agent to resolve, no prompt to check
   * against one, no cwd (the daemon reads the source's), and no last-agent to
   * remember. What it shares is the DIALOG — the same placement semantics and
   * the same derived-vs-explicit name.
   *
   * The one-at-a-time guard is the whole reason a landed fork is not simply
   * left to the daemon: one conversation must not become two panes because
   * Enter was pressed twice.
   */
  async function submitFork(draft: NewSessionDraft): Promise<void> {
    const fork = draft.fork;
    if (!fork) return;
    const toWorktree = draft.destination === "worktree";
    if (toWorktree && refuseUnslugifiableName(draft)) return;
    // Placement carries a `%N` from OUR tmux server; see `submitNewSession`.
    if (!ensureSameServer()) return;
    if (forkInFlight) {
      // Say so rather than dropping it silently, which is indistinguishable
      // from a dead key.
      store.actions.showToast("Fork already in progress");
      return;
    }
    forkInFlight = true;
    const dialogSequence = newSessionDialogSequence;
    const worktreeName = draftWorktreeName(draft);
    try {
      const placement = await forkPlacement(draft, fork);
      const response = await fetch(`${getDaemonUrl()}/spawn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fork: fork.sessionId,
          ...placement,
          // The jump below is this component's own exit path; letting the
          // daemon switch too would race it.
          detach: true,
          // Present even when empty, and absent entirely otherwise: the object
          // is what asks for a worktree at all, so a fork staying in the
          // source's checkout must not send one. Named only when one was
          // typed — left out, the daemon derives `<branch>-fork` from the
          // source checkout's own HEAD and numbers it past a collision, which
          // is what an untouched row asked for. Sent, it means that worktree
          // specifically, and an existing one of that name is opened rather
          // than sidestepped.
          worktree: toWorktree
            ? worktreeName
              ? { name: worktreeName }
              : {}
            : undefined,
        }),
        signal: AbortSignal.timeout(FORK_TIMEOUT_MS),
      });
      const body = (await response
        .json()
        .catch(() => null)) as SpawnBody | null;
      if (!response.ok || !body?.paneId) {
        // The dialog stays open: every refusal here (that name is taken, the
        // source is gone) is something to fix in the field still on screen.
        store.actions.showToast(
          `Fork failed: ${body?.error ?? response.statusText}`,
          4000,
        );
        return;
      }
      // The request may have outlived its dialog. An explicit dismissal or a
      // replacement draft means the user no longer wants this completion to
      // take over the picker, so neither close NOR navigate from stale work.
      const ownsDialog =
        newSessionDialogSequence === dialogSequence &&
        store.state.newSession?.fork?.sessionId === fork.sessionId;
      if (ownsDialog) {
        store.actions.closeNewSessionDialog();
      }
      // The daemon's name, not the row's preview: a derived name that collided
      // came back numbered.
      const created = body.worktree?.name;
      if (props.sidebar) {
        // The dialog's own convention, which an ordinary spawn from the rail
        // already follows: the sidebar is a board you watch, not a place you
        // launch from and leave. The toast is then the only account there is
        // of where the fork landed, so it says so even unnamed.
        store.actions.showToast(
          created
            ? `Forked into ${created}`
            : toWorktree
              ? "Forked into a new worktree"
              : "Forked in this checkout",
        );
        return;
      }
      if (!ownsDialog) {
        store.actions.showToast(
          created
            ? `Forked into ${created}`
            : toWorktree
              ? "Forked into a new worktree"
              : "Forked in this checkout",
        );
        return;
      }
      if (created) store.actions.showToast(`Forked into ${created}`);
      selectPane(body.paneId);
    } catch (err: unknown) {
      store.actions.showToast(`Fork failed: ${errText(err)}`, 4000);
    } finally {
      // In `finally`: a throw between the guard and the response would
      // otherwise latch the key for the rest of the picker's life.
      forkInFlight = false;
    }
  }

  async function submitNewSession(): Promise<void> {
    const draft = store.state.newSession;
    if (!draft) return;
    // Fork mode shares the dialog and almost nothing else; see above.
    if (draft.fork) {
      await submitFork(draft);
      return;
    }
    if (spawnInFlight) return;

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
    // Whether this spawn CREATES a worktree, which is what everything below
    // turns on. A session started in one that already exists does not, and
    // says so ahead of the destination: that mode has no Where row to have
    // set it, so a `worktree` block built from a stale value would ask the
    // daemon to make a second checkout next to the one that was chosen.
    // A PR spawn is excluded even though it creates a worktree: the daemon
    // derives its name and its base from the PR, and `POST /spawn` refuses
    // `pr` alongside `worktree.name`, `worktree.base` and
    // `worktree.withChanges`. There is nothing for a `worktree` block to
    // carry that would not be a 400.
    const toWorktree =
      draft.existingWorktree === null &&
      draft.pr === null &&
      draft.destination === "worktree";
    // The name the request will carry. Empty means an untouched field: let
    // the daemon derive one.
    const worktreeName = toWorktree ? draftWorktreeName(draft) : "";
    if (toWorktree && refuseUnslugifiableName(draft)) {
      return;
    }
    // With neither a name nor a prompt to derive one from there is nothing to
    // create. Refused here rather than posted: the daemon's own refusal reads
    // "pass one explicitly", which was CLI advice back when this dialog had
    // no field to act on it with.
    if (toWorktree && !worktreeName && !slugFromPrompt(prompt)) {
      store.actions.showToast(
        "Name the worktree, or type a prompt to derive one from",
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
    let spawned: SpawnBody | null = null;
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
          // The whole of a PR spawn's request: the daemon re-runs `lookupPR`,
          // refuses a PR that is no longer OPEN, derives the worktree name
          // with `slugForPR` and seeds the prompt under its own header. No
          // openness is proved here on purpose — a row seconds out of date
          // then fails with the daemon's own message rather than this
          // client's guess.
          pr: draft.pr?.number,
          // A name is sent only when one was TYPED. Left out, the daemon
          // derives it from the prompt by the same rule the row previews and
          // numbers it past a collision; sent, it means that worktree
          // specifically, and an existing one of that name is opened rather
          // than sidestepped. Posting the preview as if it had been typed
          // would silently swap the first behaviour for the second.
          //
          // In move-changes mode the same field carries the move: the daemon
          // routes creation through it, so the worktree is made once, with
          // the changes already in it.
          worktree: toWorktree
            ? {
                ...(worktreeName ? { name: worktreeName } : {}),
                ...(draft.moveChanges
                  ? { withChanges: true, untracked: draft.untracked }
                  : {}),
              }
            : undefined,
        }),
      });
      const body = (await response
        .json()
        .catch(() => null)) as SpawnBody | null;
      if (response.ok) {
        spawned = body ?? {};
      } else {
        // Leave the dialog open either way: most refusals here (agent can't
        // take a prompt, cwd is gone, that worktree name is taken) are
        // something the user can fix in the fields they are still looking at.
        // A PR spawn is the exception, and deliberately behaves the same: the
        // daemon re-runs `lookupPR`, so a PR that closed or merged since the
        // panel listed it refuses with nothing on this dialog to change. Esc
        // back to the panel is the remedy, and the daemon's own wording says
        // what happened.
        //
        // What changes is how the message is delivered. A move can fail with
        // the user's work parked in a stash, or after it has already been
        // relocated, and those hand them something to do afterwards — a
        // four-second toast that truncates a sha is the same as saying
        // nothing. The daemon's own text leads in both cases: it is written
        // to be actionable, and the fallback exists only for a body that
        // never arrived.
        const error = body?.error ?? response.statusText;
        const what = draft.moveChanges ? "Move failed" : "Spawn failed";
        if (body && failureNeedsAcknowledgement(body)) {
          store.actions.showNotice(what, [
            error,
            ...stashRecoveryLines(body),
            ...(body.move ? moveReportLines(body.move, draft.cwd) : []),
          ]);
        } else {
          store.actions.showToast(`${what}: ${error}`, 4000);
        }
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
    // Const so the closures below keep the narrowing; `spawned` is the flag
    // the `finally` above writes.
    const landed = spawned;

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

    /** Hand the board over to the new pane, which is what the picker is for. */
    const enterPane = () => {
      // The daemon already selected the new pane's window; tell the other
      // boards so their active-row highlight doesn't lag a scan behind.
      if (landed.paneId) notifyActivePane(landed.paneId);
      if (!props.persistent) process.exit(0);
    };

    const notice = landedMoveNotice(draft, landed);
    if (notice) {
      // INTERPOSED, not instead of: the pane is real and the picker still
      // hands over to it, but not before the one thing that outlives the
      // spawn has been read. Exiting first would take the message with it.
      store.actions.showNotice(notice.title, notice.lines);
      if (!detach) afterNotice = enterPane;
      return;
    }
    if (detach) {
      // The daemon's name, not the row's preview: a derived name that
      // collided came back numbered, and a toast repeating the preview would
      // name a worktree the spawn did not land in.
      const created = landed.worktree?.name;
      // The sidebar never follows the pane, so this line is the only account
      // of an operation that emptied a checkout.
      const summary = landed.move ? ` · ${moveSummary(landed.move)}` : "";
      store.actions.showToast(
        created
          ? `Spawned ${agent.displayName} in ${created}${summary}`
          : `Spawned ${agent.displayName}${summary}`,
      );
      return;
    }
    enterPane();
  }

  /**
   * What a LANDED spawn still owes the user, or null when it owes nothing.
   *
   * Two cases, and both outlive the spawn. A move can complete and still leave
   * a stash entry to drop or a staged/unstaged split to rebuild; and a daemon
   * predating the move drops the keys it does not know, answers a perfectly
   * ordinary 200, and starts the agent in an empty worktree while the work
   * sits untouched where it always was. The missing report is the only
   * evidence there is for the second, which is why an absent `move` on a
   * request that asked for one is a failure and not a shrug.
   */
  function landedMoveNotice(
    draft: NonNullable<typeof store.state.newSession>,
    body: SpawnBody,
  ): { title: string; lines: string[] } | null {
    if (draft.moveChanges && !body.move) {
      return {
        title: "Changes were not moved",
        lines: [
          `The ccmux daemon is an older build that cannot move changes, so yours were not moved: they are still in ${draft.cwd}.`,
          "Restart it with `ccmux daemon restart` from this build, then move them again.",
        ],
      };
    }
    if (body.move && moveNeedsAcknowledgement(body.move)) {
      return {
        title: "Changes moved, with one thing left over",
        lines: moveReportLines(body.move, draft.cwd),
      };
    }
    return null;
  }

  /**
   * The open dropdown overlay owns every key while it is up: it is modal
   * within an already-modal dialog, so nothing here falls through to the
   * field handling below. Escape closes it without touching the draft, which
   * is why the dialog's own Escape (close the whole dialog) must not see it.
   */
  function handleDropdownKey(
    event: KeyEvent,
    open: { field: NewSessionField; index: number },
  ): void {
    const key = event.name;
    const field = optionFieldFor(open.field);

    // A field with nothing to offer (or one the terminal has shrunk out
    // from under) closes on any key rather than acting invisibly.
    if (!field || field.options.length === 0) {
      store.actions.closeNewSessionDropdown();
      event.preventDefault();
      return;
    }

    const count = field.options.length;
    // h/left mirror the l/right that opened it; like Escape they close
    // without committing the highlight.
    if (key === "escape" || key === "h" || key === "left") {
      store.actions.closeNewSessionDropdown();
    } else if (
      key === "return" ||
      key === "enter" ||
      // The keys that opened it confirm it: the standard combobox toggle,
      // and what a hand still resting on space/l expects.
      key === "space" ||
      key === "l" ||
      key === "right"
    ) {
      commitDropdown(open.field, Math.min(open.index, count - 1));
    } else if (key === "j" || key === "down") {
      store.actions.setNewSessionDropdownIndex((open.index + 1) % count);
    } else if (key === "k" || key === "up") {
      store.actions.setNewSessionDropdownIndex(
        (open.index - 1 + count) % count,
      );
    } else if (key >= "1" && key <= "9") {
      commitDropdown(open.field, parseInt(key, 10) - 1);
    }
    event.preventDefault();
  }

  function handleNewSessionKey(event: KeyEvent): void {
    const draft = store.state.newSession;
    if (!draft) return;
    const key = event.name;

    if (draft.dropdown !== null) {
      handleDropdownKey(event, draft.dropdown);
      return;
    }

    if (key === "escape") {
      cancelNewSession();
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

    // A text input owns every remaining key while it has focus, so a prompt
    // (or a worktree name) can contain `j`, `3`, or anything else a field
    // shortcut would otherwise swallow. Field movement there is limited to
    // the keys the input doesn't consume, exactly as in search mode.
    if (draft.field === "prompt" || draft.field === "worktreeName") {
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
      commitDropdown(draft.field, parseInt(key, 10) - 1);
    } else if (key === "space" || key === "l" || key === "right") {
      // Space or l/right, not Enter: Enter is "spawn" from every field, and
      // an option field is often where focus sits, so taking it for the
      // dropdown would put an overlay between the most common flow (open,
      // Enter) and its spawn. This branch is unreachable from the text
      // fields, which returned above with every printable key intact.
      // `focusedOptionField` carries the mode and too-short-to-draw guards.
      const field = focusedOptionField();
      if (field && field.options.length > 0) {
        store.actions.openNewSessionDropdown(draft.field, field.selectedIndex);
      }
    }
    // Everything else is swallowed: the dialog is modal, and letting `q`
    // through would quit the picker mid-edit.
    event.preventDefault();
  }

  function confirmDialogAction() {
    const action = store.state.confirmAction;
    const sessionId = store.state.confirmSessionId;
    // Fired after the dialog is hidden, so what it does (reopen the
    // Worktrees panel) lands on a screen the dialog has already left.
    let afterResolve: (() => void) | undefined;
    if (action === "send-review" && sessionId) {
      const pending = pendingReviewNotes;
      pendingReviewNotes = null;
      afterResolve = pending?.onDone;
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
    afterResolve?.();
  }

  /**
   * The confirm dialog's No/escape, shared by the key handler and the
   * dialog's own cancel. Pending review notes are consumed here so a
   * cancelled hand-back can never be delivered by a later confirm, and
   * their `onDone` still fires: a cancel resolves the round-trip exactly as
   * a confirm does, and the Worktrees panel reopen riding it must not be
   * lost with the notes.
   */
  function cancelConfirmDialog() {
    const wasReview = store.state.confirmAction === "send-review";
    const pending = pendingReviewNotes;
    pendingReviewNotes = null;
    store.actions.hideConfirmDialog();
    if (wasReview) pending?.onDone?.();
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
    const dims = useSharedTerminalDimensions();
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

    // First, and it swallows the key that dismissed it. This is raised over
    // whatever was already on screen (including the new-session dialog, which
    // stays open behind it), so a key that both dismissed the notice and
    // reached the dialog would act on a message the user had not read yet.
    if (store.state.notice) {
      dismissNotice();
      event.preventDefault();
      return;
    }

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

    // The Worktrees panel owns every key while it is up (it registers its own
    // handler), so nothing here may also act on them.
    if (store.state.worktrees) {
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
        cancelConfirmDialog();
        event.preventDefault();
        return;
      }
      event.preventDefault();
      return;
    }

    // Above the new-session dialog for the same reason the notice is: nothing
    // opens both, but a key that reached two overlays at once would act on the
    // one the user cannot see.
    if (store.state.copyDialog) {
      handleCopyDialogKey(event, store.state.copyDialog);
      return;
    }

    // Beside the Copy dialog, above the new-session dialog, and above the
    // pick-mode branch below: the pick is over by the time this is open, but
    // the ordering has to hold even so, or a key would reach a list the user
    // can no longer see the aim on.
    if (store.state.handoffDialog) {
      handleHandoffDialogKey(event, store.state.handoffDialog);
      return;
    }

    if (store.state.newSession) {
      handleNewSessionKey(event);
      return;
    }

    // Aiming a handoff owns the keyboard: the keys that move and choose keep
    // their meaning (that is the whole point of picking on the list itself)
    // and every other key is swallowed. Letting them through would put `x`
    // one keystroke from killing the session the user was pointing at.
    //
    // `q` cancels rather than being swallowed with the rest. It is the muscle
    // memory for leaving this surface, and a `q` that does nothing at all
    // reads as a hung picker; cancelling puts the user back where the next
    // `q` quits.
    if (store.state.handoffPick) {
      if (key === "j" || key === "down") store.actions.moveSelection(1);
      else if (key === "k" || key === "up") store.actions.moveSelection(-1);
      else if (key === "return" || key === "enter") commitHandoffPick();
      else if (key === "escape" || key === "q") store.actions.endHandoffPick();
      event.preventDefault();
      return;
    }

    if (store.state.contextMenu || store.state.groupContextMenu) {
      // The menu answers to its own keys first (j/k, enter, esc, m). Anything
      // else dismisses it and goes on to mean what it always means — a
      // keypress that is not the menu's is attention moving elsewhere, and
      // making the menu modal would strand a user who opened it by accident.
      if (handleContextMenuKey(event)) {
        event.preventDefault();
        return;
      }
      store.actions.hideContextMenu();
      store.actions.hideGroupContextMenu();
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
        // keeps a bare `w` from opening a surface that can delete.
        if (key !== "W" && !event.shift) break;
        // Scoped to the selected row's repo when there is one, so `W` on a
        // group behaves like the group menu's item; global otherwise. The
        // panel's own Tab widens from there.
        store.actions.showWorktrees(selectedRepoRoot());
        event.preventDefault();
        break;

      case "m":
        // The keyboard's way into the right-click menus. Reached only with no
        // menu already open — the block above owns `m` while one is, so the
        // two halves of the toggle are never both live.
        toggleRowMenu();
        event.preventDefault();
        break;

      case "y": {
        // The row menu's Copy item on one key, opening the SAME dialog through
        // the same store action — a shortcut for a read that gets done over and
        // over, not a second copy path.
        const sessionToCopy = store.selectedSession();
        // Silent on a group header, like `r` and `x`; but on a real row with
        // nothing readable, say why. The menu HIDES its item in that case,
        // while a key that is advertised unconditionally has to answer.
        if (!event.shift && sessionToCopy) {
          if (canCopyLastResponse(sessionToCopy)) {
            store.actions.openCopyDialog(sessionToCopy.id);
          } else {
            store.actions.showToast(
              "Nothing to copy: no transcript and no pane",
              3_000,
            );
          }
        }
        // Shift+Y falls through deliberately, as `N` does: every other capital
        // in this switch is its own action, so treating `Y` as `y` would claim
        // a key some later feature wants.
        event.preventDefault();
        break;
      }

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
            if (canForkSession(sessionToFork)) openForkDialog(sessionToFork);
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

      case "D":
      case "d":
      case "u":
        // Ctrl+D/U scroll the preview; a bare `d` reviews the working
        // tree, Shift+D the branch. Both spellings of the capital are
        // matched because terminals deliver it as name `"d"` with `shift`
        // set as readily as `"D"`; without the lowercase case the branch
        // review would be unreachable on half of them.
        if (event.ctrl && previewScrollbox && store.state.showPreview) {
          const halfPage = Math.floor(
            (previewScrollbox.viewport?.height ?? 10) / 2,
          );
          const delta = key === "u" ? -halfPage : halfPage;
          previewScrollbox.scrollTo(previewScrollbox.scrollTop + delta);
          event.preventDefault();
        } else if (key !== "u" && !event.ctrl && !props.sidebar) {
          const session = store.selectedSession();
          if (session) reviewSession(session, key === "D" || event.shift);
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
            Bun.spawn(tmuxArgv("kill-pane", "-t", selfPane));
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

        {/* The mode's only chrome: one line saying whose response is in hand
            and what the mode wants aimed. It sits where the search input
            does, above the list the pick is being made on. The pane alone
            names the source — the aimed row was just picked FROM this very
            list, and the dialog that follows names both ends in full — and
            the keys are the footer's pick arm's; the sidebar has no footer
            to carry them, so its short form keeps the keys. */}
        <Show when={handoffSource()}>
          {(from: () => EnrichedSession) => (
            <box paddingLeft={1} height={1}>
              <text fg={theme.mauve}>
                {props.sidebar
                  ? `${HANDOFF_BADGE} pick target · enter · esc`
                  : `${HANDOFF_BADGE} Hand off from ${from().tmuxTarget ?? handoffLabel(from())} · pick a target`}
              </text>
            </box>
          )}
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
            socketError={store.state.tmuxSocketError}
            onActivate={handleRowActivate}
            onContextMenu={handleRowContextMenu}
            onRowAnchor={(resolve) => (rowAnchor = resolve)}
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
            newSessionOption={newSessionOptionMode()}
            handoffPickMode={store.state.handoffPick !== null}
            handoffDialogMode={store.state.handoffDialog !== null}
            copyDialogMode={store.state.copyDialog !== null}
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
            onCancel={cancelConfirmDialog}
          />
        </Show>

        <Show when={store.state.newSession}>
          {(draft: () => NonNullable<typeof store.state.newSession>) => (
            <NewSessionDialog
              draft={draft()}
              agents={spawnableAgents()}
              agentsError={agentsError()}
              onFocusField={store.actions.setNewSessionField}
              onOpenDropdown={store.actions.openNewSessionDropdown}
              onCloseDropdown={store.actions.closeNewSessionDropdown}
              onSelectOption={commitDropdown}
              onPromptInput={store.actions.setNewSessionPrompt}
              onWorktreeNameInput={store.actions.setNewSessionWorktreeName}
              onSubmit={() => void submitNewSession()}
              onCancel={cancelNewSession}
            />
          )}
        </Show>

        {/* Over the new-session dialog on purpose: the dialog is left open so
            a refused move can be corrected in place, and this is the record of
            what that refusal left behind. */}
        <Show when={store.state.notice}>
          {(notice: () => NonNullable<typeof store.state.notice>) => (
            <NoticeDialog
              title={notice().title}
              lines={notice().lines}
              onDismiss={dismissNotice}
            />
          )}
        </Show>

        <Show when={store.state.copyDialog}>
          {(copy: () => NonNullable<typeof store.state.copyDialog>) => (
            <CopyDialog
              // The row can leave the board under an open dialog; the dialog
              // stays (Enter then reports the loss rather than copying), so
              // the title falls back to the id it still holds.
              label={(() => {
                const session = copyDialogSession();
                return session ? handoffLabel(session) : copy().sessionId;
              })()}
              turns={copy().turns}
              onSubmit={commitCopyDialog}
              onCancel={store.actions.closeCopyDialog}
            />
          )}
        </Show>

        <Show when={store.state.handoffDialog}>
          {(handoff: () => NonNullable<typeof store.state.handoffDialog>) => (
            <HandoffDialog
              from={handoffEndpoint(
                handoffDialogSession("fromSessionId"),
                handoff().fromSessionId,
              )}
              to={handoffEndpoint(
                handoffDialogSession("toSessionId"),
                handoff().toSessionId,
              )}
              turns={handoff().turns}
              note={handoff().note}
              field={handoff().field}
              onNoteInput={store.actions.setHandoffDialogNote}
              onFocusField={store.actions.setHandoffDialogField}
              onSubmit={commitHandoffDialog}
              onCancel={store.actions.closeHandoffDialog}
            />
          )}
        </Show>

        <Show when={store.state.worktrees}>
          {(panel: () => NonNullable<typeof store.state.worktrees>) => (
            <WorktreesPanel
              repo={panel().repo}
              cwd={pickerCwd()}
              compact={props.sidebar}
              iconStyle={store.state.iconStyle}
              initialCursor={panel().initialCursor}
              isReturn={panel().isReturn}
              startWidened={panel().startWidened}
              onClose={store.actions.hideWorktrees}
              onJump={jumpToWorktreeSession}
              onSpawn={spawnInWorktree}
              onSpawnFromPR={spawnFromPR}
              effects={liveEffects}
              // Review suspends the renderer into a full-screen tool, which
              // the sidebar has neither the room nor the focus for — the same
              // reason its `d` key is inert on a session row.
              onReview={props.sidebar ? undefined : reviewWorktree}
            />
          )}
        </Show>

        <Show when={store.state.contextMenu}>
          {(cm: () => NonNullable<typeof store.state.contextMenu>) => (
            <ContextMenu
              openGeneration={menuOpenGeneration()}
              x={cm().x}
              y={cm().y}
              items={sessionMenuItems()}
              reservedRows={sessionMenuReservedRows()}
              highlight={cm().highlight}
              onClose={store.actions.hideContextMenu}
            />
          )}
        </Show>

        <Show when={store.state.groupContextMenu}>
          {(cm: () => NonNullable<typeof store.state.groupContextMenu>) => (
            <ContextMenu
              openGeneration={menuOpenGeneration()}
              x={cm().x}
              y={cm().y}
              items={groupMenuItems()}
              highlight={cm().highlight}
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
