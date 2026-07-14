/**
 * Bash templates for the three Claude hook scripts installed by
 * `ClaudeHookAdapter.install()`. The markers dir is resolved at hook RUNTIME
 * from `$CCMUX_HOME` (falling back to `$HOME/.config/ccmux`), mirroring the
 * daemon's `CCMUX_DIR` logic, so one installed hook serves both normal use
 * (CCMUX_HOME unset) and an isolated daemon (CCMUX_HOME set, e.g. the demo /
 * e2e recorder) with no reinstall. The scripts take no other parameters.
 */

export const SESSION_START_HOOK_SCRIPT = `#!/bin/bash
# Writes PID marker when Claude session starts/resumes
MARKERS_DIR="\${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids"
mkdir -p "$MARKERS_DIR"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

if [ -n "$SESSION_ID" ]; then
  # Get TTY from parent process (Claude), not from this subprocess
  # The 'tty' command fails in hook context because it runs in a non-TTY subprocess
  CLAUDE_TTY=$(ps -p $PPID -o tty= 2>/dev/null | tr -d ' ')

  # Clean up any existing marker for this PID (handles session switch in same terminal)
  for f in "$MARKERS_DIR"/*.json; do
    [ -f "$f" ] || continue
    if grep -q "\\"pid\\": *$PPID[^0-9]" "$f" 2>/dev/null; then
      rm -f "$f"
    fi
  done

  MARKER_FILE="$MARKERS_DIR/claude-$SESSION_ID.json"
  jq -nc \\
    --arg pid "$PPID" \\
    --arg tty "\${CLAUDE_TTY:-unknown}" \\
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
  # AFTER the user approves, so the transcript is empty about the pending
  # tool during the wait. The Notification payload is the only structured
  # signal at prompt time. NOTE: as of Claude Code 2.1.209 the permission
  # message is the generic "Claude needs your permission" with NO tool name,
  # so this parse yields nothing and pending_tool stays null (the notifier
  # instead reads the command from the pane, see notify-context.ts). The
  # parse is kept as future-proofing: some builds/contexts phrase it as
  # "...to use <Tool>", in which case we capture the token after "to use ".
  # Fails open to empty (idle_prompt and the generic message both yield
  # nothing) so pending_tool is cleared rather than left stale.
  PENDING_TOOL=$(printf '%s' "$MESSAGE" | sed -n 's/.*to use \\([A-Za-z0-9_][A-Za-z0-9_-]*\\).*/\\1/p')

  # Get TTY from parent process (Claude) for backfill
  CLAUDE_TTY=$(ps -p $PPID -o tty= 2>/dev/null | tr -d ' ')

  if [ -f "$MARKER_FILE" ]; then
    # Update state; backfill PID/TTY if the marker was created without them
    # (e.g. state-notify fires before session-start on a racy session).
    jq --arg state "$STATE" --arg ts "$(date +%s)" \\
      --arg pid "$PPID" --arg tty "\${CLAUDE_TTY:-unknown}" --arg tool "$PENDING_TOOL" \\
      '. + {state: $state, state_timestamp: ($ts|tonumber), pending_tool: (if $tool == "" then null else $tool end)} | if .pid == null then .pid = ($pid|tonumber) else . end | if .tty == null or .tty == "" then .tty = $tty else . end' \\
      "$MARKER_FILE" > "$MARKER_FILE.tmp" && mv "$MARKER_FILE.tmp" "$MARKER_FILE"
  else
    # Create new marker with full info
    jq -nc --arg state "$STATE" --arg ts "$(date +%s)" --arg sid "$SESSION_ID" \\
      --arg pid "$PPID" --arg tty "\${CLAUDE_TTY:-unknown}" --arg tool "$PENDING_TOOL" \\
      '{agent_type: "claude", pid: ($pid|tonumber), tty: $tty, session_id: $sid, state: $state, state_timestamp: ($ts|tonumber), timestamp: ($ts|tonumber), pending_tool: (if $tool == "" then null else $tool end)}' \\
      > "$MARKER_FILE.tmp" && mv "$MARKER_FILE.tmp" "$MARKER_FILE"
  fi
fi
`;
