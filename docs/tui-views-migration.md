# TUI key migration: Sessions · Worktrees · Start

The picker now has three persistent views and starts with all repositories in scope. `h`/`l` cycle views; `W` and `N` jump to Worktrees or Start narrowed to the cursor's repo, including when that view is already open. `s` toggles repo scope. Scope changes retain the selected session only if it remains visible. The sidebar keeps compact `W`/`N` overlays without a strip.

| Previously                                  | Now                                                           |
| ------------------------------------------- | ------------------------------------------------------------- |
| Sessions: `h`/`l` or Space collapse groups  | Enter on a header collapses it; `zm`/`zr` collapse/expand all |
| Worktrees: `h`/`l` switch Worktrees/PR tabs | Cycle Sessions/Worktrees/Start; PRs and issues share Start    |
| Worktrees: Tab changes scope                | `s` changes scope; Tab focuses the existing preview           |
| Worktrees/Source picker: `r` refreshes      | `R` refreshes; `r` restarts the attached session              |
| Worktrees: `n` opens the Source picker      | `N` opens Start; `n` creates a session here                   |
| Worktrees: `d` reviews the branch           | `d` reviews uncommitted work; `D` reviews branch vs base      |
| Worktrees: `D` consents to dirty deletion   | Dirty deletion is a Y/N question during removal confirmation  |

Space marks a row or a header's group in every view. `a` marks all visible rows; `A` clears marks. `x` kills/removes marked rows, otherwise the cursor row or header's group. `X` kills attached sessions in the current view and scope. Collapsed groups are excluded from `X` in all three views. The confirmation freezes its target set; it never expands to hidden repositories or sessions that arrive afterward. Start keeps explicitly marked sources selected when their groups collapse. Marks replace the row number with `✓` and end when the session is removed; a reused ID does not inherit a mark. Worktree rows stay one line; confirmation discloses the dirty files, ignored files and sessions that would be lost, wrapping those consequences at sidebar width.

`?` is scrollable and generated from the action registry. `headerFacts.pr` defaults on; set it to false to hide header/session PR badges and stop background source polling. GitHub unavailability stays silent in the strip and headers until a lookup has succeeded; only a later failure marks a cached value stale. Start still loads sources when opened.

Start also keeps one-line rows. Compact `CI ✓`/`CI ✗`/`CI ◐` marks show checks; `changes` means changes requested in review. Draft, labels and branch follow, with author and age where space permits. The sidebar now includes the index so marks remain visible. Session row identity and the needs-you band remain available in every `b` grouping.

Per-view previews and the `:` palette are coming in PR 3.
