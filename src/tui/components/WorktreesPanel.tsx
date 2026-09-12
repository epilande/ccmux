import { GroupHeader } from "./GroupHeader";
import {
  factsText,
  badgeText,
  branchPRs,
  badgeColor,
} from "../utils/repo-facts";
import { getAgentDisplayName } from "../../lib/agents";
import type { ViewMemory } from "../actions";
import type { RepoFactsResponse } from "../../daemon/repo-facts";
import type { Component } from "solid-js";

import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { useKeyboard, useRenderer } from "@opentui/solid";

import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";

import { MouseButton } from "@opentui/core";

import { basename, resolve, sep } from "node:path";

import { getDaemonUrl } from "../../lib/config";

import type {
  PRState,
  PruneCandidate,
  PruneRunResult,
  PruneScan,
  PruneSkip,
  ScanResponse,
  WorktreeSession,
} from "../../daemon/worktree-prune";

import {
  describeHttpFailure,
  normalizeScan,
} from "../../daemon/worktree-prune";

import type {
  WorktreeListResponse,
  WorktreeRow,
} from "../../daemon/worktree-list";

import type { SessionStatus } from "../../types/session";

import { displayWidth, truncateText } from "../utils/format";

import {
  fitSegments,
  orderRepos,
  scrollTargetFor,
  unhandled,
  type VisualLayout,
} from "./row-segments";

import { fitHints } from "./Footer";

import { useStatusIcon } from "../utils/useStatusIcon";

import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";

import type { IconStyle } from "../../lib/icons";

import { theme } from "../theme";

type Phase = "loading" | "list" | "confirm" | "running" | "done" | "error";

const LIST_TIMEOUT_MS = 20_000;

const SCAN_TIMEOUT_MS = 60_000;

const RUN_TIMEOUT_MS = 10 * 60_000;

export interface WorktreePanelRow {
  kind: "worktree";
  /**
   * What the cursor, the scroll layout and the selection sets key by.
   *
   * The worktree's own absolute path.
   */
  key: string;
  row: WorktreeRow;
  /** Set only when the scan proved a removal reason. Gates prune selection. */
  candidate: PruneCandidate | null;
  /** Set when the scan deliberately withheld this worktree. */
  skip: PruneSkip | null;
  /** PR to badge the row with, from either half of the scan. */
  pr: PRState | null;
}

export type PanelRow = WorktreePanelRow;

interface WorktreesPanelProps {
  activeSessionId?: string | null;
  facts?: RepoFactsResponse;
  memory?: ViewMemory;
  onRemember?: (memory: ViewMemory) => void;
  embedded?: boolean;
  enabled?: boolean;
  onNavigate?: (event: KeyEvent, repo: string | null) => boolean;
  onScope?: (repo: string | null) => void;
  onRefresh?: () => void;
  onNew?: (cwd: string) => void;
  onRestart?: (id: string) => void;
  onKillAll?: (ids: string[]) => void;
  /** Null includes all known repositories; cwd adds the picker's repository. */
  repo: string | null;
  cwd: string;
  compact?: boolean;
  iconStyle?: IconStyle;
  /** Stable worktree path for review and dialog round trips. */
  initialCursor?: string | null;
  /** Return opens may reuse the last completed classification once. */
  isReturn?: boolean;
  startWidened?: boolean;
  onClose: () => void;
  onJump: (session: WorktreeSession) => void;
  onSpawn: (target: {
    cwd: string;
    existingWorktree: string | null;
    panelRepo: string | null;
    panelScope: string | null;
    cursor?: string;
  }) => void;
  onReview?: (target: {
    branch?: boolean;
    path: string;
    sessionId: string | null;
    panelRepo: string | null;
    panelScope: string | null;
  }) => void;
  /** Explicit so tests cannot launch a browser or write the real clipboard. */
  effects: PanelEffects;
}

export function partitionSelection(
  candidates: PruneCandidate[],
  selected: ReadonlySet<string>,
  dirtyOk: ReadonlySet<string>,
): { removable: PruneCandidate[]; blockedDirty: PruneCandidate[] } {
  const removable: PruneCandidate[] = [];
  const blockedDirty: PruneCandidate[] = [];
  for (const candidate of candidates) {
    if (!selected.has(candidate.path)) continue;
    if (candidate.dirty && !dirtyOk.has(candidate.path)) {
      blockedDirty.push(candidate);
    } else {
      removable.push(candidate);
    }
  }
  return { removable, blockedDirty };
}

export function worktreeHoldsPath(
  worktreePath: string,
  candidate: string,
): boolean {
  if (!candidate) return false;
  const root = resolve(worktreePath);
  const path = resolve(candidate);
  if (path === root) return true;
  if (!path.startsWith(root + sep)) return false;
  return !crossesNestedCheckout(path.slice(root.length + sep.length));
}

const NESTED_CHECKOUT_SEGMENTS = [".claude", "worktrees"];

function crossesNestedCheckout(relative: string): boolean {
  const segments = relative.split(sep);
  for (let i = 0; i + 2 < segments.length; i += 1) {
    if (
      segments[i] === NESTED_CHECKOUT_SEGMENTS[0] &&
      segments[i + 1] === NESTED_CHECKOUT_SEGMENTS[1]
    ) {
      return true;
    }
  }
  return false;
}

function statusColor(status: SessionStatus): string {
  switch (status) {
    case "working":
      return theme.peach;
    case "waiting":
      return theme.red;
    case "idle":
      return theme.overlay;
  }
}

function prColor(pr: PRState): string {
  switch (pr.state) {
    case "OPEN":
      return theme.green;
    case "MERGED":
      return theme.mauve;
    case "CLOSED":
      return theme.peach;
    default:
      return unhandled(pr.state, theme.subtext);
  }
}

export function formatTracking(row: WorktreeRow): string {
  if (!row.upstream) return "";
  if (row.upstream.gone) return "branch gone";
  return [
    row.upstream.ahead ? `↑${row.upstream.ahead}` : "",
    row.upstream.behind ? `↓${row.upstream.behind}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function rowSessions(entry: WorktreePanelRow): WorktreeSession[] {
  return entry.row.sessions.length
    ? entry.row.sessions
    : (entry.candidate?.sessions ?? []);
}

export function describeSessions(
  sessions: WorktreeSession[],
  compact = false,
): string {
  if (!sessions.length) return "";
  if (sessions.length === 1) return getAgentDisplayName(sessions[0]!.agentType);
  const status = leadStatus(sessions);
  const count = sessions.filter((session) => session.status === status).length;
  if (compact)
    return `${sessions.length} (${count}${status === "waiting" ? "◆" : status === "working" ? "◐" : "●"})`;
  return count === sessions.length
    ? `${count} agents ${status}`
    : `${sessions.length} agents, ${count} ${status}`;
}

export const DIRTY_UNCOUNTED = "uncommitted work";

export function dirtyPhrases(row: WorktreeRow): string[] {
  if (!row.dirty.dirty) return [];
  const parts: string[] = [];
  if (row.dirty.modified > 0) parts.push(`${row.dirty.modified} modified`);
  if (row.dirty.untracked > 0) parts.push(`${row.dirty.untracked} untracked`);
  return parts.length > 0 ? parts : [DIRTY_UNCOUNTED];
}

export function describeReason(candidate: PruneCandidate): string {
  switch (candidate.reason) {
    // The daemon's own detail already words these well and carries the
    // number even in the cases where the candidate's `pr` did not survive the
    // trip, so it is the fallback rather than a bare "PR merged".
    case "pr-merged":
      return candidate.pr
        ? `PR #${candidate.pr.number} merged`
        : candidate.detail;
    case "pr-closed":
      return candidate.pr
        ? `PR #${candidate.pr.number} closed`
        : candidate.detail;
    case "upstream-gone":
      return "branch gone";
    case "merged-locally":
      // `merged into origin/main` names a remote the reader did not ask
      // about. Cosmetic only: an unrecognized wording passes through intact.
      return candidate.detail.replace(/\borigin\//g, "");
    default:
      // A reason only a newer daemon knows about. Its own sentence is the one
      // thing about it that is guaranteed to be true, and the alternative is
      // a checkbox with nothing next to it.
      return unhandled(candidate.reason, candidate.detail);
  }
}

function describePR(pr: PRState): string {
  return `PR #${pr.number} ${pr.state.toLowerCase()}`;
}

function leadStatus(sessions: WorktreeSession[]): SessionStatus {
  if (sessions.some((s) => s.status === "waiting")) return "waiting";
  if (sessions.some((s) => s.status === "working")) return "working";
  return "idle";
}

export function endsSessions(candidate: PruneCandidate | null): boolean {
  return (candidate?.sessions.length ?? 0) > 0;
}

export function rowLabel(entry: WorktreePanelRow): string {
  return entry.row.isMain ? "main checkout" : entry.row.name;
}

export function rowBranch(entry: PanelRow): string {
  // A PR's head ref goes on the detail line instead. Its label is already the
  // full width of a title, so a second column beside it has nowhere to start.
  if (entry.kind !== "worktree") return "";
  const row = entry.row;
  if (row.detached || !row.branch) return "detached";
  if (row.branch === rowLabel(entry)) return "";
  if (row.isMain && (row.branch === "main" || row.branch === "master")) {
    return "";
  }
  return row.branch;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function pruneFullySucceeded(result: PruneRunResult): boolean {
  return (
    result.outcomes.length > 0 &&
    result.outcomes.every(
      (outcome) =>
        outcome.removed &&
        outcome.error == null &&
        outcome.steps.every((step) => step.ok),
    )
  );
}

export function removalNotice(count: number): string {
  return `removed ${plural(count, "worktree", "worktrees")}`;
}

export interface CachedScan {
  scope: string | null;
  scan: PruneScan;
}

let lastCompletedScan: CachedScan | null = null;

export function cachedScanFor(
  cache: CachedScan | null,
  scope: string | null,
): PruneScan | null {
  return cache !== null && cache.scope === scope ? cache.scan : null;
}

export function resetScanCache(): void {
  lastCompletedScan = null;
}

export function describeRemoval(worktrees: number, branches: number): string {
  if (branches === 0) {
    return `Delete ${plural(worktrees, "worktree", "worktrees")}?`;
  }
  if (worktrees === 1 && branches === 1) {
    return "Delete 1 worktree and its branch?";
  }
  return `Delete ${plural(worktrees, "worktree", "worktrees")} and ${plural(
    branches,
    "branch",
    "branches",
  )}?`;
}

export function removalDetails(opts: {
  includedDirty: number;
  blockedDirty: number;
  ignoredFiles: number;
  /** Idle agent sessions the removal will end, counted across the selection. */
  endingSessions: number;
}): string[] {
  const lines: string[] = [];
  if (opts.includedDirty > 0) {
    lines.push(
      `including ${plural(opts.includedDirty, "worktree", "worktrees")} with uncommitted work`,
    );
  }
  // Named here as well as on the row, because the rows that carry it can be
  // off screen by the time the confirm is up. Not part of `destructive`: the
  // transcript file survives, so the red border stays with the one case that
  // loses work outright.
  if (opts.endingSessions > 0) {
    lines.push(
      `ending ${plural(opts.endingSessions, "idle agent session", "idle agent sessions")}`,
    );
  }
  if (opts.blockedDirty > 0) {
    lines.push(
      `skipping ${plural(opts.blockedDirty, "dirty worktree", "dirty worktrees")} (declined)`,
    );
  }
  if (opts.ignoredFiles > 0) {
    lines.push(
      `${plural(opts.ignoredFiles, "ignored file", "ignored files")} go too`,
    );
  }
  return lines;
}

const RemovalConfirm: Component<{
  headline: string;
  details: string[];
  destructive: boolean;
  width: number;
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => {
  const boxWidth = () => Math.max(24, Math.min(56, props.width));
  const boxHeight = () => 7 + props.details.length;
  return (
    <box
      position="absolute"
      top="50%"
      left="50%"
      width={boxWidth()}
      height={boxHeight()}
      marginTop={-Math.floor(boxHeight() / 2)}
      marginLeft={-Math.floor(boxWidth() / 2)}
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={props.destructive ? theme.red : theme.border}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <text fg={theme.text}>
        <strong>Remove worktrees?</strong>
      </text>
      <box height={1} />
      {/* Red only when uncommitted work is actually going, so the one
          irreversible case does not read like the routine one. */}
      <text fg={props.destructive ? theme.red : theme.subtext}>
        {truncateText(props.headline, boxWidth() - 2)}
      </text>
      <For each={props.details}>
        {(line) => (
          <text fg={theme.overlay}>{truncateText(line, boxWidth() - 2)}</text>
        )}
      </For>
      <box height={1} />
      <box flexDirection="row">
        <box
          flexDirection="row"
          onMouseDown={(event) => {
            if (event.button === MouseButton.LEFT) props.onConfirm();
          }}
        >
          <text fg={theme.green}>
            <strong>Y</strong>
          </text>
          <text fg={theme.overlay}> confirm </text>
        </box>
        <box
          flexDirection="row"
          onMouseDown={(event) => {
            if (event.button === MouseButton.LEFT) props.onCancel();
          }}
        >
          <text fg={theme.red}>
            <strong>N</strong>
          </text>
          <text fg={theme.overlay}> cancel</text>
        </box>
      </box>
    </box>
  );
};

export function clipboardArgv(
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  return platform === "darwin" ? ["pbcopy"] : null;
}

export function browserArgv(
  url: string,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return null;
  return ["xdg-open", url];
}

export interface Osc52Writer {
  isOsc52Supported(): boolean;
  copyToClipboardOSC52(text: string): boolean;
}

export function copyToClipboard(
  text: string,
  writer: Osc52Writer | null,
  spawn: (argv: string[], text: string) => boolean = spawnClipboardHelper,
  platform: NodeJS.Platform = process.platform,
): { osc52: boolean; local: boolean } {
  const osc52 = Boolean(
    writer?.isOsc52Supported() && writer.copyToClipboardOSC52(text),
  );
  const argv = clipboardArgv(platform);
  const local = argv !== null && spawn(argv, text);
  return { osc52, local };
}

export function rowPRUrl(entry: WorktreePanelRow): string | null {
  return entry.pr?.url ?? null;
}

export function openInBrowser(
  url: string,
  spawn: (argv: string[]) => boolean = spawnDetached,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const argv = browserArgv(url, platform);
  return argv !== null && spawn(argv);
}

function spawnDetached(argv: string[]): boolean {
  try {
    const child = Bun.spawn(argv, {
      stdout: "ignore",
      stderr: "ignore",
    });
    void child.exited;
    return true;
  } catch {
    return false;
  }
}

export interface PanelEffects {
  /** Hand `url` to the desktop browser. False when there is no way to. */
  openUrl(url: string): boolean;
  /**
   * Put `text` on the clipboard by every channel available. The OSC 52
   * writer is the renderer, which the component owns, so it is passed in
   * rather than captured here.
   */
  copyText(
    text: string,
    writer: Osc52Writer | null,
  ): { osc52: boolean; local: boolean };
}

export const liveEffects: PanelEffects = {
  openUrl: (url) => openInBrowser(url),
  copyText: (text, writer) => copyToClipboard(text, writer),
};

function spawnClipboardHelper(argv: string[], text: string): boolean {
  try {
    const child = Bun.spawn(argv, {
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    void child.exited;
    return true;
  } catch {
    return false;
  }
}

export const WorktreesPanel: Component<WorktreesPanelProps> = (props) => {
  const dims = useSharedTerminalDimensions();
  const renderer = useRenderer();
  const [phase, setPhase] = createSignal<Phase | "dirty">("loading");
  const [repos, setRepos] = createSignal<WorktreeListResponse["repos"]>([]);
  const [scan, setScan] = createSignal<PruneScan | null>(null);
  const [scanError, setScanError] = createSignal<string | null>(null);
  const [scope, setScope] = createSignal(
    props.startWidened ? null : props.repo,
  );
  const [cursor, setCursor] = createSignal<string | null>(
    props.initialCursor ?? props.memory?.cursor ?? null,
  );
  const [marks, setMarks] = createSignal(new Set<string>(props.memory?.marks));
  const [collapsed, setCollapsed] = createSignal(
    new Set<string>(props.memory?.collapsed),
  );
  const [chosen, setChosen] = createSignal<PruneCandidate[]>([]);
  const [dirtyQueue, setDirtyQueue] = createSignal<PruneCandidate[]>([]);
  const [dirtyOk, setDirtyOk] = createSignal(new Set<string>());
  const [result, setResult] = createSignal<PruneRunResult | null>(null);
  const [note, setNote] = createSignal("");
  const [measured, setMeasured] = createSignal(0);
  createEffect(() =>
    props.onRemember?.({
      scope: scope(),
      cursor: cursor(),
      marks: [...marks()],
      collapsed: [...collapsed()],
    }),
  );
  let listBox: ScrollBoxRenderable | undefined;
  let resultsBox: ScrollBoxRenderable | undefined;
  let generation = 0;
  let loadedOnce = false;
  let pendingG = false;
  let pendingZ = false;
  onCleanup(() => {
    generation++;
  });
  const width = () => Math.max(4, dims().width - (props.embedded ? 2 : 4));
  const groups = createMemo(() => {
    const candidates = new Map(
      scan()?.candidates.map((c) => [c.path, c]) ?? [],
    );
    const skipped = new Map(scan()?.skipped.map((c) => [c.path, c]) ?? []);
    const open = new Map(scan()?.open?.map((c) => [c.path, c.pr]) ?? []);
    return orderRepos(repos(), scope()).map((repo) => ({
      ...repo,
      rows: repo.worktrees.map((row) => ({
        kind: "worktree" as const,
        key: row.path,
        row,
        candidate: candidates.get(row.path) ?? null,
        skip: skipped.get(row.path) ?? null,
        pr: open.get(row.path) ?? candidates.get(row.path)?.pr ?? null,
      })),
    }));
  });
  type Item =
    | {
        kind: "header";
        key: string;
        repoRoot: string;
        repoName: string;
        rows: WorktreePanelRow[];
      }
    | WorktreePanelRow;
  const items = createMemo<Item[]>(() =>
    groups().flatMap((repo) => [
      {
        kind: "header" as const,
        key: `repo:${repo.repoRoot}`,
        repoRoot: repo.repoRoot,
        repoName: repo.repoName,
        rows: repo.rows,
      },
      ...(collapsed().has(repo.repoRoot) ? [] : repo.rows),
    ]),
  );
  const rows = createMemo(() =>
    items().filter((r): r is WorktreePanelRow => r.kind === "worktree"),
  );
  const current = createMemo(
    () => items().find((r) => r.key === cursor()) ?? null,
  );
  const currentRepo = () => {
    const row = current();
    return row?.kind === "header"
      ? row.repoRoot
      : (row?.row.repoRoot ?? scope());
  };
  createEffect(() => {
    const live = items();
    const key = cursor();
    if (!live.length || live.some((r) => r.key === key)) return;
    setCursor(live.find((r) => r.kind === "worktree")?.key ?? live[0]!.key);
  });
  createEffect(() => {
    void measured();
    const key = cursor();
    const live = items();
    const plan: VisualLayout = new Map(
      live.map((r, line) => [r.key, { line, height: 1 }]),
    );
    if (!listBox) return;
    const target = scrollTargetFor(
      plan,
      key,
      listBox.scrollTop,
      listBox.viewport.height,
    );
    if (target !== null) listBox.scrollTo(target);
  });
  function load(refresh = false) {
    const gen = ++generation;
    const seedFromCache = props.isReturn && !loadedOnce;
    loadedOnce = true;
    setNote("");
    setScanError(null);
    setScan(null);
    if (!repos().length) setPhase("loading");
    else setPhase("list");
    const query = new URLSearchParams({ cwd: props.cwd });
    if (scope()) query.set("repo", scope()!);
    void fetch(`${getDaemonUrl()}/worktrees?${query}`, {
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(describeHttpFailure(response.status));
        const data = (await response.json()) as WorktreeListResponse;
        if (gen !== generation) return;
        setRepos(data.repos);
        setPhase("list");
        const live = new Set(
          data.repos.flatMap((r) => r.worktrees.map((w) => w.path)),
        );
        setMarks((prev) => new Set([...prev].filter((p) => live.has(p))));
      })
      .catch((error: unknown) => {
        if (gen !== generation) return;
        setNote(String(error));
        setPhase("error");
      });
    const cached =
      !refresh && seedFromCache
        ? cachedScanFor(lastCompletedScan, scope())
        : null;
    if (cached) {
      setScan(cached);
      return;
    }
    void fetch(`${getDaemonUrl()}/worktrees/prune-candidates?${query}`, {
      signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(describeHttpFailure(response.status));
        const data = normalizeScan((await response.json()) as ScanResponse);
        if (gen !== generation) return;
        lastCompletedScan = { scope: scope(), scan: data };
        setScan(data);
      })
      .catch((error: unknown) => {
        if (gen === generation) setScanError(String(error));
      });
  }
  onMount(() => load());
  function move(delta: number) {
    const live = items();
    const index = live.findIndex((r) => r.key === cursor());
    setCursor(
      live[Math.max(0, Math.min(live.length - 1, index + delta))]?.key ?? null,
    );
  }
  function mark(paths: string[]) {
    setMarks((prev) => {
      const next = new Set(prev);
      const remove = paths.every((p) => next.has(p));
      for (const path of paths) {
        if (remove) next.delete(path);
        else next.add(path);
      }
      return next;
    });
  }
  function toggleGroup(root: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }
  function activate(item: Item) {
    if (item.kind === "header") {
      toggleGroup(item.repoRoot);
      return;
    }
    if (item.row.sessions[0]) props.onJump(item.row.sessions[0]);
    else
      props.onSpawn({
        cwd: item.row.path,
        existingWorktree: item.row.isMain ? null : item.row.path,
        panelRepo: scope(),
        panelScope: scope(),
      });
  }
  function remove() {
    setNote("");
    const item = current();
    const targets = marks().size
      ? marks()
      : new Set(
          item?.kind === "header"
            ? item.rows.map((r) => r.key)
            : item
              ? [item.key]
              : [],
        );
    const candidates = groups()
      .flatMap((g) => g.rows)
      .filter((r) => targets.has(r.key));
    if (candidates.some((r) => !r.candidate)) {
      setNote("Some marked rows are not removable; clear or adjust marks");
      return;
    }
    const pending = candidates.flatMap((r) =>
      r.candidate ? [r.candidate] : [],
    );
    if (!pending.length) {
      setNote(
        scan()
          ? "No removable worktree selected"
          : "Waiting for removal classification",
      );
      return;
    }
    setChosen(pending);
    setDirtyOk(new Set<string>());
    const dirty = pending.filter((c) => c.dirty);
    setDirtyQueue(dirty);
    setPhase(dirty.length ? "dirty" : "confirm");
  }
  function answerDirty(include: boolean) {
    const candidate = dirtyQueue()[0];
    if (!candidate) return;
    if (include) setDirtyOk((prev) => new Set(prev).add(candidate.path));
    else setChosen((prev) => prev.filter((c) => c.path !== candidate.path));
    const rest = dirtyQueue().slice(1);
    setDirtyQueue(rest);
    if (!rest.length) setPhase(chosen().length ? "confirm" : "list");
  }
  async function runPrune() {
    if (!chosen().length) return;
    setPhase("running");
    try {
      const response = await fetch(`${getDaemonUrl()}/worktrees/prune`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paths: chosen().map((c) => c.path),
          allowDirty: [...dirtyOk()],
          allowEndIdle: chosen()
            .filter(endsSessions)
            .map((c) => c.path),
          source: "picker",
          repo: scope(),
          cwd: props.cwd,
          callerPane: process.env.TMUX_PANE,
        }),
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      });
      const data = (await response.json()) as PruneRunResult & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
      lastCompletedScan = null;
      setMarks(new Set<string>());
      props.onRefresh?.();
      if (pruneFullySucceeded(data)) {
        load();
        setNote(removalNotice(data.outcomes.length));
      } else {
        setResult(data);
        setPhase("done");
      }
    } catch (error) {
      setNote(String(error));
      setPhase("error");
    }
  }
  useKeyboard((event: KeyEvent) => {
    if (props.enabled === false || event.defaultPrevented) return;
    event.preventDefault();
    const key = event.name;
    if (key !== "g") pendingG = false;
    if (phase() === "running") return;
    if (phase() === "dirty") {
      if (key === "y" || key === "Y") answerDirty(true);
      else if (key === "n" || key === "N") answerDirty(false);
      else if (key === "escape") setPhase("list");
      return;
    }
    if (phase() === "confirm") {
      if (key === "y" || key === "Y") void runPrune();
      else if (key === "n" || key === "N" || key === "escape") setPhase("list");
      return;
    }
    if (props.onNavigate?.(event, currentRepo())) return;
    if (key === "R" || (key === "r" && event.shift)) {
      props.onRefresh?.();
      load(true);
      return;
    }
    if (key === "q" || key === "escape") {
      props.onClose();
      return;
    }
    if (phase() === "done") {
      if (key === "j" || key === "down") resultsBox?.scrollBy(1);
      if (key === "k" || key === "up") resultsBox?.scrollBy(-1);
      if (key === "return" || key === "enter") load();
      return;
    }
    if (phase() === "error") return;
    const item = current();
    if (pendingZ) {
      pendingZ = false;
      if (key === "m") {
        setCollapsed(new Set(groups().map((g) => g.repoRoot)));
        return;
      }
      if (key === "r") {
        setCollapsed(new Set<string>());
        return;
      }
    }
    switch (key) {
      case "j":
      case "down":
        move(1);
        break;
      case "k":
      case "up":
        move(-1);
        break;
      case "n":
        if (event.ctrl) move(1);
        else
          props.onNew?.(
            item?.kind === "worktree"
              ? item.row.path
              : (currentRepo() ?? props.cwd),
          );
        break;
      case "p":
        if (event.ctrl) move(-1);
        break;
      case "r":
        if (item?.kind === "worktree" && item.row.sessions[0])
          props.onRestart?.(item.row.sessions[0].id);
        break;
      case "s": {
        const next = scope() ? null : currentRepo();
        setScope(next);
        props.onScope?.(next);
        setRepos([]);
        setMarks(new Set<string>());
        load();
        break;
      }
      case "space":
      case " ":
        if (item)
          mark(
            item.kind === "header" ? item.rows.map((r) => r.key) : [item.key],
          );
        break;
      case "a":
      case "A":
        setMarks(
          new Set(key === "A" || event.shift ? [] : rows().map((r) => r.key)),
        );
        break;
      case "x":
      case "X":
        if (key === "X" || event.shift)
          props.onKillAll?.(
            rows().flatMap((r) => r.row.sessions.map((s) => s.id)),
          );
        else remove();
        break;
      case "return":
      case "enter":
        if (item) activate(item);
        break;
      case "d":
      case "D":
        if (!event.ctrl && item?.kind === "worktree")
          props.onReview?.({
            path: item.row.path,
            sessionId: item.row.sessions[0]?.id ?? null,
            panelRepo: scope(),
            panelScope: scope(),
            branch: key === "D" || event.shift,
          });
        break;
      case "y":
        if (item?.kind === "worktree") {
          props.effects.copyText(item.row.path, renderer);
          setNote(`copied ${item.row.name}`);
        }
        break;
      case "o":
        if (item?.kind === "worktree") {
          const url =
            props.facts?.repos
              .find((r) => r.repoRoot === item.row.repoRoot)
              ?.prs?.value.find((pr) => pr.headRefOid === item.row.tip)?.url ??
            rowPRUrl(item);
          if (url) props.effects.openUrl(url);
          else setNote("No GitHub PR on this row");
        }
        break;
      case "g":
      case "G":
        if (key === "G" || event.shift) setCursor(items().at(-1)?.key ?? null);
        else if (pendingG) {
          setCursor(items()[0]?.key ?? null);
          pendingG = false;
        } else {
          pendingG = true;
        }
        break;
      case "z":
        pendingZ = true;
        break;
      case "-":
        setCollapsed(new Set(groups().map((g) => g.repoRoot)));
        break;
      case "=":
        setCollapsed(new Set<string>());
        break;
      default:
        if (/^[1-9]$/.test(key)) {
          const row = rows()[Number(key) - 1];
          if (row) {
            setCursor(row.key);
            activate(row);
          }
        }
    }
  });
  const facts = (root: string) =>
    props.facts?.repos.find((r) => r.repoRoot === root);
  const cachedPRs = (entry: WorktreePanelRow) =>
    branchPRs(
      {
        mainRepoRoot: entry.row.repoRoot,
        worktreeRoot: entry.row.path,
        gitBranch: entry.row.branch,
      },
      props.facts?.repos ?? [],
    );
  const cachedBadge = (entry: WorktreePanelRow) =>
    cachedPRs(entry)
      .map((pr) => badgeText(pr))
      .join(" ");
  const groupBranch = (root: string) => {
    const group = groups().find((g) => g.repoRoot === root);
    const rows = group?.rows ?? [];
    const first = rows[0];
    const branch = first?.row.branch;
    if (
      props.facts?.headerPR === false ||
      !group ||
      !first ||
      !branch ||
      branch === "main" ||
      !rows.every((r) => r.row.branch === branch)
    )
      return undefined;
    // Lift only when the header can carry the identity and badge in full;
    // otherwise their row positions remain visible on compact surfaces.
    const badge = cachedBadge(first) || (first.pr ? describePR(first.pr) : "");
    const header = `▾ ${group.repoName} (${rows.length})   ${branch}${badge ? `   ${badge}` : ""}`;
    return displayWidth(header) <= width() - 2 ? branch : undefined;
  };
  const renderRow = (entry: WorktreePanelRow) => {
    const status = () => leadStatus(rowSessions(entry));
    const spinner = useStatusIcon(
      () => status(),
      () => null,
      () => "dot",
    );
    const glyph = () =>
      !rowSessions(entry).length
        ? " "
        : status() === "waiting"
          ? "◆"
          : status() === "working"
            ? spinner()
            : "●";
    const index = () => rows().findIndex((r) => r.key === entry.key) + 1;
    const right = () =>
      truncateText(
        describeSessions(rowSessions(entry), width() < 100),
        Math.floor(width() / 3),
      );
    const segments = () => {
      const dirty = dirtyPhrases(entry.row);
      const skip = entry.skip?.reason;
      const metadata = [
        ...(entry.candidate
          ? [{ text: `  ${describeReason(entry.candidate)}`, fg: theme.yellow }]
          : !groupBranch(entry.row.repoRoot) && cachedBadge(entry)
            ? [
                {
                  text: `  ${cachedBadge(entry)}`,
                  fg: badgeColor(cachedPRs(entry)),
                },
              ]
            : entry.pr && !groupBranch(entry.row.repoRoot)
              ? [{ text: `  ${describePR(entry.pr)}`, fg: prColor(entry.pr) }]
              : []),
        ...(dirty.length
          ? dirty
          : entry.candidate?.dirty
            ? [DIRTY_UNCOUNTED]
            : []
        ).map((text) => ({
          text: `  ${text}`,
          fg: entry.candidate ? theme.yellow : theme.subtext,
        })),
        ...(entry.row.locked ? [{ text: "  locked", fg: theme.yellow }] : []),
        ...(skip &&
        !(entry.row.locked && skip === "locked") &&
        !(entry.row.detached && skip === "detached HEAD") &&
        !(rowSessions(entry).length && /^an agent is /.test(skip))
          ? [
              {
                text: `  ${skip.replace(/^an agent is /, "agent ")}`,
                fg: theme.subtext,
              },
            ]
          : []),
        ...(!entry.candidate && formatTracking(entry.row)
          ? [{ text: `  ${formatTracking(entry.row)}`, fg: theme.blue }]
          : []),
      ];
      const budget = Math.max(1, width() - 6 - displayWidth(right()));
      const wanted = metadata.reduce(
        (n, part) => n + displayWidth(part.text),
        0,
      );
      const identityBudget = Math.max(10, budget - wanted);
      const identity = fitSegments(
        [
          {
            text: entry.row.isMain
              ? "⌂ main checkout"
              : `${truncateText(entry.row.name, identityBudget - 2)} +`,
            fg: entry.row.isMain ? theme.text : theme.blue,
          },
          ...(!groupBranch(entry.row.repoRoot) && rowBranch(entry)
            ? [{ text: `  ${rowBranch(entry)}`, fg: theme.subtext }]
            : []),
        ],
        identityBudget,
      );
      return [
        ...identity,
        ...fitSegments(
          metadata,
          Math.max(
            0,
            budget -
              identity.reduce((n, part) => n + displayWidth(part.text), 0),
          ),
        ),
      ];
    };
    return (
      <box
        height={1}
        width="100%"
        flexDirection="row"
        backgroundColor={cursor() === entry.key ? theme.surface : undefined}
        onMouseDown={() => setCursor(entry.key)}
      >
        <text fg={theme.mauve}>
          {rowSessions(entry).some((s) => s.id === props.activeSessionId)
            ? "▎"
            : " "}
        </text>
        <text
          fg={theme.overlay}
        >{`${marks().has(entry.key) ? "✓" : index() <= 9 ? index() : " "} `}</text>
        <text fg={status() === "idle" ? theme.overlay : statusColor(status())}>
          {glyph()}{" "}
        </text>
        <For each={segments()}>
          {(segment) => <text fg={segment.fg}>{segment.text}</text>}
        </For>
        <box flexGrow={1} />
        <text fg={theme.subtext}>{right()}</text>
      </box>
    );
  };
  return (
    <box
      position="absolute"
      top={props.embedded ? 1 : 0}
      left={0}
      width="100%"
      height={props.embedded ? dims().height - 1 : "100%"}
      backgroundColor={theme.base}
      border={props.embedded ? false : true}
      borderColor={props.embedded ? undefined : theme.border}
      flexDirection="column"
      paddingLeft={0}
      paddingRight={1}
    >
      <Show when={!props.embedded}>
        <text fg={theme.text}>
          <b>Worktrees</b>
        </text>
      </Show>
      <box flexGrow={1} flexDirection="column">
        <Show when={phase() === "loading"}>
          <text fg={theme.overlay}>Reading worktrees…</text>
        </Show>
        <Show when={phase() === "running"}>
          <text fg={theme.yellow}>Removing worktrees…</text>
        </Show>
        <Show when={phase() === "done"}>
          <scrollbox flexGrow={1} ref={resultsBox}>
            <For each={result()?.outcomes ?? []}>
              {(outcome) => (
                <box flexDirection="column" flexShrink={0}>
                  <text fg={outcome.error ? theme.yellow : theme.text}>
                    {basename(outcome.path)}:{" "}
                    {outcome.removed ? "removed" : "kept"}
                  </text>
                  <Show when={outcome.error}>
                    <text fg={theme.yellow}>{outcome.error}</text>
                  </Show>
                  <For each={outcome.steps}>
                    {(step) => (
                      <text fg={step.ok ? theme.subtext : theme.yellow}>
                        {step.ok ? "✓" : "!"} {step.detail}
                      </text>
                    )}
                  </For>
                </box>
              )}
            </For>
            <For each={result()?.state.filter((s) => s.error) ?? []}>
              {(entry) => <text fg={theme.yellow}>{entry.error}</text>}
            </For>
            <text fg={theme.overlay}>
              j/k scroll · Enter returns · R refresh
            </text>
          </scrollbox>
        </Show>
        <Show when={["list", "confirm", "dirty"].includes(phase())}>
          <scrollbox
            flexGrow={1}
            ref={(r: ScrollBoxRenderable) => {
              listBox = r;
              const bump = () => setMeasured((v) => v + 1);
              r.viewport.on("resize", bump);
              r.content.on("resize", bump);
            }}
          >
            <For each={items()}>
              {(item) =>
                item.kind === "header" ? (
                  <GroupHeader
                    label={item.repoName}
                    count={item.rows.length}
                    width={width()}
                    sharedBranch={groupBranch(item.repoRoot)}
                    facts={factsText(facts(item.repoRoot))}
                    prBadgeColor={
                      item.rows[0]
                        ? cachedPRs(item.rows[0]).length
                          ? badgeColor(cachedPRs(item.rows[0]))
                          : item.rows[0].pr
                            ? prColor(item.rows[0].pr)
                            : undefined
                        : undefined
                    }
                    prBadge={
                      groupBranch(item.repoRoot) && item.rows[0]
                        ? cachedBadge(item.rows[0]) ||
                          (item.rows[0].pr ? describePR(item.rows[0].pr) : "")
                        : ""
                    }
                    collapsed={collapsed().has(item.repoRoot)}
                    selected={cursor() === item.key}
                    members={[]}
                    onActivate={() => {
                      setCursor(item.key);
                      toggleGroup(item.repoRoot);
                    }}
                  />
                ) : (
                  renderRow(item)
                )
              }
            </For>
          </scrollbox>
        </Show>
      </box>
      <text fg={note() || scanError() ? theme.yellow : theme.overlay}>
        {truncateText(
          note() ||
            scanError() ||
            (!scan() ? "scanning…  " : "") +
              fitHints(
                [
                  { text: "h/l views", rank: 2 },
                  { text: "enter open", rank: 4 },
                  { text: "space mark", rank: 3 },
                  { text: "x remove", rank: 3 },
                  { text: "s scope", rank: 2 },
                  { text: "R refresh", rank: 1 },
                  { text: "? help", rank: 3 },
                ],
                width(),
              ),
          width(),
        )}
      </text>
      <Show when={phase() === "dirty" && dirtyQueue()[0]}>
        {(candidate: () => PruneCandidate) => (
          <RemovalConfirm
            headline="Delete uncommitted work?"
            details={[
              basename(candidate().path),
              candidate().modified || candidate().untracked
                ? `${candidate().modified} modified · ${candidate().untracked} untracked`
                : "Uncommitted work",
              "Y includes it · N skips it",
              "Esc cancels removal",
            ]}
            destructive
            width={width()}
            onConfirm={() => answerDirty(true)}
            onCancel={() => answerDirty(false)}
          />
        )}
      </Show>
      <Show when={phase() === "confirm"}>
        <RemovalConfirm
          headline={describeRemoval(
            chosen().length,
            chosen().filter((c) => c.branch && c.branchDeletion !== "none")
              .length,
          )}
          details={removalDetails({
            includedDirty: dirtyOk().size,
            blockedDirty: 0,
            ignoredFiles: chosen().reduce(
              (n, c) => n + c.ignoredFiles.length,
              0,
            ),
            endingSessions: chosen().reduce((n, c) => n + c.sessions.length, 0),
          })}
          destructive={dirtyOk().size > 0}
          width={width()}
          onConfirm={() => void runPrune()}
          onCancel={() => setPhase("list")}
        />
      </Show>
    </box>
  );
};
