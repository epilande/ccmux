import { useStatusIcon } from "../utils/useStatusIcon";
import { GroupHeader } from "./GroupHeader";
import { factsText } from "../utils/repo-facts";
import type { ViewMemory } from "../actions";
import type { RepoFactsResponse } from "../../daemon/repo-facts";
import type { PanelEffects } from "./WorktreesPanel";
import { useRenderer } from "@opentui/solid";
import { displayWidth } from "../utils/format";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  onCleanup,
} from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import type { IssueListResponse } from "../../daemon/issue-list";
import type { PRListResponse } from "../../daemon/pr-list";
import type { WorktreeListResponse } from "../../daemon/worktree-list";
import { describeHttpFailure } from "../../daemon/worktree-prune";
import { getDaemonUrl } from "../../lib/config";
import type { IconStyle } from "../../lib/icons";
import { theme } from "../theme";
import { truncateText } from "../utils/format";
import { fetchOpenIssues, fetchOpenPRs } from "../utils/source-lists";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { fitHints } from "./Footer";
import { isPRRowKey } from "./pr-rows";
import { scrollTargetFor, type VisualLayout } from "./row-segments";
import {
  buildSourceRepos,
  checkedOutPathFor,
  emptyStateText,
  filterRepos,
  hasRows,
  isIssueRowKey,
  pickerRows,
  sourceRowDim,
  sourceRowLabel,
  sourceRowMarker,
  type SourceRepo,
  type SourceRow,
} from "./source-picker-rows";

/** Start is one filterable list across PRs and issues. Enter starts work or
 * opens the checkout already holding the source. `/` gives the input the
 * keyboard; Esc clears it before returning to navigation. */

/** Independent of the list read, so a slow GitHub cannot hold up the local
 *  worktrees that mark a row as already checked out. */
const LIST_TIMEOUT_MS = 20_000;
export function sourceAge(
  createdAt: string | null | undefined,
  now = Date.now(),
): string {
  if (!createdAt) return "";
  const ms = now - Date.parse(createdAt);
  if (!Number.isFinite(ms)) return "";
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  return days ? `${days}d` : `${Math.max(0, Math.floor(ms / 3_600_000))}h`;
}

/** How the two GitHub reads are announced while they are in flight. */
type LoadPhase = "loading" | "list" | "error";

export interface SourcePickerOrigin {
  /** The Worktrees panel this was opened from, so Esc can reopen it. */
  panelRepo: string | null;
  panelScope: string | null;
  panelCursor: string;
}

export interface SourcePickerProps {
  activeSessionId?: string | null;
  effects: PanelEffects;
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
  onKill?: (ids: string[]) => void;
  onReview?: (target: {
    path: string;
    sessionId: string | null;
    branch: boolean;
    cursor: string;
    filter: string;
  }) => void;

  /** Main checkout to scope to; null lists every known repo. */
  repo: string | null;
  /** The caller's directory, additive to `repo`, exactly as on `/worktrees`. */
  cwd?: string;
  /** Sidebar rendering: narrower rows, fewer phrases. */
  compact?: boolean;
  iconStyle?: IconStyle;
  /** Cursor and filter to reopen on, for a return from a cancelled dialog. */
  initialCursor?: string | null;
  initialFilter?: string;
  /** Where Esc goes back to, or null for a picker nothing opened. */
  origin?: SourcePickerOrigin | null;
  onClose: () => void;
  onPickPR: (target: {
    number: number;
    title: string;
    repoRoot: string;
    cursor: string;
    filter: string;
  }) => void;
  onPickIssue: (target: {
    number: number;
    title: string;
    repoRoot: string;
    cursor: string;
    filter: string;
  }) => void;
  /** A source already checked out here: go to the worktree, never spawn a
   *  second agent into it. */
  onOpenWorktree: (target: {
    path: string;
    cursor: string;
    filter: string;
  }) => void;
}

/** Columns before a row's content: a space, the marker, a space. */

/** Columns the scrollbox keeps for its scrollbar. */
const SCROLLBAR_GUTTER = 1;
/** The separator between detail phrases, muted so the facts carry the line. */

/** All source rows occupy one visual line. */
export function sourceRowHeight(row: SourceRow, compact = false): number {
  void row;
  void compact;
  return 1;
}

/**
 * Where each row starts, in the scrollbox's own units.
 *
 * Section headers and repo headers are LINES rather than rows — the cursor
 * never stops on furniture — but they are lines the layout must COUNT, or
 * every row below one sits at a position the scroll arithmetic disagrees
 * with. That drift is the exact bug the Worktrees panel already paid for, in
 * its case over the removable divider.
 */
export function sourcePickerLayout(
  repos: SourceRepo[],
  heightOf: (row: SourceRow) => number,
  opts: { repoHeaders: boolean },
): VisualLayout {
  const layout: VisualLayout = new Map();
  let line = 0;
  for (const repo of repos) {
    if (opts.repoHeaders) {
      layout.set(`repo:${repo.repoRoot}`, { line, height: 1 });
      line += 1;
    }
    for (const section of [repo.prs, repo.issues]) {
      for (const row of section) {
        const height = heightOf(row);
        layout.set(row.key, { line, height });
        line += height;
      }
    }
  }
  return layout;
}

/** Even a single repository retains its group header. */
export function showsRepoHeaders(repos: SourceRepo[]): boolean {
  return repos.length > 0;
}

export const SourcePicker: Component<SourcePickerProps> = (props) => {
  const dims = useSharedTerminalDimensions();
  const renderer = useRenderer();
  const [scope, setScope] = createSignal(props.repo);
  const [marks, setMarks] = createSignal(new Set<string>(props.memory?.marks));
  const [collapsed, setCollapsed] = createSignal(
    new Set<string>(props.memory?.collapsed),
  );
  let pendingG = false;
  let pendingZ = false;

  const [phase, setPhase] = createSignal<LoadPhase>("loading");
  const [prs, setPrs] = createSignal<PRListResponse | null>(null);
  const [prError, setPrError] = createSignal<string | null>(null);
  const [issues, setIssues] = createSignal<IssueListResponse | null>(null);
  const [issueError, setIssueError] = createSignal<string | null>(null);
  const [worktrees, setWorktrees] = createSignal<WorktreeListResponse | null>(
    null,
  );
  const [error, setError] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal(
    props.initialFilter ?? props.memory?.filter ?? "",
  );
  /**
   * Whether the filter input has the keyboard. `/` enters, Esc leaves.
   *
   * A carried query opens IN the filter, because leaving it clears it: a
   * non-empty filter can only have been typed in filter mode, so a return
   * from a cancelled dialog restores the state the pick was made from.
   */
  const [filtering, setFiltering] = createSignal(
    (props.initialFilter ?? props.memory?.filter ?? "") !== "",
  );
  const [cursorKey, setCursorKey] = createSignal<string | null>(
    props.initialCursor ?? props.memory?.cursor ?? null,
  );
  /**
   * Whether the user has typed into the filter. Releases the cursor hold
   * below, and is why that release is neither "the filter is non-empty" (a
   * cancel-return seeds a filter and a cursor together, and that hold must
   * survive) nor a comparison against the seed (Esc clears the query, which
   * says nothing about the row the cursor is on).
   */
  const [filterEdited, setFilterEdited] = createSignal(false);
  const [note, setNote] = createSignal<string | null>(null);
  const [scrollboxLayout, setScrollboxLayout] = createSignal(0);
  createEffect(() =>
    props.onRemember?.({
      scope: scope(),
      cursor: cursorKey(),
      marks: [...marks()],
      collapsed: [...collapsed()],
      filter: filter(),
    }),
  );
  let listBox: ScrollBoxRenderable | undefined;
  let loadGeneration = 0;
  onCleanup(() => {
    loadGeneration++;
  });
  let activating = false;

  const width = () => dims().width;
  /** The box less its border and padding. */
  const contentWidth = () => Math.max(8, width() - (props.embedded ? 2 : 4));
  /** Inside the scrollbox, which keeps a column for its bar. */
  const listWidth = () => Math.max(4, contentWidth() - SCROLLBAR_GUTTER);

  function worktreesUrl(): URL {
    const listUrl = new URL(`${getDaemonUrl()}/worktrees`);
    if (scope()) listUrl.searchParams.set("repo", scope()!);
    if (props.cwd) listUrl.searchParams.set("cwd", props.cwd);
    return listUrl;
  }

  /**
   * Three independent reads on one generation.
   *
   * The worktree list is LOCAL and answers in milliseconds; the two GitHub
   * reads are network-bound and behind the daemon's per-repo TTL. Firing them
   * together is the point: a row can be marked as already checked out before
   * either GitHub answer lands, and a failure of one costs its own section
   * rather than the surface.
   */
  function load(opts: { refresh?: boolean } = {}): void {
    const generation = ++loadGeneration;
    setPhase("loading");
    setPrs(null);
    setPrError(null);
    setIssues(null);
    setIssueError(null);
    setError(null);

    fetch(worktreesUrl(), { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(describeHttpFailure(response.status));
        const data = (await response.json()) as WorktreeListResponse;
        if (generation !== loadGeneration) return;
        setWorktrees(data);
        setPhase("list");
      })
      .catch((err: unknown) => {
        if (generation !== loadGeneration) return;
        // The local read is the one failure that takes the surface: without
        // it there is nothing to mark rows against and, more to the point,
        // nothing here works if the daemon is unreachable.
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });

    const query = {
      repo: scope(),
      cwd: props.cwd,
      refresh: opts.refresh,
    };
    fetchOpenPRs(query)
      .then((data) => {
        if (generation !== loadGeneration) return;
        setPrs(data);
      })
      .catch((err: unknown) => {
        if (generation !== loadGeneration) return;
        setPrError(err instanceof Error ? err.message : String(err));
      });
    fetchOpenIssues(query)
      .then((data) => {
        if (generation !== loadGeneration) return;
        setIssues(data);
      })
      .catch((err: unknown) => {
        if (generation !== loadGeneration) return;
        setIssueError(err instanceof Error ? err.message : String(err));
      });
  }

  onMount(() => load());

  /** Every repo in scope, with each source's rows and state. */
  const repos = createMemo(() =>
    buildSourceRepos({
      prs: prs(),
      prError: prError(),
      issues: issues(),
      issueError: issueError(),
      worktrees: worktrees(),
      home: scope(),
    }),
  );

  /**
   * The same, narrowed by whatever is typed, and EMPTY until the local
   * worktree read answers: a PR row drawn before `/worktrees` cannot know it
   * is already checked out, and Enter would cut a duplicate beside it. The
   * gate is on the data because Enter reads `cursorRow()` → `rows()` → this
   * and never asks what is on screen. `worktrees()` rather than `phase()`,
   * so an explicit refresh keeps the list live with momentarily stale
   * checkout marks instead of blanking under the user.
   */
  const visible = createMemo(() =>
    worktrees() === null ? [] : filterRepos(repos(), filter()),
  );
  const rows = createMemo(() =>
    pickerRows(visible().filter((r) => !collapsed().has(r.repoRoot))),
  );
  const navKeys = createMemo(() =>
    visible()
      .filter((r) => r.prs.length + r.issues.length > 0)
      .flatMap((r) => [
        `repo:${r.repoRoot}`,
        ...(collapsed().has(r.repoRoot)
          ? []
          : [...r.prs, ...r.issues].map((row) => row.key)),
      ]),
  );
  const headerRepo = () =>
    visible().find((r) => `repo:${r.repoRoot}` === cursorKey());
  const currentRepo = () =>
    headerRepo()?.repoRoot ?? cursorRow()?.repoRoot ?? scope();
  function toggleGroup(root: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }
  function mark(keys: string[]) {
    setMarks((prev) => {
      const next = new Set(prev);
      const remove = keys.every((k) => next.has(k));
      for (const k of keys) {
        if (remove) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }
  const repoHeaders = createMemo(() => showsRepoHeaders(visible()));

  const cursorIndex = createMemo(() => {
    const index = rows().findIndex((row) => row.key === cursorKey());
    return index === -1 ? 0 : index;
  });
  /**
   * Whether the cursor is being HELD on a row that has not arrived yet.
   *
   * The hold below keeps `cursorKey` naming a row the list does not have, and
   * `cursorIndex` answers 0 for any key it cannot find. Together those would
   * put Enter on the first row while `isCursor` highlights NOTHING — a key
   * acting on a row the user can neither see nor chose.
   */
  const cursorHeld = createMemo(() => {
    const key = cursorKey();
    if (key === null) return false;
    if (rows().some((row) => row.key === key)) return false;
    // Typing releases it: a hold that outlived the user's narrowing would
    // leave a visible match unhighlighted with Enter dead until the timeout.
    if (filterEdited()) return false;
    return sourcePending(key);
  });

  /** The row a key acts on, or null while held — the no-row path Enter has. */
  const cursorRow = createMemo(() =>
    cursorHeld() || headerRepo() ? null : (rows()[cursorIndex()] ?? null),
  );

  /**
   * Whether the source that would deliver `key` has yet to answer.
   *
   * A row key names its own source — `pr:` or `issue:` — which is what makes
   * this answerable per key rather than "is anything still loading". Holding
   * on the latter would freeze a cursor the filter legitimately narrowed away
   * while an unrelated source was in flight.
   *
   * A source that FAILED has answered: the hold releases and the cursor
   * re-seeds, because the row is never coming.
   */
  function sourcePending(key: string): boolean {
    if (isPRRowKey(key)) return prs() === null && prError() === null;
    if (isIssueRowKey(key)) return issues() === null && issueError() === null;
    return false;
  }

  /**
   * Re-seed the cursor onto a row that exists.
   *
   * The list is re-derived on every keystroke of the filter, so the key under
   * the cursor can simply stop existing. Falling to the first row is the same
   * rule the panel follows, and it is what makes typing feel like narrowing
   * rather than losing your place.
   */
  createEffect(() => {
    const live = rows();
    if (live.length === 0) return;
    const key = cursorKey();
    if (key !== null && (headerRepo() || live.some((row) => row.key === key)))
      return;
    // "Not delivered YET" is not "gone": the three reads land independently,
    // so a seeded key can be absent for reasons the filter had no part in.
    // Clobbering it is unrecoverable — the cursor then names a row that DOES
    // exist, so the guard above never reconsiders and the late answer brings
    // back the row without the cursor. Hold instead, as the panel holds a PR
    // key through its own phase 3; `SOURCE_TIMEOUT_MS` bounds the wait, and
    // typing ends it early — the cursor follows the rows the user is aiming at.
    if (key !== null && !filterEdited() && sourcePending(key)) return;
    setCursorKey(live[0]!.key);
  });

  const layout = createMemo(() =>
    sourcePickerLayout(
      visible()
        .filter((r) => r.prs.length + r.issues.length > 0)
        .map((r) =>
          collapsed().has(r.repoRoot) ? { ...r, prs: [], issues: [] } : r,
        ),
      (row) => sourceRowHeight(row, props.compact === true),
      { repoHeaders: repoHeaders() },
    ),
  );

  /**
   * Scrolling is an EFFECT of where the cursor is, not of the key that moved
   * it: the filter re-derives the list with no keypress on the list at all.
   */
  createEffect(() => {
    // Read every signal BEFORE the `listBox` guard. `listBox` is a ref rather
    // than a signal, and the scrollbox mounts only once rows arrive, so
    // guarding first leaves an effect that tracked nothing — which Solid
    // never runs again, and the list never scrolls at all.
    //
    // `scrollboxLayout()` is the one that carries the INITIAL scroll, however
    // unused it looks: `layout()` re-runs this too early, while yoga has not
    // measured the box and `scrollTargetFor` refuses a zero-height viewport,
    // and `cursorKey()` only moves once a key is pressed.
    void scrollboxLayout();
    const key = cursorKey();
    const plan = layout();
    const box = listBox;
    if (!box) return;
    const target = scrollTargetFor(
      plan,
      key,
      box.scrollTop,
      box.viewport?.height ?? 0,
    );
    if (target !== null) box.scrollTo(target);
  });

  function moveCursor(delta: number): void {
    const live = navKeys();
    if (!live.length) return;
    if (cursorHeld()) {
      setCursorKey(rows()[0]?.key ?? null);
      return;
    }
    const base = live.indexOf(cursorKey() ?? "");
    setCursorKey(live[Math.min(Math.max(base + delta, 0), live.length - 1)]!);
  }

  /**
   * Enter: start work on whatever the row is.
   *
   * A source already checked out here is not a spawn question at all — it is
   * the worktree that holds it — so it routes through the caller's
   * open-worktree verb, which revalidates against the live session list and
   * jumps if an agent has moved in since this list was read.
   *
   * The mark on the row is from the `/worktrees` snapshot taken when the
   * picker loaded. Another spawn can cut the issue (or PR) worktree while
   * this surface sits open, leaving `checkedOutPath` null; Enter would then
   * open spawn mode and `POST /spawn` would number a sibling. Re-read first,
   * rematch with the same rules the list used, and go THERE if a checkout
   * now exists.
   */
  async function activate(row: SourceRow): Promise<void> {
    if (activating) return;
    activating = true;
    const carry = { cursor: row.key, filter: filter() };
    try {
      let snapshot = worktrees();
      let refreshed = false;
      try {
        const response = await fetch(worktreesUrl(), {
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });
        if (response.ok) {
          const fresh = (await response.json()) as WorktreeListResponse;
          setWorktrees(fresh);
          snapshot = fresh;
          refreshed = true;
        }
      } catch {
        // Keep the snapshot we already have: a failed re-read must not
        // turn a known checkout into a spawn, or a spawn into a hang.
      }
      const path = checkedOutPathFor(row, snapshot);
      const checkout = refreshed ? path : (path ?? row.checkedOutPath);
      if (checkout) {
        props.onOpenWorktree({ path: checkout, ...carry });
        return;
      }
      if (row.kind === "pr") {
        props.onPickPR({
          number: row.pr.number,
          title: row.pr.title,
          repoRoot: row.repoRoot,
          ...carry,
        });
        return;
      }
      props.onPickIssue({
        number: row.issue.number,
        title: row.issue.title,
        repoRoot: row.repoRoot,
        ...carry,
      });
    } finally {
      activating = false;
    }
  }

  /** Esc, and `q` in nav mode: back to wherever this was opened from. */
  function close(): void {
    props.onClose();
  }

  useKeyboard((event: KeyEvent) => {
    if (props.enabled === false || event.defaultPrevented) return;
    const key = event.name;
    if (key !== "g") pendingG = false;

    // FILTER mode. The input owns every text key, so only the keys handled
    // here may be preventDefault'd — a handler that defaults everything, the
    // way the Worktrees panel's does, kills typing dead.
    if (filtering()) {
      if (key === "down" || (key === "n" && event.ctrl)) {
        moveCursor(1);
        event.preventDefault();
        return;
      }
      if (key === "up" || (key === "p" && event.ctrl)) {
        moveCursor(-1);
        event.preventDefault();
        return;
      }
      if (key === "escape") {
        // Drops the filter and the row with it, exactly as `exitSearchMode`
        // does for the session picker's search. The query cannot outlive the
        // row that shows it, or the list is narrowed for no visible reason.
        setFilter("");
        setFiltering(false);
        // The edit goes with it: what remains is fresh nav, which holds.
        setFilterEdited(false);
        event.preventDefault();
        return;
      }
      if (key === "return" || key === "enter") {
        // Enter PICKS rather than merely blurring the input: the filter
        // exists to reach a row, so the keystroke that ends typing is the
        // one that acts on what typing found.
        const row = cursorRow();
        if (row) activate(row);
        event.preventDefault();
        return;
      }
      // Everything else falls through to the input, untouched.
      return;
    }

    // NAV mode: one key, one meaning, the same as every other list here.
    event.preventDefault();
    setNote(null);
    if (props.onNavigate?.(event, currentRepo())) return;
    if (pendingZ) {
      pendingZ = false;
      if (key === "m") {
        setCollapsed(new Set(visible().map((r) => r.repoRoot)));
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
        moveCursor(1);
        break;
      case "k":
      case "up":
        moveCursor(-1);
        break;
      case "n":
        if (event.ctrl) moveCursor(1);
        else
          props.onNew?.(
            cursorRow()?.checkedOutPath ??
              currentRepo() ??
              props.cwd ??
              process.cwd(),
          );
        break;
      case "p":
        if (event.ctrl) moveCursor(-1);
        break;
      case "/":
        setFiltering(true);
        break;
      case "r":
      case "R":
        // An explicit refresh, which is the only thing that skips the
        // daemon's TTL: a PR merged a moment ago still reads open.
        if (key === "R" || event.shift) {
          props.onRefresh?.();
          load({ refresh: true });
        } else {
          const path = cursorRow()?.checkedOutPath;
          const session = worktrees()
            ?.repos.flatMap((r) => r.worktrees)
            .find((w) => w.path === path)?.sessions[0];
          if (session) props.onRestart?.(session.id);
        }
        break;
      case "return":
      case "enter": {
        const header = headerRepo();
        if (header) {
          toggleGroup(header.repoRoot);
          break;
        }
        const row = cursorRow();
        if (row) activate(row);
        break;
      }
      case "s": {
        const next = scope() ? null : currentRepo();
        setScope(next);
        props.onScope?.(next);
        setMarks(new Set<string>());
        setWorktrees(null);
        load();
        break;
      }
      case "space":
      case " ": {
        const header = headerRepo();
        const row = cursorRow();
        if (header) mark([...header.prs, ...header.issues].map((r) => r.key));
        else if (row) mark([row.key]);
        break;
      }
      case "a":
      case "A":
        setMarks(
          new Set(key === "A" || event.shift ? [] : rows().map((r) => r.key)),
        );
        break;
      case "x":
      case "X": {
        const header = headerRepo();
        const selected =
          key === "X" || event.shift
            ? rows()
            : marks().size
              ? rows().filter((r) => marks().has(r.key))
              : header
                ? [...header.prs, ...header.issues]
                : cursorRow()
                  ? [cursorRow()!]
                  : [];
        const paths = new Set(
          selected.map((r) => r.checkedOutPath).filter(Boolean),
        );
        const ids = [
          ...new Set(
            worktrees()
              ?.repos.flatMap((r) => r.worktrees)
              .filter((w) => paths.has(w.path))
              .flatMap((w) => w.sessions.map((s) => s.id)) ?? [],
          ),
        ];
        if (ids.length) props.onKill?.(ids);
        else setNote("No attached sessions on the selected sources");
        break;
      }
      case "d":
      case "D": {
        const row = cursorRow();
        if (!row?.checkedOutPath) {
          setNote("Check out this source before reviewing it");
          break;
        }
        const checkout = worktrees()
          ?.repos.flatMap((r) => r.worktrees)
          .find((w) => w.path === row.checkedOutPath);
        props.onReview?.({
          path: row.checkedOutPath,
          sessionId: checkout?.sessions[0]?.id ?? null,
          branch: key === "D" || event.shift,
          cursor: row.key,
          filter: filter(),
        });
        break;
      }
      case "y":
      case "o": {
        const row = cursorRow();
        if (row) {
          const url = row.kind === "pr" ? row.pr.url : row.issue.url;
          if (key === "o") props.effects.openUrl(url);
          else props.effects.copyText(url, renderer);
        }
        break;
      }
      case "g":
      case "G":
        if (key === "G" || event.shift) setCursorKey(navKeys().at(-1) ?? null);
        else if (pendingG) {
          setCursorKey(navKeys()[0] ?? null);
          pendingG = false;
        } else pendingG = true;
        break;
      case "z":
        pendingZ = true;
        break;
      case "-":
        setCollapsed(new Set(visible().map((r) => r.repoRoot)));
        break;
      case "=":
        setCollapsed(new Set<string>());
        break;
      case "q":
      case "escape":
        close();
        break;
      default:
        if (/^[1-9]$/.test(key)) {
          const row = rows()[Number(key) - 1];
          if (row) {
            setCursorKey(row.key);
            void activate(row);
          }
        }
        break;
    }
  });

  const title = createMemo(() => {
    const scoped = scope();
    const name = scoped ? scoped.split("/").filter(Boolean).pop() : null;
    return truncateText(
      name ? `Start work · ${name}` : "Start work",
      contentWidth(),
    );
  });

  /**
   * What the rowless surface says. The gate above is a loading state, not an
   * absence: `emptyStateText` over it would read "No repository here".
   */
  const emptyState = createMemo(() =>
    worktrees() === null
      ? { text: "Loading...", fg: theme.subtext }
      : emptyStateText(visible(), filter()),
  );

  const hints = createMemo(() =>
    fitHints(
      filtering()
        ? [
            { text: "enter start", rank: 3 },
            { text: "ctrl-n/p move", rank: 2 },
            // "cancel", not "done": Esc drops the query, the same word the
            // session picker's footer uses for the same key.
            { text: "esc cancel", rank: 3 },
          ]
        : [
            { text: "/ filter", rank: 3 },
            { text: "enter start", rank: 3 },
            { text: "j/k move", rank: 1 },
            { text: "R refresh", rank: 1 },
            { text: "q close", rank: 2 },
          ],
      contentWidth(),
    ),
  );

  const sourceNotice = () =>
    prError() ??
    issueError() ??
    prs()?.errors[0]?.error ??
    issues()?.errors[0]?.error ??
    (prs() === null || issues() === null ? "Checking GitHub…" : null);
  const renderRow = (row: SourceRow) => {
    const isCursor = () => cursorKey() === row.key;
    const index = () => rows().findIndex((r) => r.key === row.key) + 1;
    const source = () => (row.kind === "pr" ? row.pr : row.issue);
    const right = () =>
      listWidth() < 50
        ? ""
        : truncateText(
            [
              source().author ? `@${source().author}` : "",
              row.kind === "issue"
                ? (row.issue.labels[0] ?? "")
                : (row.pr.labels?.[0] ?? ""),
              row.kind === "pr" && row.pr.ciStatus !== "none"
                ? row.pr.ciStatus
                : "",
              sourceAge(source().createdAt),
            ]
              .filter(Boolean)
              .join("  "),
            Math.floor(listWidth() / 3),
          );
    const label = () => {
      const budget = Math.max(1, listWidth() - 6 - displayWidth(right()));
      const checkout = row.checkedOutName
        ? truncateText(` → ${row.checkedOutName}`, Math.floor(budget / 2))
        : "";
      return (
        truncateText(
          `${sourceRowMarker(row)} ${sourceRowLabel(row)}`,
          Math.max(1, budget - displayWidth(checkout)),
        ) + checkout
      );
    };
    const sessions = () =>
      worktrees()
        ?.repos.flatMap((r) => r.worktrees)
        .find((w) => w.path === row.checkedOutPath)?.sessions ?? [];
    const status = () =>
      sessions().some((s) => s.status === "waiting")
        ? "waiting"
        : sessions().some((s) => s.status === "working")
          ? "working"
          : "idle";
    const spinner = useStatusIcon(
      status,
      () => null,
      () => "dot",
    );
    const glyph = () =>
      !sessions().length
        ? " "
        : status() === "waiting"
          ? "◆"
          : status() === "working"
            ? spinner()
            : "●";
    return (
      <box
        height={1}
        width="100%"
        flexDirection="row"
        backgroundColor={isCursor() ? theme.surface : undefined}
        onMouseDown={() => setCursorKey(row.key)}
      >
        <text fg={theme.mauve}>
          {sessions().some((s) => s.id === props.activeSessionId) ? "▎" : " "}
        </text>
        <text
          fg={theme.overlay}
        >{`${marks().has(row.key) ? "✓" : index() <= 9 ? index() : " "} `}</text>
        <text
          fg={
            status() === "waiting"
              ? theme.red
              : status() === "working"
                ? theme.peach
                : theme.overlay
          }
        >
          {glyph()}{" "}
        </text>
        <text fg={sourceRowDim(row) ? theme.subtext : theme.text}>
          {label()}
        </text>
        <box flexGrow={1} />
        <text fg={theme.overlay}>{right()}</text>
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
        <box width="100%" height={1} flexDirection="row">
          <text fg={theme.text} attributes={1}>
            {title()}
          </text>
        </box>
      </Show>

      {/* Drawn only while filtering, in the session picker's own shape: the
          `/ ` prefix, a placeholder, and no line at all until `/` is pressed.
          The footer's `/ filter` hint is what teaches the key, which is how
          the session picker teaches it too. */}
      <Show when={filtering()}>
        <box width="100%" height={1} flexDirection="row">
          <text fg={theme.overlay} width={2}>
            {"/ "}
          </text>
          <input
            value={filter()}
            onInput={(value: string) => {
              // 0.1.97 emits `input` for programmatic assignments too, the
              // seed at mount included, so only a changed value is the user.
              if (value !== filter()) setFilterEdited(true);
              setFilter(value);
            }}
            focused
            placeholder="Filter pull requests and issues..."
            placeholderColor={theme.overlay}
            textColor={theme.text}
            cursorColor={theme.blue}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            width="100%"
          />
        </box>
      </Show>

      <box flexGrow={1} flexDirection="column">
        <Show when={phase() === "error"}>
          <box paddingTop={1} flexDirection="column">
            <text fg={theme.red}>
              {truncateText(error() ?? "", contentWidth())}
            </text>
            <text fg={theme.overlay}>R retry · q close</text>
          </box>
        </Show>

        <Show when={phase() !== "error"}>
          <Show
            when={hasRows(visible())}
            fallback={
              <box paddingTop={1}>
                <text fg={emptyState().fg}>
                  {truncateText(emptyState().text, contentWidth())}
                </text>
              </box>
            }
          >
            <scrollbox
              flexGrow={1}
              ref={(r: ScrollBoxRenderable) => {
                listBox = r;
                const bump = () => setScrollboxLayout((v) => v + 1);
                r.viewport.on("resize", bump);
                r.content.on("resize", bump);
              }}
            >
              <For
                each={visible().filter(
                  (r) => r.prs.length + r.issues.length > 0,
                )}
              >
                {(repo) => (
                  <box flexDirection="column">
                    <GroupHeader
                      label={repo.repoName}
                      count={repo.prs.length + repo.issues.length}
                      width={listWidth()}
                      facts={factsText(
                        props.facts?.repos.find(
                          (r) => r.repoRoot === repo.repoRoot,
                        ),
                      )}
                      collapsed={collapsed().has(repo.repoRoot)}
                      selected={headerRepo()?.repoRoot === repo.repoRoot}
                      members={[]}
                      onActivate={() => {
                        setCursorKey(`repo:${repo.repoRoot}`);
                        toggleGroup(repo.repoRoot);
                      }}
                    />
                    <Show when={!collapsed().has(repo.repoRoot)}>
                      <For each={[...repo.prs, ...repo.issues]}>
                        {renderRow}
                      </For>
                    </Show>
                  </box>
                )}
              </For>
            </scrollbox>
          </Show>
        </Show>
      </box>

      <box width="100%" height={1} flexDirection="row">
        <text fg={note() ? theme.yellow : theme.overlay}>
          {truncateText(note() ?? sourceNotice() ?? hints(), contentWidth())}
        </text>
      </box>
    </box>
  );
};
