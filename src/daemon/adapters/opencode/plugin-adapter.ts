import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import {
  MARKERS_DIR,
  OPENCODE_PLUGIN_DIR,
  OPENCODE_PLUGIN_FILE,
  OPENCODE_TUI_PLUGIN_DIR,
  OPENCODE_TUI_PLUGIN_FILE,
} from "../../../lib/config";
import pkg from "../../../../package.json" with { type: "json" };
import { BUILTIN_AGENTS, parseMajorVersion } from "../../../lib/agents";
import { VersionResolver } from "../../version-resolver";
import { aggregateOpenCodeMarkers } from "./aggregate";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import { renderOpenCodePlugin, renderOpenCodeTuiPlugin } from "./plugin-script";
import {
  filterMarkerCache,
  type SessionPidMarker,
} from "../../session-markers";

const CCMUX_VERSION: string = pkg.version;

const SENTINEL_PREFIX = "// ccmux-plugin v";
const SENTINEL_REGEX = /^\/\/ ccmux-plugin v(\S+)/;

/** `opencode --version` from PATH: `1.18.34` on 1.x, `opencode v2.0.21` on 2.x. */
async function readInstalledOpenCodeVersion(): Promise<string | null> {
  const agent = BUILTIN_AGENTS.find((a) => a.name === "opencode");
  if (!agent) return null;
  return new VersionResolver({ timeoutMs: 3000 }).resolve(
    agent,
    agent.executable ?? agent.name,
  );
}

function inspectInstalledPlugin(path: string): {
  exists: boolean;
  owned: boolean;
  version: string | null;
} {
  if (!existsSync(path)) return { exists: false, owned: false, version: null };
  let firstLine: string;
  try {
    firstLine = readFileSync(path, "utf-8").split("\n", 1)[0];
  } catch {
    return { exists: true, owned: false, version: null };
  }
  const match = firstLine.match(SENTINEL_REGEX);
  if (!match) return { exists: true, owned: false, version: null };
  return { exists: true, owned: true, version: match[1] };
}

/**
 * One ccmux-owned file in OpenCode's config dir. OpenCode 1 loads the
 * server plugin (`plugin/ccmux.js`); OpenCode 2 rejects that file and loads
 * the TUI plugin (`plugins/ccmux/tui.js`), which OpenCode 1 never reads.
 */
interface PluginFile {
  file: string;
  dir: string;
  /** The directory exists only for this file, so uninstall removes it too. */
  ownsDir: boolean;
  render: typeof renderOpenCodePlugin;
}

// Built per call rather than at module load, so the paths stay live config
// bindings (tests mock them; a module-level copy would keep the real ones).
function serverPlugin(): PluginFile {
  return {
    file: OPENCODE_PLUGIN_FILE,
    dir: OPENCODE_PLUGIN_DIR,
    ownsDir: false,
    render: renderOpenCodePlugin,
  };
}

function tuiPlugin(): PluginFile {
  return {
    file: OPENCODE_TUI_PLUGIN_FILE,
    dir: OPENCODE_TUI_PLUGIN_DIR,
    ownsDir: true,
    render: renderOpenCodeTuiPlugin,
  };
}

/**
 * Write (or refresh) one plugin file. A same-named file without the
 * sentinel is left alone, matching Codex's "advisory, keep going" posture
 * so a combined `ccmux setup` can still install the other agents' hooks.
 */
function installPluginFile(plugin: PluginFile): HookAdapterOutcome {
  const inspection = inspectInstalledPlugin(plugin.file);
  if (inspection.exists && !inspection.owned) {
    return {
      lines: [
        `Skipped ${plugin.file}: first line does not start with "${SENTINEL_PREFIX}".`,
        "Move the existing file aside and re-run `ccmux setup --agent opencode` to install.",
      ],
      changed: false,
    };
  }
  const source = plugin.render({
    markersDir: MARKERS_DIR,
    version: CCMUX_VERSION,
  });
  if (inspection.exists && readFileSync(plugin.file, "utf-8") === source) {
    return {
      lines: [`Plugin already up to date: ${plugin.file}`],
      changed: false,
    };
  }
  mkdirSync(plugin.dir, { recursive: true });
  const tmp = `${plugin.file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, source);
  renameSync(tmp, plugin.file);
  return {
    lines: [
      inspection.exists
        ? `Updated plugin: ${plugin.file} (was v${inspection.version ?? "unknown"}, now v${CCMUX_VERSION})`
        : `Created plugin: ${plugin.file}`,
    ],
    changed: true,
  };
}

/**
 * OpenCode 2 rejects the server plugin outright ("Plugin must export a
 * default definition with an id and an effect or setup function") and
 * raises that error on every launch, so setup removes a copy it wrote
 * earlier instead of installing one. A same-named file ccmux did not write
 * is left alone.
 */
function retireServerPlugin(version: string): HookAdapterOutcome {
  const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
  if (inspection.owned) {
    unlinkSync(OPENCODE_PLUGIN_FILE);
    return {
      lines: [
        `Removed ${OPENCODE_PLUGIN_FILE}, which OpenCode ${version} rejects at startup.`,
      ],
      changed: true,
    };
  }
  if (inspection.exists) {
    return {
      lines: [
        `Left ${OPENCODE_PLUGIN_FILE} alone: first line does not start with "${SENTINEL_PREFIX}".`,
      ],
      changed: false,
    };
  }
  return { lines: [], changed: false };
}

function uninstallPluginFile(plugin: PluginFile): HookAdapterOutcome {
  const inspection = inspectInstalledPlugin(plugin.file);
  if (!inspection.exists) return { lines: [], changed: false };
  if (!inspection.owned) {
    return {
      lines: [
        `Skipped ${plugin.file}: first line does not start with "${SENTINEL_PREFIX}". ` +
          "Refusing to delete a file ccmux did not write.",
      ],
      changed: false,
    };
  }
  unlinkSync(plugin.file);
  if (plugin.ownsDir) {
    try {
      rmdirSync(plugin.dir);
    } catch {
      // Not empty (leave whatever else landed there), or already gone.
    }
  }
  return { lines: [`Removed ${plugin.file}`], changed: true };
}

/**
 * OpenCode plugin-based hook integration.
 *
 * Unlike Claude/Codex, there are no shell scripts to install. `install()`
 * writes JS files OpenCode auto-discovers: the TUI plugin for OpenCode 2
 * (always; OpenCode 1 ignores it) and the server plugin for OpenCode 1
 * (removed instead when the installed OpenCode is 2.x, which rejects it).
 * `uninstall()` unlinks both. Each file's first line carries a sentinel
 * (`// ccmux-plugin v<version>`) so we can confirm ownership before
 * overwriting or deleting.
 *
 * Marker lifecycle is driven by the plugins: on OpenCode events they
 * rewrite `opencode-<session_id>.json` markers with the same schema. The
 * adapter reads those markers (via `filterMarkerCache`) and folds every
 * marker sharing a pid into the single ccmux Session for the hosting tmux
 * pane: N sessions per 1.x server, one displayed session per 2.x TUI.
 */
export class OpenCodePluginAdapter implements HookAdapter {
  readonly agentType = "opencode";

  private readonly readOpenCodeVersion: () => Promise<string | null>;

  constructor(
    options: {
      /** Version string of the `opencode` on PATH, or null if it cannot be run. */
      readOpenCodeVersion?: () => Promise<string | null>;
    } = {},
  ) {
    this.readOpenCodeVersion =
      options.readOpenCodeVersion ?? readInstalledOpenCodeVersion;
  }

  /** The installed OpenCode's version when it is 2.x or newer, else null. */
  private async detectOpenCode2(): Promise<string | null> {
    const version = await this.readOpenCodeVersion().catch(() => null);
    const major = parseMajorVersion(version);
    return major !== null && major >= 2 ? version : null;
  }

  async install(): Promise<HookAdapterOutcome> {
    const outcomes = [installPluginFile(tuiPlugin())];
    const v2Version = await this.detectOpenCode2();
    outcomes.push(
      v2Version
        ? retireServerPlugin(v2Version)
        : installPluginFile(serverPlugin()),
    );
    const lines = outcomes.flatMap((o) => o.lines);
    const changed = outcomes.some((o) => o.changed);
    if (changed) {
      lines.push(
        "Restart any running OpenCode sessions to pick up the plugin.",
      );
    }
    return { lines, changed };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const outcomes = [serverPlugin(), tuiPlugin()].map(uninstallPluginFile);
    const lines = outcomes.flatMap((o) => o.lines);
    const changed = outcomes.some((o) => o.changed);
    if (!changed && lines.length === 0) {
      lines.push(
        `No ccmux plugin at ${OPENCODE_PLUGIN_FILE} or ${OPENCODE_TUI_PLUGIN_FILE}.`,
      );
    }
    if (changed) {
      lines.push(
        "Marker files under ~/.config/ccmux/session-pids/ will be swept on the next daemon cycle.",
      );
    }
    return { lines, changed };
  }

  isInstalled(): boolean {
    return (
      inspectInstalledPlugin(OPENCODE_TUI_PLUGIN_FILE).owned ||
      inspectInstalledPlugin(OPENCODE_PLUGIN_FILE).owned
    );
  }

  describeInstallDetail(): string | null {
    const tui = inspectInstalledPlugin(OPENCODE_TUI_PLUGIN_FILE);
    const inspection = tui.owned
      ? tui
      : inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (!inspection.owned || !inspection.version) return null;
    return inspection.version === CCMUX_VERSION
      ? `(plugin v${inspection.version}, matches running ccmux)`
      : `(plugin v${inspection.version})`;
  }

  async describeInstallAnomalies(): Promise<string[]> {
    const warnings: string[] = [];
    const server = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (server.owned) {
      const v2Version = await this.detectOpenCode2();
      if (v2Version) {
        warnings.push(
          `OpenCode: plugin at ${OPENCODE_PLUGIN_FILE} is installed, but OpenCode ${v2Version} rejects it at startup. ` +
            "Run `ccmux setup --agent opencode` to replace it.",
        );
      }
    }
    for (const file of [OPENCODE_PLUGIN_FILE, OPENCODE_TUI_PLUGIN_FILE]) {
      const inspection = inspectInstalledPlugin(file);
      if (
        inspection.owned &&
        inspection.version &&
        inspection.version !== CCMUX_VERSION
      ) {
        warnings.push(
          `OpenCode: plugin at ${file} is v${inspection.version} but ccmux is v${CCMUX_VERSION}. ` +
            "Run `ccmux setup --agent opencode` to update.",
        );
      }
    }
    return warnings;
  }

  isSessionStillLive(_marker: SessionPidMarker): boolean {
    // OpenCode has no per-session log to check. The generic PID-liveness
    // sweep in `cleanupStaleMarkers` is the whole story for us.
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    await this.reaggregate(marker, ctx);
  }

  async onMarkerRemoved(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    // Cache eviction for an unlinked marker happens on the next scan's
    // refreshMarkerCache, so the just-removed marker may still be in the
    // cache. Filter it out so the aggregate reflects reality.
    await this.reaggregate(marker, ctx, marker.session_id);
  }

  async onMarkerChanged(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    // Re-aggregate by server PID rather than session id. Closes the
    // non-winning-sibling gap from the generic resolver: when an
    // OpenCode plugin rewrites any sibling's marker (winning or not),
    // the daemon's `resolveSessionForMarkerEvent(marker.session_id)`
    // would miss for non-winning siblings since `nativeSessionId` only
    // stores the winning marker's id. The adapter has no such issue:
    // `reaggregate` maps `marker.pid` -> pane -> ccmux session in one
    // step.
    await this.reaggregate(marker, ctx);
  }

  private async reaggregate(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
    excludeSessionId?: string,
  ): Promise<void> {
    const target = await this.findTargetSession(marker.pid, ctx);
    if (!target) return;
    const siblings = filterMarkerCache(
      (m) =>
        m.agent_type === this.agentType &&
        m.pid === marker.pid &&
        m.session_id !== excludeSessionId,
    );
    this.applyAggregate(target.sessionId, siblings, ctx);
  }

  private async findTargetSession(
    pid: number,
    ctx: HookManagerContext,
  ): Promise<{ sessionId: string } | null> {
    const pane = await ctx.getPaneHostingPid(pid);
    if (!pane) return null;
    const session = findPaneTrackedSession(ctx, this.agentType, pane.paneId);
    return session ? { sessionId: session.id } : null;
  }

  private applyAggregate(
    sessionId: string,
    siblings: SessionPidMarker[],
    ctx: HookManagerContext,
  ): void {
    const aggregate = aggregateOpenCodeMarkers(siblings);
    const { nativeSessionId, ...state } = aggregate;
    ctx.sessionManager.updateSession(sessionId, state);
    if (nativeSessionId) {
      // Marker-backed, so reclaim: a heuristic holder of this
      // id is stripped and the id re-routes here.
      ctx.sessionManager.setNativeSessionId(sessionId, nativeSessionId, {
        reclaim: true,
      });
    }
  }
}
