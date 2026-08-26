import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onMount,
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
import { useStatusIcon } from "../utils/useStatusIcon";
import { fitHints } from "./Footer";
import { isPRRowKey } from "./pr-rows";
import {
  fitSegments,
  scrollTargetFor,
  type RowSegment,
  type VisualLayout,
} from "./row-segments";
import {
  ISSUES_SECTION,
  PRS_SECTION,
  buildSourceRepos,
  emptyStateText,
  filterRepos,
  hasRows,
  isIssueRowKey,
  pickerRows,
  sectionText,
  sourceDetailPhrases,
  sourceRowDim,
  sourceRowLabel,
  sourceRowMarker,
  type SourceRepo,
  type SourceRow,
} from "./source-picker-rows";

/**
 * The source picker (issue #151): one filterable list of a repo's open pull
 * requests and open issues, whose only verb is Enter.
 *
 * It is the SOURCE SELECTOR for a spawn, in the daemon's own vocabulary
 * (`gh-spawn-source.ts`). Pick a row and the existing new-session dialog
 * opens in the matching mode to cut a worktree and start an agent in it; pick
 * one already checked out and it jumps to the checkout instead. It is not a
 * survey — that is the Worktrees panel's PR view — and it renders nothing
 * that view does not already know how to render.
 *
 * Both sources share ONE list rather than two tabs, and the filter is why:
 * typing `notif` should reach a PR and an issue at once, because a user
 * remembers the words and not whether the thing they remember was filed as
 * one or the other. A tab boundary would answer a question nobody asked, and
 * a match on the far side of it would read as "nothing matches".
 *
 * The surface opens in NAV mode and `/` starts the filter, rather than being
 * permanently in search mode. That is a deliberate reversal of the first
 * design: one key means one thing on every surface here, so `j`/`k` move and
 * `q` closes exactly as they do in the panel and the picker.
 *
 * The filter row follows the session picker's search row exactly, down to
 * Esc: it is DRAWN only while filtering, and leaving clears what was typed
 * (`exitSearchMode` in `store.ts`). Those two halves are one decision. A row
 * that hid while the query stayed applied would leave a list narrowed to
 * three of forty with nothing on screen saying why.
 */

/** Independent of the list read, so a slow GitHub cannot hold up the local
 *  worktrees that mark a row as already checked out. */
const LIST_TIMEOUT_MS = 20_000;

/** How the two GitHub reads are announced while they are in flight. */
type LoadPhase = "loading" | "list" | "error";

export interface SourcePickerOrigin {
  /** The Worktrees panel this was opened from, so Esc can reopen it. */
  panelRepo: string | null;
  panelScope: string | null;
  panelCursor: string;
}

export interface SourcePickerProps {
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
const ROW_GUTTER = 3;
/** Columns the scrollbox keeps for its scrollbar. */
const SCROLLBAR_GUTTER = 1;
/** The separator between detail phrases, muted so the facts carry the line. */
const PHRASE_SEPARATOR = " · ";

/** How tall a row draws: one line, plus a detail line when it has one. */
export function sourceRowHeight(row: SourceRow, compact = false): number {
  return 1 + (sourceDetailPhrases(row, { compact }).length > 0 ? 1 : 0);
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
    if (opts.repoHeaders) line += 1;
    for (const section of [repo.prs, repo.issues]) {
      line += 1; // the section header
      for (const row of section) {
        const height = heightOf(row);
        layout.set(row.key, { line, height });
        line += height;
      }
    }
  }
  return layout;
}

/** Repo headers are drawn only where there is more than one repo to name. */
export function showsRepoHeaders(repos: SourceRepo[]): boolean {
  return repos.length > 1;
}

export const SourcePicker: Component<SourcePickerProps> = (props) => {
  const dims = useSharedTerminalDimensions();

  const [phase, setPhase] = createSignal<LoadPhase>("loading");
  const [prs, setPrs] = createSignal<PRListResponse | null>(null);
  const [prError, setPrError] = createSignal<string | null>(null);
  const [issues, setIssues] = createSignal<IssueListResponse | null>(null);
  const [issueError, setIssueError] = createSignal<string | null>(null);
  const [worktrees, setWorktrees] = createSignal<WorktreeListResponse | null>(
    null,
  );
  const [error, setError] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal(props.initialFilter ?? "");
  /**
   * Whether the filter input has the keyboard. `/` enters, Esc leaves.
   *
   * A carried query opens IN the filter, because leaving it clears it: a
   * non-empty filter can only have been typed in filter mode, so a return
   * from a cancelled dialog restores the state the pick was made from.
   */
  const [filtering, setFiltering] = createSignal(
    (props.initialFilter ?? "") !== "",
  );
  const [cursorKey, setCursorKey] = createSignal<string | null>(
    props.initialCursor ?? null,
  );
  const [note, setNote] = createSignal<string | null>(null);
  const [scrollboxLayout, setScrollboxLayout] = createSignal(0);
  let listBox: ScrollBoxRenderable | undefined;
  let loadGeneration = 0;

  const width = () => dims().width;
  /** The box less its border and padding. */
  const contentWidth = () => Math.max(8, width() - 4);
  /** Inside the scrollbox, which keeps a column for its bar. */
  const listWidth = () => Math.max(4, contentWidth() - SCROLLBAR_GUTTER);

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

    const listUrl = new URL(`${getDaemonUrl()}/worktrees`);
    if (props.repo) listUrl.searchParams.set("repo", props.repo);
    if (props.cwd) listUrl.searchParams.set("cwd", props.cwd);
    fetch(listUrl, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
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
      repo: props.repo,
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
      home: props.repo,
    }),
  );

  /** The same, narrowed by whatever is typed. */
  const visible = createMemo(() => filterRepos(repos(), filter()));
  const rows = createMemo(() => pickerRows(visible()));
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
    return sourcePending(key);
  });

  /** The row a key acts on, or null while held — the no-row path Enter has. */
  const cursorRow = createMemo(() =>
    cursorHeld() ? null : (rows()[cursorIndex()] ?? null),
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
    if (key !== null && live.some((row) => row.key === key)) return;
    // "Not delivered YET" is not "gone": the three reads land independently,
    // so a seeded key can be absent for reasons the filter had no part in.
    // Clobbering it is unrecoverable — the cursor then names a row that DOES
    // exist, so the guard above never reconsiders and the late answer brings
    // back the row without the cursor. Hold instead, as the panel holds a PR
    // key through its own phase 3; `SOURCE_TIMEOUT_MS` bounds the wait.
    if (key !== null && sourcePending(key)) return;
    setCursorKey(live[0]!.key);
  });

  const layout = createMemo(() =>
    sourcePickerLayout(
      visible(),
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
    const live = rows();
    if (live.length === 0) return;
    const next = Math.min(Math.max(cursorIndex() + delta, 0), live.length - 1);
    setCursorKey(live[next]!.key);
  }

  /**
   * Enter: start work on whatever the row is.
   *
   * A source already checked out here is not a spawn question at all — it is
   * the worktree that holds it — so it routes through the caller's
   * open-worktree verb, which revalidates against the live session list and
   * jumps if an agent has moved in since this list was read.
   */
  function activate(row: SourceRow): void {
    const carry = { cursor: row.key, filter: filter() };
    if (row.checkedOutPath) {
      props.onOpenWorktree({ path: row.checkedOutPath, ...carry });
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
  }

  /** Esc, and `q` in nav mode: back to wherever this was opened from. */
  function close(): void {
    props.onClose();
  }

  useKeyboard((event: KeyEvent) => {
    const key = event.name;

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
        load({ refresh: true });
        break;
      case "return":
      case "enter": {
        const row = cursorRow();
        if (row) activate(row);
        break;
      }
      case "q":
      case "escape":
        close();
        break;
      default:
        break;
    }
  });

  const spinner = useStatusIcon(
    () => (phase() === "loading" ? "working" : "idle"),
    () => null,
    () => props.iconStyle ?? "dot",
  );

  const title = createMemo(() => {
    const scoped = props.repo;
    const name = scoped ? scoped.split("/").filter(Boolean).pop() : null;
    return truncateText(
      name ? `Start work · ${name}` : "Start work",
      contentWidth(),
    );
  });

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
            { text: "r refresh", rank: 1 },
            { text: "q close", rank: 2 },
          ],
      contentWidth(),
    ),
  );

  /** One row's bright line: the marker, then the label. */
  const primarySegments = (row: SourceRow, isCursor: boolean): RowSegment[] => {
    const fg = isCursor
      ? theme.text
      : sourceRowDim(row)
        ? theme.subtext
        : theme.text;
    return fitSegments(
      [
        { text: " ", fg: theme.overlay },
        {
          text: sourceRowMarker(row),
          fg: isCursor ? theme.mauve : theme.overlay,
        },
        { text: " ", fg: theme.overlay },
        { text: sourceRowLabel(row), fg },
      ],
      listWidth(),
    );
  };

  /** Its dim line, indented under the label. */
  const detailSegments = (row: SourceRow): RowSegment[] => {
    const phrases = sourceDetailPhrases(row, {
      compact: props.compact === true,
    });
    if (phrases.length === 0) return [];
    const segments: RowSegment[] = [
      { text: " ".repeat(ROW_GUTTER + 1), fg: theme.overlay },
    ];
    phrases.forEach((phrase, index) => {
      if (index > 0) {
        segments.push({ text: PHRASE_SEPARATOR, fg: theme.overlay });
      }
      segments.push({ text: phrase.text, fg: phrase.fg });
    });
    return fitSegments(segments, listWidth());
  };

  const renderRow = (row: SourceRow) => {
    const isCursor = createMemo(() => cursorKey() === row.key);
    const detail = createMemo(() => detailSegments(row));
    return (
      <box flexDirection="column">
        <box
          height={1}
          width="100%"
          flexDirection="row"
          backgroundColor={isCursor() ? theme.surface : undefined}
        >
          <For each={primarySegments(row, isCursor())}>
            {(segment) => <text fg={segment.fg}>{segment.text}</text>}
          </For>
        </box>
        <Show when={detail().length > 0}>
          <box
            height={1}
            width="100%"
            flexDirection="row"
            backgroundColor={isCursor() ? theme.surface : undefined}
          >
            <For each={detail()}>
              {(segment) => <text fg={segment.fg}>{segment.text}</text>}
            </For>
          </box>
        </Show>
      </box>
    );
  };

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box width="100%" height={1} flexDirection="row">
        <text fg={theme.text} attributes={1}>
          {title()}
        </text>
      </box>

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
            onInput={setFilter}
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
            <text fg={theme.overlay}>r retry · q close</text>
          </box>
        </Show>

        <Show when={phase() !== "error"}>
          <Show
            when={hasRows(visible())}
            fallback={
              <box paddingTop={1}>
                <text fg={emptyStateText(visible(), filter()).fg}>
                  {truncateText(
                    emptyStateText(visible(), filter()).text,
                    contentWidth(),
                  )}
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
              <For each={visible()}>
                {(repo) => (
                  <box flexDirection="column">
                    <Show when={repoHeaders()}>
                      <box height={1} width="100%">
                        <text fg={theme.mauve} attributes={1}>
                          {truncateText(repo.repoName, listWidth())}
                        </text>
                      </box>
                    </Show>
                    <box height={1} width="100%">
                      <text fg={theme.overlay}>
                        {truncateText(
                          sectionText(PRS_SECTION, repo.prSection, spinner()),
                          listWidth(),
                        )}
                      </text>
                    </box>
                    <For each={repo.prs}>{renderRow}</For>
                    <box height={1} width="100%">
                      <text fg={theme.overlay}>
                        {truncateText(
                          sectionText(
                            ISSUES_SECTION,
                            repo.issueSection,
                            spinner(),
                          ),
                          listWidth(),
                        )}
                      </text>
                    </box>
                    <For each={repo.issues}>{renderRow}</For>
                  </box>
                )}
              </For>
            </scrollbox>
          </Show>
        </Show>
      </box>

      <box width="100%" height={1} flexDirection="row">
        <text fg={note() ? theme.yellow : theme.overlay}>
          {truncateText(note() ?? hints(), contentWidth())}
        </text>
      </box>
    </box>
  );
};
