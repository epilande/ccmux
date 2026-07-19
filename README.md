<div align="center">
  <h1>
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
      <img alt="ccmux logo" src="assets/logo.svg" width="120">
    </picture>
    <br>ccmux
  </h1>
</div>

<p align="center">
  <strong>Track all your AI coding agents (Claude Code, Codex, Cursor, ...) in tmux and jump to the one that needs you</strong>
</p>

<p align="center">
  <img alt="ccmux picker showing live agent sessions grouped by project" src="https://github.com/user-attachments/assets/e4c41e9c-9221-47e2-86d4-362dd799651a" width="900">
</p>

## ❓ Why?

When running multiple AI coding agent sessions across tmux panes, it's hard to keep track of which session is idle, which is waiting for permission, and which pane to switch to. `ccmux` solves this with a background daemon that monitors session activity and an interactive TUI that shows live session states at a glance.

It works with your existing tmux workflow. You don't change how you launch or run your agents; ccmux discovers what's already running in your panes, so as long as you're in tmux with a supported agent, it just works.

**Built-in support for:** Claude Code, Codex, Cursor, OpenCode, Pi, Antigravity, Copilot, Gemini CLI, plus [custom agent definitions](#-custom-agents) via config.

## ✨ Features

- 🎯 **Live Session States**: Every agent tracked as idle, working, or waiting (permission / plan approval / question), flagged the moment one needs you
- 🧩 **Multi-Agent**: Claude Code, Codex, Cursor, OpenCode, Pi, Antigravity, Copilot, Gemini CLI, plus custom agents via config
- 🔄 **Real-Time**: Background daemon streams state changes instantly over SSE, no polling, no refresh
- 👁️ **Live Preview**: Split-pane view of the selected session's pane content
- ⚡ **Act in Place**: Tab into the preview to approve, answer, or type, keys go straight to that pane
- 🔔 **Actionable Notifications**: Approve, deny, or reply to a waiting agent straight from the desktop notification
- 📊 **Sidebar Mode**: Compact always-visible session rail docked beside your working panes
- 🔍 **Fuzzy Search**: Fuzzy-match sessions by project, branch, or path; substring-match any recent prompt, captured pane content, and on-demand live transcripts
- 📂 **Session Grouping**: Collapsible project groups with reordering and pinning
- 🌿 **Git & PR Aware**: Branch and worktree detection, open PRs with live CI and review status
- 📝 **Diff Review**: Press <kbd>d</kbd> to review a session's working-tree diff with [hunk](https://github.com/modem-dev/hunk), right in the pane
- 🤖 **Background Agents & Subagents**: Claude Code background agents get rows too; running subagents show as `agents` with a live list in the preview
- 🔁 **Session Control**: Spawn, kill, and restart sessions from the TUI; `ccmux invoke` for scripted one-shot agent turns
- ⌨️ **Keyboard-First, Mouse-Friendly**: Vim keys and number jumps, plus click-to-switch and right-click context actions

## 📦 Installation

### Prerequisites

- [tmux](https://github.com/tmux/tmux) with active sessions running AI coding agents

### Homebrew

```sh
brew install epilande/tap/ccmux
ccmux setup
```

### From Source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/epilande/ccmux.git
cd ccmux
bun install
bun link
ccmux setup
```

`ccmux setup` installs agent hooks for authoritative session matching. ccmux works without it, but it's recommended; see [Session Matching with Hooks](#-session-matching-with-hooks). Bare `ccmux setup` only configures agents whose executable is found on PATH; use `ccmux setup --agent <name>` to install for a specific agent even if it isn't detected.

## 🚀 Quick Start

1. Start your AI coding sessions in tmux panes as usual
2. Launch the picker:
   ```bash
   ccmux
   ```
3. Navigate with <kbd>j</kbd>/<kbd>k</kbd>, press <kbd>Enter</kbd> to switch to a session

> [!TIP]
> Bind a tmux key so you can pop ccmux open from anywhere (add to `~/.tmux.conf`):
>
> ```tmux
> # Prefix + C-p: open ccmux in a centered popup
> bind-key C-p display-popup -E -w 80% -h 75% "ccmux"
>
> # Or skip the prefix entirely (Alt+p from any pane)
> bind-key -n M-p display-popup -E -w 80% -h 75% "ccmux"
> ```
>
> The picker exits after you select a session, so the popup closes itself and drops you straight into that pane. (`display-popup` requires tmux 3.2+.)

## 🎮 Usage

### CLI Commands

| Command                                     | Description                                                                                                   |
| :------------------------------------------ | :------------------------------------------------------------------------------------------------------------ |
| `ccmux`                                     | Launch interactive TUI picker (default)                                                                       |
| `ccmux picker`                              | Launch TUI with options (`--preview`, `--icons <style>`)                                                      |
| `ccmux picker --persistent`                 | Dashboard mode (stay open after switching sessions)                                                           |
| `ccmux spawn [agent]`                       | Spawn a new agent session in a tmux pane                                                                      |
| `ccmux invoke [agent] "prompt"`             | Run a single agent turn and write the response to stdout ([docs](docs/invoke.md))                             |
| `ccmux invoke list`                         | List active and recently-finished invocations (`-j` for JSON)                                                 |
| `ccmux invoke cancel <id>`                  | Cancel a running invocation by id (idempotent)                                                                |
| `ccmux invoke result <id>`                  | Print an invocation's full captured output (subprocess agents only)                                           |
| `ccmux show`                                | List all active sessions                                                                                      |
| `ccmux show --json`                         | Output sessions as JSON                                                                                       |
| `ccmux status`                              | Show daemon and session overview                                                                              |
| `ccmux switch <id>`                         | Switch tmux client to a session's pane                                                                        |
| `ccmux review [id]`                         | Review a session's diff with [hunk](https://github.com/modem-dev/hunk) (defaults to cwd)                      |
| `ccmux kill <id>`                           | Kill a session's process                                                                                      |
| `ccmux restart <id>`                        | Kill and resume a session                                                                                     |
| `ccmux send <id> <text>`                    | Send text to a session's tmux pane (multiline pastes as one message; `--no-enter` skips submit)               |
| `ccmux screen [id]`                         | Capture pane content                                                                                          |
| `ccmux screen --grep <pattern>`             | Search across all session panes                                                                               |
| `ccmux dismiss <id>`                        | Remove a session from tracking                                                                                |
| `ccmux daemon start\|stop\|restart\|status` | Manage the background daemon                                                                                  |
| `ccmux config set <key> <value>`            | Set a preference                                                                                              |
| `ccmux config get <key>`                    | Get a single preference value                                                                                 |
| `ccmux config list`                         | List all preferences                                                                                          |
| `ccmux config themes`                       | List built-in themes (marks the active one)                                                                   |
| `ccmux setup`                               | Install hooks for every supported agent found on PATH (Claude + Codex + Cursor + OpenCode + Pi + Antigravity) |
| `ccmux setup --agent <name>`                | Limit install/uninstall/status to specific agent(s); forces install even if not found on PATH                 |
| `ccmux setup --status`                      | Report install state without writing anything                                                                 |
| `ccmux setup --uninstall`                   | Remove hooks (preserves user-owned hook entries)                                                              |
| `ccmux debug`                               | Diagnose session tracking discrepancies                                                                       |
| `ccmux notify [message]`                    | Send a notification via the configured backend (bare: test message + diagnostics)                             |
| `ccmux sidebar`                             | Launch narrow sidebar TUI (no preview/footer)                                                                 |
| `ccmux sidebar --toggle`                    | Smart toggle: spawn/kill sidebars in every window across all tmux sessions                                    |

The daemon starts automatically the first time you run a ccmux command (picker, show, invoke, etc.). It runs on `127.0.0.1:2269` and provides both a REST API and SSE event stream.

### Preview Pane

Press <kbd>P</kbd> to split the picker and preview the highlighted session's live pane content side by side. Press <kbd>Tab</kbd> to focus the preview and act in place: your keystrokes go straight to that agent's pane, so you can approve a permission, answer a question, or type a follow-up without ever leaving ccmux.

When the session has agents running, an **Agents** section lists each one with its runtime. Finished agents drop off the list.

https://github.com/user-attachments/assets/7e0d42b3-4e7b-43b8-8d06-72a2d69dd694

### Diff Review with Hunk

[hunk](https://github.com/modem-dev/hunk) is a terminal diff reviewer. With `hunk` on your `PATH`, press <kbd>d</kbd> in the picker to review the selected session's working-tree diff without leaving ccmux: the picker suspends, `hunk diff --watch` takes over the pane in the session's repository root, and the picker resumes when hunk exits. The same action is available from the right-click context menu. If the working tree has no changes, ccmux reports that instead of opening an empty review.

To send review feedback back to the agent:

1. Press <kbd>c</kbd> in hunk to annotate a line, then <kbd>Ctrl+S</kbd> to save the note.
2. Add any other review notes and quit hunk.
3. Confirm **Send review comments** when the picker resumes. ccmux sends all captured notes, including short source snippets, to the agent as one prompt and stays in the picker so you can watch its status.

The offer relies on hunk's session JSON commands (`hunk session list` / `session comment list`, verified against hunk 0.17.0). With an older hunk the review itself still works; the offer just doesn't appear.

The `reviewHandback` preference controls what happens when hunk exits:

- `confirm` (default) asks before sending the prompt.
- `auto` sends and submits the prompt immediately without a dialog.
- `fill` pastes the prompt into the agent's composer without submitting it. The text remains there until you jump to the session and submit or edit it; a later send or invoke may find it prepended.

The review also runs from the CLI:

```bash
ccmux review          # Review the current directory's repository
ccmux review <id>     # Review a session's repository by id
```

Install hunk with `brew install modem-dev/tap/hunk`. The <kbd>d</kbd> footer hint and help entry appear only when hunk is detected on `PATH` at launch.

### Sidebar Mode

A compact, always-visible session list that lives alongside your working panes. No preview panel, no footer, just status icons and project names.

<p align="center">
  <img alt="ccmux sidebar alongside working panes" src="https://github.com/user-attachments/assets/742642cf-b90b-445d-bc9a-38b6cfa0ab79" width="900">
</p>

```bash
ccmux sidebar --toggle                  # Toggle sidebars in all tmux windows
ccmux sidebar --toggle --width 40       # Custom width (default: 30)
ccmux sidebar --toggle --position right # Right side (default: left)
ccmux sidebar --resize --width 30       # Snap every existing sidebar pane to <width>
```

The smart toggle fills gaps when some windows are missing sidebars, and kills all sidebars when every window already has one. New windows automatically get a sidebar, and sidebars snap back to their configured width when a window is resized.

Configure defaults so `--toggle` uses your preferred layout:

```bash
ccmux config set sidebar.width 40
ccmux config set sidebar.position right
```

**Suggested tmux keybinding** (add to `~/.tmux.conf`):

```tmux
bind-key S run-shell "ccmux sidebar --toggle"
```

### Notifications

Desktop notifications on `waiting`/`finished` transitions, disabled by default. When a session needs permission, or has a plan waiting for approval, the banner carries **Approve** / **Deny** buttons; permission, plan, question, and "finished" notifications also carry an inline **Reply** field, so you can answer, redirect, or send the next instruction without switching to its pane. Focusing a session's pane clears its notification.

|                                                                           **Permission → Approve / Deny**                                                                            |                                                                        **Question → inline Reply**                                                                         |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| <img alt="ccmux notification with Approve / Deny buttons for a permission prompt" src="https://github.com/user-attachments/assets/e2fb5423-eac0-47d5-ae35-b003d797e42c" width="380"> | <img alt="ccmux notification with an inline Reply field for a question" src="https://github.com/user-attachments/assets/75671613-1c19-47c0-986c-ee41fd6a9860" width="380"> |

```bash
ccmux config set notifications.enabled true
ccmux notify   # sends a test notification and prints setup diagnostics
```

Actionable Approve/Deny buttons work for **Claude Code**, **OpenCode**, **Codex**, **Cursor**, **Gemini CLI**, **Antigravity**, and **Copilot**; Pi has no tool-approval pause, so its notifications are click-to-jump. Inline **Reply** is Claude Code only. Approve/Deny work on macOS and Linux; inline reply needs a notification server that advertises it (always on macOS, varies on Linux).

For OpenCode, one server can host several sessions folded into a single row, so when more than one is waiting at once the buttons are withheld (the keystroke could land on the wrong session's dialog) and the notification is delivered informational-only.

**macOS:** the buttons, ccmux's own name and icon, per-session grouping, and retraction come from a helper app Homebrew installs alongside ccmux, so `brew install epilande/tap/ccmux` for the full experience. Source installs fall back to `osascript` (posts as Script Editor, silenced by Focus / Do Not Disturb, no buttons or reply). macOS never shows a permission dialog for a CLI-launched app, so grant it once by hand: run `ccmux notify` and follow the printed steps (open the settings deep link, find **ccmux-notifier**, enable **Allow notifications**, set **Alert Style** to **Persistent**), then re-run `ccmux notify` to confirm.

**Linux:** `dbus` grouping, click-to-jump, and Approve/Deny are native (no extra binary); inline reply appears only when the server advertises it. A headless daemon (SSH, systemd) needs `DBUS_SESSION_BUS_ADDRESS`, plus `DISPLAY` for the `notify-send` fallback.

Configure further with `ccmux config set notifications.<key> <value>`, or edit `~/.config/ccmux/ccmux.json` directly:

```jsonc
{
  "notifications": {
    "enabled": true, // default false (opt-in)
    "events": ["waiting", "finished"], // default both
    "sound": "Glass", // false (default) | true (platform default sound) | macOS sound name
    "delayMs": 1000, // debounce for "finished" only; "waiting" always fires immediately
    "backend": "auto", // "auto" | "ccmux-notifier" | "osascript" | "notify-send" | "dbus" | "command"
    "command": "ntfy publish agents \"$CCMUX_TITLE: $CCMUX_BODY\"", // used when backend = "command"
  },
}
```

`backend: "auto"` picks `ccmux-notifier` (else `osascript`) on macOS, and D-Bus (else `notify-send`) on Linux. `command` runs your own shell command with `CCMUX_*` env set (`EVENT`, `SESSION_ID`, `AGENT`, `PROJECT`, `BRANCH`, `TITLE`, `SUBTITLE`, `BODY`, `PANE`), for ntfy, Pushover, and the like. `CCMUX_BODY` is the complete text (the event line plus any context), so a script reading only it still gets something meaningful; `CCMUX_SUBTITLE` is the bare event line on its own for structured consumers.

> [!NOTE]
> **Approve/Deny only send the mapped keystroke** to that session's pane (for Claude, the same key you'd press yourself). **Approve on a plan** picks "manually approve edits" (edits stay gated), never Claude's auto-accept mode. **Reply on a permission or plan notification denies the pending tool/plan** and sends your text as the next message (it cancels the prompt first, then types). If the session moved on since the notification fired, the press sends nothing and you get a fresh "state changed" notification instead; dismissing a notification never approves anything.

The keystrokes behind the buttons come from a per-agent `notificationActions` map, overridable per [Custom Agents](#-custom-agents).

### Search Mode

Press <kbd>/</kbd> to filter the list as you type. ccmux searches several sources at once and highlights why each row matched:

- **Metadata** (project, branch, path) matches fuzzily, so `ccmx` still finds `ccmux`.
- **Recent prompts, captured pane content, and live transcripts** match by substring, so a content word matches only where it actually appears.

Prompts come from the daemon's in-memory index, which keeps the most recent prompts per session and is tail-bounded after a daemon restart (only recent prompts are re-read from disk). Transcript search closes that gap: it reads each session's transcript file on demand and covers the full session history, including assistant replies (Claude and Codex).

Three toggles control what gets scanned: `searchPaneContent`, `searchPaneLines`, and `searchTranscript` (see [Configuration](#-configuration)).

### Spawning Sessions

Launch new agent sessions directly from the CLI:

```bash
ccmux spawn                          # Spawn claude (default) in a new tmux window
ccmux spawn codex                    # Spawn a specific agent
ccmux spawn --split                  # Split current pane instead of new window
ccmux spawn --detach                 # Don't switch to the new pane
ccmux spawn --cwd ~/proj             # Set working directory
ccmux spawn --resume <id>            # Resume an existing session
ccmux spawn --prompt "fix the tests" # Send an initial prompt
```

### Programmatic Invocation

`ccmux invoke` runs a single agent turn and writes the response to stdout, so you can use real agents in shell pipelines and scripts. See [`docs/invoke.md`](docs/invoke.md) for the full reference.

```bash
ccmux invoke claude "say hi in one word"
echo "what is 2 + 2" | ccmux invoke claude
git diff main | ccmux invoke claude "Review this diff"
```

Claude runs interactively in a dedicated tmux session and returns clean text parsed from the transcript JSONL. Codex, Cursor, OpenCode, Pi, Antigravity, Copilot, and Gemini run as non-interactive subprocesses (`codex exec -o`, `cursor-agent --print`, `opencode run --format json`, `pi -p`, `agy -p`, `copilot -p --allow-all-tools`, `gemini -p`) and return the agent's clean response text.

For orchestration, name an invocation with `--id <id>`, then use `ccmux invoke list`, `ccmux invoke cancel <id>`, and `ccmux invoke result <id>` to watch, cancel, or read its full captured output by that id. See [`docs/invoke.md`](docs/invoke.md#fire-and-poll---id-list-cancel-result) for the fire-and-poll reference.

### Dispatch Skill

This repo ships a `dispatch` [Agent Skill](https://agentskills.io) that teaches your coding agent to orchestrate other agents through `ccmux invoke` (firing, fan-out, joining, cancelling, and reading worker output). For Claude Code it installs as a plugin (this repo doubles as a plugin marketplace):

```
/plugin marketplace add epilande/ccmux
/plugin install ccmux@ccmux
```

Other skills-capable agents (Codex, Cursor, OpenCode, and others) can use the same skill by copying it into their skills directory. The skill is additive glue for the ccmux CLI, which must be installed and on your `PATH`. See [`plugins/ccmux/README.md`](plugins/ccmux/README.md) for details.

## ⌨️ Keyboard Controls

| Action                | Key                                                                                | Description                                                                                                            |
| :-------------------- | :--------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| Navigate              | <kbd>j</kbd> / <kbd>k</kbd> or <kbd>↑</kbd> / <kbd>↓</kbd>                         | Move through session list                                                                                              |
| Jump to first/last    | <kbd>g</kbd><kbd>g</kbd> / <kbd>G</kbd>                                            | Go to top / bottom                                                                                                     |
| Jump to session       | <kbd>1</kbd>–<kbd>9</kbd>                                                          | Switch directly to session N                                                                                           |
| Switch to session     | <kbd>Enter</kbd>                                                                   | Switch tmux to the selected pane                                                                                       |
| Search                | <kbd>/</kbd>                                                                       | Enter fuzzy search mode                                                                                                |
| Toggle preview        | <kbd>P</kbd>                                                                       | Show/hide the preview panel                                                                                            |
| Scroll preview        | <kbd>Ctrl+D</kbd> / <kbd>Ctrl+U</kbd>                                              | Half-page scroll in preview                                                                                            |
| Resize preview        | <kbd>Alt+H</kbd> / <kbd>Alt+L</kbd>                                                | Increase/decrease preview width                                                                                        |
| Focus preview         | <kbd>Tab</kbd>                                                                     | Send keys directly to tmux pane                                                                                        |
| Restart session       | <kbd>r</kbd>                                                                       | Kill and resume the selected session                                                                                   |
| Reconnect             | <kbd>R</kbd>                                                                       | Reconnect to the daemon SSE stream                                                                                     |
| Kill session          | <kbd>x</kbd>                                                                       | Kill the selected session's process                                                                                    |
| Kill all              | <kbd>X</kbd>                                                                       | Kill all tracked sessions                                                                                              |
| Review and hand back  | <kbd>d</kbd>                                                                       | Review with [hunk](https://github.com/modem-dev/hunk), then offer to send notes to the agent (requires `hunk` on PATH) |
| Collapse/expand       | <kbd>h</kbd> / <kbd>l</kbd> or <kbd>Space</kbd>                                    | Toggle group collapsed state                                                                                           |
| Move group            | <kbd>J</kbd> / <kbd>K</kbd>                                                        | Reorder group down / up (persisted)                                                                                    |
| Move group top/bottom | <kbd><</kbd> / <kbd>></kbd>                                                        | Pin group to top / bottom                                                                                              |
| Collapse/expand all   | <kbd>z</kbd><kbd>M</kbd> / <kbd>z</kbd><kbd>R</kbd> or <kbd>-</kbd> / <kbd>=</kbd> | Collapse or expand all groups                                                                                          |
| Hide idle             | <kbd>f</kbd>                                                                       | Toggle hiding idle sessions                                                                                            |
| Cycle prompt          | <kbd>p</kbd>                                                                       | Prompt display: inline → own row → off                                                                                 |
| Cycle group-by        | <kbd>b</kbd>                                                                       | Cycle through group-by modes                                                                                           |
| Help                  | <kbd>?</kbd>                                                                       | Show keyboard shortcuts overlay                                                                                        |
| Quit                  | <kbd>q</kbd> / <kbd>Esc</kbd>                                                      | Exit the picker                                                                                                        |

<details>
<summary><strong>Search mode keys</strong></summary>

| Action           | Key                                   |
| :--------------- | :------------------------------------ |
| Navigate results | <kbd>Ctrl+N</kbd> / <kbd>Ctrl+P</kbd> |
| Select           | <kbd>Enter</kbd>                      |
| Cancel           | <kbd>Esc</kbd>                        |

</details>

<details>
<summary><strong>Preview focus mode</strong></summary>

When preview is focused (<kbd>Tab</kbd>), keystrokes are forwarded to the tmux pane. These keys still work:

| Action            | Key                                   |
| :---------------- | :------------------------------------ |
| Navigate sessions | <kbd>Ctrl+N</kbd> / <kbd>Ctrl+P</kbd> |
| Resize preview    | <kbd>Alt+H</kbd> / <kbd>Alt+L</kbd>   |
| Scroll preview    | <kbd>Ctrl+D</kbd> / <kbd>Ctrl+U</kbd> |
| Exit focus        | <kbd>Tab</kbd> / <kbd>Esc</kbd>       |

</details>

## ⚙️ Configuration

Preferences are stored in `~/.config/ccmux/ccmux.json` and can be managed with:

```bash
ccmux config set <key> <value>
ccmux config get <key>
ccmux config list
```

| Key                          | Values                                                                       | Default            | Description                                                                                                                        |
| :--------------------------- | :--------------------------------------------------------------------------- | :----------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| `iconStyle`                  | `dot`, `emoji`, `nerdfont`, `none`                                           | `dot`              | Status icon style                                                                                                                  |
| `theme`                      | `catppuccin-*`, `tokyo-night*`, `dracula`, `gruvbox-*`, `nord`, `rose-pine*` | `catppuccin-mocha` | TUI color theme (resolved at launch; see [Theme](#-theme))                                                                         |
| `showPreview`                | `true`, `false`                                                              | `false`            | Show preview panel on launch                                                                                                       |
| `previewWidth`               | `20`–`80`                                                                    | `40`               | Preview panel width (percentage)                                                                                                   |
| `command`                    | any non-blank string                                                         | `claude`           | CLI command used for session restart                                                                                               |
| `groupBy`                    | `project`, `cwd`, `session`, `window`, `none`                                | `project`          | How sessions are grouped in the TUI                                                                                                |
| `promptDisplay`              | `inline`, `row2`, `off`                                                      | `inline`           | Prompt display: inline on row 1, its own row, or hidden                                                                            |
| `backgroundAgents`           | `true`, `false`                                                              | `true`             | Show Claude background agents as rows (daemon restart required)                                                                    |
| `additionalClaudeConfigDirs` | array of paths                                                               | `[]`               | Additional Claude config dirs to watch (daemon restart required; see [Multiple Claude Config Dirs](#-multiple-claude-config-dirs)) |
| `searchPaneContent`          | `true`, `false`                                                              | `true`             | Include captured pane content in TUI search                                                                                        |
| `searchPaneLines`            | `10`–`500`                                                                   | `100`              | Lines of pane content scanned in TUI search                                                                                        |
| `searchTranscript`           | `true`, `false`                                                              | `true`             | Search live Claude/Codex transcripts (full history + assistant text) via the daemon                                                |
| `persistent`                 | `true`, `false`                                                              | `false`            | Keep picker open after switching sessions (dashboard mode)                                                                         |
| `reviewHandback`             | `confirm`, `auto`, `fill`                                                    | `confirm`          | After a hunk review, confirm delivery, send immediately, or fill the agent composer without submitting                             |
| `sidebar.width`              | `10`–`80`                                                                    | `30`               | Sidebar pane width in columns                                                                                                      |
| `sidebar.position`           | `left`, `right`                                                              | `left`             | Which side of the window to place the sidebar                                                                                      |

For how these search knobs interact, see [Search Mode](#search-mode).

### 📊 Column Configuration

Each session item has up to two rows (`row1`, `row2`), and each row has a `left` and `right` side. Each side is a comma-separated list of field entries. An entry is either `<field>` (use the field's default mode) or `<field>:<mode>` (override the mode).

```bash
ccmux config set columns.row1.left  "index,status:icon,project"
ccmux config set columns.row1.right "agent:short,pane,time"
ccmux config set columns.row2.left  "prompt"
ccmux config set columns.row2.right "branch"
```

Pass an empty string to clear a side: `ccmux config set columns.row2.left ""`.

| Field     | Modes                 | Default mode | Description                              |
| :-------- | :-------------------- | :----------- | :--------------------------------------- |
| `index`   | —                     | —            | Row number (1–9)                         |
| `status`  | `icon`/`short`/`full` | `icon`       | Status badge style                       |
| `project` | `dirname`/`full`      | `dirname`    | Project path (basename or full)          |
| `agent`   | `short`/`full`        | `full`       | Agent name (2-char code or full label)   |
| `version` | —                     | —            | Agent version                            |
| `pane`    | —                     | —            | Tmux pane target (session:window.pane)   |
| `time`    | —                     | —            | Relative time since last input           |
| `prompt`  | —                     | —            | Last user prompt (truncated)             |
| `cwd`     | —                     | —            | Working directory                        |
| `branch`  | —                     | —            | Git branch                               |
| `pr`      | `short`/`full`        | `full`       | Open PRs for the branch (`#25`/`PR #25`) |

Defaults: `row1.left` is `index, status, project` (status badge widens icon→short→full as the terminal grows). `row1.right` cascades by breakpoint: just `pane` below `xs`, then `agent:short, pane` at `xs`, `agent:short, pane, time` at `sm`, and `agent:full, version, pane, time` at `md`+. The `prompt` and `pr` cells are configured on `row2`, but `promptDisplay` (default `inline`, cycled live by <kbd>p</kbd>) controls how they render: `inline` flattens them onto `row1` so each session stays a single line, `row2` gives the prompt its own line with `pr` at the right edge, and `off` hides both. Sessions with no prompt stay single-line in `inline` mode; in `row2` mode the second line still appears when another row-2 field (such as an open PR) has data.

Sidebar defaults differ to fit the narrow rail: `row1` is `status, project` with `pr:short, agent:short` on the right (PR stays visible even with the prompt hidden), and `row2` is `prompt` / `time` (a lone `time` never earns the row; it rides along when some other field has data). The 30-col rail has no room to inline, so the sidebar always uses the two-row layout (`inline` behaves like `row2`). Override these under the `sidebar.columns` key in `~/.config/ccmux/ccmux.json` (e.g. `"sidebar": { "columns": { "row2": { "left": ["pane"] } } }` to bring the pane target back).

The CLI's comma-separated form sets one mode per entry. To vary the layout by terminal width (responsive cascade), edit `~/.config/ccmux/ccmux.json` directly and use the `default`/`xs`/`sm`/`md`/`lg` keys on either a row side (whole array) or an entry's `mode`.

### 📐 Breakpoints

Named breakpoints control when responsive column layouts activate. A breakpoint value applies from that terminal width upward until a larger breakpoint overrides it.

| Name | Default width |
| :--- | :------------ |
| `xs` | 40            |
| `sm` | 60            |
| `md` | 80            |
| `lg` | 100           |

```bash
ccmux config set breakpoints.sm 55
ccmux config set breakpoints.lg 120
```

### 🎨 Theme

The TUI ships 14 built-in palettes across six families, resolved once at launch (no in-TUI toggle).

```bash
ccmux config themes                       # list built-ins, mark the active one
ccmux config set theme tokyo-night        # switch theme
```

| Theme                  | Background     |
| :--------------------- | :------------- |
| `catppuccin-mocha`     | dark (default) |
| `catppuccin-macchiato` | dark           |
| `catppuccin-frappe`    | dark           |
| `catppuccin-latte`     | light          |
| `tokyo-night`          | dark           |
| `tokyo-night-storm`    | dark           |
| `tokyo-night-day`      | light          |
| `dracula`              | dark           |
| `gruvbox-dark`         | dark           |
| `gruvbox-light`        | light          |
| `nord`                 | dark           |
| `rose-pine`            | dark           |
| `rose-pine-moon`       | dark           |
| `rose-pine-dawn`       | light          |

For per-key tweaks, set `theme` to an object in `~/.config/ccmux/ccmux.json`: a built-in `base` plus `colors` (the 14 semantic keys) and/or `ansi` (the 16 terminal colors used to render the preview), deep-merged over the base.

```json
{
  "theme": {
    "base": "catppuccin-mocha",
    "colors": { "red": "#ff5555" },
    "ansi": { "brightBlack": "#585b70" }
  }
}
```

An unknown base name falls back to the default theme; an invalid hex value or unknown override key is dropped and the base value is kept. Each emits a warning. Run `ccmux config themes` to inspect any problems with the current config.

> [!NOTE]
> ccmux paints no background fill, so theme colors sit on your terminal's own background. The light palettes (`catppuccin-latte`, `tokyo-night-day`, `gruvbox-light`, `rose-pine-dawn`) assume a light terminal; pair them with a light background. Every other palette assumes a dark one.

### 🗂️ Multiple Claude Config Dirs

Claude Code writes session transcripts to `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), so sessions from a second account (e.g. a personal login launched with `CLAUDE_CONFIG_DIR=~/.claude-personal`) land in a tree ccmux doesn't watch by default. List those dirs in `additionalClaudeConfigDirs` and a single daemon watches every `<dir>/projects` tree:

```bash
ccmux config set additionalClaudeConfigDirs '["~/.claude-personal"]'
ccmux setup --agent claude   # installs hooks into every configured dir
ccmux daemon restart
```

`~/.claude` is always watched; entries are additional config dirs (`~` paths supported), and a set `CLAUDE_CONFIG_DIR` environment variable is picked up automatically. Sessions are keyed by their globally unique session ID, so the same project opened under two accounts coexists without collision.

> [!NOTE]
> If you add a dir later, re-run `ccmux setup --agent claude`. The daemon warns at startup about any configured dir still missing hooks.

## 🔗 Session Matching with Hooks

For reliable session-to-pane mapping (especially with multiple sessions of the same agent in the same project), install hooks:

```bash
ccmux setup                    # Install hooks for every supported agent found on PATH
ccmux setup --agent codex      # Limit to a single agent (installs even if not on PATH)
ccmux setup --status           # Report install state without writing
ccmux setup --uninstall        # Remove hooks
```

Hooks write PID marker files under `~/.config/ccmux/session-pids/` whenever a session starts or begins its first invocation, a turn completes, or the agent asks the user to approve a tool. The daemon picks up the markers in real time via a filesystem watcher. See [`docs/architecture.md#hook-lifecycle`](./docs/architecture.md#hook-lifecycle) for the full flow (marker writes, chokidar dispatch, per-agent correlation).

Gemini CLI is tracked through process detection and terminal pattern matching, so it needs no setup.

### Claude Code

Uses Claude's native hooks in `~/.claude/settings.json` with three scripts under `~/.claude/hooks/`:

- `ccmux-session-start.sh`: writes the marker on session create/resume
- `ccmux-session-end.sh`: removes the marker
- `ccmux-state-notify.sh`: updates state on `idle_prompt` / `permission_prompt`

### Codex CLI

Uses Codex's native hooks (`~/.codex/hooks.json` plus the codex hooks feature flag in `~/.codex/config.toml`, which is `[features] codex_hooks = true` pre-0.124 and `[features] hooks = true` on 0.124+; ccmux recognizes either) with three scripts under `~/.codex/hooks/`:

- `ccmux-session-start.sh`: writes the marker when a Codex session starts
- `ccmux-stop.sh`: refreshes the marker at the end of every turn
- `ccmux-permission-request.sh`: marks the session as `waiting_permission` when the user is asked to approve a tool

Tool-approval detection (`PermissionRequest`) needs Codex >= 0.122.

### Cursor CLI

Uses Cursor's native hooks (`~/.cursor/hooks.json`) with four scripts under `~/.cursor/hooks/`:

- `ccmux-session-start.sh`: writes the marker on fresh chat launch
- `ccmux-session-end.sh`: unlinks the marker when the chat ends
- `ccmux-before-submit-prompt.sh`: flips state to `working` and records the last prompt (1 KB cap)
- `ccmux-stop.sh`: refreshes state back to `idle` at turn completion

Requires `cursor-agent` >= 2026.1.16 (when the hooks feature landed).

### OpenCode

Uses OpenCode's plugin system rather than shell hooks. `ccmux setup --agent opencode` drops a single auto-discovered JS plugin at `~/.config/opencode/plugin/ccmux.js` (honors `$XDG_CONFIG_HOME`). The plugin subscribes to OpenCode's in-process event bus and writes a marker for every session on the server:

- `session.created` / `session.updated`: marker with directory + title
- `session.status` (busy/retry/idle): refreshes state to `working` or `idle`
- `message.updated` / `message.part.updated`: captures the user's last prompt (1 KB cap) into the marker (parity with Claude/Codex/Cursor)
- `permission.asked` / `permission.replied`: flips state to `waiting_permission` with the pending tool, clears back to `working` on reply
- `session.deleted`: unlinks the marker

Because one OpenCode server can host many sessions, the daemon folds all markers sharing a server PID into the single ccmux Session for the tmux pane that hosts the server. Status is worst-of (`waiting > working > idle`); `cwd` and `nativeSessionId` come from the newest-activity marker, while `pendingTool` and the attention indicator come from the newest-waiting marker.

### Pi

Uses Pi's extension system rather than shell hooks. `ccmux setup --agent pi` drops a single auto-discovered JS extension at `~/.pi/agent/extensions/ccmux.js`. The extension subscribes to Pi's lifecycle events and writes one marker per session:

- `session_start`: marker with the session id, transcript path, and cwd (Pi fires this at launch, so the marker carries full identity immediately)
- `before_agent_start`: captures the user's last prompt (1 KB cap)
- `agent_start` / `agent_end`: flips state to `working` / `idle` (these bracket one full user prompt, so the row never flickers mid-response the way per-turn events would)
- `session_shutdown`: unlinks the marker

Pi runs one session per process, so there's no server-style aggregation; the daemon correlates the marker's PID to its tmux pane via process ancestry and links `nativeSessionId`.

### Antigravity CLI

Uses Antigravity's global named-hook config at `~/.gemini/config/hooks.json` with two scripts under `~/.gemini/config/hooks/`:

- `ccmux-preinvocation.sh`: creates or refreshes the marker as `working` before each model invocation
- `ccmux-stop.sh`: refreshes the marker as `idle` when the execution loop stops

Antigravity exposes no session-start hook, so a fresh idle session remains pane-tracked until its first prompt. ccmux deliberately does not install `PreToolUse`: in Antigravity v1.1.1, an empty `{}` response silently denies the tool call. Permission attention instead comes from the native permission dialog detected in pane content.

### Copilot CLI

Drops one hooks file plus its marker script into Copilot's auto-discovered `~/.copilot/hooks/` dir (`ccmux-copilot.json` and `ccmux-copilot.sh`), registering observational events only:

- `sessionStart`: writes the marker (`working` if the session launched with an initial prompt, else `idle`)
- `userPromptSubmitted`: flips the marker to `working`
- `notification`: flips to `waiting` when the payload is a permission or elicitation dialog (other notification types are ignored)
- `agentStop`: flips back to `idle`
- `sessionEnd`: removes the marker

ccmux deliberately does not install Copilot's `permissionRequest` hook: it is a deciding hook whose output can allow or deny the tool call. Permission attention is observed through `notification` instead. Copilot's `events.jsonl` is also tailed as a log source (it flushes in real time, including the mid-wait `permission.requested`), and its held-open `session.db` backs no-hooks native-id discovery.

### Matching priority (with hooks installed)

1. **Marker file** (authoritative): Direct PID/TTY/session-id/transcript from the hook, re-verified on every scan so a wrong binding heals itself
2. **Process start time**: For panes markers don't claim, ccmux correlates session timestamps with agent process start times, matching each same-directory group as a whole within a 10-minute tolerance. When two candidates are too close to call, the session is left unbound rather than guessed.

Without hooks, the daemon does not use historical session IDs to claim pane ownership. It creates pane-scoped sessions from live process + tmux discovery, then attaches agent log metadata only when it can safely tie a log to the running process.

## 🧩 Custom Agents

The built-in agents are the happy path: they ship with hook integration for authoritative session matching. If you run an agent ccmux doesn't support out of the box, you can teach it one in `~/.config/ccmux/ccmux.json`. Custom agents fall back to process matching plus terminal pattern scanning (no hooks), so detection is less precise than a built-in, but it gets unsupported agents onto the board.

<details>
<summary><strong>Defining a custom agent</strong></summary>

```json
{
  "agents": {
    "myagent": {
      "processMatch": "myagent",
      "terminalRules": [
        {
          "matchAny": ["thinking...", "esc to interrupt"],
          "status": "working"
        },
        {
          "matchAll": ["approve?", "[y/n]"],
          "status": "waiting",
          "attentionType": "permission",
          "pendingTool": "Command"
        }
      ],
      "resumeCommand": "myagent resume {id}"
    }
  }
}
```

You can also override built-in agent settings by using the agent's name as the key (e.g., `"claude"`, `"codex"`). An override of `notificationActions` (the notification button/reply keystroke map) **replaces the whole map**, it is not merged key by key; it also controls the reply surfaces (`replyOnQuestion`, `replyOnFinished`, `permissionReplyPrelude`, and the `plan*` keys), so any key you leave out is dropped rather than inherited from the built-in default. Copy across every key you still want when you override it.

| Field                 | Required | Description                                                                         |
| :-------------------- | :------- | :---------------------------------------------------------------------------------- |
| `processMatch`        | Yes\*    | Regex to match the process executable                                               |
| `commandPatterns`     | No       | Additional regex patterns to match full commands                                    |
| `terminalRules`       | No       | Ordered terminal matching rules                                                     |
| `versionCommand`      | No       | Command to get agent version                                                        |
| `versionPatterns`     | No       | Regex patterns to extract version from output                                       |
| `resumeCommand`       | No       | Command template for restarting (`{id}` placeholder)                                |
| `sessionFilePattern`  | No       | Regex to extract session ID from log filenames                                      |
| `executable`          | No       | Command used to launch the agent (defaults to key)                                  |
| `hooks`               | No       | `{ type }` (built-in override only; internal)                                       |
| `notificationActions` | No       | Notification button/reply keystroke map (built-in override only; whole-map replace) |

\* Required for new agents; optional when overriding built-in agents.

Invoke-related fields (`invokeMode`, `errorRules`, `readyPattern`) are documented in [`docs/invoke.md`](docs/invoke.md).

Each `terminalRules` entry must define exactly one matcher:

- `matchAny`: matches when any string is present in the last 30 lines (case-insensitive)
- `matchAll`: matches only when every string is present in the last 30 lines (case-insensitive)

Rules are evaluated top-to-bottom, and the first match wins. This lets you express broad "working" prompts and more specific multi-line waiting prompts without detector-specific logic.

</details>

## 🏗️ Architecture

ccmux has three layers: agents running in tmux panes, a background daemon that observes them, and clients (TUI + CLI utilities) that consume daemon state over HTTP/SSE.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/system-overview-dark.svg">
  <img alt="ccmux system overview" src="./docs/system-overview-light.svg">
</picture>

The daemon merges three signals into one session state: log parsing for agents that write JSONL transcripts, terminal pattern matching for agents that don't, and PID marker files written by hook adapters for authoritative session-to-pane mapping. It exposes a local HTTP API with SSE streaming on port 2269. The TUI connects as an SSE client and renders state reactively using Solid.js via the [@opentui/solid](https://github.com/anomalyco/opentui) framework.

For deeper internals (status detection cascade, session-to-pane binding, hook event lifecycle, PR enrichment, background agents, code map), see [`docs/architecture.md`](./docs/architecture.md). Per-agent hook quirks and the agent-owned files ccmux reads are in [`docs/agent-adapters.md`](./docs/agent-adapters.md).

<details>
<summary><strong>Session states</strong></summary>

| State       | Meaning                                                 |
| :---------- | :------------------------------------------------------ |
| **idle**    | Waiting for user input                                  |
| **working** | Processing (thinking, running tools, subagents)         |
| **waiting** | Needs attention: permission, plan approval, or question |

The status machine derives state from JSONL log entries, tracks pending tool IDs for parallel tool calls, and checks process liveness to detect crashed sessions.

</details>

## 🔧 Development

```bash
bun install              # Install dependencies
bun run dev              # Run with --watch
bun run typecheck        # Type check
bun test                 # Run tests
bun run build            # Bundle to dist/index.js (consumed by the launcher)
```

### Performance Profiling

Set `CCMUX_PERF=1` to enable performance instrumentation:

```bash
CCMUX_PERF=1 ccmux picker 2>/tmp/ccmux-perf.log
```

This outputs a startup waterfall and periodic runtime stats (FPS, memo recomputes, active timers) to stderr.

## 📄 License

MIT
