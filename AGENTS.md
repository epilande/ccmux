# AGENTS.md

## Project Overview

ccmux is a CLI tool for tracking AI coding agent sessions running in tmux panes and jumping to the one that needs you. It uses a background daemon that detects agent processes, watches log files, and scans terminal output to derive session state. An interactive TUI shows live session states at a glance.

**Built-in agents:** Antigravity, Claude Code, Codex, Cursor, OpenCode, Pi, Gemini CLI, plus custom agent definitions via config.

## Tech Stack

- **Runtime:** Bun 1.x
- **Language:** TypeScript 5.x
- **TUI Framework:** @opentui/solid 0.1.97 (Solid.js-based terminal UI)
- **Reactivity:** Solid.js 1.9
- **File Watching:** native recursive `fs.watch` for the agent log trees (`log-tree-watcher.ts`; chokidar fallback when recursive watching is unavailable), chokidar 4.x for the small flat dirs (markers, Claude subagents)
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
#    would render an empty list)
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

### Do Not

- Do not add new daemon modules without wiring them into `src/daemon/index.ts`
- Do not modify the SSE event protocol without updating both `src/daemon/server.ts` and `src/tui/utils/sse.ts`
- Do not add built-in agents without defining `terminalRules` for pane-tracked detection
- Do not register new `HookAdapter`s in `src/commands/setup.ts` and `src/daemon/index.ts` separately. Add them to `createBuiltinHookAdapters()` in `src/daemon/adapters/index.ts` — both call sites go through it

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
- **Background Source** (`sources/claude-background.ts`) - Sole owner of paneless Claude background-agent rows (`claude --bg`), read-only and independent of hooks/pane scanning.

Full daemon internals — the binder's D1/D2/D3 guards, the recursive log-tree watcher, PR enrichment, background agents, boot ordering, the invoke split, and a complete concern→path code map — live in [`docs/architecture.md`](docs/architecture.md). Do not duplicate that detail here; keep this list to a one-line-per-module orientation.

### TUI

Built with @opentui/solid. Entry point: `src/tui/App.tsx` with reactive store in `src/tui/store.ts`. Components live in `src/tui/components/`.

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

Built-in agents: `src/lib/agents.ts`. Each `AgentDef` includes: `processMatch`, `commandPatterns`, `terminalRules`, `errorRules`, `executable`, `resumeCommand`, `sessionFilePattern`, `versionCommand`, `hooks`, `invokeMode`, `readyPattern`.

Custom agents via `agents` key in `~/.config/ccmux/ccmux.json` (types in `src/lib/preferences.ts` -> `AgentConfig`).

### Session Matching

For reliable multi-session matching, install hooks via `ccmux setup` (all agents detected on PATH) or `ccmux setup --agent <name>`. Currently supported: Antigravity, Claude Code, Codex, Cursor, OpenCode, and Pi.

**Hook-driven flow:**

1. The agent fires its `SessionStart` hook (or, for Antigravity, the first `PreInvocation` creates the marker because no session-start event exists; for OpenCode, the plugin reacts to a `session.created` bus event; for Pi, the extension reacts to a `session_start` lifecycle event), which writes a marker file to `~/.config/ccmux/session-pids/<agent_type>-<session_id>.json` via tmp+rename.
2. `HookManager`'s chokidar watcher observes the new marker and dispatches to the registered `HookAdapter.onMarkerAdded`.
3. The adapter finds the matching pane-tracked session (TTY-based for Codex, TTY match with PID fallback for Antigravity and Claude, PID-ancestry for OpenCode, Cursor, and Pi) and enriches it with `nativeSessionId`, `logPath`, etc.
4. Per-turn signals (Antigravity `PreInvocation` / `Stop`, Claude `Notification`, Codex `Stop` / `PermissionRequest`, Cursor `beforeSubmitPrompt` / `stop`, OpenCode `session.status` / `permission.asked` / `permission.replied`, Pi `agent_start` / `agent_end` / `before_agent_start`) refresh the marker's state. The reconciler then runs the `CascadeEvaluator` over the available sources (marker, log, terminal) and picks the freshest one, breaking ties as `marker > log > terminal`. This applies uniformly to native Claude/Codex and to pane-tracked sessions, so log-driven and marker-driven status converge through the same fold.

**Matching priority (binder policy):** Marker claims settle first and are authoritative (re-verified every scan, so a mis-bind heals). Panes markers don't claim are solved as a same-cwd optimal assignment gated by direction skew, a 600s tolerance cap, and an ambiguity refusal (a near-tie stays visibly unbound rather than guessing). See [`docs/architecture.md#session-to-pane-binding-the-binder`](docs/architecture.md#session-to-pane-binding-the-binder) for the full policy (D1/D2/D3 guards, boot-migration fallback).

**Note:** Claude Code does NOT keep session log files open, so lsof-based session file discovery won't work. This is why we use hooks for authoritative PID->Session mapping. For agents without hooks, detection relies on process matching + terminal pattern scanning.

**Per-agent hook caveats** (Codex feature-flag renames and the `PermissionRequest` version gate, Cursor's zsh-wrapper PID walk and version gate, OpenCode aggregation and the `permission.list` gap, Pi's `process.title` and no-approval-pause) live in [`docs/agent-adapters.md`](docs/agent-adapters.md). **Read the relevant section before touching an adapter** — most are load-bearing workarounds, not incidental notes.

## Key Patterns

### Tool Permission Resolution

Tool permissions are resolved dynamically in `src/lib/permission-resolver.ts` by reading the user's layered Claude Code settings:

1. `~/.claude/settings.json` (global)
2. `{cwd}/.claude/settings.json` (project shared)
3. `{cwd}/.claude/settings.local.json` (project local)

Precedence: deny > ask > allow > defaultMode. Supports argument matching (e.g., `Bash(git *)`) and `acceptEdits`/`bypassPermissions` modes. Cached with 30s TTL.

### File Paths

Agent-owned files (logs, hooks, settings, sessions, per-agent install paths) are catalogued in [`docs/agent-adapters.md#file-paths`](docs/agent-adapters.md#file-paths). ccmux treats them as read-only except during `ccmux setup`.

ccmux-owned markers: `~/.config/ccmux/session-pids/<agent_type>-<session_id>.json` (written by hook scripts for Antigravity/Claude/Codex/Cursor, the bundled plugin for OpenCode, or the bundled extension for Pi; consumed by the daemon's `HookManager`).

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
