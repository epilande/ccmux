# AGENTS.md

## Project Overview

ccmux is a CLI tool for tracking AI coding agent sessions running in tmux panes and jumping to the one that needs you. It uses a background daemon that detects agent processes, watches log files, and scans terminal output to derive session state. An interactive TUI shows live session states at a glance.

**Built-in agents:** Claude Code, Codex, Cursor, OpenCode, Pi, oh-my-pi (omp), Antigravity, Copilot, Gemini CLI, plus custom agent definitions via config.

## Tech Stack

- **Runtime:** Bun 1.x
- **Language:** TypeScript 5.x
- **TUI Framework:** @opentui/solid 0.1.97 (Solid.js-based terminal UI)
- **Reactivity:** Solid.js 1.9
- **File Watching:** native recursive `fs.watch` for the agent log trees (`log-tree-watcher.ts`; chokidar fallback when recursive watching is unavailable), chokidar 4.x for the small flat dirs (markers, Claude subagents); stat-polling for agents that hold their log fd open (codex), whose appends `fs.watch` cannot see
- **CLI Framework:** Commander 14.x

## Development Guidelines

- Always use `bun` instead of `npm` for all package management and script execution
- Avoid `as any` type casts. Use proper types, generics, or `as unknown as T` only when source types have a genuine gap
- Use `ccmux show` to check session status and see active tmux panes
- You can run `tmux` and `ccmux` commands directly to test features end to end (e.g., `ccmux screen`, `ccmux send`, `ccmux spawn`, `tmux list-panes`, `tmux send-keys`)

### Verifying TUI changes

Typecheck and `bun test` verify code correctness, not rendering correctness. After any change touching TUI components, columns, layout, theming, or the daemon→TUI data path, you MUST launch the picker and/or sidebar and capture the output before declaring the work done. Non-rendering CLI commands (`ccmux show`, `ccmux config get/set`) do not exercise the renderer.

**Always test in a detached, isolated tmux session.** Do not launch the picker in a window/pane inside the user's active session.

Standard workflow:

```bash
# 1. Create a detached session with a forced, known viewport size
tmux new-session -d -s ccmux-verify -x 200 -y 50

# 2. Launch the TUI and let it render (use the same default tmux server
#    so the ccmux daemon can see real sessions; an isolated `-L` socket
#    would render an empty list unless you point a daemon at it too, see below)
tmux send-keys -t ccmux-verify 'ccmux picker' Enter   # or 'ccmux sidebar'
sleep 3
tmux capture-pane -t ccmux-verify -p | head -40

# 3. Resize / re-capture to test responsive breakpoints if relevant
tmux resize-window -t ccmux-verify -x 60 -y 30
sleep 1
tmux capture-pane -t ccmux-verify -p | head -20

# 4. Tear it all down
tmux kill-session -t ccmux-verify
```

Verify the specific area you changed: column alignment, active indicator (`▎`), agent colors, row collapse vs subtitle, sidebar layout, etc. If you can't reach the path you changed (e.g., needs a session in a specific state that doesn't currently exist), say so explicitly rather than claiming success.

**Fully isolated runs.** `CCMUX_TMUX_SOCKET` picks the tmux server a daemon tracks, so a test daemon can own its own server instead of sharing the developer's. Give it a distinct `CCMUX_PORT` as well (the daemon rewrites global tmux hooks, and two on one port fight over the same marker dir):

```bash
tmux -L ccmux-verify new-session -d -x 200 -y 50
CCMUX_TMUX_SOCKET=ccmux-verify CCMUX_PORT=2270 ccmux daemon start -b
# ... drive agents on -L ccmux-verify, then:
CCMUX_TMUX_SOCKET=ccmux-verify CCMUX_PORT=2270 ccmux daemon stop
tmux -L ccmux-verify kill-server
```

### Do Not

- Do not add new daemon modules without wiring them into `src/daemon/index.ts`
- Do not modify the SSE event protocol without updating both `src/daemon/server.ts` and `src/tui/utils/sse.ts`
- Do not add built-in agents without defining `terminalRules` for pane-tracked detection
- Do not register new `HookAdapter`s in `src/commands/setup.ts` and `src/daemon/index.ts` separately. Add them to `createBuiltinHookAdapters()` in `src/daemon/adapters/index.ts` — both call sites go through it
- Do not spawn `tmux` directly. Build the argv with `tmuxArgv`/`tmuxArgvFor` from `src/lib/tmux-exec.ts`, or `tmuxShellPrefix()` for a nested invocation inside a format-expanded shell body (`run-shell`, a hook) — a configured socket override reaches every call site through them and nowhere else

## Commands

```bash
# Run CLI
ccmux                    # Run the CLI (via ./bin/ccmux or bun link)

# Type checking and testing
bun run typecheck        # TypeScript type check (tsc --noEmit)
bun test                 # Run all tests
bun test src/daemon/parser.test.ts  # Run single test file

# Build
bun run build            # Bundle to dist/index.js

# Performance profiling
CCMUX_PERF=1 ccmux picker 2>/tmp/perf.log  # Startup waterfall + runtime stats
```

Full CLI reference: `ccmux --help` or see README.md.

## Architecture

### Daemon

The daemon (`src/daemon/`) detects agent processes in tmux panes, watches log files, and scans terminal output. The key modules to orient by:

- **State Reconciler** (`state-reconciler.ts`) - Core loop reconciling native (hook-tracked) and pane-tracked sessions with live tmux state. The `background` tracking mode is owned solely by the Background Source and is excluded from every reconciler arm.
- **Cascade Evaluator** (`cascade-evaluator.ts`) - Pure freshest-wins-with-tiebreak fold over `CascadeSource[]` (marker, log, terminal). Tie-break `marker > log > terminal`; `upgradeOnly` sources can lift status to `waiting` but never downgrade. Used by both native and pane-tracked paths.
- **Status Machine** (`status-machine.ts`) - Derives session state from JSONL log entries.
- **Terminal Detector** (`terminal-detector.ts`) - Pattern-based status detection from pane content (agents without log parsing).
- **Binder** (`binder/`) - All session-to-pane matching policy: marker claims settle first (authoritative, re-asserted every scan), then heuristic assignment gated by direction skew, a 600s cap, and an ambiguity refusal.
- **Hook Manager** (`hook-manager.ts`) + **Hook Adapters** (`adapters/`) - Marker watching plus per-agent install/lifecycle/enrichment. `adapters/index.ts:createBuiltinHookAdapters()` is the single source of truth for both the daemon and `ccmux setup`.
- **Invocation Manager** (`invocation-manager.ts`) + **Invokers** (`invokers/`) - Drive `POST /invoke` / `ccmux invoke` (see [`docs/invoke.md`](docs/invoke.md)).
- **Server** (`server.ts`) - HTTP + SSE on port 2269: session CRUD, invoke endpoints, `/server-info`, PR enrichment.
- **Worktree Create** (`worktree-create.ts`) - Creates or opens the git worktree a spawn asks for: derives a name from `--worktree`'s value or the prompt's opening words, resolves the base ref, and applies the same file-setup conventions (`worktree.symlinkDirectories`, `.worktreeinclude`) Claude Code uses for its own worktrees. Also adds `**/.claude/worktrees/` to the hosting repo's `.git/info/exclude` (`ensureWorktreesExcluded`, idempotent via `check-ignore`), without which every later spawn sees the sibling checkouts as untracked work — the spawn handler calls it EARLY as well, because a move reads status before it creates anything. Per-repo locked so concurrent spawns don't race `git worktree add`. Drives `--worktree`/`--base` on `ccmux spawn` and the picker's worktree destination.
- **Worktree Move Changes** (`worktree-move-changes.ts`) - Relocates a checkout's UNCOMMITTED work into a fresh worktree: stash, create (through an injected seam the spawn handler backs with Worktree Create), apply into the new checkout, then drop. Apply-then-drop, by-SHA references, and a stash entry proved ours by `refs/stash` MOVING and by a per-operation nonce in its message are what make every failure path end with the work still reachable — reachable, not necessarily restored: a restore can fail, and the result says so. The whole transaction is locked per repository (the stash stack is shared across a repo's worktrees), it refuses a worktree the engine merely opened (the rollback removes what it made), and there is deliberately no reset of the source. Drives `--with-changes`/`--untracked` on `ccmux spawn` and the picker's "Move changes".
- **Worktree Prune** (`worktree-prune.ts` + `worktree-git.ts` + `agent-state.ts`) - Classifies a repo's linked worktrees with a removal reason and runs the removal (directory, local branch, leftover pane, per-directory agent state). The read half is the only input the write half accepts; the endpoint (`server.ts`) is what re-derives it per request, so a caller can never name a path the scan did not itself classify as removable. What a caller DOES control is the scope that re-derivation runs over (`repo`, and an additive `cwd`), so a repo no session lives in is reachable — the gate is the classification, not the repo list. Prune is one action inside the picker's Worktrees panel (`W`), and the whole of `ccmux worktree prune`.
- **Worktree List** (`worktree-list.ts` + `worktree-git.ts`) - Every worktree a repo has, main checkout included, with branch, dirty counts, ahead/behind and attached sessions. LOCAL ONLY by contract (no fetch, no `gh`), because it is what the Worktrees panel paints instantly before the prune scan's slower classification merges in by path — which is also why it is a separate scan rather than a flag on Worktree Prune: absence of a removal reason is a FILTER there and a row here. Drives `GET /worktrees` and `ccmux worktree list`.
- **Background Source** (`sources/claude-background.ts`) - Sole owner of paneless Claude background-agent rows (`claude --bg`), read-only and independent of hooks/pane scanning.
- **Notifier** (`notifier.ts` + `notify-delivery.ts` + `notify-context.ts`) - Fires opt-in desktop notifications on `waiting`/`finished` transitions and delivers them down the backend ladder (macOS `ccmux-notifier` helper → osascript; Linux dbus → notify-send). Actionable Approve/Deny/Reply callbacks route through `notification-action.ts` (shared macOS-HTTP + Linux-D-Bus handler, all safety gating). The macOS helper app lives in `notifier/`.

Full daemon internals — the binder's D1/D2/D3 guards, the recursive log-tree watcher, PR enrichment, background agents, boot ordering, the invoke split, and a complete concern→path code map — live in [`docs/architecture.md`](docs/architecture.md). Do not duplicate that detail here; keep this list to a one-line-per-module orientation.

### TUI

Built with @opentui/solid. Entry point: `src/tui/App.tsx` with reactive store in `src/tui/store.ts`. Components live in `src/tui/components/`.

The row menus open two ways and must stay one thing: right-click, and `m` on the selected row. Both go through `openRowMenu` in `App.tsx`; only the anchor differs (a click has coordinates, `m` asks `SessionList`'s `onRowAnchor` where the row is) and the starting highlight (null for the pointer, the first item's id for `m`). Every `ContextMenuItem` carries a stable `id` because the keyboard highlight is stored as one: the list mutates under an open menu (the async "Move changes", a Fork that an SSE update removes) and a positional highlight would ride the shift onto a neighbour. The pointer cannot use identity while it aims by screen coordinate, so `ContextMenu` snapshots its items and reserved height on the first item hover; a mouse target never changes after the user starts aiming, while an untouched/keyboard-driven menu stays reactive. Menu keys are routed in the keydown handler's context-menu branch, which takes j/k/Enter/esc/`m` and lets anything else dismiss the menu and act normally. See [`docs/architecture.md`](docs/architecture.md).

The new-session dialog (`n`, or the row menus) is driven by `NEW_SESSION_FIELDS` in `store.ts` plus a matching `NewSessionDraft` key per field. Focus movement, the option keys, the rendered rows, and the dialog's own height all read that list, so adding a field is additive rather than a rework of the key handling — but it is not a one-liner: expect to touch the field list and draft key, the store action and the dialog's open-time default, `optionFieldFor()` in `App.tsx`, the component's props and its render branch, and the row budget in `NewSessionDialog.tsx` (`planDialogRows` and `newSessionFloorRows`, below).

Every option field renders as a one-row dropdown pill (`DropdownTrigger` in `DropdownField.tsx`) whose list opens as a single shared absolute overlay (`DropdownOverlay`, a late child of the dialog box for the sibling z-sorting reason `DropdownField.tsx`'s header explains). What each field offers, and which option it holds, comes from ONE accessor (`newSessionOptions` in `src/tui/new-session-options.ts`) shared by the key routing, the pills, the overlay, and the store's value dispatch. Which dropdown is open, and its highlight, is one record on the draft (`dropdown: { field, index } | null`), so two can never be open at once; space/l/right open the focused field's, and while open the overlay owns every key (j/k navigate, enter/space/l/right confirm, h/left/esc cancel, 1-9 direct-pick). The overlay lives OUTSIDE the row budget and clamps against the screen, windowing itself via `optionWindow`.

Not every field is present every time. The dialog has four modes — an ordinary spawn, "Move changes" (issue #71), "Fork" (issue #70, which drops the agent and prompt rows because a fork continues the source's), and an EXISTING worktree (issue #102, the Worktrees panel's Enter on a session-less row, which creates nothing and so drops the destination row outright: the row it was opened over IS the destination, and there is no worktree to name) — and `NewSessionShape` in `store.ts` is the type the two POLICY functions take (`namesAWorktree` and `newSessionFields`), so a fifth mode fails to compile at both of those until it says what it means there. A mode is not the same thing as a DESTINATION: a move locks its destination to a worktree and a fork picks one like an ordinary spawn does (locked to the source's own checkout only where `fork.canWorktree` is false, i.e. the source is outside a repository), so `namesAWorktree` reads the destination and the mode flags rather than the mode alone — which is why the Name row, and the row it costs, come and go inside fork mode. The row budget is not protected that way: both budget functions now read ONE named flattened shape (`DialogModeShape` in `NewSessionDialog.tsx`, which `newSessionFloorRows` takes directly and `DialogShape` extends with the width-dependent counts `planDialogRows` needs), so a mode can no longer be taught to one of them and forgotten by the next — but that shape is still a hand-maintained mirror of `NewSessionShape`, and a new mode can simply fail to mention it there. What the types do catch there is a new FIELD — `floorFieldRows` returns a `Record<NewSessionField, number>`, so one that never says how many rows it wants will not compile. A new MODE's counts are held by the per-shape `planDialogRows` unit tests instead. `newSessionFields(draft)` is the ACTIVE list (focus order and Tab traversal), and the store keeps focus inside it — a field the draft does not have sends focus to the first one it does, because focus scopes the number keys. A conditional field owes two things beyond its own case in that filter: its rows in the budget below (zero when hidden, and a term in `newSessionFloorRows` when it is a field of its own), and a `<Show>` around its render branch keyed on the same condition. Get the count wrong and nothing clips: two rows render over each other, so component tests assert row ORDER rather than presence.

A text field additionally needs its case in `handleNewSessionKey`'s input branch (`App.tsx`), or the input will never see `j`, `3`, or any other key a field shortcut claims. Note also that an OpenTUI `<input>` draws past its own box — a placeholder must be truncated before it is handed over, and a long typed value overruns the dialog border at sidebar widths exactly as the Prompt field has always done.

The dialog's height is a BUDGET, not a sum: `planDialogRows` decides what it can afford at the current terminal height and gives rows up in a fixed order (the blank rows between the fields first — pure air, dropped all at once — then the confirm/Cancel button row — a click-only duplicate of enter/esc — then the agent field's wrapped error back toward one row, then key hints, the mode note, title spacer, directory row last — the option fields never enter the order, each being one pill row with its list in the overlay outside the budget), and every `<Show>` and row count in the component reads that plan. Below `newSessionFloorRows` — a border, a title, and one row per field — it renders a single "needs N rows" line instead, and `App.tsx` gates the option keys on the same floor so a number key can never act on a field nobody can see. Anything that renders a row the plan did not budget for overlaps its neighbour rather than clipping, which is why the plan is a pure, separately tested function.

The dialog's wire behavior (`GET /agents`, why placement travels as `callerPane` rather than `target`, and why an untouched worktree name is omitted from the spawn rather than sent) is in [`docs/architecture.md`](docs/architecture.md).

The Worktrees panel (`W`, or the group context menu; `WorktreesPanel.tsx`, which replaced PruneDialog in issue #102) keeps that component's shape — its own state and `useKeyboard`, App.tsx returning early while it is up, a `compact` variant for the sidebar — and adds a TWO-PHASE read. `GET /worktrees` is local-only and paints immediately; `GET /worktrees/prune-candidates` fetches and asks GitHub and merges in by `path` afterwards (`candidates` make a row prune-selectable, `skipped` puts its hold reason inline, `open` badges a healthy PR). Firing them together is the point: waiting for the second would cost the first's whole reason for existing, and a phase-2 failure therefore degrades to a read-only panel with one error line rather than an error state. Its `open` field is typed optional HERE while the daemon declares it required, because the daemon is a long-lived process that may predate the build. The in-flight scan is announced on the TITLE line and nowhere else (`titleSegments`, a muted `· <spinner> scanning` suffix over the panel's own working spinner via `useStatusIcon`), because a status ROW states the fact a second time and then takes its row back at the exact moment the re-sort moves the list, which is the "glitch" the announcement exists to prevent. It is derived state (`scan() === null && scanError() === null`), not a flag, so the generation counter covers it for free: a re-fired scan announces itself again and a stale one cannot clear a newer one's. The suffix is dropped WHOLE when it does not fit rather than fitted alongside the title, since at sidebar widths the truncation would eat the repo name to render half a word.

Three consequences follow from the merge and are easy to undo by accident. The cursor is tracked by PATH (`cursorPath`), not index, because phase 2 re-sorts the list under it (`sortWorktreeRows` sinks classified candidates to the bottom of their group), and an index would silently point at whichever row took the slot. Every row is fitted before it is rendered (`fitSegments`, over `displayWidth`), because OpenTUI does not clip. What it does instead is WRAP, and a wrapped line inside a `height={1}` box vanishes rather than overflowing: that is how the removable divider silently lost its rule, its run of dashes being one unbreakable word. Anything drawn inside the scrollbox is budgeted against `listWidth()` (the content less `SCROLLBAR_GUTTER`), not against `contentWidth()`. And SCROLLING is measured in visual LINES, never in rows: a row is one or two lines (`rowVisualHeight`, derived from `detailPhrases` so the height and the render cannot disagree), plus one per repo header and one per removable divider, so `scrollTo(rowIndex)` drifts further out of true the further down the list you go. It left the cursor off screen while space/x/Enter/y/D went on acting on the row nobody could see. `visualLayout` + `scrollTargetFor` are the panel's counterpart to `toVisualLine`/`scrollTarget` in `utils/grouping.ts`, and they run from an EFFECT rather than from `moveCursor`, because the phase-2 re-sort moves rows with no keypress at all. All of these are pure and separately tested; the component tests assert row ORDER rather than presence for the same reason.

The ROW PRESENTATION is a set of rules the user arrived at after finding v1 unreadable, and each one answers a specific complaint. Line 1 is the icon slot, the name, and the branch ONLY when it differs from the name (`rowBranch`). The cursor row carries the session list's `theme.surface` selection background and the `▎` bar down both of its lines (the bar on line 1 alone was too easy to miss and looked lopsided against the two-line highlight). The icon is the SESSION LIST's own status glyph, spinner and all, through `useStatusIcon`: a static dot on a working row asked the reader to learn a second vocabulary for a fact ccmux already has one for. Note that the two halves of that API disagree about an unset style (`getStatusIcon` defaults to `dot`, `getAnimationFrames` requires it spelled out), so the panel defaults it explicitly or a working row renders a STATIC dot, because a worktree named after its branch said the same word twice on the loudest part of every row; the main checkout says `main checkout` rather than repeating the directory name the header just gave (`rowLabel`). Everything else moved to a second line, and the two are tied together by a CONTINUOUS RAIL: a muted `│` in its own column carried by every row line of a repo group, one-line rows included; the bare line it hangs from is the panel title in the single-repo view or the repo header in the multi-repo view (`RAIL`, `ROW_GUTTER`, `DETAIL_GUTTER`). A per-row connector was the obvious first shape and the wrong one, because rows with nothing to say drew no second line, so it appeared and vanished down the list and read as broken. The removable rule starts with a tee (`├`) so the rail runs INTO it rather than stopping at it, and the rail simply ends with the group rather than being closed off. A worktree with genuinely nothing to report collapses to one line, which is why a session-less row's line 1 and a detail line are deliberately the same shape. That line is `·`-separated phrases in plain words (`detailPhrases`): `2 modified · 4 untracked` rather than `2m/4u`, `branch gone` rather than `gone`, `agent working here` rather than `held: an agent is working here`. Facts are stated ONCE, which is the rule most easily broken by adding a phrase: a merged PR arrives as the removal reason, so the badge is dropped; a removable row's tracking state is suppressed entirely because `PR #100 merged · branch gone` is one event told twice; and the scan's agent-LIVENESS skip is dropped on a row that has sessions, because the session summary states the same thing with an agent name and a count (`isLivenessSkip`). Each of those three drops is CONDITIONAL for the same reason: a lock the phase-1 read missed, or an agent the daemon saw where the row lists none, must still be able to speak. Non-liveness skips (locked, an unresolvable PR state) always survive, since nothing else on the row carries them. Classified rows cluster under a per-repo `├─ removable · N ──` rule (`splitRemovable`, `dividerText`) and are the ONLY rows with checkboxes, which is what makes an unexplained checkbox impossible; the divider is not selectable but IS a line, so `visualLayout` counts it. The box is `[ ]`/`[x]` rather than `☐`/`☑`, which are East Asian Ambiguous and would take two columns wherever a terminal decides they are wide, breaking the column the group aligns on. That makes the marker slot two widths rather than one (`markerWidth`), and the detail line indents to whatever marker its own line 1 used (`detailGutter`), or the removable section's two lines would not line up with each other. A single repo puts its name in the panel title and drops the group header that would repeat it (`showsGroupHeaders`, read by both the render and the line arithmetic). The hint line advertises the removal keys only where they apply, and compact mode reorders the detail line so the phrase about work that would be DELETED outlives truncation while the reason (which the rule above the row already gives) is what gets cut.

The REMOVAL flow answers three things the user hit live. `x` with an empty selection is never a silent no-op: on a clean removable row it selects that row and confirms (the confirm is still the gate), on a dirty one it names the key that unblocks it rather than opening a "delete 0 worktrees" dialog, and anywhere else it says what is missing. The hint reads `x remove` until there is something to count. And the confirmation is a CENTERED BOX (`RemovalConfirm`), a child of the panel's own overlay and its last child: it mirrors `ConfirmationDialog`'s visual language rather than reusing it (that component is typed against `ConfirmAction`/`Session` and renders one subtitle line where this needs a headline plus up to three consequences), and it must never route through `store.showConfirmDialog`, which renders OUTSIDE the panel and is exactly how the send-review confirm ended up buried. Its wording is built by `describeRemoval` and `removalDetails`, which pluralize for real: `Delete 1 worktree and its branch?`, not `1 worktree(s), 1 branch(es)`.

`Enter` is context-sensitive (jump to the row's session, else `openNewSession` with `existingWorktree` for a linked worktree or a plain `cwd` for the main checkout), which is why removal moved to `x`. The rows are a phase-1 SNAPSHOT, so App REVALIDATES the spawn direction before acting: `spawnInWorktree` asks the live store for a session whose `sessionCwd` is inside the row's worktree (`worktreeHoldsPath`, a separator-aware prefix test, since an agent that has `cd`-ed deeper is still in that worktree) and jumps instead if it finds one. That decision lives in App and not in `activateRow` because App is where the live store is; the panel reports what it saw and App picks the verb. Only the LINKED-worktree case is revalidated: the main checkout's Enter opens an ordinary dialog whose destination is still a real choice, and since ccmux nests worktrees under `<repo>/.claude/worktrees/`, a containment test against a repo root would match every one of them and jump to an unrelated agent. The opposite direction (a row that LOST its session) needs no snapshot check: the jump path already prefers the live store and falls back to the reported pane, ending in a "pane is gone" toast.

`d` here reviews a BRANCH where the session list's `d` reviews a working tree, and the difference is deliberate: a worktree's interesting diff is usually already committed. `resolveMergeBase` (`utils/review.ts`) resolves the fork point with the default branch and passes it to `hunk diff --watch <sha>`; the merge-base and not the base ref itself, or a branch that is behind would also show everything that landed on the base since it forked. Two things follow. The emptiness pre-flight has to switch with it (`git diff --name-only <target>` instead of `git status --porcelain`, because a committed worktree has a clean status and is exactly the case this exists for), and null from `resolveMergeBase` — no default branch, orphan history, a checkout sitting on the base — falls back to the working-tree review rather than opening an empty one. `handBackReviewNotes` is shared with the list so the rule about what reaches an agent unprompted has one home.

`y` (`copyToClipboard`) writes through BOTH the renderer's OSC 52 and `pbcopy`, deliberately not one with the other as fallback. Neither can be confirmed and they reach different machines: OSC 52 is the only thing that reaches the clipboard the user is looking at over ssh, but `copyToClipboardOSC52` returning true only means the sequence was WRITTEN (a terminal that drops it, or a tmux without `set-clipboard on`, reports success and copies nothing), while `pbcopy` is verifiable but local-only. Preferring either alone gives a `y` that silently does nothing in the other's case, which is exactly what live testing caught.

### Data Flow

```
Agent processes/logs --> Watcher --> Parser --> Status Machine --> Session Manager --> HTTP/SSE --> TUI
         └── Terminal Detector ──┘    └── Hook Manager ──┘
```

### Session States

- `idle` - Not processing, waiting for input
- `working` - Processing (assistant thinking, tools running)
- `waiting` - Waiting for user input/permission (triggers attention indicator)

### Agent Definitions

Built-in agents: `src/lib/agents.ts`. Each `AgentDef` includes: `processMatch`, `commandPatterns`, `terminalRules`, `errorRules`, `executable`, `resumeCommand`, `promptCommand`, `forkCommand`, `sessionFilePattern`, `versionCommand`, `hooks`, `invokeMode`, `readyPattern`.

`promptCommand` (the interactive-with-initial-prompt shape used by `ccmux spawn --prompt`) is per-agent and non-obvious — `--prompt` means one-shot print mode for three of the built-ins. See [`docs/agent-adapters.md#spawning-with-an-initial-prompt`](docs/agent-adapters.md#spawning-with-an-initial-prompt) before adding or changing one.

`forkCommand` (branch a conversation into a new session, leaving the original alone) is Claude-only: for every other built-in, what a resume does to a still-running original is unverified, and a wrong guess damages the session the user asked to preserve. Do not add one without checking it live. See [`docs/agent-adapters.md#forking-a-session`](docs/agent-adapters.md#forking-a-session).

Custom agents via `agents` key in `~/.config/ccmux/ccmux.json` (types in `src/lib/preferences.ts` -> `AgentConfig`).

### Session Matching

For reliable multi-session matching, install hooks via `ccmux setup` (all agents detected on PATH) or `ccmux setup --agent <name>`. Currently supported: Claude Code, Codex, Cursor, OpenCode, Pi, oh-my-pi, Antigravity, and Copilot.

**Hook-driven flow:**

1. The agent fires its `SessionStart` hook (or, for OpenCode, the plugin reacts to a `session.created` bus event; for Pi and oh-my-pi, the extension reacts to a `session_start` lifecycle event; for Antigravity, the first `PreInvocation` creates the marker because no session-start event exists; for Copilot, the `sessionStart` hook fires), which writes a marker file to `~/.config/ccmux/session-pids/<agent_type>-<session_id>.json` via tmp+rename.
2. `HookManager`'s chokidar watcher observes the new marker and dispatches to the registered `HookAdapter.onMarkerAdded`.
3. The adapter finds the matching pane-tracked session (TTY-based for Codex, TTY match with PID fallback for Claude, PID-ancestry for OpenCode, Cursor, Pi, and oh-my-pi, and TTY match with PID fallback for Antigravity and Copilot) and enriches it with `nativeSessionId`, `logPath`, etc.
4. Per-turn signals (Claude `Notification`, Codex `Stop` / `PermissionRequest`, Cursor `beforeSubmitPrompt` / `stop`, OpenCode `session.status` / `permission.asked` / `permission.replied`, Pi `agent_start` / `agent_end` / `before_agent_start`, oh-my-pi the same three plus `tool_approval_requested` / `tool_approval_resolved`, Antigravity `PreInvocation` / `Stop`, Copilot `userPromptSubmitted` / `notification` / `agentStop`) refresh the marker's state. The reconciler then runs the `CascadeEvaluator` over the available sources (marker, log, terminal) and picks the freshest one, breaking ties as `marker > log > terminal`. This applies uniformly to native Claude/Codex and to pane-tracked sessions, so log-driven and marker-driven status converge through the same fold.

**Matching priority (binder policy):** Marker claims settle first and are authoritative (re-verified every scan, so a mis-bind heals). Panes markers don't claim are solved as a same-cwd optimal assignment gated by direction skew, a 600s tolerance cap, and an ambiguity refusal (a near-tie stays visibly unbound rather than guessing). See [`docs/architecture.md#session-to-pane-binding-the-binder`](docs/architecture.md#session-to-pane-binding-the-binder) for the full policy (D1/D2/D3 guards, boot-migration fallback).

**Note:** Claude Code does NOT keep session log files open, so lsof-based session file discovery won't work. This is why we use hooks for authoritative PID->Session mapping. For agents without hooks, detection relies on process matching + terminal pattern scanning.

**Per-agent hook caveats** (Codex feature-flag renames and the `PermissionRequest` version gate, Cursor's zsh-wrapper PID walk and version gate, OpenCode aggregation and the `permission.list` gap, Pi's `process.title` and no-approval-pause) live in [`docs/agent-adapters.md`](docs/agent-adapters.md). **Read the relevant section before touching an adapter** — most are load-bearing workarounds, not incidental notes.

## Key Patterns

### File Paths

Agent-owned files (logs, hooks, settings, sessions, per-agent install paths) are catalogued in [`docs/agent-adapters.md#file-paths`](docs/agent-adapters.md#file-paths). ccmux treats them as read-only except during `ccmux setup`.

ccmux-owned markers: `~/.config/ccmux/session-pids/<agent_type>-<session_id>.json` (written by hook scripts for Claude/Codex/Cursor/Antigravity/Copilot, the bundled plugin for OpenCode, or the bundled extensions for Pi and oh-my-pi; consumed by the daemon's `HookManager`).

### Column Configuration

TUI columns are configurable via `columns` and `breakpoints` in `~/.config/ccmux/ccmux.json`. Each column accepts a simple value or a responsive object with named breakpoint keys (`xs`, `sm`, `md`, `lg`, per `BREAKPOINT_NAMES`) using mobile-first cascade. The default `row1.right` layout keys off `xs`.

- **Types**: `src/lib/preferences.ts` -- `Responsive<T>`, `ColumnConfig`, `BreakpointConfig`
- **Resolution**: `src/tui/components/session-columns.ts` -- `resolveColumns()` merges user overrides with responsive defaults

### Testing

**TUI component tests** use `testRender` from `@opentui/solid` (headless renderer, no real terminal I/O):

```typescript
import { testRender } from "@opentui/solid";

const setup = await testRender(() => <Component />, { width: 80, height: 3 });
await setup.renderOnce();
const frame = setup.captureCharFrame(); // rendered text as string
setup.renderer.destroy();               // always clean up in afterEach
```

- **Shared helpers**: `src/tui/components/test-helpers.tsx` provides `mockEnrichedSession()`, `mockSession()`, `emptySummary()`
- **TickContext**: Components using `useTick()` (SessionItem, Preview, GroupPreview) require wrapping with `TickContext.Provider`
- **Mocking tmux**: Preview tests use `mock.module()` from `bun:test` to mock `capturePane` before importing the component
- **Input simulation**: `createMockKeys` and `createSpy` from `@opentui/core/testing` for keyboard/callback tests
- **Fixed timestamps**: Use `"2024-01-15T12:00:00Z"` instead of `new Date()` to avoid time-dependent fragility

**Pure logic tests** (store, grouping, format, icons) use standard `bun:test` without `testRender`.
