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
}

/** Public action vocabulary shared by help, the footer and view-level
 *  keyboard routing. `views` lists the views that handle a key; absent means
 *  every view. `hint` puts the action on the footer, in registry order. */
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
  },
  {
    id: "edges",
    key: "gg / G",
    desc: "First / last row",
    section: "Navigation",
  },
  { id: "number", key: "1-9", desc: "Go to row N", section: "Navigation" },
  {
    id: "enter",
    key: "Enter",
    desc: "Go / toggle group",
    section: "Navigation",
    hint: { key: "enter", verb: "go", rank: 5 },
  },
  {
    id: "scope",
    key: "s",
    desc: "All repos / this repo",
    section: "Navigation",
    hint: { key: "s", verb: "scope", rank: PINNED },
  },
  {
    id: "search",
    key: "/",
    desc: "Filter",
    section: "Navigation",
    views: ["sessions", "start"] as readonly View[],
    hint: { key: "/", verb: "search", rank: 4 },
  },
  {
    id: "mark",
    key: "Space",
    desc: "Mark row / group",
    section: "Actions",
    hint: { key: "space", verb: "mark", rank: 2 },
  },
  {
    id: "markAll",
    key: "a / A",
    desc: "Mark all / clear marks",
    section: "Actions",
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
  },
  {
    id: "new",
    key: "n",
    desc: "New session here",
    section: "Actions",
    hint: { key: "n", verb: "new", rank: 2 },
  },
  {
    id: "start",
    key: "N",
    desc: "Start from PR or issue",
    section: "Actions",
    hint: { key: "N", verb: "start", rank: 3 },
  },
  {
    id: "worktrees",
    key: "W",
    desc: "Worktrees in this repo",
    section: "Actions",
    hint: { key: "W", verb: "worktrees", rank: 3 },
  },
  {
    id: "copy",
    key: "y",
    desc: "Copy response / path / URL",
    section: "Actions",
  },
  { id: "open", key: "o", desc: "Open on GitHub", section: "Actions" },
  {
    id: "restart",
    key: "r",
    desc: "Restart session",
    section: "Actions",
    hint: { key: "r", verb: "restart", rank: 4 },
  },
  {
    id: "refresh",
    key: "R",
    desc: "Refresh / reconnect",
    section: "Actions",
    hint: { key: "R", verb: "refresh", rank: 1 },
  },
  {
    id: "review",
    key: "d / D",
    desc: "Working tree / branch",
    section: "Actions",
    hint: { key: "d/D", verb: "review", rank: 1 },
  },
  {
    id: "menu",
    key: "m",
    desc: "Row menu",
    section: "Sessions",
    views: SESSIONS,
  },
  {
    id: "fork",
    key: "F",
    desc: "Fork session",
    section: "Sessions",
    views: SESSIONS,
  },
  {
    id: "prompt",
    key: "p",
    desc: "Cycle prompt display",
    section: "Sessions",
    views: SESSIONS,
  },
  {
    id: "hideIdle",
    key: "f",
    desc: "Toggle hide idle",
    section: "Sessions",
    views: SESSIONS,
  },
  {
    id: "group",
    key: "b",
    desc: "Cycle group-by",
    section: "Groups",
    views: SESSIONS,
    // Its verb is the live grouping (`b group:project`), filled by the
    // footer: it says which reading of Sessions is on screen.
    hint: { key: "b", verb: "group", rank: 5 },
  },
  {
    id: "moveGroup",
    key: "J / K",
    desc: "Move group down / up",
    section: "Groups",
    views: SESSIONS,
  },
  {
    id: "pinGroup",
    key: "< / >",
    desc: "Move to top / bottom",
    section: "Groups",
    views: SESSIONS,
  },
  {
    id: "collapse",
    key: "- / zm",
    desc: "Collapse all groups",
    section: "Groups",
  },
  { id: "expand", key: "= / zr", desc: "Expand all groups", section: "Groups" },
  {
    id: "preview",
    key: "P",
    desc: "Toggle preview",
    section: "Preview",
    views: SESSIONS,
    hint: { key: "P", verb: "preview", rank: 4 },
  },
  {
    id: "previewFocus",
    key: "Tab",
    desc: "Focus preview",
    section: "Preview",
    views: SESSIONS,
  },
  {
    id: "previewScroll",
    key: "Ctrl+D/U",
    desc: "Scroll preview",
    section: "Preview",
    views: SESSIONS,
  },
  {
    id: "previewResize",
    key: "Alt+H/L",
    desc: "Resize preview",
    section: "Preview",
    views: SESSIONS,
  },
  {
    id: "help",
    key: "?",
    desc: "Help",
    section: "Other",
    hint: { key: "?", verb: "help", rank: PINNED },
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
  },
] as const satisfies readonly {
  id: string;
  key: string;
  desc: string;
  section: string;
  views?: readonly View[];
  hint?: FooterHint;
}[];
export const VIEWS: View[] = ["sessions", "worktrees", "start"];
export function nextView(view: View, delta: number): View {
  return VIEWS[(VIEWS.indexOf(view) + delta + VIEWS.length) % VIEWS.length]!;
}
export function helpGroups(
  sidebar = false,
  reviewable = true,
  view: View = "sessions",
) {
  const groups: { section: string; items: { key: string; desc: string }[] }[] =
    [];
  for (const action of ACTIONS) {
    if ("views" in action && !action.views.includes(view)) continue;
    // The sidebar's overlays cycle with h/l; its session list does not.
    if (sidebar && view === "sessions" && action.id === "views") continue;
    if (sidebar && action.section === "Preview") continue;
    if (!reviewable && action.id === "review") continue;
    let group = groups.find((g) => g.section === action.section);
    if (!group) {
      group = { section: action.section, items: [] };
      groups.push(group);
    }
    // Esc is inert in the sidebar's session list, so only q is offered there.
    group.items.push(
      sidebar && view === "sessions" && action.id === "back"
        ? { key: "q", desc: action.desc }
        : action,
    );
  }
  return groups;
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
