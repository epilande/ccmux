/**
 * Bash templates for the three Claude hook scripts installed by
 * `ClaudeHookAdapter.install()`. The markers dir is resolved at hook RUNTIME
 * from `$CCMUX_HOME` (falling back to `$HOME/.config/ccmux`), mirroring the
 * daemon's `CCMUX_DIR` logic, so one installed hook serves both normal use
 * (CCMUX_HOME unset) and an isolated daemon (CCMUX_HOME set, e.g. the demo /
 * e2e recorder) with no reinstall. The scripts take no other parameters.
 */

/**
 * Shared bash snippet: resolves the real claude PID and TTY by walking process
 * ancestry from $PPID. Sets $CLAUDE_PID and $CLAUDE_TTY.
 *
 * $PPID is not always the claude process. On LINUX (observed on Claude Code
 * 2.1.250) hooks run from an intermediate `sh -c` wrapper, so $PPID is a
 * short-lived, tty-less shell; storing that pid gives the marker a DEAD pid and
 * a no-tty value, which `cleanupStaleMarkers` purges and no bind can rescue,
 * leaving the session invisible (installed hooks disable Claude pane-tracking).
 * On macOS the same version runs hooks directly, so $PPID IS the agent, the walk
 * matches at the first hop, and it is harmless there. Walk up from $PPID and
 * take the first process whose comm is claude, else the first with a real
 * controlling terminal: the agent runs foreground in its pane and owns the
 * pane's pts, while every wrapper above the hook is tty-less. Fall back to $PPID
 * so a process-shape surprise self-cleans within a scan cycle rather than
 * silently no-opping.
 */
const CLAUDE_PID_WALK = `CLAUDE_PID=""
CLAUDE_TTY=""
WALK="$PPID"
for _ in 1 2 3 4 5 6 7 8; do
  [ -n "$WALK" ] || break
  [ "$WALK" = "1" ] && break
  [ "$WALK" = "0" ] && break
  W_COMM=$(ps -o comm= -p "$WALK" 2>/dev/null | tr -d ' ')
  W_TTY=$(ps -o tty= -p "$WALK" 2>/dev/null | tr -d ' ')
  case "$W_COMM" in
    claude|*/claude)
      CLAUDE_PID="$WALK"; CLAUDE_TTY="$W_TTY"; break ;;
  esac
  # No controlling terminal prints "??" on macOS/BSD ps and "?" on Linux.
  case "$W_TTY" in
    ""|"?"|"??"|"-") ;;
    *) [ -z "$CLAUDE_PID" ] && { CLAUDE_PID="$WALK"; CLAUDE_TTY="$W_TTY"; } ;;
  esac
  WALK=$(ps -o ppid= -p "$WALK" 2>/dev/null | tr -d ' ')
done
[ -n "$CLAUDE_PID" ] || CLAUDE_PID="$PPID"
[ -n "$CLAUDE_TTY" ] || CLAUDE_TTY=$(ps -p "$PPID" -o tty= 2>/dev/null | tr -d ' ')
# Normalize every no-tty spelling to the marker's sentinel.
case "$CLAUDE_TTY" in
  ""|"?"|"??"|"-") CLAUDE_TTY="unknown" ;;
esac`;

export const SESSION_START_HOOK_SCRIPT = `#!/bin/bash
# Writes PID marker when Claude session starts/resumes
MARKERS_DIR="\${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids"
mkdir -p "$MARKERS_DIR"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -n "$SESSION_ID" ]; then
  ${CLAUDE_PID_WALK}

  # Clean up any existing marker for this PID (handles session switch in same terminal)
  for f in "$MARKERS_DIR"/*.json; do
    [ -f "$f" ] || continue
    if grep -q "\\"pid\\": *$CLAUDE_PID[^0-9]" "$f" 2>/dev/null; then
      rm -f "$f"
    fi
  done

  MARKER_FILE="$MARKERS_DIR/claude-$SESSION_ID.json"
  jq -nc \\
    --arg pid "$CLAUDE_PID" \\
    --arg tty "$CLAUDE_TTY" \\
    --arg session_id "$SESSION_ID" \\
    '{agent_type: "claude", pid: ($pid|tonumber), tty: $tty, session_id: $session_id, state: "idle", state_timestamp: now, timestamp: now}' \\
    > "$MARKER_FILE.tmp" && mv "$MARKER_FILE.tmp" "$MARKER_FILE"
fi
`;

export const SESSION_END_HOOK_SCRIPT = `#!/bin/bash
# Removes PID marker when Claude session closes
MARKERS_DIR="\${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids"
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -n "$SESSION_ID" ]; then
  rm -f "$MARKERS_DIR/claude-$SESSION_ID.json"
fi
`;

export const STATE_NOTIFY_HOOK_SCRIPT = `#!/bin/bash
# Updates session marker with current state from notifications
MARKERS_DIR="\${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids"
mkdir -p "$MARKERS_DIR"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.notification_type // empty')
MESSAGE=$(echo "$INPUT" | jq -r '.message // empty')

if [ -n "$SESSION_ID" ]; then
  MARKER_FILE="$MARKERS_DIR/claude-$SESSION_ID.json"

  case "$NOTIFICATION_TYPE" in
    "idle_prompt") STATE="idle" ;;
    "permission_prompt") STATE="waiting_permission" ;;
    *) exit 0 ;;
  esac

  # Claude does NOT write the permission-gated tool_use to the JSONL until
  # AFTER the user approves, so the Notification payload is the only
  # structured signal at prompt time. As of Claude Code 2.1.209 the message
  # is the generic "Claude needs your permission" with NO tool name, so this
  # parse yields nothing (the notifier reads the command from the pane, see
  # notify-context.ts); it's kept because some builds/contexts phrase it as
  # "...to use <Tool>". Fails open to empty so pending_tool is cleared
  # rather than left stale.
  PENDING_TOOL=$(printf '%s' "$MESSAGE" | sed -n 's/.*to use \\([A-Za-z0-9_][A-Za-z0-9_-]*\\).*/\\1/p')

  # Resolve the real claude PID/TTY for backfill (see CLAUDE_PID_WALK). $PPID
  # is a tty-less wrapper, so backfilling from it would re-introduce the dead
  # pid / "?" tty the session-start walk exists to avoid.
  ${CLAUDE_PID_WALK}

  if [ -f "$MARKER_FILE" ]; then
    # Update state; backfill PID/TTY if the marker was created without them
    # (e.g. state-notify fires before session-start on a racy session).
    jq --arg state "$STATE" --arg ts "$(date +%s)" \\
      --arg pid "$CLAUDE_PID" --arg tty "$CLAUDE_TTY" --arg tool "$PENDING_TOOL" \\
      '. + {state: $state, state_timestamp: ($ts|tonumber), pending_tool: (if $tool == "" then null else $tool end)} | if .pid == null then .pid = ($pid|tonumber) else . end | if .tty == null or .tty == "" then .tty = $tty else . end' \\
      "$MARKER_FILE" > "$MARKER_FILE.tmp" && mv "$MARKER_FILE.tmp" "$MARKER_FILE"
  else
    # Create new marker with full info
    jq -nc --arg state "$STATE" --arg ts "$(date +%s)" --arg sid "$SESSION_ID" \\
      --arg pid "$CLAUDE_PID" --arg tty "$CLAUDE_TTY" --arg tool "$PENDING_TOOL" \\
      '{agent_type: "claude", pid: ($pid|tonumber), tty: $tty, session_id: $sid, state: $state, state_timestamp: ($ts|tonumber), timestamp: ($ts|tonumber), pending_tool: (if $tool == "" then null else $tool end)}' \\
      > "$MARKER_FILE.tmp" && mv "$MARKER_FILE.tmp" "$MARKER_FILE"
  fi
fi
`;
