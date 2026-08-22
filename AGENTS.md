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
- **Session Ref** (`session-ref.ts`) - Pure resolver turning a human/agent session REFERENCE (id, `%pane`, `session:window.pane`, `self`, agent type, project name) into one session: exact tiers claim their syntax, fuzzy tiers are scoped by caller proximity, and ambiguity REFUSES with the candidate list.
- **Transcript Read** (`transcript-read.ts`) + **Readers** (`transcript-readers/`) - Read a session's last N turns from the agent's own transcript (all nine built-ins, tool output never inlined), behind `GET /sessions/:ref/transcript` and `ccmux last`.
- **Handoff** (`handoff.ts`) - The frozen provenance header plus the one-per-target queue behind `POST /handoff` / `ccmux handoff`: a peer's last response is composed daemon-side and only ever typed into an IDLE composer (working queues, waiting refuses, no `--force`). See [`docs/handoff.md`](docs/handoff.md).
- **Send Guards** (`send-guards.ts`) - The shared delivery-safety checks every path that types into a live agent pane runs (foreground liveness fail-closed, control-char strip, `unsafeReplyPattern` refusal, leading `/`/`!` defuse, `ambiguousWait`).
- **Server** (`server.ts`) - HTTP + SSE on port 2269: session CRUD, invoke endpoints, transcript/handoff endpoints, `/server-info`, PR enrichment.
- **Worktree Create** (`worktree-create.ts`) - Creates or opens the git worktree a spawn asks for: derives a name from `--worktree`'s value or the prompt's opening words, resolves the base ref, and applies the same file-setup conventions (`worktree.symlinkDirectories`, `.worktreeinclude`) Claude Code uses for its own worktrees. Also adds `**/.claude/worktrees/` to the hosting repo's `.git/info/exclude` (`ensureWorktreesExcluded`, idempotent via `check-ignore`), without which every later spawn sees the sibling checkouts as untracked work — the spawn handler calls it EARLY as well, because a move reads status before it creates anything. Per-repo locked so concurrent spawns don't race `git worktree add`. Drives `--worktree`/`--base` on `ccmux spawn` and the picker's worktree destination.
- **GH Spawn Source** (`gh-spawn-source.ts`) - Turns `ccmux spawn --pr <n>` / `--issue <n>` into a worktree spawn: the `gh pr view` / `gh issue view` lookups (injectable runner, 15s timeout), the `pull/<n>/head` fetch, the local-branch decision (reuse only a branch whose `branch.<b>.merge` already says it is this PR, fast-forward only, never a force), the `gh pr checkout` tracking config plus `branch.<b>.ccmux-base`, and the seeded prompt. Every refusal is HTTP 400 with nothing created. Two rules it exists to keep: `preparePRBranch` releases the repo lock BEFORE `createWorktree` takes it (`withRepoLock` is not reentrant), and the seed prompt is never passed to `createWorktree`, which would prefer it over the derived name and rename the worktree.
- **Worktree Move Changes** (`worktree-move-changes.ts`) - Relocates a checkout's UNCOMMITTED work into a fresh worktree: stash, create (through an injected seam the spawn handler backs with Worktree Create), apply into the new checkout, then drop. Apply-then-drop, by-SHA references, and a stash entry proved ours by `refs/stash` MOVING and by a per-operation nonce in its message are what make every failure path end with the work still reachable — reachable, not necessarily restored: a restore can fail, and the result says so. The whole transaction is locked per repository (the stash stack is shared across a repo's worktrees), it refuses a worktree the engine merely opened (the rollback removes what it made), and there is deliberately no reset of the source. Drives `--with-changes`/`--untracked` on `ccmux spawn` and the picker's "Move changes".
- **Worktree Prune** (`worktree-prune.ts` + `worktree-git.ts` + `agent-state.ts`) - Classifies a repo's linked worktrees with a removal reason and runs the removal (directory, local branch, leftover pane, per-directory agent state). The read half is the only input the write half accepts; the endpoint (`server.ts`) is what re-derives it per request, so a caller can never name a path the scan did not itself classify as removable. What a caller DOES control is the scope that re-derivation runs over (`repo`, and an additive `cwd`), so a repo no session lives in is reachable — the gate is the classification, not the repo list. Prune is one action inside the picker's Worktrees panel (`W`), and the whole of `ccmux worktree prune`.
- **Worktree List** (`worktree-list.ts` + `worktree-git.ts`) - Every worktree a repo has, main checkout included, with branch, dirty counts, ahead/behind and attached sessions. LOCAL ONLY by contract (no fetch, no `gh`), because it is what the Worktrees panel paints instantly before the prune scan's slower classification merges in by path — which is also why it is a separate scan rather than a flag on Worktree Prune: absence of a removal reason is a FILTER there and a row here. Drives `GET /worktrees` and `ccmux worktree list`.
- **Background Source** (`sources/claude-background.ts`) - Sole owner of paneless Claude background-agent rows (`claude --bg`), read-only and independent of hooks/pane scanning.
- **Notifier** (`notifier.ts` + `notify-delivery.ts` + `notify-context.ts`) - Fires opt-in desktop notifications on `waiting`/`finished` transitions and delivers them down the backend ladder (macOS `ccmux-notifier` helper → osascript; Linux dbus → notify-send). Actionable Approve/Deny/Reply callbacks route through `notification-action.ts` (shared macOS-HTTP + Linux-D-Bus handler, all safety gating). The macOS helper app lives in `notifier/`.

Full daemon internals — the binder's D1/D2/D3 guards, the recursive log-tree watcher, PR enrichment, background agents, boot ordering, the invoke split, and a complete concern→path code map — live in [`docs/architecture.md`](docs/architecture.md). Do not duplicate that detail here; keep this list to a one-line-per-module orientation.

### TUI

Built with @opentui/solid. Entry point: `src/tui/App.tsx` (key routing, dialogs) with reactive store in `src/tui/store.ts`. Components live in `src/tui/components/`. The surfaces with real internal machinery:

- **Row menus** (right-click, or `m` on the selected row) - Both paths go through one `openRowMenu` in `App.tsx` and must stay one thing; only the anchor and the starting highlight differ. Every `ContextMenuItem` carries a stable `id` because the list mutates under an open menu, and the pointer gets a snapshot where the keyboard stays reactive. Read [`docs/architecture.md#row-menus`](docs/architecture.md#row-menus) before touching them.
- **New-session dialog** (`n`, the row menus, or `F` for a fork) - Driven by `NEW_SESSION_FIELDS` in `store.ts` plus a `NewSessionDraft` key per field; four modes (spawn, Move changes, Fork, existing worktree) policed by `NewSessionShape` and the policy functions; height is a BUDGET (`planDialogRows`), not a sum, and an unbudgeted row overlaps instead of clipping. Adding a field or a mode touches several places by design; read [`docs/architecture.md#new-session-dialog`](docs/architecture.md#new-session-dialog) first.
- **Worktrees panel** (`W`, or the group context menu; `WorktreesPanel.tsx`) - Two-phase read: the local worktree list paints instantly, the prune scan merges in by path afterwards, which is why the cursor is path-tracked and scrolling is measured in visual lines. Its row presentation and removal flow are load-bearing responses to live testing; read [`docs/architecture.md#worktrees-panel`](docs/architecture.md#worktrees-panel) before touching it.

Full TUI internals — the menus' anchor/highlight/snapshot rules, the dialog's field, mode, and row-budget machinery plus its wire behavior, and the Worktrees panel's scan, layout, presentation, and removal rules — live in [`docs/architecture.md#tui`](docs/architecture.md#tui). Do not duplicate that detail here; keep this list to a short orientation per surface.

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
4. Per-turn signals (Claude `Notification`, Codex `Stop` / `PermissionRequest`, Cursor `beforeSubmitPrompt` / `stop`, OpenCode `session.status` / `permission.asked` / `permission.replied` / `question.asked` / `question.replied` / `question.rejected`, Pi `agent_start` / `agent_end` / `before_agent_start`, oh-my-pi the same three plus `tool_approval_requested` / `tool_approval_resolved`, Antigravity `PreInvocation` / `Stop`, Copilot `userPromptSubmitted` / `notification` / `agentStop`) refresh the marker's state. The reconciler then runs the `CascadeEvaluator` over the available sources (marker, log, terminal) and picks the freshest one, breaking ties as `marker > log > terminal`. This applies uniformly to native Claude/Codex and to pane-tracked sessions, so log-driven and marker-driven status converge through the same fold.

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
