import { createStore } from "solid-js/store";
import {
  batch,
  createContext,
  createMemo,
  createSignal,
  createEffect,
  onCleanup,
  untrack,
  useContext,
} from "solid-js";
import type { Accessor } from "solid-js";
import { trackedMemo } from "./utils/perf";
import fuzzysort from "fuzzysort";
import type {
  EnrichedSession,
  InvocationStartedEvent,
  InvocationFinishedEvent,
  FinishedInvocationStatus,
  InvocationSnapshotEntry,
} from "../types";
import type { ConnectionState } from "./utils/sse";
import type { IconStyle } from "../lib/icons";
import type {
  ColumnsConfig,
  BreakpointConfig,
  PromptDisplay,
} from "../lib/preferences";
import { DEFAULT_PROMPT_DISPLAY } from "../lib/preferences";
import { setUIState, type UIState } from "../lib/state";
import { getDaemonUrl } from "../lib/config";
import type { TranscriptMatch } from "../daemon/transcript-search";
import { normalizePrompt } from "./components/session-columns";
import { capturePane } from "./utils/tmux";
import { isSameServerCached } from "./utils/server-guard";
import { stripAnsi } from "../lib/strip-ansi";
import {
  buildFlatItems,
  getGroupKey,
  groupSessions,
  headerGroupKeys,
  sortGroups,
  VALID_GROUP_BY,
  DEFAULT_GROUP_BY,
  type FlatItem,
  type GroupBy,
  type FilteredSession,
} from "./utils/grouping";

export type ConfirmAction = "kill" | "kill-all" | "kill-group" | "restart";

interface TUIState {
  sessions: EnrichedSession[];
  selectedSessionId: string | null;
  searchQuery: string;
  searchMode: boolean;
  confirmMode: boolean;
  confirmSessionId: string | null;
  confirmAction: ConfirmAction | null;
  /** Snapshot of session IDs captured when the confirm dialog opens */
  confirmSessionIds: string[];
  connectionState: ConnectionState;
  error: string | null;
  showPreview: boolean;
  promptDisplay: PromptDisplay;
  previewFocused: boolean;
  showHelp: boolean;
  iconStyle: IconStyle;
  previewWidth: number;
  activePaneId: string | null;
  activeSessionId: string | null;
  toastMessage: string | null;
  contextMenu: { sessionId: string; x: number; y: number } | null;
  groupContextMenu: { groupKey: string; x: number; y: number } | null;
  columns?: ColumnsConfig;
  breakpoints?: BreakpointConfig;
  groupBy: GroupBy;
  hideIdle: boolean;
}

interface TUIStoreOptions {
  initialPreview?: boolean;
  promptDisplay?: PromptDisplay;
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
  sidebar?: boolean;
  /** Override state persistence (pass no-op in tests) */
  onPersistState?: (updates: Partial<UIState>) => void;
  /** How long a finished invoke row lingers before removal. Defaults to
   *  INVOKE_FINISHED_LINGER_MS; lowered in tests. */
  invokeFinishedLingerMs?: number;
}

/**
 * Given a desired group order, compute the minimal pinnedGroups array.
 * Compares against the natural (auto-sorted with no pins) order.
 * Groups that match the natural tail order don't need pinning.
 * Also prunes any keys not present in the current group set.
 */
function computePinnedFromOrder(
  desiredOrder: string[],
  filtered: FilteredSession[],
  groupBy: GroupBy,
): string[] {
  // Compute the natural order (no pins)
  const naturalOrder = sortGroups(groupSessions(filtered, groupBy), []).map(
    (g) => g.key,
  );

  // Only keep keys that exist as current groups (prune stale entries)
  const activeKeys = new Set(naturalOrder);
  const cleaned = desiredOrder.filter((k) => activeKeys.has(k));

  // Find how many groups at the tail of cleaned match the natural order.
  // Those don't need pinning. Everything before them does.
  let naturalIdx = naturalOrder.length - 1;
  let desiredIdx = cleaned.length - 1;

  while (naturalIdx >= 0 && desiredIdx >= 0) {
    if (naturalOrder[naturalIdx] === cleaned[desiredIdx]) {
      naturalIdx--;
      desiredIdx--;
    } else {
      break;
    }
  }

  // Pin everything from the start up to and including desiredIdx
  return cleaned.slice(0, desiredIdx + 1);
}

/**
 * How long a finished subprocess invoke row lingers on the board (showing
 * its success/failure outcome) before it is removed. Purely visual: the
 * `/tmp` result file the orchestrator reads via `ccmux invoke result`
 * persists independently of this window.
 */
export const INVOKE_FINISHED_LINGER_MS = 6000;

/**
 * Build the paneless `EnrichedSession` the board shows for a subprocess
 * invoke worker (codex/cursor/opencode/gemini), which creates no tmux
 * session and would otherwise be invisible. Keyed by `invocationId`.
 *
 * `project` mirrors the daemon's pane-tracked derivation
 * (`cwd.split("/").pop()`, see `sessions.ts:createPaneTrackedSession`) so
 * the row co-locates with real sessions in the same directory under
 * project/cwd grouping. `lastActivityAt` is the start time so the existing
 * `useTick` age column counts up live (a stuck worker reads as stale).
 */
export function fabricateInvokeSession(
  event: InvocationStartedEvent,
): EnrichedSession {
  const project = event.cwd.split("/").pop() || event.agent;
  return {
    id: event.invocationId,
    agentType: event.agent,
    trackingMode: "native",
    project,
    cwd: event.cwd,
    logPath: null,
    status: "working",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    tmuxPane: null,
    updatedAt: new Date(event.startedAt),
    lastActivityAt: event.startedAt,
    lastUserInputAt: null,
    subagents: [],
    gitBranch: null,
    version: null,
    pid: null,
    statusChangedAt: event.startedAt,
    previousStatus: null,
    attentionState: null,
    lastSeenAt: null,
    lastPrompt: null,
    prompts: [],
    tmuxTarget: null,
    paneCwd: null,
    isWorktree: false,
    originInvocationId: event.invocationId,
    originInvocationStatus: "running",
  };
}

/**
 * Wrap the first case-insensitive occurrence of `lowerQuery` in `text` with a
 * single `<b>...</b>` span (the same markup fuzzysort's `.highlight()` emits,
 * which `HighlightedText` renders). Returns `text` unchanged when absent.
 * Used for prompt matches, which are substring-based (not fuzzy).
 */
function wrapFirstMatch(text: string, lowerQuery: string): string {
  const idx = text.toLowerCase().indexOf(lowerQuery);
  if (idx === -1) return text;
  const end = idx + lowerQuery.length;
  return `${text.slice(0, idx)}<b>${text.slice(idx, end)}</b>${text.slice(end)}`;
}

const PROMPT_DISPLAY_LABEL: Record<PromptDisplay, string> = {
  inline: "Prompt: inline",
  row2: "Prompt: own row",
  off: "Prompt: off",
};

export function createTUIStore(options: TUIStoreOptions = {}) {
  const [tick, setTick] = createSignal(0);
  const searchPaneContentEnabled = options.searchPaneContent ?? true;
  const searchPaneLines = options.searchPaneLines ?? 100;
  const searchTranscriptEnabled = options.searchTranscript ?? true;
  /** Shortest query that triggers the transcript search (matches the daemon's
   *  MIN_QUERY_LEN; kept local so the TUI bundle doesn't import daemon code). */
  const MIN_TRANSCRIPT_QUERY_LEN = 2;

  const [paneCache, setPaneCache] = createSignal<Map<string, string>>(
    new Map(),
  );

  // Live transcript matches keyed by session id, populated by the debounced
  // /search effect below.
  const [transcriptCache, setTranscriptCache] = createSignal<
    Map<string, TranscriptMatch[]>
  >(new Map());

  // Signals for state that can't live in solid-js store (Set, nullable selection)
  const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(
    new Set(options.collapsedGroups ?? []),
  );
  const [selectedHeaderKey, setSelectedHeaderKey] = createSignal<string | null>(
    null,
  );
  const [pinnedGroups, setPinnedGroups] = createSignal<string[]>(
    options.pinnedGroups ?? [],
  );

  // Debounced persistence for UI state (avoids disk writes on every keypress)
  const persistStateFn = options.onPersistState ?? setUIState;
  let statePersistTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingUpdates: Partial<UIState> = {};
  function persistUIState(updates: Partial<UIState>) {
    pendingUpdates = { ...pendingUpdates, ...updates };
    if (statePersistTimer) clearTimeout(statePersistTimer);
    statePersistTimer = setTimeout(() => {
      persistStateFn(pendingUpdates);
      pendingUpdates = {};
      statePersistTimer = null;
    }, 300);
  }
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Invocation ids currently in flight (every invoke, Claude included).
   *  Driven by invocation_started/finished SSE events; mirrors the daemon's
   *  `inFlightCount` and feeds the board's in-flight count. Includes a
   *  Claude invoke parked at a permission prompt (which a row-status count
   *  would miss). Survives reconnect (separate from the sessions array). */
  const [invocationInFlight, setInvocationInFlight] = createSignal<Set<string>>(
    new Set(),
  );

  /** Pending removals of finished subprocess invoke rows, keyed by
   *  invocationId, so a `started` for a reused id can cancel a stale
   *  removal (newest-wins) and so cleanup can clear them all. */
  const invokeRemovalTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Monotonic version counter for sidebar state sync.
   *  Incremented on every local selection change so echo-back events
   *  from the daemon can be detected and ignored. */
  let sidebarVersion = 0;
  let sidebarBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Broadcast sidebar selection to all instances via daemon SSE.
   *  Debounced to coalesce rapid navigation into a single broadcast. */
  function broadcastSidebarState() {
    sidebarVersion++;
    if (sidebarBroadcastTimer) clearTimeout(sidebarBroadcastTimer);
    sidebarBroadcastTimer = setTimeout(() => {
      sidebarBroadcastTimer = null;
      fetch(`${getDaemonUrl()}/sidebar-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedSessionId: state.selectedSessionId,
          selectedHeaderKey: selectedHeaderKey(),
          version: sidebarVersion,
        }),
      }).catch(() => {});
    }, 100);
  }

  /** Check if an incoming sidebar state version is newer than our local state */
  function isSidebarVersionNewer(incomingVersion: number | undefined): boolean {
    if (incomingVersion === undefined) return true; // legacy event without version
    return incomingVersion > sidebarVersion;
  }

  onCleanup(() => {
    if (statePersistTimer) clearTimeout(statePersistTimer);
    if (sidebarBroadcastTimer) clearTimeout(sidebarBroadcastTimer);
    if (toastTimer) clearTimeout(toastTimer);
    for (const timer of invokeRemovalTimers.values()) clearTimeout(timer);
    invokeRemovalTimers.clear();
  });

  const [state, setState] = createStore<TUIState>({
    sessions: [],
    selectedSessionId: null,
    searchQuery: "",
    searchMode: false,
    confirmMode: false,
    confirmSessionId: null,
    confirmAction: null,
    confirmSessionIds: [],
    connectionState: "disconnected",
    error: null,
    showPreview: options.sidebar ? false : (options.initialPreview ?? false),
    promptDisplay: options.promptDisplay ?? DEFAULT_PROMPT_DISPLAY,
    previewFocused: false,
    showHelp: false,
    iconStyle: options.iconStyle ?? "dot",
    previewWidth: options.previewWidth ?? 40,
    activePaneId: null,
    activeSessionId: null,
    toastMessage: null,
    contextMenu: null,
    groupContextMenu: null,
    columns: options.columns,
    breakpoints: options.breakpoints,
    groupBy: options.groupBy ?? DEFAULT_GROUP_BY,
    hideIdle: options.hideIdle ?? false,
  });

  // Effect: capture pane content for search (debounced)
  // Only tracks searchQuery - sessions read via untrack to avoid re-firing on SSE updates
  createEffect(() => {
    const query = state.searchQuery.trim();
    if (!query || !searchPaneContentEnabled) {
      if (paneCache().size > 0) setPaneCache(new Map());
      return;
    }

    const sessions = untrack(() => [...state.sessions]);
    const timer = setTimeout(async () => {
      // Cross-server `%N` collision (utils/server-guard.ts): every pane id in
      // this batch comes from the one daemon, so one cached verdict covers
      // them all. Capturing would match search against the WRONG panes'
      // content; fail to no-match instead.
      if (!isSameServerCached()) {
        setPaneCache(new Map());
        return;
      }
      const cache = new Map<string, string>();
      await Promise.all(
        sessions
          .filter((s) => s.tmuxPane)
          .map(async (s) => {
            // A gone pane has nothing to match; capturePane throws, treat as empty.
            const content = await capturePane(
              s.tmuxPane!,
              searchPaneLines,
            ).catch(() => "");
            cache.set(s.id, stripAnsi(content));
          }),
      );
      setPaneCache(cache);
    }, 250);

    onCleanup(() => clearTimeout(timer));
  });

  // Effect: fetch live transcript matches for search (debounced). Mirrors the
  // pane-content effect but hits the daemon's /search endpoint, so it can match
  // full Claude/Codex history (user + assistant text), not just the in-memory
  // prompt index. No cross-server guard is needed: /search results are keyed by
  // the same daemon's session ids the SSE stream produced (unlike pane ids,
  // which can collide across tmux servers).
  //
  // Every effect run (including the short-query clear branch) bumps a
  // generation counter; the async body drops its result if a newer run has
  // started. Without this, a slow response for query A could overwrite the
  // cache after fast query B already responded, or a response landing after
  // the query was cleared could repopulate stale rows.
  let transcriptSearchGen = 0;
  createEffect(() => {
    const query = state.searchQuery.trim();
    const gen = ++transcriptSearchGen;
    if (!searchTranscriptEnabled || query.length < MIN_TRANSCRIPT_QUERY_LEN) {
      if (transcriptCache().size > 0) setTranscriptCache(new Map());
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${getDaemonUrl()}/search?q=${encodeURIComponent(query)}`,
        );
        if (gen !== transcriptSearchGen) return; // superseded by a newer run
        if (!res.ok) {
          setTranscriptCache(new Map());
          return;
        }
        const data = (await res.json()) as {
          results: { sessionId: string; matches: TranscriptMatch[] }[];
        };
        if (gen !== transcriptSearchGen) return; // superseded during json parse
        const map = new Map<string, TranscriptMatch[]>();
        for (const r of data.results) map.set(r.sessionId, r.matches);
        setTranscriptCache(map);
      } catch {
        if (gen !== transcriptSearchGen) return;
        setTranscriptCache(new Map());
      }
    }, 250);

    onCleanup(() => clearTimeout(timer));
  });

  // Derived: sorted sessions (by status priority, then time).
  // Custom equality keeps the previous array identity when a delta didn't
  // actually move any row, so the downstream memo chain (filter -> fuzzy ->
  // flatItems -> row renders) doesn't rebuild on every SSE event.
  const sortedSessions = trackedMemo(
    "sortedSessions",
    () => {
      const statusOrder: Record<string, number> = {
        waiting: 0,
        working: 1,
        idle: 1,
      };

      // Decorate once per session so the comparator doesn't re-run
      // Date.parse O(n log n) times per sort.
      const keyed = state.sessions.map((s) => ({
        session: s,
        status: statusOrder[s.status],
        // Within same status, sort by last user input (stable, doesn't jump while working)
        time: s.lastUserInputAt
          ? Date.parse(s.lastUserInputAt)
          : s.lastActivityAt
            ? Date.parse(s.lastActivityAt)
            : 0,
      }));
      keyed.sort((a, b) => a.status - b.status || b.time - a.time);
      return keyed.map((k) => k.session);
    },
    {
      equals: (prev, next) =>
        prev.length === next.length && prev.every((s, i) => s === next[i]),
    },
  );

  // Derived: status-filtered sessions (hide idle toggle, keeps unread/read visible)
  const statusFilteredSessions = trackedMemo("statusFilteredSessions", () => {
    const sorted = sortedSessions();
    if (!state.hideIdle) return sorted;
    const filtered = sorted.filter(
      (s) => s.status !== "idle" || s.attentionState !== null,
    );
    // Preserve reference when filter removes nothing to avoid downstream recomputation
    return filtered.length === sorted.length ? sorted : filtered;
  });

  // Derived: filtered sessions (fuzzy search + pane content)
  // Cache for the empty-query path: keyed on the upstream array identity so
  // toggling search on/off (or any re-run with unchanged sessions) returns
  // the same wrapper array instead of rebuilding the downstream chain.
  let emptyQueryInput: EnrichedSession[] | null = null;
  let emptyQueryResult: FilteredSession[] | null = null;
  const filteredSessions = trackedMemo("filteredSessions", () => {
    const sorted = statusFilteredSessions();
    const query = state.searchQuery.trim();

    if (!query) {
      if (emptyQueryInput !== sorted || !emptyQueryResult) {
        emptyQueryInput = sorted;
        emptyQueryResult = sorted.map((s) => ({
          session: s,
          highlights: null,
          paneMatch: false,
        }));
      }
      return emptyQueryResult;
    }

    const lowerQuery = query.toLowerCase();

    // Metadata matches (instant, synchronous, fuzzy over the four identity
    // fields). Prompts are deliberately NOT a fuzzysort key: fuzzy over a
    // joined multi-prompt haystack is far too permissive (nearly any query
    // scatter-matches as a subsequence, so the filter stops filtering).
    // Recent prompts match by substring instead, consistent with how pane
    // and transcript content match.
    const results = fuzzysort.go(query, sorted, {
      keys: ["project", "cwd", "gitBranch", "lastPrompt"],
      threshold: -10000,
    });
    const metadataMap = new Map(results.map((r) => [r.obj.id, r]));

    // Prompt matches (substring over the in-memory prompt index). Scan each
    // session's prompts newest-first and keep the newest one that contains the
    // query, highlighted with a single `<b>` span around the first occurrence.
    // Each prompt is normalized to a single line FIRST (same reduction the
    // lastPrompt subtitle uses), both so a multi-line prompt (task
    // notifications, teammate messages) can't render embedded newlines that
    // overlap in the height-1 row, and so a spaced query can match across what
    // was a newline.
    const promptMatches = new Map<string, string>();
    for (const s of sorted) {
      const prompts = s.prompts ?? [];
      for (let i = prompts.length - 1; i >= 0; i--) {
        const norm = normalizePrompt(prompts[i]);
        if (norm.toLowerCase().includes(lowerQuery)) {
          promptMatches.set(s.id, wrapFirstMatch(norm, lowerQuery));
          break;
        }
      }
    }

    // Pane content matches (from async cache)
    const cache = paneCache();
    const paneMatches = new Set<string>();
    if (cache.size > 0) {
      for (const [id, content] of cache) {
        if (content.toLowerCase().includes(lowerQuery)) {
          paneMatches.add(id);
        }
      }
    }

    // Transcript matches (from async /search cache)
    const transcript = transcriptCache();

    // Union: sessions matching metadata OR prompt OR pane content OR transcript
    const allMatchIds = new Set([
      ...results.map((r) => r.obj.id),
      ...promptMatches.keys(),
      ...paneMatches,
      ...transcript.keys(),
    ]);

    // Build results preserving original sort order
    return sorted
      .filter((s) => allMatchIds.has(s.id))
      .map((s) => {
        const fzResult = metadataMap.get(s.id);
        const promptMatch = promptMatches.get(s.id);
        const tMatches = transcript.get(s.id);
        // `lastPrompt` renders as a substring highlight on normalized text
        // (like `prompts`), NOT fuzzysort markup: a fuzzy scatter-match over a
        // long prompt produces dozens of single-char <b> fragments that
        // HighlightedText can't lay out (dropped/mispositioned chars), and a
        // multi-line prompt would render raw newlines. Fuzzy still controls
        // MEMBERSHIP via the four keys; this only changes what renders. A
        // scatter-only hit shows the plain truncated lastPrompt (null here,
        // via SessionItem's text() fallback).
        const lpNorm = normalizePrompt(s.lastPrompt ?? "");
        const lastPromptHl = lpNorm.toLowerCase().includes(lowerQuery)
          ? wrapFirstMatch(lpNorm, lowerQuery)
          : null;
        // Build highlights when EITHER a metadata field or a prompt matched;
        // a prompt-substring-only match still needs to carry highlights.prompts
        // (with the four metadata fields null). project/cwd/gitBranch keep
        // fuzzysort markup (short strings, few segments, render fine).
        const highlights =
          fzResult || promptMatch
            ? {
                project: fzResult?.[0]?.highlight("<b>", "</b>") || null,
                cwd: fzResult?.[1]?.highlight("<b>", "</b>") || null,
                gitBranch: fzResult?.[2]?.highlight("<b>", "</b>") || null,
                lastPrompt: lastPromptHl,
                prompts: promptMatch ?? null,
              }
            : null;
        return {
          session: s,
          highlights,
          paneMatch: paneMatches.has(s.id),
          transcriptMatch: tMatches !== undefined && tMatches.length > 0,
          transcriptSnippet: tMatches?.[0]?.snippet,
        };
      });
  });

  const flatItems = trackedMemo("flatItems", () => {
    const isSearching = state.searchQuery.trim().length > 0;
    return buildFlatItems(
      filteredSessions(),
      state.groupBy,
      collapsedGroups(),
      isSearching,
      pinnedGroups(),
    );
  });

  const selectedIndex = trackedMemo("selectedIndex", () => {
    const items = flatItems();

    // Check for selected header first
    const headerKey = selectedHeaderKey();
    if (headerKey) {
      const idx = items.findIndex(
        (item) => item.type === "header" && item.groupKey === headerKey,
      );
      if (idx !== -1) return idx;
    }

    // Check for selected session
    if (state.selectedSessionId) {
      const idx = items.findIndex(
        (item) =>
          item.type === "session" &&
          item.filteredSession.session.id === state.selectedSessionId,
      );
      if (idx !== -1) return idx;
    }

    // Fall back to first item
    return items.length > 0 ? 0 : -1;
  });

  const selectedFlatItem = createMemo((): FlatItem | null => {
    const items = flatItems();
    const idx = selectedIndex();
    return idx >= 0 && idx < items.length ? items[idx] : null;
  });

  // Derived: selected session (always by ID from full session list, not filtered index)
  const selectedSession = createMemo(() => {
    if (state.selectedSessionId) {
      return (
        state.sessions.find((s) => s.id === state.selectedSessionId) ?? null
      );
    }
    // When a header is selected (explicitly or via fallback), return null
    const item = selectedFlatItem();
    if (!item || item.type === "header") return null;
    // Fallback: first visible session (initial state, no explicit selection)
    return item.filteredSession.session;
  });

  const selectedGroupHeader = createMemo(
    (): Extract<FlatItem, { type: "header" }> | null => {
      const item = selectedFlatItem();
      return item?.type === "header" ? item : null;
    },
  );

  // Derived: sessions belonging to the selected group
  const selectedGroupSessions = createMemo(() => {
    const header = selectedGroupHeader();
    if (!header || state.groupBy === "none") return [];
    return filteredSessions()
      .filter(
        (fs) => getGroupKey(fs.session, state.groupBy) === header.groupKey,
      )
      .map((fs) => fs.session);
  });

  /** Select an item in the flat list by index.
   *  Batched to prevent transient states where selectedIndex() falls back to 0. */
  function selectItemAt(index: number) {
    const items = flatItems();
    if (index < 0 || index >= items.length) return;
    const item = items[index];
    batch(() => {
      if (item.type === "session") {
        const sessionId = item.filteredSession.session.id;
        const changed = state.selectedSessionId !== sessionId;
        setState("selectedSessionId", sessionId);
        setSelectedHeaderKey(null);
        if (changed) broadcastSidebarState();
      } else {
        const changed =
          state.selectedSessionId !== null ||
          selectedHeaderKey() !== item.groupKey;
        setState("selectedSessionId", null);
        setSelectedHeaderKey(item.groupKey);
        if (changed) broadcastSidebarState();
      }
    });
  }

  /** Persist collapsed groups, pruning keys that no longer match active groups */
  function persistCollapsedGroups(collapsed: Set<string>) {
    const activeKeys = new Set(headerGroupKeys(flatItems()));
    const pruned = [...collapsed].filter((k) => activeKeys.has(k));
    persistUIState({ collapsedGroups: pruned });
  }

  /**
   * Flip a synthetic subprocess invoke row to its terminal outcome and arm
   * the ~6s linger removal. Shared by `finishInvocation` (live finish) and
   * `reconcileInvocations` (a `finished` missed while disconnected). No-op
   * if the row is already gone. `attentionState` keeps the row past the
   * hideIdle filter for the duration of its linger window.
   */
  function flipInvokeRowToTerminal(
    invocationId: string,
    status: FinishedInvocationStatus,
  ) {
    const idx = state.sessions.findIndex((s) => s.id === invocationId);
    if (idx === -1) return;
    setState("sessions", idx, {
      status: "idle",
      attentionType: null,
      pendingTool: null,
      attentionState: "unread",
      originInvocationStatus: status,
    });
    const existing = invokeRemovalTimers.get(invocationId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      invokeRemovalTimers.delete(invocationId);
      removeInvokeRow(invocationId);
    }, options.invokeFinishedLingerMs ?? INVOKE_FINISHED_LINGER_MS);
    invokeRemovalTimers.set(invocationId, timer);
  }

  /**
   * Immediately drop a synthetic invoke row (no outcome to show), clearing
   * any armed linger timer and the selection if it pointed at the row.
   * Used by the linger timer's own body and by the reconnect reconcile when
   * the daemon no longer knows the invocation (purged or daemon restart).
   */
  function removeInvokeRow(invocationId: string) {
    const existing = invokeRemovalTimers.get(invocationId);
    if (existing) {
      clearTimeout(existing);
      invokeRemovalTimers.delete(invocationId);
    }
    setState("sessions", (s) =>
      s.filter((session) => session.id !== invocationId),
    );
    if (state.selectedSessionId === invocationId) {
      if (state.previewFocused) setState("previewFocused", false);
      setState("selectedSessionId", null);
    }
  }

  const actions = {
    setSessions(sessions: EnrichedSession[]) {
      // Preserve client-synthesized subprocess invoke rows. They live only
      // in the TUI (no daemon session), and every `init` (initial connect
      // AND every reconnect) carries only pane-matched daemon sessions, so
      // a plain replace would wipe a still-running worker's row on any
      // SSE blip and its later `invocation_finished` would land on nothing.
      // Re-append the ones the incoming snapshot doesn't already cover.
      const incomingIds = new Set(sessions.map((s) => s.id));
      const synthetic = state.sessions.filter(
        (s) => s.originInvocationStatus !== undefined && !incomingIds.has(s.id),
      );
      const merged =
        synthetic.length > 0 ? [...sessions, ...synthetic] : sessions;
      setState("sessions", merged);
      if (
        state.selectedSessionId &&
        !merged.some((s) => s.id === state.selectedSessionId)
      ) {
        if (state.previewFocused) {
          setState("previewFocused", false);
        }
        setState("selectedSessionId", null);
      }
    },

    addSession(session: EnrichedSession) {
      setState("sessions", (s) => [...s, session]);
    },

    updateSession(session: EnrichedSession) {
      const idx = state.sessions.findIndex((s) => s.id === session.id);
      if (idx !== -1) {
        setState("sessions", idx, session);
      }
    },

    removeSession(sessionId: string) {
      setState("sessions", (s) =>
        s.filter((session) => session.id !== sessionId),
      );
      if (state.selectedSessionId === sessionId) {
        if (state.previewFocused) {
          setState("previewFocused", false);
        }
        setState("selectedSessionId", null);
      }
    },

    /** An invoke worker began executing (invocation_started SSE event). */
    startInvocation(event: InvocationStartedEvent) {
      // SSE actions run in the async read loop, outside Solid's auto-batching,
      // so batch the in-flight write and the row mutation into one flush of
      // the list memos.
      batch(() => {
        // Track every invoke (Claude included) for the in-flight count, even
        // ones with no synthetic row, so a Claude invoke parked at a
        // permission prompt still counts.
        setInvocationInFlight((prev) => {
          if (prev.has(event.invocationId)) return prev;
          const next = new Set(prev);
          next.add(event.invocationId);
          return next;
        });
        // Claude invokes render as their real detached session via
        // session_created (skip-and-wait de-dup); only paneless subprocess
        // invokes need a fabricated row.
        if (event.agent === "claude") return;
        // Newest-wins on a reused id: cancel any pending removal of a
        // lingering finished row before re-adding it as running.
        const pending = invokeRemovalTimers.get(event.invocationId);
        if (pending) {
          clearTimeout(pending);
          invokeRemovalTimers.delete(event.invocationId);
        }
        const row = fabricateInvokeSession(event);
        const idx = state.sessions.findIndex(
          (s) => s.id === event.invocationId,
        );
        if (idx !== -1) {
          setState("sessions", idx, row);
        } else {
          setState("sessions", (s) => [...s, row]);
        }
      });
    },

    /** An invoke worker reached a terminal state (invocation_finished). */
    finishInvocation(event: InvocationFinishedEvent) {
      // Batched (async SSE loop): the in-flight drop and the row flip land in
      // one memo flush.
      batch(() => {
        setInvocationInFlight((prev) => {
          if (!prev.has(event.invocationId)) return prev;
          const next = new Set(prev);
          next.delete(event.invocationId);
          return next;
        });
        // Claude invokes (skip-and-wait) and ids whose `started` we missed
        // (e.g. a TUI opened mid-run) have no synthetic row; the flip no-ops.
        flipInvokeRowToTerminal(event.invocationId, event.status);
      });
    },

    /**
     * Reconcile the board's invoke state against the daemon's authoritative
     * snapshot (`GET /invocations`), fetched on every (re)connect. SSE is
     * fire-and-forget with no replay, so an `invocation_finished` emitted
     * while the TUI was disconnected (a reconnect blip, or a daemon restart
     * that took the worker down mid-run) is never delivered. Without this it
     * would strand the synthetic `running` row forever (no removal timer was
     * ever armed) and leave the id in the in-flight Set, inflating the
     * header count, including Claude invokes, which have no on-screen row to
     * explain the phantom count.
     *
     * Prunes the in-flight Set to the daemon's currently-running ids, then
     * for each existing synthetic row: leaves it if still running, flips it
     * to its outcome (+linger) if the daemon recorded a terminal status we
     * missed, or drops it if the daemon no longer knows it. Intentionally
     * does NOT fabricate rows for running invokes the client never saw start
     * (mid-run-open hydration stays deferred, per the plan).
     */
    reconcileInvocations(records: InvocationSnapshotEntry[]) {
      const statusById = new Map(
        records.map((r) => [r.invocationId, r.status]),
      );
      // Batched (async SSE loop): the in-flight prune plus every per-row flip
      // or removal collapse into a single memo flush instead of one per row.
      batch(() => {
        // Prune phantom in-flight ids: keep only what the daemon still runs.
        setInvocationInFlight((prev) => {
          let changed = false;
          const next = new Set<string>();
          for (const id of prev) {
            if (statusById.get(id) === "running") next.add(id);
            else changed = true;
          }
          return changed ? next : prev;
        });
        // Iterate a captured snapshot of synthetic rows (the loop mutates
        // state.sessions through the helpers).
        const synthetic = state.sessions.filter(
          (s) => s.originInvocationStatus !== undefined,
        );
        for (const row of synthetic) {
          const status = statusById.get(row.id);
          if (status === "running") continue; // genuinely still live
          if (status === undefined) {
            removeInvokeRow(row.id); // daemon purged/restarted: nothing to show
            continue;
          }
          // Daemon recorded a terminal status. If our row is still "running"
          // we missed the finished event: show the outcome briefly. If it is
          // already lingering, leave its existing timer to fire.
          if (row.originInvocationStatus === "running") {
            flipInvokeRowToTerminal(row.id, status);
          }
        }
      });
    },

    moveSelection(delta: number) {
      const items = flatItems();
      if (items.length === 0) return;

      const curIdx = selectedIndex();
      const newIndex = Math.max(0, Math.min(items.length - 1, curIdx + delta));
      selectItemAt(newIndex);
    },

    setSelectedIndex(index: number) {
      selectItemAt(index);
    },

    setSearchQuery(query: string) {
      setState("searchQuery", query);
      setState("selectedSessionId", null);
      setSelectedHeaderKey(null);
    },

    enterSearchMode() {
      setState("searchMode", true);
    },

    exitSearchMode() {
      setState("searchMode", false);
      setState("searchQuery", "");
      setState("selectedSessionId", null);
      setSelectedHeaderKey(null);
    },

    setConnectionState(connectionState: ConnectionState) {
      setState("connectionState", connectionState);
    },

    setError(error: string | null) {
      setState("error", error);
    },

    showConfirmDialog(
      sessionId: string | null,
      action: ConfirmAction = "kill",
      sessionIds: string[] = [],
    ) {
      setState("confirmMode", true);
      setState("confirmSessionId", sessionId);
      setState("confirmAction", action);
      setState("confirmSessionIds", sessionIds);
    },

    hideConfirmDialog() {
      setState("confirmMode", false);
      setState("confirmSessionId", null);
      setState("confirmAction", null);
      setState("confirmSessionIds", []);
    },

    showContextMenu(sessionId: string, x: number, y: number) {
      setState("contextMenu", { sessionId, x, y });
      setState("groupContextMenu", null);
    },

    hideContextMenu() {
      setState("contextMenu", null);
    },

    showGroupContextMenu(groupKey: string, x: number, y: number) {
      setState("groupContextMenu", { groupKey, x, y });
      setState("contextMenu", null);
    },

    hideGroupContextMenu() {
      setState("groupContextMenu", null);
    },

    togglePreview() {
      if (options.sidebar) return;
      const next = !state.showPreview;
      setState("showPreview", next);
      if (!next) setState("previewFocused", false);
      persistUIState({ showPreview: next });
    },

    cyclePrompt() {
      // Picker: inline (single line) -> own row (two lines) -> off -> inline.
      // Sidebar: the 30-col rail can't inline (inline renders the same as
      // row2 there), so cycle only the two visible states (own row <-> off)
      // and treat a stored `inline` as `row2`, so every press then changes
      // what is shown and the toast never names a no-op transition.
      const order: PromptDisplay[] = options.sidebar
        ? ["row2", "off"]
        : ["inline", "row2", "off"];
      const current: PromptDisplay =
        options.sidebar && state.promptDisplay === "inline"
          ? "row2"
          : state.promptDisplay;
      const next = order[(order.indexOf(current) + 1) % order.length]!;
      setState("promptDisplay", next);
      persistUIState({ promptDisplay: next });
      this.showToast(PROMPT_DISPLAY_LABEL[next]);
    },

    toggleHideIdle() {
      const next = !state.hideIdle;
      setState("hideIdle", next);
      setState("selectedSessionId", null);
      setSelectedHeaderKey(null);
      persistUIState({ hideIdle: next });
      this.showToast(next ? "Hide Idle ON" : "Hide Idle OFF");
    },

    cycleGroupBy() {
      const currentIdx = VALID_GROUP_BY.indexOf(state.groupBy);
      const nextIdx = (currentIdx + 1) % VALID_GROUP_BY.length;
      const next = VALID_GROUP_BY[nextIdx];
      batch(() => {
        setState("groupBy", next);
        setState("selectedSessionId", null);
        setSelectedHeaderKey(null);
        setCollapsedGroups(new Set<string>());
        setPinnedGroups([]);
      });
      persistUIState({ groupBy: next, collapsedGroups: [], pinnedGroups: [] });
      this.showToast(`Group: ${next}`);
    },

    enterPreviewFocus() {
      setState("previewFocused", true);
    },

    exitPreviewFocus() {
      setState("previewFocused", false);
    },

    toggleHelp() {
      setState("showHelp", (show) => !show);
    },

    hideHelp() {
      setState("showHelp", false);
    },

    resizePreview(delta: number) {
      const next = Math.max(20, Math.min(70, state.previewWidth + delta));
      if (next !== state.previewWidth) {
        setState("previewWidth", next);
        persistUIState({ previewWidth: next });
      }
    },

    setActivePaneId(paneId: string | null) {
      setState("activePaneId", paneId);
    },

    setActiveSessionId(sessionId: string | null) {
      setState("activeSessionId", sessionId);
    },

    setSelectedSessionId(sessionId: string | null) {
      setState("selectedSessionId", sessionId);
    },

    /** Apply a full sidebar selection received from another instance */
    applySidebarSelection(sessionId: string | null, headerKey: string | null) {
      batch(() => {
        setState("selectedSessionId", sessionId);
        setSelectedHeaderKey(headerKey);
      });
    },

    showToast(message: string) {
      setState("toastMessage", message);
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        setState("toastMessage", null);
        toastTimer = null;
      }, 1500);
    },

    reloadUIState(freshState: UIState) {
      batch(() => {
        if (freshState.collapsedGroups !== undefined) {
          setCollapsedGroups(new Set(freshState.collapsedGroups));
        }
        if (freshState.groupBy !== undefined) {
          setState("groupBy", freshState.groupBy);
        }
        if (freshState.hideIdle !== undefined) {
          setState("hideIdle", freshState.hideIdle);
        }
        // Only an explicit `promptDisplay` (written by the `p` key) syncs across
        // instances here. The legacy `showPrompt` migration and the config
        // default are resolved once at launch (picker.ts / sidebar.ts); re-running
        // the migration on reload without the config default would let a stale
        // `showPrompt: false` clobber a newer config `promptDisplay`.
        if (freshState.promptDisplay !== undefined) {
          setState("promptDisplay", freshState.promptDisplay);
        }
        if (freshState.pinnedGroups !== undefined) {
          setPinnedGroups(freshState.pinnedGroups);
        }
      });
    },

    toggleGroupCollapse(groupKey: string) {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(groupKey)) {
          next.delete(groupKey);
        } else {
          next.add(groupKey);
          // If collapsing and selected session belongs to this group, select the header
          if (state.selectedSessionId) {
            const session = state.sessions.find(
              (s) => s.id === state.selectedSessionId,
            );
            if (session && getGroupKey(session, state.groupBy) === groupKey) {
              setState("selectedSessionId", null);
              setSelectedHeaderKey(groupKey);
            }
          }
        }
        persistCollapsedGroups(next);
        return next;
      });
    },

    collapseAll() {
      const items = flatItems();
      const keys = new Set(headerGroupKeys(items));
      setCollapsedGroups(keys);
      persistCollapsedGroups(keys);
      // Select the first header if a session was selected
      if (state.selectedSessionId) {
        setState("selectedSessionId", null);
        const firstHeader = items.find((i) => i.type === "header");
        if (firstHeader?.type === "header") {
          setSelectedHeaderKey(firstHeader.groupKey);
        }
      }
    },

    expandAll() {
      setCollapsedGroups(new Set<string>());
      persistUIState({ collapsedGroups: [] });
    },

    collapseParent() {
      if (!state.selectedSessionId) return;
      const session = state.sessions.find(
        (s) => s.id === state.selectedSessionId,
      );
      if (!session) return;
      const groupKey = getGroupKey(session, state.groupBy);
      if (state.groupBy === "none" || !groupKey) return;
      setState("selectedSessionId", null);
      setSelectedHeaderKey(groupKey);
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        next.add(groupKey);
        persistCollapsedGroups(next);
        return next;
      });
    },

    expandGroup(groupKey: string) {
      setCollapsedGroups((prev) => {
        if (!prev.has(groupKey)) return prev;
        const next = new Set(prev);
        next.delete(groupKey);
        persistCollapsedGroups(next);
        return next;
      });
    },

    applyGroupOrder(newOrder: string[], groupKey: string, sessionId?: string) {
      const next = computePinnedFromOrder(
        newOrder,
        filteredSessions(),
        state.groupBy,
      );
      setPinnedGroups(next);
      persistUIState({ pinnedGroups: next });

      // Ensure selection follows the moved group
      if (sessionId) {
        setState("selectedSessionId", sessionId);
        setSelectedHeaderKey(null);
      } else {
        setState("selectedSessionId", null);
        setSelectedHeaderKey(groupKey);
      }
    },

    moveGroup(groupKey: string, direction: -1 | 1, sessionId?: string) {
      if (state.groupBy === "none") return;

      const groupOrder = headerGroupKeys(flatItems());
      const idx = groupOrder.indexOf(groupKey);
      const targetIdx = idx + direction;
      if (idx === -1 || targetIdx < 0 || targetIdx >= groupOrder.length) return;

      const swapped = [...groupOrder];
      [swapped[idx], swapped[targetIdx]] = [swapped[targetIdx], swapped[idx]];
      this.applyGroupOrder(swapped, groupKey, sessionId);
    },

    moveGroupUp(groupKey: string, sessionId?: string) {
      this.moveGroup(groupKey, -1, sessionId);
    },

    moveGroupDown(groupKey: string, sessionId?: string) {
      this.moveGroup(groupKey, 1, sessionId);
    },

    moveGroupToEdge(
      groupKey: string,
      edge: "top" | "bottom",
      sessionId?: string,
    ) {
      if (state.groupBy === "none") return;

      const groupOrder = headerGroupKeys(flatItems());
      const idx = groupOrder.indexOf(groupKey);
      if (idx === -1) return;

      const rest = groupOrder.filter((k) => k !== groupKey);
      if (edge === "top") {
        if (idx === 0) return;
        rest.unshift(groupKey);
      } else {
        if (idx === groupOrder.length - 1) return;
        rest.push(groupKey);
      }
      this.applyGroupOrder(rest, groupKey, sessionId);
    },
  };

  /** Count of invocations currently in flight (the board's status-line
   *  signal). Driven by the invocation_started/finished SSE lifecycle, so
   *  it counts Claude and subprocess invokes alike. Reading it in a
   *  tracking scope (the Header) subscribes to the underlying signal. */
  const invocationInFlightCount = () => invocationInFlight().size;

  return {
    state,
    sortedSessions,
    filteredSessions,
    flatItems,
    invocationInFlightCount,
    selectedIndex,
    selectedFlatItem,
    selectedSession,
    selectedHeaderKey,
    selectedGroupHeader,
    selectedGroupSessions,
    collapsedGroups,
    pinnedGroups,
    actions,
    tick,
    bumpTick: () => setTick((t) => t + 1),
    isSidebarVersionNewer,
  };
}

// --- Tick Context ---
// Provides the tick signal via context so child components can read it
// without receiving it as a prop (which would cause parent re-renders).

interface TickContextValue {
  tick: Accessor<number>;
}

export const TickContext = createContext<TickContextValue>();

export function useTick(): TickContextValue {
  const ctx = useContext(TickContext);
  if (!ctx)
    throw new Error("useTick must be used within a TickContext provider");
  return ctx;
}
