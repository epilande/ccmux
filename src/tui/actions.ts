import fuzzysort from "fuzzysort";

export type View = "sessions" | "worktrees" | "start";
const SESSIONS: readonly View[] = ["sessions"];

/** Never dropped from the footer, at any width. */
export const PINNED = Number.POSITIVE_INFINITY;

/**
 * How an action appears on the footer line: its key, the one verb it is
 * glossed with, and how long it survives a narrowing terminal (lowest rank
 * drops first, see `fitHints`). A verb differs by view only where the key
 * does something different there: `x` kills sessions but removes worktrees,
 * and `q` quits from Sessions but goes back from the other views.
 */
export interface FooterHint {
  key: string;
  verb: string | Readonly<Record<View, string>>;
  rank: number;
  /** A different rank in some views, where the key matters more (or less)
   *  than its default says. */
  rankIn?: Readonly<Partial<Record<View, number>>>;
  /** The only views whose footer carries the hint. The key still works
   *  everywhere `views` says; the footer just has better things to teach
   *  elsewhere (`space mark` matters in Worktrees, where marks are how a
   *  removal is chosen). */
  only?: readonly View[];
}

/**
 * One row the `:` palette offers for a keyed action: the label it is found
 * by and the key it presses. A paired action (`x / X`, `h / l`) offers each
 * side as its own row, because the palette runs one thing per Enter; help
 * keeps rendering the pair.
 *
 * `keys` is spelled the way help spells keys (`X`, `zm`, `Ctrl+D`, `Alt+H`,
 * `Tab`, `Enter`, `Space`) and is both what the palette shows beside the
 * label and what `keySequence` turns into the bytes it replays.
 */
export interface PaletteEntry {
  label: string | Readonly<Record<View, string>>;
  keys: string;
}

/** Public action vocabulary shared by help, the footer, the `:` palette and
 *  view-level keyboard routing. `views` lists the views that handle a key;
 *  absent means every view. `hint` puts the action on the footer, in
 *  registry order; `palette` lists what the palette offers for it (an action
 *  without one, cursor movement, is not worth a palette row). */
export const ACTIONS = [
  {
    id: "move",
    key: "j/k ↑/↓",
    desc: "Move cursor",
    section: "Navigation",
    hint: { key: "j/k", verb: "nav", rank: 5 },
  },
  {
    id: "views",
    key: "h / l",
    desc: "Previous / next view",
    section: "Navigation",
    hint: { key: "h/l", verb: "views", rank: PINNED },
    palette: [
      { label: "Previous view", keys: "h" },
      { label: "Next view", keys: "l" },
    ],
  },
  {
    id: "edges",
    key: "gg / G",
    desc: "First / last row",
    section: "Navigation",
    palette: [
      { label: "First row", keys: "gg" },
      { label: "Last row", keys: "G" },
    ],
  },
  { id: "number", key: "1-9", desc: "Jump to row N", section: "Navigation" },
  {
    id: "enter",
    key: "Enter",
    desc: "Go / toggle group",
    section: "Navigation",
    hint: { key: "enter", verb: "go", rank: 5 },
    palette: [{ label: "Go / toggle group", keys: "Enter" }],
  },
  {
    id: "scope",
    key: "s",
    desc: "All repos / this repo",
    section: "Navigation",
    hint: { key: "s", verb: "scope", rank: PINNED },
    palette: [{ label: "Scope: all repos / this repo", keys: "s" }],
  },
  {
    id: "search",
    key: "/",
    desc: "Filter",
    section: "Navigation",
    views: ["sessions", "start"] as readonly View[],
    // Start's list is one filter away from any PR or issue, so there the
    // filter outranks the row actions.
    hint: { key: "/", verb: "search", rank: 4, rankIn: { start: 5 } },
    palette: [{ label: "Search", keys: "/" }],
  },
  {
    id: "mark",
    key: "Space",
    desc: "Mark row / group",
    section: "Actions",
    hint: {
      key: "space",
      verb: "mark",
      rank: 2,
      only: ["worktrees"] as readonly View[],
    },
    palette: [{ label: "Mark row / group", keys: "Space" }],
  },
  {
    id: "markAll",
    key: "a / A",
    desc: "Mark all / clear marks",
    section: "Actions",
    palette: [
      { label: "Mark all", keys: "a" },
      { label: "Clear marks", keys: "A" },
    ],
  },
  {
    id: "remove",
    key: "x / X",
    desc: "Kill or remove / all",
    section: "Actions",
    hint: {
      key: "x",
      verb: { sessions: "kill", worktrees: "remove", start: "kill" },
      rank: 5,
    },
    palette: [
      {
        label: {
          sessions: "Kill session",
          worktrees: "Remove worktree",
          start: "Kill session",
        },
        keys: "x",
      },
      { label: "Kill all sessions", keys: "X" },
    ],
  },
  {
    id: "new",
    key: "n",
    desc: "New session here",
    section: "Actions",
    // In Worktrees `n` starts a session in the worktree under the cursor
    // (cancelling returns to the row), the view's main way to put an agent
    // in a checkout: it ranks with `r restart` there.
    hint: { key: "n", verb: "new", rank: 2, rankIn: { worktrees: 4 } },
    palette: [{ label: "New session here", keys: "n" }],
  },
  {
    id: "start",
    key: "N",
    desc: "Start from PR or issue",
    section: "Actions",
    palette: [{ label: "Start from PR or issue", keys: "N" }],
  },
  {
    id: "worktrees",
    key: "W",
    desc: "Worktrees in this repo",
    section: "Actions",
    palette: [{ label: "Worktrees in this repo", keys: "W" }],
  },
  {
    id: "copy",
    key: "y",
    desc: "Copy response / path / URL",
    section: "Actions",
    palette: [
      {
        label: {
          sessions: "Copy response",
          worktrees: "Copy path",
          start: "Copy URL",
        },
        keys: "y",
      },
    ],
  },
  {
    id: "open",
    key: "o",
    desc: "Open on GitHub",
    section: "Actions",
    palette: [{ label: "Open on GitHub", keys: "o" }],
  },
  {
    id: "restart",
    key: "r",
    desc: "Restart session",
    section: "Actions",
    hint: { key: "r", verb: "restart", rank: 4 },
    palette: [{ label: "Restart session", keys: "r" }],
  },
  {
    id: "refresh",
    key: "R",
    desc: "Refresh / reconnect",
    section: "Actions",
    palette: [{ label: "Refresh / reconnect", keys: "R" }],
  },
  {
    id: "review",
    key: "d / D",
    desc: "Working tree / branch",
    section: "Actions",
    palette: [
      { label: "Review working tree", keys: "d" },
      { label: "Review branch vs base", keys: "D" },
    ],
  },
  {
    id: "menu",
    key: "m",
    desc: "Row menu",
    section: "Sessions",
    views: SESSIONS,
    palette: [{ label: "Row menu", keys: "m" }],
  },
  {
    id: "fork",
    key: "F",
    desc: "Fork session",
    section: "Sessions",
    views: SESSIONS,
    palette: [{ label: "Fork session", keys: "F" }],
  },
  {
    id: "prompt",
    key: "p",
    desc: "Cycle prompt display",
    section: "Sessions",
    views: SESSIONS,
    palette: [{ label: "Cycle prompt display", keys: "p" }],
  },
  {
    id: "hideIdle",
    key: "f",
    desc: "Toggle hide idle",
    section: "Sessions",
    views: SESSIONS,
    palette: [{ label: "Toggle hide idle", keys: "f" }],
  },
  {
    id: "group",
    key: "b",
    desc: "Cycle group-by",
    section: "Groups",
    views: SESSIONS,
    // Its verb is the live grouping (`b group:project`), filled by the
    // footer: it is the only place on screen that says which reading of
    // Sessions is showing, so it stays, at the lowest rank.
    hint: { key: "b", verb: "group", rank: 1 },
    palette: [{ label: "Cycle group-by", keys: "b" }],
  },
  {
    id: "renameGroup",
    key: "e",
    desc: "Rename / merge group",
    section: "Groups",
    views: SESSIONS,
    palette: [{ label: "Rename group…", keys: "e" }],
  },
  {
    id: "moveGroup",
    key: "J / K",
    desc: "Move group down / up",
    section: "Groups",
    views: SESSIONS,
    palette: [
      { label: "Move group down", keys: "J" },
      { label: "Move group up", keys: "K" },
    ],
  },
  {
    id: "pinGroup",
    key: "< / >",
    desc: "Move to top / bottom",
    section: "Groups",
    views: SESSIONS,
    palette: [
      { label: "Pin group to top", keys: "<" },
      { label: "Pin group to bottom", keys: ">" },
    ],
  },
  {
    id: "collapse",
    key: "- / zm",
    desc: "Collapse all groups",
    section: "Groups",
    palette: [{ label: "Collapse all groups", keys: "zm" }],
  },
  {
    id: "expand",
    key: "= / zr",
    desc: "Expand all groups",
    section: "Groups",
    palette: [{ label: "Expand all groups", keys: "zr" }],
  },
  {
    id: "preview",
    key: "P",
    desc: "Toggle preview",
    section: "Preview",
    palette: [{ label: "Toggle preview", keys: "P" }],
  },
  {
    id: "previewFocus",
    key: "Tab",
    desc: "Focus preview",
    section: "Preview",
    palette: [{ label: "Focus preview", keys: "Tab" }],
  },
  {
    id: "previewScroll",
    key: "Ctrl+D/U",
    desc: "Scroll preview",
    section: "Preview",
    palette: [
      { label: "Scroll preview down", keys: "Ctrl+D" },
      { label: "Scroll preview up", keys: "Ctrl+U" },
    ],
  },
  {
    id: "previewResize",
    key: "Alt+H/L",
    desc: "Resize preview",
    section: "Preview",
    palette: [
      { label: "Widen preview", keys: "Alt+H" },
      { label: "Narrow preview", keys: "Alt+L" },
    ],
  },
  {
    id: "palette",
    key: ":",
    desc: "Command palette",
    section: "Other",
    hint: { key: ":", verb: "more", rank: PINNED },
  },
  {
    id: "help",
    key: "?",
    desc: "Help",
    section: "Other",
    hint: { key: "?", verb: "help", rank: PINNED },
    palette: [{ label: "Help", keys: "?" }],
  },
  {
    id: "back",
    key: "q / Esc",
    desc: "Back, then quit",
    section: "Other",
    hint: {
      key: "q",
      verb: { sessions: "quit", worktrees: "back", start: "back" },
      rank: PINNED,
    },
    palette: [
      {
        label: { sessions: "Quit", worktrees: "Back", start: "Back" },
        keys: "q",
      },
    ],
  },
] as const satisfies readonly {
  id: string;
  key: string;
  desc: string;
  section: string;
  views?: readonly View[];
  hint?: FooterHint;
  palette?: readonly PaletteEntry[];
}[];

/**
 * Actions with no key: the rare ones, reachable only from the `:` palette.
 * App runs each by its id (`runPaletteCommand`); there is nothing to replay.
 * Help lists them in their own section so the cheat sheet still names every
 * action there is.
 */
export const PALETTE_ONLY = [
  {
    id: "groupBy:project",
    label: "Group by project",
    section: "Groups",
    views: SESSIONS,
  },
  {
    id: "groupBy:cwd",
    label: "Group by directory",
    section: "Groups",
    views: SESSIONS,
  },
  {
    id: "groupBy:session",
    label: "Group by tmux session",
    section: "Groups",
    views: SESSIONS,
  },
  {
    id: "groupBy:window",
    label: "Group by tmux window",
    section: "Groups",
    views: SESSIONS,
  },
  {
    id: "groupBy:none",
    label: "No grouping",
    section: "Groups",
    views: SESSIONS,
  },
  {
    id: "resetGroupName",
    label: "Reset group name",
    section: "Groups",
    views: SESSIONS,
  },
  {
    id: "copySessionId",
    label: "Copy session id",
    section: "Sessions",
    views: SESSIONS,
  },
  {
    id: "openTranscript",
    label: "Open transcript",
    section: "Sessions",
    views: SESSIONS,
  },
] as const satisfies readonly {
  id: string;
  label: string;
  section: string;
  views?: readonly View[];
}[];

export type PaletteOnlyId = (typeof PALETTE_ONLY)[number]["id"];

export const VIEWS: View[] = ["sessions", "worktrees", "start"];
export function nextView(view: View, delta: number): View {
  return VIEWS[(VIEWS.indexOf(view) + delta + VIEWS.length) % VIEWS.length]!;
}

/** The section help lists the palette-only actions under. */
export const PALETTE_SECTION = "Palette only (:)";

export function helpGroups(
  sidebar = false,
  reviewable = true,
  view: View = "sessions",
) {
  const groups: { section: string; items: { key: string; desc: string }[] }[] =
    [];
  const add = (section: string, item: { key: string; desc: string }) => {
    let group = groups.find((g) => g.section === section);
    if (!group) {
      group = { section, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  };
  for (const action of ACTIONS) {
    if ("views" in action && !action.views.includes(view)) continue;
    // The sidebar's overlays cycle with h/l; its session list does not.
    if (sidebar && view === "sessions" && action.id === "views") continue;
    if (sidebar && action.section === "Preview") continue;
    // The sidebar has no palette (the rail is the binding width).
    if (sidebar && action.id === "palette") continue;
    if (!reviewable && action.id === "review") continue;
    // Esc is inert in the sidebar's session list, so only q is offered there.
    add(
      action.section,
      sidebar && view === "sessions" && action.id === "back"
        ? { key: "q", desc: action.desc }
        : action,
    );
  }
  if (!sidebar)
    for (const command of PALETTE_ONLY)
      if (!("views" in command) || command.views.includes(view))
        add(PALETTE_SECTION, { key: "", desc: command.label });
  return groups;
}

/** One row of the `:` palette. */
export interface PaletteCommand {
  /** Stable identity: the highlight is stored as one, never as a row
   *  number, so a list re-filtered under it cannot slide another command
   *  under the Enter. */
  id: string;
  label: string;
  section: string;
  /** The key it presses, as help spells it; absent for a palette-only
   *  command, which App runs by `id`. */
  keys?: string;
}

/**
 * Every command the palette offers in `view`: each keyed action's palette
 * entries in registry order, then the palette-only actions. Gated the way
 * help is (a view that does not handle a key does not offer it, review only
 * where it is installed), and empty in the sidebar, which has no palette.
 */
export function paletteCommands(
  view: View,
  opts: { sidebar?: boolean; reviewable?: boolean } = {},
): PaletteCommand[] {
  if (opts.sidebar) return [];
  const commands: PaletteCommand[] = [];
  for (const action of ACTIONS) {
    if (!("palette" in action)) continue;
    if ("views" in action && !action.views.includes(view)) continue;
    if (action.id === "review" && opts.reviewable === false) continue;
    action.palette.forEach((entry: PaletteEntry, index) => {
      commands.push({
        id: `${action.id}:${index}`,
        label:
          typeof entry.label === "string" ? entry.label : entry.label[view],
        section: action.section,
        keys: entry.keys,
      });
    });
  }
  for (const command of PALETTE_ONLY) {
    if ("views" in command && !command.views.includes(view)) continue;
    commands.push({
      id: command.id,
      label: command.label,
      section: command.section,
    });
  }
  return commands;
}

/** A palette row as the list draws it: `labelMarkup` carries fuzzysort's
 *  `<b>` match markup for `HighlightedText`. */
export interface PaletteMatch {
  command: PaletteCommand;
  labelMarkup: string;
}

/**
 * The palette's list for `query`: everything in registry order when it is
 * empty, otherwise fuzzy matches on the label (or the section, so `groups`
 * finds every group action) best first.
 */
export function filterPalette(
  commands: PaletteCommand[],
  query: string,
): PaletteMatch[] {
  const q = query.trim();
  if (!q)
    return commands.map((command) => ({ command, labelMarkup: command.label }));
  return fuzzysort
    .go(q, commands, { keys: ["label", "section"], threshold: 0.3 })
    .map((result) => ({
      command: result.obj,
      // A section-only match highlights nothing in the label.
      labelMarkup: result[0]?.highlight("<b>", "</b>") || result.obj.label,
    }));
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: "\r",
  Space: " ",
  Tab: "\t",
  Esc: "\x1b",
};

/**
 * The raw input a palette command replays, one string per keypress, in the
 * bytes a terminal sends. Fed through `parseKeypress` and the renderer's own
 * key handler, the replayed key reaches exactly the handlers a typed one
 * would, so a palette row cannot do anything its key does not.
 *
 * `Ctrl+X` is the control byte, `Alt+X` is ESC followed by the letter, a
 * named key is its byte, and anything else is typed character by character
 * (`zm` is `z` then `m`, `X` is a shifted `x` the way a terminal sends it).
 */
export function keySequence(keys: string): string[] {
  const named = NAMED_KEYS[keys];
  if (named) return [named];
  const ctrl = /^Ctrl\+([A-Za-z])$/.exec(keys);
  if (ctrl)
    return [String.fromCharCode(ctrl[1]!.toLowerCase().charCodeAt(0) - 96)];
  const alt = /^Alt\+([A-Za-z])$/.exec(keys);
  if (alt) return [`\x1b${alt[1]!.toLowerCase()}`];
  return [...keys];
}

export interface ViewMemory {
  scope: string | null;
  cursor: string | null;
  marks: string[];
  collapsed: string[];
  filter?: string;
}

/** Resolve documented single keys and chords without claiming text input. */
export function actionForKey(event: {
  name: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}) {
  if (event.ctrl || event.meta) return undefined;
  const key =
    event.name === " " || event.name === "space"
      ? "Space"
      : event.name === "return" || event.name === "enter"
        ? "Enter"
        : event.name === "escape"
          ? "Esc"
          : event.shift && event.name.length === 1
            ? event.name.toUpperCase()
            : event.name;
  return ACTIONS.find((action) => action.key.split(" / ").includes(key));
}
