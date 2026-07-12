function markerScript(state: "working" | "idle"): string {
  return `#!/bin/bash
# ccmux-antigravity-hook v1
# Antigravity passes the full parent environment to hooks. Never print it.
MARKERS_DIR="\${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids"
INPUT=$(cat 2>/dev/null) || INPUT=""

if command -v jq >/dev/null 2>&1; then
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.conversationId // empty' 2>/dev/null) || SESSION_ID=""
  TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcriptPath // empty' 2>/dev/null) || TRANSCRIPT_PATH=""
  if [ -n "$SESSION_ID" ]; then
    mkdir -p "$MARKERS_DIR" 2>/dev/null || true
    AGY_TTY=$(ps -p $PPID -o tty= 2>/dev/null | tr -d ' ') || AGY_TTY=""
    MARKER_FILE="$MARKERS_DIR/antigravity-$SESSION_ID.json"
    TS=$(date +%s 2>/dev/null) || TS=0
    if [ -f "$MARKER_FILE" ]; then
      jq --arg state "${state}" --arg ts "$TS" --arg pid "$PPID" \\
        --arg tty "\${AGY_TTY:-unknown}" --arg transcript "$TRANSCRIPT_PATH" \\
        '. + {state: $state, state_timestamp: ($ts|tonumber), timestamp: ($ts|tonumber)} | if .pid == null then .pid = ($pid|tonumber) else . end | if .tty == null or .tty == "" then .tty = $tty else . end | if $transcript != "" then .transcript_path = $transcript else . end' \\
        "$MARKER_FILE" > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null || true
    else
      jq -nc --arg state "${state}" --arg ts "$TS" --arg sid "$SESSION_ID" \\
        --arg pid "$PPID" --arg tty "\${AGY_TTY:-unknown}" --arg transcript "$TRANSCRIPT_PATH" \\
        '{agent_type: "antigravity", pid: ($pid|tonumber), tty: $tty, session_id: $sid, state: $state, state_timestamp: ($ts|tonumber), timestamp: ($ts|tonumber)} | if $transcript != "" then .transcript_path = $transcript else . end' \\
        > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null || true
    fi
  fi
fi

echo '{}'
exit 0
`;
}

export const PREINVOCATION_HOOK_SCRIPT = markerScript("working");
export const STOP_HOOK_SCRIPT = markerScript("idle");
