/**
 * The one-time notice a 1.4 user sees on their first 1.5 picker launch,
 * decided by `claimNotice` (`lib/state.ts`). Picker only: a sidebar fleet
 * would raise it in every pane at once.
 *
 * Plain data, so the picker can read it before the TUI bundle loads. The
 * link is absolute because a compiled install ships no `docs/`.
 */
import { KEY_CHANGES_NOTICE_ID } from "../lib/state";

export const KEY_CHANGES_NOTICE = {
  id: KEY_CHANGES_NOTICE_ID,
  title: "Keys changed in ccmux 1.5",
  lines: [
    "h and l now switch between the Sessions, Worktrees and Start views. Enter on a group header collapses it.",
    "",
    "Space marks a row, or a whole group on its header, and x then acts on the marks.",
    "",
    "In Worktrees, r restarts the attached session (R refreshes), n starts a new session (N opens Start), Tab focuses the preview (s changes scope), and D reviews the branch against its base.",
    "",
    "? lists every key and : searches every action. What changed and why:",
    "https://github.com/epilande/ccmux/blob/main/docs/tui-views-migration.md",
  ],
};
