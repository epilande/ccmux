/**
 * Bash templates for the four Cursor hook scripts installed by
 * `CursorHookAdapter.install()`. Mirrors the Codex style: render functions
 * returning plain strings, tested via snapshot + Bun.spawn execution.
 *
 * Contract — read before touching these scripts:
 *
 * - **Every failure path `exit 0` with empty stdout.** Cursor treats
 *   `exit 2` + stderr on any hook as a "deny the action" signal. Four
 *   events below (sessionStart/sessionEnd/beforeSubmitPrompt/stop) don't
 *   gate execution today, but keeping the contract uniform with Codex
 *   avoids surprises if we later add a preToolUse hook.
 *
 * - **No `set -e`.** A failing jq or ps in the middle must not abort the
 *   handler; the `|| exit 0` gates exist to swallow those failures and
 *   keep Cursor's own flow unblocked.
 *
 * - **$PPID is NOT cursor-agent.** Cursor invokes hook commands via
 *   `/bin/zsh -c '<command>'`, so `$PPID` points at the transient shell
 *   wrapper, not at the long-lived cursor-agent process. Storing the
 *   wrapper PID in the marker makes `cleanupStaleMarkers` purge it on
 *   the next scan (wrapper dies when the script returns). We walk up
 *   the ancestry to find the real cursor-agent: first a process whose
 *   `comm=` is cursor-agent or `agent`, else the first ancestor with a
 *   real controlling terminal. The comm match alone is NOT enough —
 *   cursor-agent 2026.08.25 reports `comm=MainThread` (node sets the
 *   thread name), so the name walk misses it and only the tty-bearing
 *   ancestor walk finds it (the agent runs foreground in its pane and
 *   owns the pane's pts, while the wrapper is tty-less). If both fail we
 *   fall back to `$PPID` — the marker self-cleans within a scan cycle,
 *   which is better than silently no-oping on a process-shape surprise.
 *
 * - **--resume does NOT fire sessionStart.** Cursor only emits
 *   sessionStart on fresh chats, not on `--resume`. So
 *   `beforeSubmitPrompt` and `stop` must CREATE the marker if it's
 *   missing (resumed chats are otherwise invisible to ccmux until the
 *   user manually exits and relaunches). Same identity fields as
 *   sessionStart, just with event-specific state.
 *
 * - **Payload uses snake_case.** `conversation_id`, `session_id`,
 *   `hook_event_name`, `prompt`, `transcript_path` — observed against
 *   cursor-agent 2026.04.17-787b533. `conversation_id` and `session_id`
 *   are identical UUIDs at every event; we key on `conversation_id`
 *   because `cursor-agent --resume <chatId>` matches that name.
 */

/**
 * Shared bash snippet: walks process ancestry from $PPID to find the
 * cursor-agent (or bare `agent`) PID. Sets $CURSOR_PID or exits 0.
 */
const CURSOR_PID_WALK = `# Walk up process tree from $PPID to find cursor-agent. $PPID is the
# transient /bin/zsh -c wrapper cursor spawns to invoke the hook, not the
# agent itself. Prefer an ancestor whose comm is cursor-agent/agent; but
# cursor-agent 2026.08.25 reports comm=MainThread, so also record the first
# ancestor with a real controlling terminal (the agent owns its pane's pts;
# the wrapper is tty-less). Falls back to $PPID if the walk finds nothing —
# the stale marker self-cleans on the next scan rather than silently no-opping.
CURSOR_PID=""
CURSOR_TTY_PID=""
WALK="$PPID"
for _ in 1 2 3 4 5 6 7 8; do
  [ -n "$WALK" ] || break
  [ "$WALK" = "1" ] && break
  [ "$WALK" = "0" ] && break
  COMM=$(ps -o comm= -p "$WALK" 2>/dev/null | tr -d ' ')
  case "$COMM" in
    cursor-agent|*/cursor-agent|agent|*/agent)
      CURSOR_PID="$WALK"
      break
      ;;
  esac
  if [ -z "$CURSOR_TTY_PID" ]; then
    WTTY=$(ps -o tty= -p "$WALK" 2>/dev/null | tr -d ' ')
    if [ -n "$WTTY" ] && [ "$WTTY" != "?" ]; then
      CURSOR_TTY_PID="$WALK"
    fi
  fi
  WALK=$(ps -o ppid= -p "$WALK" 2>/dev/null | tr -d ' ')
done
[ -n "$CURSOR_PID" ] || CURSOR_PID="$CURSOR_TTY_PID"
[ -n "$CURSOR_PID" ] || CURSOR_PID="$PPID"`;

/** sessionStart: writes the initial marker with state=idle. */
export function renderSessionStartScript(markersDir: string): string {
  return `#!/bin/bash
# ccmux Cursor sessionStart hook. Writes the PID marker so the daemon can
# bind this pane to the real conversation_id.
# Contract: exit 0 on every path, never write to stdout.
MARKERS_DIR="${markersDir}"
mkdir -p "$MARKERS_DIR" 2>/dev/null || exit 0

INPUT=$(cat)
eval "$(printf '%s' "$INPUT" | jq -r '
  @sh "CONVERSATION_ID=\\(.conversation_id // "")",
  @sh "TRANSCRIPT_PATH=\\(.transcript_path // "")"
' 2>/dev/null)"
[ -n "$CONVERSATION_ID" ] || exit 0

${CURSOR_PID_WALK}

MARKER_FILE="$MARKERS_DIR/cursor-$CONVERSATION_ID.json"
jq -nc \\
  --arg pid "$CURSOR_PID" \\
  --arg session_id "$CONVERSATION_ID" \\
  --arg transcript_path "$TRANSCRIPT_PATH" \\
  '{agent_type: "cursor", pid: ($pid|tonumber), session_id: $session_id, transcript_path: (if $transcript_path == "" then null else $transcript_path end), state: "idle", state_timestamp: now, timestamp: now}' \\
  > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null

exit 0
`;
}

/** sessionEnd: unlinks the marker. */
export function renderSessionEndScript(markersDir: string): string {
  return `#!/bin/bash
# ccmux Cursor sessionEnd hook. Unlinks the marker so cleanupStaleMarkers
# doesn't need to wait for PID death.
# Contract: exit 0 on every path, never write to stdout.
MARKERS_DIR="${markersDir}"

INPUT=$(cat)
CONVERSATION_ID=$(printf '%s' "$INPUT" | jq -r '.conversation_id // empty' 2>/dev/null)
[ -n "$CONVERSATION_ID" ] || exit 0

rm -f "$MARKERS_DIR/cursor-$CONVERSATION_ID.json" 2>/dev/null

exit 0
`;
}

/**
 * beforeSubmitPrompt: fires when the user submits a prompt. Flips state
 * to working, captures last_prompt (1KB cap). Creates marker if missing
 * (covers the --resume case where sessionStart never fires).
 */
export function renderBeforeSubmitPromptScript(markersDir: string): string {
  return `#!/bin/bash
# ccmux Cursor beforeSubmitPrompt hook. Flips state to working and
# records the last prompt (1KB cap). Creates marker if missing to cover
# --resume, which does NOT fire sessionStart.
# Contract: exit 0 on every path, never write to stdout.
MARKERS_DIR="${markersDir}"
mkdir -p "$MARKERS_DIR" 2>/dev/null || exit 0

INPUT=$(cat)
eval "$(printf '%s' "$INPUT" | jq -r '
  @sh "CONVERSATION_ID=\\(.conversation_id // "")",
  @sh "TRANSCRIPT_PATH=\\(.transcript_path // "")"
' 2>/dev/null)"
[ -n "$CONVERSATION_ID" ] || exit 0

# Extract and truncate the prompt separately. jq -r prints the raw string,
# head -c caps at 1024 bytes. Safe even if the prompt contains quotes or
# newlines because we pass it through jq --arg below.
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null | head -c 1024)

${CURSOR_PID_WALK}

MARKER_FILE="$MARKERS_DIR/cursor-$CONVERSATION_ID.json"
jq -nc \\
  --arg pid "$CURSOR_PID" \\
  --arg session_id "$CONVERSATION_ID" \\
  --arg transcript_path "$TRANSCRIPT_PATH" \\
  --arg prompt "$PROMPT" \\
  '{agent_type: "cursor", pid: ($pid|tonumber), session_id: $session_id, transcript_path: (if $transcript_path == "" then null else $transcript_path end), state: "working", state_timestamp: now, timestamp: now, last_prompt: (if $prompt == "" then null else $prompt end)}' \\
  > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null

exit 0
`;
}

/**
 * stop: fires at the end of every turn. Flips state to idle. Creates
 * marker if missing (covers --resume like beforeSubmitPrompt).
 */
export function renderStopScript(markersDir: string): string {
  return `#!/bin/bash
# ccmux Cursor stop hook. Flips state back to idle at turn completion.
# Creates marker if missing to cover --resume; beforeSubmitPrompt usually
# fires first so this path is rare but must not silently drop state.
# Contract: exit 0 on every path, never write to stdout.
MARKERS_DIR="${markersDir}"
mkdir -p "$MARKERS_DIR" 2>/dev/null || exit 0

INPUT=$(cat)
eval "$(printf '%s' "$INPUT" | jq -r '
  @sh "CONVERSATION_ID=\\(.conversation_id // "")",
  @sh "TRANSCRIPT_PATH=\\(.transcript_path // "")"
' 2>/dev/null)"
[ -n "$CONVERSATION_ID" ] || exit 0

${CURSOR_PID_WALK}

MARKER_FILE="$MARKERS_DIR/cursor-$CONVERSATION_ID.json"
jq -nc \\
  --arg pid "$CURSOR_PID" \\
  --arg session_id "$CONVERSATION_ID" \\
  --arg transcript_path "$TRANSCRIPT_PATH" \\
  '{agent_type: "cursor", pid: ($pid|tonumber), session_id: $session_id, transcript_path: (if $transcript_path == "" then null else $transcript_path end), state: "idle", state_timestamp: now, timestamp: now}' \\
  > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null

exit 0
`;
}
