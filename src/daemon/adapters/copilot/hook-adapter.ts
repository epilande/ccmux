import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { COPILOT_DIR } from "../../../lib/config";
import {
  COPILOT_MARKER_SCRIPT,
  COPILOT_SCRIPT_SENTINEL,
  renderCopilotHooksJson,
} from "./hook-scripts";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import { normalizeTty } from "../../pane-discovery";

const MARKER_SCRIPT = "ccmux-copilot.sh";
const HOOKS_JSON = "ccmux-copilot.json";

/**
 * GitHub Copilot CLI hook integration.
 *
 * Copilot auto-discovers `~/.copilot/hooks/*.json`, so ccmux drops in a
 * single hooks file (`ccmux-copilot.json`) plus its marker script
 * (`ccmux-copilot.sh`). Both are ccmux-owned and namespaced; the drop-in dir
 * is shared, so we never touch other files there or `~/.copilot/settings.json`.
 *
 * We register only OBSERVATIONAL events (`sessionStart`,
 * `userPromptSubmitted`, `notification`, `agentStop`, `sessionEnd`) and
 * deliberately never register `permissionRequest`, which is a DECIDING hook
 * whose output can allow/deny a tool call. Permission attention is observed
 * through the `notification` hook (`notification_type: permission_prompt` /
 * `elicitation_dialog`) instead.
 *
 * Like Codex, `onMarkerAdded` ENRICHES an existing pane-tracked session
 * (sets `nativeSessionId` + `logPath`, kicks the log watcher) rather than
 * creating a new one. Ongoing state transitions flow through the cascade
 * evaluator's generic marker + log sources, so no custom `onMarkerChanged`
 * is needed.
 */
export class CopilotHookAdapter implements HookAdapter {
  readonly agentType = "copilot";

  constructor(private readonly copilotDir = COPILOT_DIR) {}

  private get hooksDir(): string {
    return join(this.copilotDir, "hooks");
  }

  private get scriptPath(): string {
    return join(this.hooksDir, MARKER_SCRIPT);
  }

  private get hooksJsonPath(): string {
    return join(this.hooksDir, HOOKS_JSON);
  }

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    mkdirSync(this.hooksDir, { recursive: true });

    const script = this.scriptPath;
    if (
      existsSync(script) &&
      readFileSync(script, "utf-8") === COPILOT_MARKER_SCRIPT
    ) {
      lines.push(`Hook script already up to date: ${script}`);
    } else {
      const wasPresent = existsSync(script);
      writeFileSync(script, COPILOT_MARKER_SCRIPT);
      chmodSync(script, 0o755);
      lines.push(
        `${wasPresent ? "Updated" : "Created"} hook script: ${script}`,
      );
      changed = true;
    }

    const desired = renderCopilotHooksJson(script);
    const jsonPath = this.hooksJsonPath;
    if (existsSync(jsonPath) && readFileSync(jsonPath, "utf-8") === desired) {
      lines.push(`ccmux hooks already up to date in ${jsonPath}`);
    } else {
      const wasPresent = existsSync(jsonPath);
      writeFileSync(jsonPath, desired);
      lines.push(`${wasPresent ? "Updated" : "Created"} ${jsonPath}`);
      changed = true;
    }

    return { lines, changed };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;
    for (const path of [this.hooksJsonPath, this.scriptPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
        lines.push(`Removed ${path}`);
        changed = true;
      }
    }
    return { lines, changed };
  }

  isInstalled(): boolean {
    try {
      const parsed = JSON.parse(readFileSync(this.hooksJsonPath, "utf-8")) as {
        hooks?: Record<string, unknown>;
      };
      const serialized = JSON.stringify(parsed.hooks ?? {});
      return (
        serialized.includes(MARKER_SCRIPT) &&
        serialized.includes("sessionStart") &&
        serialized.includes("notification")
      );
    } catch {
      return false;
    }
  }

  describeInstallDetail(): string | null {
    return this.isInstalled()
      ? "(sessionStart, userPromptSubmitted, notification, agentStop, sessionEnd hooks)"
      : null;
  }

  describeInstallAnomalies(): string[] {
    if (!this.isInstalled()) return [];
    if (
      !existsSync(this.scriptPath) ||
      !readFileSync(this.scriptPath, "utf-8").includes(COPILOT_SCRIPT_SENTINEL)
    ) {
      return [
        `copilot: hook script missing or version-skewed at ${this.scriptPath}`,
      ];
    }
    return [];
  }

  isSessionStillLive(_marker: SessionPidMarker): boolean {
    // events.jsonl persists after the session ends, so it is not a liveness
    // signal. PID (and TTY) liveness owns Copilot marker cleanup.
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    // Copilot's pane-tracked session already exists from the daemon's
    // process scan; we enrich it with the real session id + transcript.
    // Markers carry a TTY (derived from $PPID in an interactive pane); fall
    // back to PID ancestry when the TTY is absent.
    const markerTty = normalizeTty(marker.tty);
    const panes = await ctx.listPanes();
    let pane = markerTty
      ? (panes.find((p) => normalizeTty(p.tty) === markerTty) ?? null)
      : null;
    pane ??= await ctx.getPaneHostingPid(marker.pid);
    if (!pane) return;

    const session = findPaneTrackedSession(ctx, this.agentType, pane.paneId);
    if (!session) return;

    // Marker-backed, so reclaim: a heuristic holder of this id is stripped
    // and the id re-routes here. A remaining conflict means a native row
    // owns it; skip enrichment rather than stranding this pane's log path on
    // the wrong row.
    if (
      ctx.sessionManager.setNativeSessionId(session.id, marker.session_id, {
        reclaim: true,
      }) === "conflict"
    ) {
      return;
    }
    if (marker.transcript_path) {
      ctx.sessionManager.setLogPath(session.id, marker.transcript_path);
      await ctx
        .getLogWatcher(this.agentType)
        ?.processPath(marker.transcript_path);
    }
  }

  async onMarkerRemoved(
    _marker: SessionPidMarker,
    _ctx: HookManagerContext,
  ): Promise<void> {
    // sessionEnd removes the marker; the cascade drops the marker source on
    // the next reconcile. No per-session teardown needed.
  }
}
