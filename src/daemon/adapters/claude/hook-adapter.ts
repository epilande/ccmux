import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { MARKERS_DIR, resolveClaudeConfigDirs } from "../../../lib/config";
import { getPreferences, getPreferencesSync } from "../../../lib/preferences";
import {
  SESSION_END_HOOK_SCRIPT,
  SESSION_START_HOOK_SCRIPT,
  STATE_NOTIFY_HOOK_SCRIPT,
} from "./hook-scripts";
import type {
  HookAdapter,
  HookAdapterOutcome,
  HookManagerContext,
} from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";

/** Per-config-dir paths ccmux reads/writes for Claude hook integration. */
function hooksDirFor(configDir: string): string {
  return join(configDir, "hooks");
}
function settingsFileFor(configDir: string): string {
  return join(configDir, "settings.json");
}

const SESSION_START_SCRIPT = "ccmux-session-start.sh";
const SESSION_END_SCRIPT = "ccmux-session-end.sh";
const STATE_NOTIFY_SCRIPT = "ccmux-state-notify.sh";

interface HookConfig {
  type: string;
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookConfig[];
}

interface ClaudeSettings {
  hooks?: {
    SessionStart?: HookMatcher[];
    SessionEnd?: HookMatcher[];
    Notification?: HookMatcher[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Claude-specific hook integration. Owns install/uninstall of hook scripts
 * and settings.json entries, JSONL-based liveness checks, and delegation of
 * marker add/remove events to the Claude `LogWatcher`.
 */
export class ClaudeHookAdapter implements HookAdapter {
  readonly agentType = "claude";

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    mkdirSync(MARKERS_DIR, { recursive: true });

    // Fan out across every configured Claude config dir so a second account
    // (via CLAUDE_CONFIG_DIR / the `claudeConfigDirs` preference) gets hooks
    // too, not just the default ~/.claude.
    const configDirs = resolveClaudeConfigDirs(
      (await getPreferences()).claudeConfigDirs,
    );
    for (const dir of configDirs) {
      changed = this.installIntoDir(dir, lines) || changed;
    }

    return { lines, changed };
  }

  private installIntoDir(configDir: string, lines: string[]): boolean {
    let changed = false;
    const hooksDir = hooksDirFor(configDir);
    const settingsFile = settingsFileFor(configDir);

    mkdirSync(hooksDir, { recursive: true });

    const scripts = [
      { name: SESSION_START_SCRIPT, content: SESSION_START_HOOK_SCRIPT },
      { name: SESSION_END_SCRIPT, content: SESSION_END_HOOK_SCRIPT },
      { name: STATE_NOTIFY_SCRIPT, content: STATE_NOTIFY_HOOK_SCRIPT },
    ] as const;
    for (const { name, content } of scripts) {
      const path = join(hooksDir, name);
      const existed = existsSync(path);
      const current = existed ? readFileSync(path, "utf-8") : null;
      if (current === content) {
        lines.push(`Hook script already up to date: ${path}`);
        continue;
      }
      writeFileSync(path, content);
      chmodSync(path, 0o755);
      lines.push(`${existed ? "Updated" : "Created"} hook script: ${path}`);
      changed = true;
    }

    let settings: ClaudeSettings = {};
    const settingsExisted = existsSync(settingsFile);
    if (settingsExisted) {
      settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    }

    const hookSlots: Array<{
      slot: "SessionStart" | "SessionEnd" | "Notification";
      matcher: string;
      script: string;
    }> = [
      { slot: "SessionStart", matcher: "", script: SESSION_START_SCRIPT },
      { slot: "SessionEnd", matcher: "", script: SESSION_END_SCRIPT },
      {
        slot: "Notification",
        matcher: "idle_prompt|permission_prompt",
        script: STATE_NOTIFY_SCRIPT,
      },
    ];

    let settingsChanged = false;
    for (const { slot, matcher, script } of hookSlots) {
      const added = ensureHook(
        settings,
        slot,
        matcher,
        join(hooksDir, script),
        lines,
      );
      settingsChanged ||= added;
    }

    if (settingsChanged) {
      if (settingsExisted) {
        const backupPath = `${settingsFile}.backup`;
        copyFileSync(settingsFile, backupPath);
        lines.push(`Backed up settings to ${backupPath}`);
      }
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
      lines.push(`Updated ${settingsFile}`);
      changed = true;
    }

    return changed;
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    const configDirs = resolveClaudeConfigDirs(
      (await getPreferences()).claudeConfigDirs,
    );
    for (const dir of configDirs) {
      changed = this.uninstallFromDir(dir, lines) || changed;
    }

    if (existsSync(MARKERS_DIR)) {
      let removed = 0;
      for (const entry of readdirSync(MARKERS_DIR)) {
        if (!entry.startsWith("claude-") || !entry.endsWith(".json")) continue;
        try {
          unlinkSync(join(MARKERS_DIR, entry));
          removed += 1;
        } catch {
          // best-effort; next daemon sweep will catch stragglers
        }
      }
      if (removed > 0) {
        lines.push(`Removed ${removed} claude marker(s) from ${MARKERS_DIR}`);
        changed = true;
      }
    }

    return { lines, changed };
  }

  private uninstallFromDir(configDir: string, lines: string[]): boolean {
    let changed = false;
    const settingsFile = settingsFileFor(configDir);
    const hooksDir = hooksDirFor(configDir);

    if (existsSync(settingsFile)) {
      const settings: ClaudeSettings = JSON.parse(
        readFileSync(settingsFile, "utf-8"),
      );

      const removedStart = removeHook(
        settings,
        "SessionStart",
        SESSION_START_SCRIPT,
      );
      const removedEnd = removeHook(settings, "SessionEnd", SESSION_END_SCRIPT);
      const removedNotify = removeHook(
        settings,
        "Notification",
        STATE_NOTIFY_SCRIPT,
      );
      const removed = removedStart || removedEnd || removedNotify;

      if (settings.hooks && Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }

      if (removed) {
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        lines.push(`Removed hooks from ${settingsFile}`);
        changed = true;
      }
    }

    for (const script of [
      SESSION_START_SCRIPT,
      SESSION_END_SCRIPT,
      STATE_NOTIFY_SCRIPT,
    ]) {
      const scriptPath = join(hooksDir, script);
      if (existsSync(scriptPath)) {
        unlinkSync(scriptPath);
        lines.push(`Removed ${scriptPath}`);
        changed = true;
      }
    }

    return changed;
  }

  // Installed status tracks the primary `~/.claude` dir, which drives the
  // daemon's single global runtime mode; keying it off an unconfigured extra
  // dir could flip the whole daemon to no-hooks. Coverage gaps in extra
  // configured dirs surface via `describeInstallAnomalies` instead.
  isInstalled(): boolean {
    const [primary] = resolveClaudeConfigDirs(
      getPreferencesSync().claudeConfigDirs,
    );
    return isInstalledInDir(primary);
  }

  // Warn (at daemon startup and in `ccmux setup` status) when a configured
  // Claude dir beyond the primary is missing hooks — those sessions won't be
  // tracked authoritatively until `ccmux setup` is re-run.
  describeInstallAnomalies(): string[] {
    const [, ...extra] = resolveClaudeConfigDirs(
      getPreferencesSync().claudeConfigDirs,
    );
    return extra
      .filter((dir) => !isInstalledInDir(dir))
      .map(
        (dir) =>
          `configured Claude dir missing hooks: ${dir} — run \`ccmux setup --agent claude\``,
      );
  }

  // Claude does not write the per-session JSONL until the user submits the
  // first prompt, so a JSONL-existence check would race-delete fresh
  // markers in the seconds between SessionStart and the first turn. PID
  // liveness in cleanupStaleMarkers is authoritative.
  isSessionStillLive(_marker: SessionPidMarker): boolean {
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    ctx.getLogWatcher(this.agentType)?.handleMarkerAdded(marker);
  }

  async onMarkerRemoved(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    ctx.getLogWatcher(this.agentType)?.handleMarkerRemoved(marker);
  }
}

function isInstalledInDir(configDir: string): boolean {
  const settingsFile = settingsFileFor(configDir);
  if (!existsSync(settingsFile)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
    const startHooks = settings?.hooks?.SessionStart;
    if (!Array.isArray(startHooks)) return false;
    return startHooks.some((h: { hooks?: { command?: string }[] }) =>
      h.hooks?.some((hook) => hook.command?.includes(SESSION_START_SCRIPT)),
    );
  } catch {
    return false;
  }
}

function ensureHook(
  settings: ClaudeSettings,
  slot: "SessionStart" | "SessionEnd" | "Notification",
  matcher: string,
  scriptPath: string,
  lines: string[],
): boolean {
  const existing = settings.hooks?.[slot] ?? [];
  const scriptName = scriptPath.split("/").pop() ?? "";
  const alreadyInstalled = existing.some(
    (h) => h.hooks?.some((hook) => hook.command?.includes(scriptName)) ?? false,
  );
  if (alreadyInstalled) {
    lines.push(`${slot} hook already installed in settings.json`);
    return false;
  }

  settings.hooks = {
    ...(settings.hooks ?? {}),
    [slot]: [
      ...existing,
      { matcher, hooks: [{ type: "command", command: scriptPath }] },
    ],
  };
  lines.push(`Added ${slot} hook to settings.json`);
  return true;
}

function removeHook(
  settings: ClaudeSettings,
  slot: "SessionStart" | "SessionEnd" | "Notification",
  scriptName: string,
): boolean {
  const existing = settings.hooks?.[slot];
  if (!existing) return false;
  const filtered = existing.filter(
    (h) => !h.hooks?.some((hook) => hook.command?.includes(scriptName)),
  );
  if (filtered.length === existing.length) return false;
  if (filtered.length === 0) {
    delete settings.hooks![slot];
  } else {
    settings.hooks![slot] = filtered;
  }
  return true;
}
