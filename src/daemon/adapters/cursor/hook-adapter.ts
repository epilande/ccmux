import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  CURSOR_HOOKS_DIR,
  CURSOR_HOOKS_FILE,
  MARKERS_DIR,
} from "../../../lib/config";
import {
  renderBeforeSubmitPromptScript,
  renderSessionEndScript,
  renderSessionStartScript,
  renderStopScript,
} from "./hook-scripts";
import {
  cursorVersionMeetsHookRequirement,
  MIN_CURSOR_VERSION,
} from "./version";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import type { SessionState, SessionStatus } from "../../../types/session";

const SESSION_START_SCRIPT = "ccmux-session-start.sh";
const SESSION_END_SCRIPT = "ccmux-session-end.sh";
const BEFORE_SUBMIT_PROMPT_SCRIPT = "ccmux-before-submit-prompt.sh";
const STOP_SCRIPT = "ccmux-stop.sh";

type CursorHookEvent =
  | "sessionStart"
  | "sessionEnd"
  | "beforeSubmitPrompt"
  | "stop";

/**
 * Cursor's hooks.json schema is flatter than Codex's: each event name maps
 * to a plain array of `{command, type}` entries. No matcher groups. The
 * `version` field is user-authored (documented schema versioning) and must
 * be preserved across install/uninstall.
 */
interface CursorHookEntry {
  command?: string;
  type?: string;
  [key: string]: unknown;
}

interface CursorHooksFile {
  version?: number;
  hooks?: Partial<Record<CursorHookEvent, CursorHookEntry[]>> & {
    [key: string]: CursorHookEntry[] | undefined;
  };
  [key: string]: unknown;
}

const HOOK_ENTRIES: Array<{ event: CursorHookEvent; script: string }> = [
  { event: "sessionStart", script: SESSION_START_SCRIPT },
  { event: "sessionEnd", script: SESSION_END_SCRIPT },
  { event: "beforeSubmitPrompt", script: BEFORE_SUBMIT_PROMPT_SCRIPT },
  { event: "stop", script: STOP_SCRIPT },
];

/**
 * Cursor CLI hook integration.
 *
 * Unlike Claude and Codex, Cursor's hooks fire through a `/bin/zsh -c`
 * wrapper, so the hook scripts walk the process ancestry to find the
 * real cursor-agent PID (see `hook-scripts.ts:CURSOR_PID_WALK`). Pane
 * correlation is PID-ancestry via `getPaneHostingPid` — the same
 * pattern OpenCode uses — because the payload carries no TTY.
 *
 * `install()`:
 *   - Writes four scripts to ~/.cursor/hooks/ccmux-*.sh
 *   - Merges four entries into ~/.cursor/hooks.json under sessionStart,
 *     sessionEnd, beforeSubmitPrompt, and stop. Preserves user-authored
 *     entries and the top-level `version` field.
 *   - Errors if `cursor-agent` is missing from PATH.
 *   - Warns (does not block) if version is older than MIN_CURSOR_VERSION
 *     because old Cursor silently ignores unknown hook entries.
 *
 * `uninstall()` removes only entries whose `command` matches our exact
 * install-written paths; unrelated entries (including unrelated ccmux-
 * prefixed ones) are left alone.
 */
export class CursorHookAdapter implements HookAdapter {
  readonly agentType = "cursor";

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    const versionCheck = await cursorVersionMeetsHookRequirement();
    if (!versionCheck.ok && versionCheck.detected === null) {
      throw new Error(
        versionCheck.error ??
          "cursor-agent not on PATH. Install from https://cursor.sh and re-run `ccmux setup --agent cursor`.",
      );
    }
    if (!versionCheck.ok && versionCheck.detected) {
      lines.push(
        `Warning: cursor-agent ${versionCheck.detected} is older than required ${MIN_CURSOR_VERSION.join(".")}. Hooks were introduced in that release; older Cursor silently ignores hooks.json entries.`,
      );
    }

    mkdirSync(CURSOR_HOOKS_DIR, { recursive: true });
    mkdirSync(MARKERS_DIR, { recursive: true });

    const scripts: Array<{ name: string; content: string }> = [
      {
        name: SESSION_START_SCRIPT,
        content: renderSessionStartScript(MARKERS_DIR),
      },
      {
        name: SESSION_END_SCRIPT,
        content: renderSessionEndScript(MARKERS_DIR),
      },
      {
        name: BEFORE_SUBMIT_PROMPT_SCRIPT,
        content: renderBeforeSubmitPromptScript(MARKERS_DIR),
      },
      { name: STOP_SCRIPT, content: renderStopScript(MARKERS_DIR) },
    ];
    for (const { name, content } of scripts) {
      const path = join(CURSOR_HOOKS_DIR, name);
      writeFileSync(path, content);
      chmodSync(path, 0o755);
      lines.push(`Created hook script: ${path}`);
      changed = true;
    }

    const hooksFile = this.readHooksFile();
    let hooksChanged = false;
    hooksFile.hooks = hooksFile.hooks ?? {};
    for (const { event, script } of HOOK_ENTRIES) {
      const scriptPath = join(CURSOR_HOOKS_DIR, script);
      if (ensureHookEntry(hooksFile, event, scriptPath)) {
        hooksChanged = true;
        lines.push(`Added ${event} hook to hooks.json`);
      } else {
        lines.push(`${event} hook already installed in hooks.json`);
      }
    }

    if (hooksChanged) {
      if (hooksFile.version === undefined) {
        hooksFile.version = 1;
      }
      writeFileSync(
        CURSOR_HOOKS_FILE,
        JSON.stringify(hooksFile, null, 2) + "\n",
      );
      lines.push(`Updated ${CURSOR_HOOKS_FILE}`);
      changed = true;
    }

    return { lines, changed };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    if (existsSync(CURSOR_HOOKS_FILE)) {
      const hooksFile = this.readHooksFile();
      let removed = false;
      for (const { event, script } of HOOK_ENTRIES) {
        const scriptPath = join(CURSOR_HOOKS_DIR, script);
        if (removeHookEntry(hooksFile, event, scriptPath)) removed = true;
      }
      if (removed) {
        writeFileSync(
          CURSOR_HOOKS_FILE,
          JSON.stringify(hooksFile, null, 2) + "\n",
        );
        lines.push(`Removed ccmux entries from ${CURSOR_HOOKS_FILE}`);
        changed = true;
      }
    }

    for (const { script } of HOOK_ENTRIES) {
      const path = join(CURSOR_HOOKS_DIR, script);
      if (existsSync(path)) {
        unlinkSync(path);
        lines.push(`Removed ${path}`);
        changed = true;
      }
    }

    return { lines, changed };
  }

  isInstalled(): boolean {
    if (!existsSync(CURSOR_HOOKS_FILE)) return false;
    let hooksFile: CursorHooksFile;
    try {
      hooksFile = JSON.parse(readFileSync(CURSOR_HOOKS_FILE, "utf-8"));
    } catch {
      return false;
    }
    const owned = ownedScriptPaths();
    for (const { event } of HOOK_ENTRIES) {
      const entries = hooksFile.hooks?.[event];
      if (!Array.isArray(entries)) continue;
      if (entries.some((h) => h.command && owned.has(h.command))) {
        return true;
      }
    }
    return false;
  }

  async describeInstallAnomalies(): Promise<string[]> {
    const warnings: string[] = [];
    const versionCheck = await cursorVersionMeetsHookRequirement();
    if (!versionCheck.ok && versionCheck.detected === null) {
      warnings.push(
        "Cursor: cursor-agent is not on PATH. Install from https://cursor.sh to activate the hook integration (existing ccmux hook scripts are harmless without it).",
      );
    } else if (!versionCheck.ok && versionCheck.detected) {
      warnings.push(
        `Cursor: cursor-agent ${versionCheck.detected} is older than required ${MIN_CURSOR_VERSION.join(".")}. Older releases silently ignore hook entries; ccmux session tracking will be disabled until you upgrade.`,
      );
    }
    return warnings;
  }

  // SQLite store is persistent by design; we never evict based on it.
  // PID liveness in cleanupStaleMarkers is authoritative.
  isSessionStillLive(_marker: SessionPidMarker): boolean {
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    const session = await findTargetSession(marker.pid, ctx, this.agentType);
    if (!session) return;

    // Marker-backed, so reclaim: a heuristic holder of this id
    // is stripped and the id re-routes here. A remaining conflict means a
    // native row owns the id; skip the marker-derived state update or we
    // would apply a foreign session's state to this row (a "noop" re-fire
    // still proceeds).
    if (
      ctx.sessionManager.setNativeSessionId(session.id, marker.session_id, {
        reclaim: true,
      }) === "conflict"
    ) {
      return;
    }
    ctx.sessionManager.updateSession(session.id, stateFromCursorMarker(marker));
    // Cursor has no registered LogAdapter, so this only makes the transcript
    // path visible to consumers that check for one themselves (fork's
    // {path} template, ccmux show); it does not add a cascade log source
    // (that's keyed on a registered adapter, not mere logPath presence).
    // Existence-checked because the marker's value is unparsed input.
    if (marker.transcript_path && existsSync(marker.transcript_path)) {
      ctx.sessionManager.setLogPath(session.id, marker.transcript_path);
    }
  }

  async onMarkerRemoved(
    _marker: SessionPidMarker,
    _ctx: HookManagerContext,
  ): Promise<void> {
    // No teardown needed: when cursor-agent exits, the process scan
    // clears the session and cleanupStaleMarkers reaps the marker. The
    // sessionEnd hook removes the marker but the pane-tracked session
    // persists until cursor-agent's PID is actually gone.
  }

  private readHooksFile(): CursorHooksFile {
    if (!existsSync(CURSOR_HOOKS_FILE)) return {};
    try {
      return JSON.parse(readFileSync(CURSOR_HOOKS_FILE, "utf-8"));
    } catch {
      return {};
    }
  }
}

async function findTargetSession(
  pid: number,
  ctx: HookManagerContext,
  agentType: string,
): Promise<{ id: string } | null> {
  const pane = await ctx.getPaneHostingPid(pid);
  if (!pane) return null;
  const session = findPaneTrackedSession(ctx, agentType, pane.paneId);
  return session ? { id: session.id } : null;
}

/**
 * Map a cursor marker into the SessionState fields the adapter owns.
 * Distinct from the shared `genericMarkerSource` (cascade-evaluator.ts)
 * which produces a CascadeState; this writes adapter-side state
 * directly and is the path that handles `state === "working"` emitted
 * by cursor's beforeSubmitPrompt hook.
 */
function stateFromCursorMarker(
  marker: SessionPidMarker,
): Partial<SessionState> {
  const status: SessionStatus = marker.state === "working" ? "working" : "idle";
  return {
    status,
    attentionType: null,
    pendingTool: null,
    lastPrompt: marker.last_prompt,
    lastActivityAt: marker.state_timestamp
      ? new Date(marker.state_timestamp * 1000).toISOString()
      : undefined,
  };
}

function ownedScriptPaths(): Set<string> {
  return new Set(
    HOOK_ENTRIES.map(({ script }) => join(CURSOR_HOOKS_DIR, script)),
  );
}

function ensureHookEntry(
  hooksFile: CursorHooksFile,
  event: CursorHookEvent,
  scriptPath: string,
): boolean {
  hooksFile.hooks = hooksFile.hooks ?? {};
  const entries = (hooksFile.hooks[event] = hooksFile.hooks[event] ?? []);
  if (entries.some((h) => h.command === scriptPath)) return false;
  entries.push({ command: scriptPath, type: "command" });
  return true;
}

function removeHookEntry(
  hooksFile: CursorHooksFile,
  event: CursorHookEvent,
  scriptPath: string,
): boolean {
  const entries = hooksFile.hooks?.[event];
  if (!Array.isArray(entries)) return false;
  const filtered = entries.filter((h) => h.command !== scriptPath);
  if (filtered.length === entries.length) return false;
  if (filtered.length === 0) {
    delete hooksFile.hooks![event];
    if (Object.keys(hooksFile.hooks!).length === 0) delete hooksFile.hooks;
  } else {
    hooksFile.hooks![event] = filtered;
  }
  return true;
}
