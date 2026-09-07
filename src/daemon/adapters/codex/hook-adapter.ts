import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  CODEX_CONFIG_FILE,
  CODEX_HOOKS_DIR,
  CODEX_HOOKS_FILE,
  MARKERS_DIR,
} from "../../../lib/config";
import {
  renderPermissionRequestScript,
  renderSessionStartScript,
  renderStopScript,
} from "./hook-scripts";
import { ensureCodexHooksEnabled, isCodexHooksEnabled } from "./toml";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import { normalizeTty } from "../../pane-discovery";

const SESSION_START_SCRIPT = "ccmux-session-start.sh";
const STOP_SCRIPT = "ccmux-stop.sh";
const PERMISSION_REQUEST_SCRIPT = "ccmux-permission-request.sh";

const HOOK_TIMEOUT_SEC = 1;

type CodexHookSlot = "SessionStart" | "Stop" | "PermissionRequest";

interface CodexHookHandlerConfig {
  type?: string;
  command?: string;
  timeoutSec?: number;
  [key: string]: unknown;
}

interface CodexMatcherGroup {
  matcher?: string;
  hooks?: CodexHookHandlerConfig[];
}

interface CodexHooksFile {
  hooks?: Partial<Record<CodexHookSlot, CodexMatcherGroup[]>> & {
    [key: string]: CodexMatcherGroup[] | undefined;
  };
  [key: string]: unknown;
}

/**
 * Codex-specific hook integration.
 *
 * Unlike Claude, Codex's `onMarkerAdded` *enriches* an existing pane-tracked
 * session (sets `nativeSessionId` + `logPath`, kicks the log watcher) rather
 * than creating a new one.
 *
 * `install()` targets three hook events:
 *
 *   SessionStart        (matcher "startup|resume|clear")
 *   Stop
 *   PermissionRequest
 *
 * `PermissionRequest` only fires on Codex >= 0.122; older versions ignore
 * the entry silently because `HooksFile` does not use
 * `#[serde(deny_unknown_fields)]`.
 *
 * `uninstall()` removes the ccmux-owned hooks.json entries and scripts
 * but deliberately leaves the codex hooks feature flag in `config.toml`
 * alone (either `[features] codex_hooks` pre-0.124 or `[features] hooks`
 * on 0.124+). The orphan flag is cosmetic (empty handler list = no
 * hooks fire); flipping it off would be a footgun for users who enabled
 * it independently of ccmux.
 */
export class CodexHookAdapter implements HookAdapter {
  readonly agentType = "codex";

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    mkdirSync(CODEX_HOOKS_DIR, { recursive: true });
    mkdirSync(MARKERS_DIR, { recursive: true });

    const scripts: Array<{ name: string; content: string }> = [
      {
        name: SESSION_START_SCRIPT,
        content: renderSessionStartScript(MARKERS_DIR),
      },
      { name: STOP_SCRIPT, content: renderStopScript(MARKERS_DIR) },
      {
        name: PERMISSION_REQUEST_SCRIPT,
        content: renderPermissionRequestScript(MARKERS_DIR),
      },
    ];
    for (const { name, content } of scripts) {
      const path = join(CODEX_HOOKS_DIR, name);
      writeFileSync(path, content);
      chmodSync(path, 0o755);
      lines.push(`Created hook script: ${path}`);
      changed = true;
    }

    const hooksFile = this.readHooksFile();
    if (existsSync(CODEX_HOOKS_FILE)) {
      const backupPath = `${CODEX_HOOKS_FILE}.backup`;
      copyFileSync(CODEX_HOOKS_FILE, backupPath);
      lines.push(`Backed up hooks to ${backupPath}`);
    }

    const entries: Array<{
      slot: CodexHookSlot;
      script: string;
      matcher?: string;
    }> = [
      {
        slot: "SessionStart",
        script: SESSION_START_SCRIPT,
        matcher: "startup|resume|clear",
      },
      { slot: "Stop", script: STOP_SCRIPT },
      {
        slot: "PermissionRequest",
        script: PERMISSION_REQUEST_SCRIPT,
      },
    ];

    let hooksChanged = false;
    for (const { slot, script, matcher } of entries) {
      const scriptPath = join(CODEX_HOOKS_DIR, script);
      if (ensureHookEntry(hooksFile, slot, matcher, scriptPath)) {
        hooksChanged = true;
        lines.push(`Added ${slot} hook to hooks.json`);
      } else {
        lines.push(`${slot} hook already installed in hooks.json`);
      }
    }
    if (hooksChanged) {
      writeFileSync(
        CODEX_HOOKS_FILE,
        JSON.stringify(hooksFile, null, 2) + "\n",
      );
      lines.push(`Updated ${CODEX_HOOKS_FILE}`);
      changed = true;
    }

    const currentConfig = existsSync(CODEX_CONFIG_FILE)
      ? readFileSync(CODEX_CONFIG_FILE, "utf-8")
      : "";
    if (isCodexHooksEnabled(currentConfig)) {
      lines.push(`Codex hooks feature already enabled in ${CODEX_CONFIG_FILE}`);
    } else {
      if (existsSync(CODEX_CONFIG_FILE)) {
        copyFileSync(CODEX_CONFIG_FILE, `${CODEX_CONFIG_FILE}.backup`);
        lines.push(`Backed up config to ${CODEX_CONFIG_FILE}.backup`);
      }
      writeFileSync(CODEX_CONFIG_FILE, ensureCodexHooksEnabled(currentConfig));
      lines.push(`Enabled the codex hooks feature in ${CODEX_CONFIG_FILE}`);
      changed = true;
    }

    return { lines, changed };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    if (existsSync(CODEX_HOOKS_FILE)) {
      const hooksFile = this.readHooksFile();
      let removed = false;
      for (const { slot, script } of [
        { slot: "SessionStart" as const, script: SESSION_START_SCRIPT },
        { slot: "Stop" as const, script: STOP_SCRIPT },
        {
          slot: "PermissionRequest" as const,
          script: PERMISSION_REQUEST_SCRIPT,
        },
      ]) {
        if (removeHookEntry(hooksFile, slot, script)) removed = true;
      }
      if (removed) {
        writeFileSync(
          CODEX_HOOKS_FILE,
          JSON.stringify(hooksFile, null, 2) + "\n",
        );
        lines.push(`Removed ccmux entries from ${CODEX_HOOKS_FILE}`);
        changed = true;
      }
    }

    for (const script of [
      SESSION_START_SCRIPT,
      STOP_SCRIPT,
      PERMISSION_REQUEST_SCRIPT,
    ]) {
      const path = join(CODEX_HOOKS_DIR, script);
      if (existsSync(path)) {
        unlinkSync(path);
        lines.push(`Removed ${path}`);
        changed = true;
      }
    }

    // Advisory: we never flip the codex hooks feature flag off because the
    // user may have enabled it independently (or, on Codex 0.124+, it's
    // default-on under the `hooks` name). Empty hooks.json entries mean no
    // handlers fire, so the orphan flag is cosmetic.
    lines.push(
      `Note: Codex hooks feature flag left as-is in ${CODEX_CONFIG_FILE}.`,
    );
    lines.push("Remove manually if you no longer want Codex hooks enabled.");

    return { lines, changed };
  }

  isInstalled(): boolean {
    if (!existsSync(CODEX_HOOKS_FILE)) return false;
    let hooksFile: CodexHooksFile;
    try {
      hooksFile = JSON.parse(readFileSync(CODEX_HOOKS_FILE, "utf-8"));
    } catch {
      return false;
    }
    const owned = ownedScriptPaths();
    for (const slot of ["SessionStart", "Stop", "PermissionRequest"] as const) {
      const groups = hooksFile.hooks?.[slot];
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (group.hooks?.some((h) => h.command && owned.has(h.command))) {
          return true;
        }
      }
    }
    return false;
  }

  describeInstallAnomalies(): string[] {
    const warnings: string[] = [];
    const flagEnabled = this.isFeatureFlagEnabled();
    const hooksInstalled = this.isInstalled();
    if (flagEnabled && !hooksInstalled) {
      warnings.push(
        "Codex: hooks feature is enabled in ~/.codex/config.toml but ccmux hook scripts are not installed. Run `ccmux setup` to enable rich Codex session tracking.",
      );
    } else if (!flagEnabled && hooksInstalled) {
      warnings.push(
        "Codex: ccmux hook scripts are installed but the hooks feature is not enabled in [features] (Codex 0.124+ uses `hooks`, older versions use `codex_hooks`). Hooks will not fire. Re-run `ccmux setup` or enable the flag manually in ~/.codex/config.toml.",
      );
    }
    return warnings;
  }

  isSessionStillLive(marker: SessionPidMarker): boolean {
    // Treat a transcript-less marker as fresh (Codex fires SessionStart
    // slightly before writing the rollout file). Once transcript_path is
    // recorded, its disappearance means Codex cleaned up the session.
    if (!marker.transcript_path) return true;
    return existsSync(marker.transcript_path);
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    // Unlike Claude (where a marker CREATES a hook-tracked session),
    // Codex's pane-tracked session already exists from the daemon's
    // process scan. We enrich it with the real session_id + transcript.
    //
    // Race to be aware of: on daemon-startup replay (HookManager.start)
    // the pane-tracked session may not exist yet because the first scan
    // runs afterwards. In that case we no-op; the daemon's
    // `enrichUnlinkedCodexSessionsFromMarkers` retries on each scan
    // cycle, so the state converges by the next scan.
    const markerTty = normalizeTty(marker.tty);
    if (!markerTty) return;

    const panes = await ctx.listPanes();
    const pane = panes.find((p) => normalizeTty(p.tty) === markerTty);
    if (!pane) return;

    const session = findPaneTrackedSession(ctx, this.agentType, pane.paneId);
    if (!session) return;

    // Marker-backed, so reclaim: a heuristic holder of this id
    // (e.g. the rollout fallback picking the wrong same-cwd rollout) is
    // stripped and the id re-routes here. A remaining conflict means a
    // native row owns the id; skip the transcript enrichment below or we
    // would strand this pane's log path + parsed state on the wrong row
    // (a "noop" re-fire still proceeds).
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
    // Codex has no SessionEnd hook, so marker removal is purely driven
    // by `cleanupStaleMarkers`. No per-session teardown needed.
  }

  private readHooksFile(): CodexHooksFile {
    if (!existsSync(CODEX_HOOKS_FILE)) return {};
    try {
      return JSON.parse(readFileSync(CODEX_HOOKS_FILE, "utf-8"));
    } catch {
      return {};
    }
  }

  private isFeatureFlagEnabled(): boolean {
    if (!existsSync(CODEX_CONFIG_FILE)) return false;
    try {
      return isCodexHooksEnabled(readFileSync(CODEX_CONFIG_FILE, "utf-8"));
    } catch {
      return false;
    }
  }
}

function ownedScriptPaths(): Set<string> {
  return new Set([
    join(CODEX_HOOKS_DIR, SESSION_START_SCRIPT),
    join(CODEX_HOOKS_DIR, STOP_SCRIPT),
    join(CODEX_HOOKS_DIR, PERMISSION_REQUEST_SCRIPT),
  ]);
}

function ensureHookEntry(
  hooksFile: CodexHooksFile,
  slot: CodexHookSlot,
  matcher: string | undefined,
  scriptPath: string,
): boolean {
  hooksFile.hooks = hooksFile.hooks ?? {};
  const groups = (hooksFile.hooks[slot] = hooksFile.hooks[slot] ?? []);
  const already = groups.some((g) =>
    g.hooks?.some((h) => h.command === scriptPath),
  );
  if (already) return false;
  const entry: CodexMatcherGroup = {
    ...(matcher ? { matcher } : {}),
    hooks: [
      { type: "command", command: scriptPath, timeoutSec: HOOK_TIMEOUT_SEC },
    ],
  };
  groups.push(entry);
  return true;
}

function removeHookEntry(
  hooksFile: CodexHooksFile,
  slot: CodexHookSlot,
  scriptName: string,
): boolean {
  if (!hooksFile.hooks?.[slot]) return false;
  let changed = false;
  const after = hooksFile.hooks[slot]!.map((group) => {
    const originalHooks = group.hooks ?? [];
    const filtered = originalHooks.filter(
      (h) => !h.command?.endsWith(`/${scriptName}`),
    );
    if (filtered.length !== originalHooks.length) changed = true;
    return { ...group, hooks: filtered };
  }).filter((group) => (group.hooks?.length ?? 0) > 0);
  hooksFile.hooks[slot] = after;
  if (after.length === 0) delete hooksFile.hooks[slot];
  if (hooksFile.hooks && Object.keys(hooksFile.hooks).length === 0) {
    delete hooksFile.hooks;
  }
  return changed;
}
