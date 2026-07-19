/**
 * Bash + JSON templates for the Copilot hook integration installed by
 * `CopilotHookAdapter.install()`. Kept as pure string-returning values so
 * tests can snapshot and shell-exec them without touching the real
 * `~/.copilot` layout.
 *
 * Contract — read before touching these:
 *
 * - **Every branch `exit 0` with empty stdout.** ccmux only registers
 *   OBSERVATIONAL Copilot hooks (`sessionStart`, `userPromptSubmitted`,
 *   `notification`, `agentStop`, `sessionEnd`). It NEVER registers
 *   `permissionRequest`, which is a DECIDING hook whose output can
 *   allow/deny a tool call. So no branch here can affect the user's flow.
 *
 * - **Payload fields are camelCase.** Copilot delivers one JSON object on
 *   stdin (`sessionId`, `cwd`, `initialPrompt`, `notification_type`,
 *   `message`, `title`, ...). The single script is dispatched per-event by
 *   its `$1` argument set in the hooks JSON.
 *
 * - **`$PPID` is the Copilot PID.** Copilot runs the hook command with the
 *   `copilot` process as its direct parent, so `ps -p $PPID -o tty=` yields
 *   the pane's tty in an interactive session (verified on v1.0.71).
 */

const SENTINEL = "# ccmux-copilot-hook v1";

/**
 * The single marker script, dispatched per event by its first argument
 * (`session-start` | `prompt` | `notification` | `stop` | `end`). Reads the
 * Copilot payload from stdin and writes/updates the ccmux marker via
 * tmp+rename, or removes it on `sessionEnd`.
 */
export const COPILOT_MARKER_SCRIPT = `#!/bin/bash
${SENTINEL}
# Dispatched per Copilot hook event by $1. Copilot passes the payload as one
# JSON object on stdin (camelCase fields). Contract: exit 0 on every path,
# empty stdout. The deciding permissionRequest hook is deliberately NOT
# registered, so nothing here can allow/deny a tool call.
EVENT="$1"
MARKERS_DIR="\${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids"
INPUT=$(cat 2>/dev/null) || INPUT=""
command -v jq >/dev/null 2>&1 || exit 0

# One jq spawn extracts every payload field we care about, shell-quoted via
# @sh so eval is injection-safe even on hostile values.
eval "$(printf '%s' "$INPUT" | jq -r '
  @sh "SESSION_ID=\\(.sessionId // "")",
  @sh "INITIAL_PROMPT=\\(.initialPrompt // "")",
  @sh "NOTIFY_TYPE=\\(.notification_type // "")",
  @sh "MESSAGE=\\(.message // "")"
' 2>/dev/null)"
[ -n "$SESSION_ID" ] || exit 0

MARKER_FILE="$MARKERS_DIR/copilot-$SESSION_ID.json"

# sessionEnd removes the marker outright.
if [ "$EVENT" = "end" ]; then
  rm -f "$MARKER_FILE" 2>/dev/null
  exit 0
fi

# Map the event to a marker state. A notification only counts when it is one
# of the two attention dialogs; every other notification_type is ignored.
STATE=""
PENDING_TOOL=""
PERMISSION_CTX=""
case "$EVENT" in
  session-start)
    if [ -n "$INITIAL_PROMPT" ]; then STATE="working"; else STATE="idle"; fi
    ;;
  prompt)
    STATE="working"
    ;;
  stop)
    STATE="idle"
    ;;
  notification)
    # Only the shell/tool approval dialog names a pending tool; an
    # elicitation (ask_user question) dialog is generic attention.
    if [ "$NOTIFY_TYPE" = "permission_prompt" ]; then
      STATE="waiting_permission"
      PENDING_TOOL="Command"
      PERMISSION_CTX="$MESSAGE"
    elif [ "$NOTIFY_TYPE" = "elicitation_dialog" ]; then
      STATE="waiting_permission"
      PERMISSION_CTX="$MESSAGE"
    else
      exit 0
    fi
    ;;
  *)
    exit 0
    ;;
esac
[ -n "$STATE" ] || exit 0

mkdir -p "$MARKERS_DIR" 2>/dev/null || exit 0
COPILOT_TTY=$(ps -p $PPID -o tty= 2>/dev/null | tr -d ' ')
TRANSCRIPT_PATH="\${COPILOT_HOME:-$HOME/.copilot}/session-state/$SESSION_ID/events.jsonl"
TS=$(date +%s 2>/dev/null) || TS=0

if [ "$EVENT" = "session-start" ] && [ -f "$MARKER_FILE" ]; then
  # Copilot can emit userPromptSubmitted BEFORE sessionStart (observed on
  # v1.0.71; interactive sessionStart is deferred to the first prompt). A
  # racing prompt/notification hook may have already written a fresher
  # state, so session-start on an existing marker refreshes identity only
  # and never touches state.
  jq --arg ts "$TS" --arg pid "$PPID" --arg tty "\${COPILOT_TTY:-unknown}" \\
    --arg transcript "$TRANSCRIPT_PATH" \\
    '. + {timestamp: ($ts|tonumber), transcript_path: $transcript} | if .pid == null then .pid = ($pid|tonumber) else . end | if .tty == null or .tty == "" then .tty = $tty else . end' \\
    "$MARKER_FILE" > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null || true
elif [ -f "$MARKER_FILE" ]; then
  jq --arg state "$STATE" --arg ts "$TS" --arg pid "$PPID" \\
    --arg tty "\${COPILOT_TTY:-unknown}" --arg tool "$PENDING_TOOL" --arg ctx "$PERMISSION_CTX" \\
    '. + {state: $state, state_timestamp: ($ts|tonumber), timestamp: ($ts|tonumber), pending_tool: (if $tool == "" then null else $tool end), permission_context: (if $ctx == "" then null else $ctx end)} | if .pid == null then .pid = ($pid|tonumber) else . end | if .tty == null or .tty == "" then .tty = $tty else . end' \\
    "$MARKER_FILE" > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null || true
else
  jq -nc --arg state "$STATE" --arg ts "$TS" --arg sid "$SESSION_ID" \\
    --arg pid "$PPID" --arg tty "\${COPILOT_TTY:-unknown}" --arg transcript "$TRANSCRIPT_PATH" \\
    --arg tool "$PENDING_TOOL" --arg ctx "$PERMISSION_CTX" \\
    '{agent_type: "copilot", pid: ($pid|tonumber), tty: $tty, session_id: $sid, transcript_path: $transcript, state: $state, state_timestamp: ($ts|tonumber), timestamp: ($ts|tonumber), pending_tool: (if $tool == "" then null else $tool end), permission_context: (if $ctx == "" then null else $ctx end)}' \\
    > "$MARKER_FILE.tmp" 2>/dev/null && mv "$MARKER_FILE.tmp" "$MARKER_FILE" 2>/dev/null || true
fi

exit 0
`;

/** Per-event → marker-script argument, in the order they are registered. */
const COPILOT_HOOK_EVENTS: Array<{ event: string; arg: string }> = [
  { event: "sessionStart", arg: "session-start" },
  { event: "userPromptSubmitted", arg: "prompt" },
  { event: "notification", arg: "notification" },
  { event: "agentStop", arg: "stop" },
  { event: "sessionEnd", arg: "end" },
];

const HOOK_TIMEOUT_SEC = 5;

interface CopilotHookHandler {
  type: "command";
  bash: string;
  timeoutSec: number;
}

export interface CopilotHooksFile {
  version: number;
  hooks: Record<string, CopilotHookHandler[]>;
}

/**
 * Build the ccmux Copilot hooks JSON object registering the observational
 * events against `scriptPath` (each event dispatches the script with its own
 * argument). Exported as a plain object so the adapter can serialize it and
 * tests can assert its shape.
 */
export function buildCopilotHooksFile(scriptPath: string): CopilotHooksFile {
  const hooks: Record<string, CopilotHookHandler[]> = {};
  for (const { event, arg } of COPILOT_HOOK_EVENTS) {
    hooks[event] = [
      {
        type: "command",
        bash: `${JSON.stringify(scriptPath)} ${arg}`,
        timeoutSec: HOOK_TIMEOUT_SEC,
      },
    ];
  }
  return { version: 1, hooks };
}

/** Serialized form written to `~/.copilot/hooks/ccmux-copilot.json`. */
export function renderCopilotHooksJson(scriptPath: string): string {
  return JSON.stringify(buildCopilotHooksFile(scriptPath), null, 2) + "\n";
}

/** The sentinel line every ccmux Copilot marker script carries. */
export const COPILOT_SCRIPT_SENTINEL = SENTINEL;
