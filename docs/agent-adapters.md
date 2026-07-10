# Agent adapters

Per-agent hook/plugin quirks and the agent-owned files ccmux reads. **Read the relevant section before touching an adapter** — most of these are load-bearing workarounds for a specific agent's behavior, not incidental notes.

For the general hook flow (marker shape, per-agent pane-correlation strategy, install lifecycle, OpenCode aggregation), see [`docs/architecture.md#hook-lifecycle`](./architecture.md#hook-lifecycle). The single-source-of-truth adapter factory is `createBuiltinHookAdapters()` in `src/daemon/adapters/index.ts`, consumed by both the daemon and `ccmux setup`.

## Adapter module map

| Agent    | Adapter + primitives                                                                                                                                                     |
| :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `adapters/claude/hook-adapter.ts`                                                                                                                                        |
| Codex    | `adapters/codex/hook-adapter.ts`, `hook-scripts.ts` (bash generators), `toml.ts` (hand-rolled `[features]` flag editor)                                                  |
| Cursor   | `adapters/cursor/hook-adapter.ts`, `hook-scripts.ts` (bash generators), `version.ts` (`cursor-agent --version` gate)                                                     |
| OpenCode | `adapters/opencode/plugin-adapter.ts`, `plugin-script.ts` (install-time renderer), `aggregate.ts` (pure many→one fold), authored plugin `src/plugins/opencode/plugin.js` |
| Pi       | `adapters/pi/hook-adapter.ts`, `extension-script.ts` (install-time renderer), authored extension `src/plugins/pi/ccmux.js`                                               |

The startup-race closer for markers written before the first scan created the pane-tracked session is the shared, agent-agnostic `reconcileSessionMarkerLinks()` in `adapters/link.ts` (keyed off `adapter.agentType`; it also re-derives native-id ownership each scan so a mis-linked id heals). Used by Cursor, OpenCode, and Pi (`Daemon.linkPiSessions`).

## Codex-specific caveats

- `PermissionRequest` requires Codex >= 0.122 (`rust-v0.122` / `@openai/codex@0.122.0-alpha.8+`). Older Codex silently ignores the entry because `HooksFile` does not use `#[serde(deny_unknown_fields)]`; `SessionStart` and `Stop` still work.
- `PermissionRequest` hook scripts MUST `exit 0` with empty stdout on every failure path. Codex interprets `exit 2 + stderr` as a `Deny` decision, which would silently block tool approvals.
- Codex 0.124+ renamed the feature flag from `[features] codex_hooks` to `[features] hooks` (stable, default-on by 0.130). ccmux's TOML helper recognizes either name; new installs write `codex_hooks = true` for backwards compat with older Codex, which is a harmless orphan key on 0.124+. Uninstall deliberately leaves whichever flag is present in place (see below).
- `SessionStart` fires on first user message in Codex 0.124+, not on agent launch. Sessions appear pane-tracked (no `nativeSessionId`) until the user submits their first turn; this is expected. Codex 0.122/0.123 fire `SessionStart` on launch.
- `ccmux setup --uninstall --agent codex` deliberately leaves the codex hooks feature flag in `~/.codex/config.toml` untouched (either `codex_hooks` or `hooks`, whichever is present). Orphan flag is cosmetic (empty `hooks.json` = zero handlers fire); flipping it off would be a footgun for users who enabled it independently.
- Codex's unanchored `processMatch` (`/\bcodex\b/i`) also matches the bundled computer-use MCP server (argv[0] basename `Codex`), which runs with its cwd inside `<CODEX_DIR>/plugins/`. `discoverAgentProcesses` drops any discovered process whose resolved cwd is under `<CODEX_DIR>/plugins/` (`isCodexPluginHostCwd` in `processes.ts`), so the plugin host never becomes a session. Without it the host would group by its version dir (e.g. "1.0.793"), collapsing unrelated panes. The filter targets the process (by cwd), not a session, so a real `codex` sharing the pane still populates the session with its own repo cwd.

## Cursor-specific caveats

- Hooks require `cursor-agent` >= 2026.1.16 (the hooks feature landed in that release). Older versions silently ignore `hooks.json` entries; `install()` warns but doesn't block, and `describeInstallAnomalies()` surfaces the same warning at daemon startup. Version gate lives in `adapters/cursor/version.ts`.
- `processMatch: /^(cursor-agent|agent)$/i` matches both the stock binary and the bare `agent` shim Cursor ships. Anchored on argv[0] basename via `findAgentForProcess`, so it won't collide with arbitrary shell commands that include the word "agent".
- `--resume <chatId>` accepts the payload's `conversation_id` (which equals `session_id` in every captured payload). Cursor scopes chats per workspace — `cursor-agent --resume <id>` only restores the transcript when invoked from the original `workspace_roots` directory. ccmux resumes inside the pane's own shell, which preserves cwd, so this is fine in practice.
- Cursor invokes hook commands through a `/bin/zsh -c` wrapper, so `$PPID` inside the script is a transient shell, not cursor-agent. The scripts walk the process ancestry via `ps -o comm=` to find the real cursor-agent PID; if the walk fails they fall back to `$PPID` so the marker self-cleans on the next scan rather than silently no-opping.
- `--resume` does NOT fire `sessionStart`; only `beforeSubmitPrompt` fires on the first submission in a resumed chat. The `ccmux-before-submit-prompt.sh` and `ccmux-stop.sh` scripts therefore create the marker if missing (same identity fields `sessionStart` would have written), otherwise resumed chats would be invisible to ccmux.
- Hook scripts MUST `exit 0` with empty stdout on every failure path. Cursor treats `exit 2 + stderr` as a "deny the action" signal. The four subscribed events don't gate execution today, but keeping the contract uniform prevents surprises if we later add `preToolUse`.
- `ccmux setup --uninstall --agent cursor` removes only entries whose `command` matches the exact install-written script paths, and preserves the top-level `version` field so a user's hand-authored `hooks.json` structure stays intact.

## OpenCode-specific caveats

- The OpenCode adapter installs a single JS plugin at `~/.config/opencode/plugin/ccmux.js` (OpenCode auto-discovery). The plugin authors are careful to use only `node:fs/promises` so the same file runs under both Bun and Node, whichever OpenCode was launched with. The first line is a sentinel (`// ccmux-plugin v<version>`); `install()` refuses to overwrite any same-named file missing the sentinel, and `uninstall()` refuses to delete anything lacking it.
- One OpenCode server can host many sessions. The plugin writes one marker per server-side session; the adapter folds all markers sharing a server PID into the single ccmux Session for the hosting tmux pane. Status is worst-of (waiting > working > idle); `attentionType`, `pendingTool`, `cwd`, and `nativeSessionId` follow the newest-activity or newest-waiting marker.
- Pane correlation uses PID ancestry (`HookManagerContext.getPaneHostingPid`) because OpenCode markers carry no TTY (no per-session TTY exists). OpenCode launched outside a tmux pane is out of scope.
- When all sessions on a live server are deleted, the adapter resets the ccmux Session's status to idle but the stale `nativeSessionId` remains (the `SessionManager` setter accepts only strings, not null). Inert: status shows idle, click-through still lands in the pane. PID death clears it via `cleanupStaleSessions`.
- `ccmux setup --uninstall --agent opencode` only unlinks the plugin file; the daemon's next `cleanupStaleMarkers` sweep removes any leftover markers when their server PIDs die.
- The JS SDK does not expose `permission.list`. If ccmux is installed while OpenCode is already waiting on a tool approval, the pending permission is invisible until the user responds or a new `permission.asked` fires.

## Pi-specific caveats

- Pi sets `process.title = "pi"` at the top of its CLI entrypoint, so `ps` reports the process as `pi` (not `node .../cli.js`). `processMatch` is anchored `/^pi$/i` (not `\bpi\b`) because "pi" is a short, collision-prone token; a `pi-coding-agent/dist/cli.js` `commandPatterns` entry covers the sub-millisecond window before the title is set and any platform where title rewriting doesn't reach `ps`.
- Pi has **no native tool-approval pause** (it runs tools immediately), so there is no authoritative `waiting`/`permission` state. The marker only ever carries `idle`/`working`, and the no-hooks `terminalRules` only detect `working` (keyed on the literal `Working...` / `Thinking...`; Pi's idle footer contains the word "interrupt", so unlike codex/gemini we must NOT key `working` on "interrupt"). A `waiting` indicator is only possible if the user installs a `tool_call`-gating extension, which is out of scope.
- Pi runs ONE session per process. A session switch (`/new`, `/resume`) emits `session_shutdown` for the old session (removing its marker), reloads extensions, then emits `session_start` for the new one, so markers never overlap and need no OpenCode-style aggregation.
- Pi auto-discovers both `*.ts` and `*.js` extensions (loaded via jiti), so ccmux installs a `.js` file. That keeps the authored template out of ccmux's own TypeScript build (mirrors the OpenCode plugin) while still being picked up by Pi.
- `ccmux invoke pi` shells `pi -p "<prompt>"` (print mode → final assistant text on stdout). `--session <id>` resume in print mode is unverified, so `resumeArgs` is not exposed (sessionId resume is rejected at the daemon, like gemini).

## File paths

### Agent-owned (read-only except during `ccmux setup`)

- Claude Code logs: `~/.claude/projects/<encoded-path>/<sessionId>.jsonl` (plus any extra config dirs from the `additionalClaudeConfigDirs` preference / `CLAUDE_CONFIG_DIR`, each watched at `<dir>/projects`)
- Claude Code history: `~/.claude/history.jsonl`
- Claude Code settings: `~/.claude/settings.json` (written by `ccmux setup --agent claude`)
- Claude Code hooks: `~/.claude/hooks/ccmux-session-start.sh`, `ccmux-session-end.sh`, `ccmux-state-notify.sh`
- Codex sessions: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (honors `$CODEX_HOME`)
- Codex hooks.json: `~/.codex/hooks.json` (written by `ccmux setup --agent codex`)
- Codex config.toml: `~/.codex/config.toml` (codex hooks feature flag written by install as `[features] codex_hooks = true` for backwards compat with older Codex; ccmux recognizes the 0.124+ `[features] hooks = true` rename on read; uninstall never touches whichever name is present)
- Codex hooks: `~/.codex/hooks/ccmux-session-start.sh`, `ccmux-stop.sh`, `ccmux-permission-request.sh`
- OpenCode logs: `~/.local/share/opencode/log/` (daily-rotated, plain-text)
- OpenCode plugin: `~/.config/opencode/plugin/ccmux.js` (written by `ccmux setup --agent opencode`; honors `$XDG_CONFIG_HOME`)
- Cursor hooks.json: `~/.cursor/hooks.json` (written by `ccmux setup --agent cursor`; user-authored `version` field and unrelated entries preserved on uninstall)
- Cursor hooks: `~/.cursor/hooks/ccmux-session-start.sh`, `ccmux-session-end.sh`, `ccmux-before-submit-prompt.sh`, `ccmux-stop.sh`
- Cursor transcripts: `~/.cursor/projects/<workspace-slug>/agent-transcripts/<conversation_id>/<conversation_id>.jsonl` (ccmux does not parse these in v1)
- Pi sessions: `~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<uuidv7>.jsonl` (ccmux does not parse these in v1; Pi appends-and-closes per entry, so the lsof discovery path never fires, same constraint as Claude)
- Pi extension: `~/.pi/agent/extensions/ccmux.js` (written by `ccmux setup --agent pi`; Pi resolves `~/.pi/agent` with no XDG/env override)

### ccmux-owned

- Markers: `~/.config/ccmux/session-pids/<agent_type>-<session_id>.json` (written by hook scripts for Claude/Codex/Cursor, the bundled plugin for OpenCode, or the bundled extension for Pi; consumed by the daemon's `HookManager`)
