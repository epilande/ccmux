/** Public action vocabulary shared by keyboard routing, help, and the future palette. */
export const ACTIONS = [
  { id: "move", key: "j/k ↑/↓", desc: "Move cursor", section: "Navigation" },
  {
    id: "views",
    key: "h / l",
    desc: "Previous / next view",
    section: "Navigation",
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
  },
  {
    id: "scope",
    key: "s",
    desc: "All repos / this repo",
    section: "Navigation",
  },
  { id: "search", key: "/", desc: "Filter", section: "Navigation" },
  { id: "mark", key: "Space", desc: "Mark row / group", section: "Actions" },
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
  },
  { id: "new", key: "n", desc: "New session here", section: "Actions" },
  { id: "start", key: "N", desc: "Start from PR or issue", section: "Actions" },
  {
    id: "worktrees",
    key: "W",
    desc: "Worktrees in this repo",
    section: "Actions",
  },
  {
    id: "copy",
    key: "y",
    desc: "Copy response / path / URL",
    section: "Actions",
  },
  { id: "open", key: "o", desc: "Open on GitHub", section: "Actions" },
  { id: "restart", key: "r", desc: "Restart session", section: "Actions" },
  { id: "refresh", key: "R", desc: "Refresh / reconnect", section: "Actions" },
  {
    id: "review",
    key: "d / D",
    desc: "Working tree / branch",
    section: "Actions",
  },
  { id: "menu", key: "m", desc: "Row menu", section: "Sessions" },
  { id: "fork", key: "F", desc: "Fork session", section: "Sessions" },
  { id: "prompt", key: "p", desc: "Cycle prompt display", section: "Sessions" },
  { id: "hideIdle", key: "f", desc: "Toggle hide idle", section: "Sessions" },
  { id: "group", key: "b", desc: "Cycle group-by", section: "Groups" },
  {
    id: "moveGroup",
    key: "J / K",
    desc: "Move group down / up",
    section: "Groups",
  },
  {
    id: "pinGroup",
    key: "< / >",
    desc: "Move to top / bottom",
    section: "Groups",
  },
  {
    id: "collapse",
    key: "- / zm",
    desc: "Collapse all groups",
    section: "Groups",
  },
  { id: "expand", key: "= / zr", desc: "Expand all groups", section: "Groups" },
  { id: "preview", key: "P", desc: "Toggle preview", section: "Preview" },
  { id: "previewFocus", key: "Tab", desc: "Focus preview", section: "Preview" },
  {
    id: "previewScroll",
    key: "Ctrl+D/U",
    desc: "Scroll preview",
    section: "Preview",
  },
  {
    id: "previewResize",
    key: "Alt+H/L",
    desc: "Resize preview",
    section: "Preview",
  },
  { id: "help", key: "?", desc: "Help", section: "Other" },
  { id: "back", key: "q / Esc", desc: "Back, then quit", section: "Other" },
] as const;
export type View = "sessions" | "worktrees" | "start";
export const VIEWS: View[] = ["sessions", "worktrees", "start"];
export function nextView(view: View, delta: number): View {
  return VIEWS[(VIEWS.indexOf(view) + delta + VIEWS.length) % VIEWS.length]!;
}
export function helpGroups(sidebar = false, reviewable = true) {
  const groups: { section: string; items: { key: string; desc: string }[] }[] =
    [];
  for (const action of ACTIONS) {
    if (sidebar && (action.section === "Preview" || action.id === "views"))
      continue;
    if (!reviewable && action.id === "review") continue;
    let group = groups.find((g) => g.section === action.section);
    if (!group) {
      group = { section: action.section, items: [] };
      groups.push(group);
    }
    group.items.push(action);
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
