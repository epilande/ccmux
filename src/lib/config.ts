import { join, resolve } from "path";
import { homedir } from "os";

/**
 * Claude Code's own directory (read-only by ccmux)
 */
export const CLAUDE_DIR = join(homedir(), ".claude");
export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
export const CLAUDE_HOOKS_DIR = join(CLAUDE_DIR, "hooks");

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the set of Claude `projects` directories ccmux should watch.
 *
 * Claude Code writes session transcripts to `$CLAUDE_CONFIG_DIR/projects`
 * (default `~/.claude/projects`). A user running a second account via
 * `CLAUDE_CONFIG_DIR=~/.claude-personal claude` produces sessions under a
 * *different* projects tree that the default single-root watcher never
 * sees. This returns every tree to watch so one ccmux instance can surface
 * sessions from multiple Claude config dirs — the same way it already fans
 * out across multiple agents.
 *
 * Sources, in order: the default `~/.claude/projects` (always first), the
 * `CLAUDE_CONFIG_DIR` env var (matches Claude's own resolution), then the
 * `claudeConfigDirs` preference. Each extra entry is a Claude *config* dir
 * whose `projects` subdir is watched. Paths may start with `~`. The result
 * is absolute and de-duplicated, order-preserving, so the default behavior
 * is unchanged when nothing extra is configured.
 */
export function resolveClaudeProjectDirs(configDirs?: string[]): string[] {
  const dirs = [PROJECTS_DIR];
  const extraConfigDirs = [
    ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : []),
    ...(configDirs ?? []),
  ];
  for (const dir of extraConfigDirs) {
    if (!dir) continue;
    dirs.push(join(resolve(expandHome(dir)), "projects"));
  }
  return [...new Set(dirs)];
}

/**
 * Claude Code's background/background-agent state, written by Claude's own
 * supervisor daemon (read-only by ccmux; never written). Derived from
 * `CLAUDE_DIR` to match how the rest of the code resolves Claude paths.
 * - `roster.json`: authoritative live membership (`proto:1`, `workers{}`).
 * - `jobs/<short>/state.json`: per-session status transitions.
 */
export const DAEMON_ROSTER = join(CLAUDE_DIR, "daemon", "roster.json");
export const JOBS_DIR = join(CLAUDE_DIR, "jobs");

/**
 * Codex CLI's own directory. Read-only except during `ccmux setup --agent codex`,
 * which writes hook scripts + toggles the codex hooks feature flag in `config.toml`
 * (recognizes both the pre-0.124 `codex_hooks` and the 0.124+ `hooks` name).
 * Honors `CODEX_HOME` to match Codex's own resolution.
 */
export const CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), ".codex");
export const CODEX_HOOKS_DIR = join(CODEX_DIR, "hooks");
export const CODEX_HOOKS_FILE = join(CODEX_DIR, "hooks.json");
export const CODEX_CONFIG_FILE = join(CODEX_DIR, "config.toml");

/**
 * OpenCode's own directory. Read-only except during
 * `ccmux setup --agent opencode`, which drops a bundled JS plugin into
 * the auto-discovered plugin dir. Honors `XDG_CONFIG_HOME` to match
 * OpenCode's own resolution.
 */
export const OPENCODE_CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "opencode",
);
export const OPENCODE_PLUGIN_DIR = join(OPENCODE_CONFIG_DIR, "plugin");
export const OPENCODE_PLUGIN_FILE = join(OPENCODE_PLUGIN_DIR, "ccmux.js");

/**
 * Cursor CLI's own directory. Read-only except during
 * `ccmux setup --agent cursor`, which writes hook scripts and merges
 * entries into `hooks.json`. Cursor does not respect XDG overrides; it
 * always reads `~/.cursor/` (source: `cursor-agent --help` references
 * `~/.cursor/worktrees/...`, and env dumps from live hook invocations
 * showed no XDG-controlled relocation).
 */
export const CURSOR_DIR = join(homedir(), ".cursor");
export const CURSOR_HOOKS_DIR = join(CURSOR_DIR, "hooks");
export const CURSOR_HOOKS_FILE = join(CURSOR_DIR, "hooks.json");

/**
 * pi's own directory. Read-only except during `ccmux setup --agent pi`,
 * which drops a bundled JS extension into the auto-discovered extensions
 * dir. pi resolves this dir as `~/.pi/agent` unconditionally (no XDG/env
 * override; source: pi `config.ts` `getAgentDir()` -> `join(homedir(),
 * ".pi", "agent")`).
 */
export const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
export const PI_EXTENSION_DIR = join(PI_AGENT_DIR, "extensions");
export const PI_EXTENSION_FILE = join(PI_EXTENSION_DIR, "ccmux.js");

/**
 * ccmux's own config/state directory
 */
export const CCMUX_DIR =
  process.env.CCMUX_HOME ?? join(homedir(), ".config", "ccmux");

export const PID_FILE = join(CCMUX_DIR, "ccmux.pid");
export const LOG_FILE = join(CCMUX_DIR, "ccmux.log");
export const PREFS_FILE = join(CCMUX_DIR, "ccmux.json");
export const STATE_FILE = join(CCMUX_DIR, "state.json");
export const MARKERS_DIR = join(CCMUX_DIR, "session-pids");

const CCMUX_PANE_PREFIX = "ccmux-";
export const SIDEBAR_PANE_TITLE = "ccmux-sidebar";
export const PICKER_PANE_TITLE = "ccmux-picker";

export function isCcmuxPane(paneTitle: string | null): boolean {
  return paneTitle?.startsWith(CCMUX_PANE_PREFIX) ?? false;
}

// Re-reads `CCMUX_HOME` at call time rather than reusing the import-frozen
// `CCMUX_DIR`, so the lifecycle/stop tests can redirect the pid file to a temp
// dir by setting `CCMUX_HOME` after this module is imported. Do NOT collapse to
// `return CCMUX_DIR`: that writes test pid files into the real ~/.config/ccmux.
function getCcmuxDirPath(): string {
  return process.env.CCMUX_HOME ?? CCMUX_DIR;
}

export function getPidFilePath(): string {
  return join(getCcmuxDirPath(), "ccmux.pid");
}

/**
 * Daemon configuration
 */
/**
 * Parse a `CCMUX_PORT`-style value to a valid TCP port, or null. Rejects unset,
 * empty, non-numeric, non-integer, and out-of-range (<=0, >65535) values so a
 * malformed override falls back to the default instead of silently misbinding:
 * `Number("-1")` would otherwise have Bun.serve bind a random ephemeral port and
 * `"70000"` clamp, both leaving the daemon up but unreachable. Shared with
 * `ccmuxPortEnvPrefix` in commands/sidebar.ts so both validate identically.
 */
export function parseCcmuxPort(raw: string | undefined): number | null {
  if (!raw) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

// Default 2269 spells "CCMX" on a phone keypad. `CCMUX_PORT` overrides it so an
// isolated daemon (e.g. recording a demo) can run beside the real one; an unset,
// empty, non-numeric, or out-of-range value falls back to the default.
export const DAEMON_PORT = parseCcmuxPort(process.env.CCMUX_PORT) ?? 2269;
export const DAEMON_HOST = "127.0.0.1";

/**
 * Interval configuration
 */
export const SCAN_INTERVAL_MS = 5000;
export const WATCHER_DEBOUNCE_MS = 200;
export const HEARTBEAT_INTERVAL_MS = 15000;
export const HEALTH_CHECK_TIMEOUT_MS = 100;

/**
 * Pane activity threshold — pane silent longer than this means not actively working
 */
export const PANE_IDLE_THRESHOLD_MS = 30_000;

/**
 * Zombie session threshold — soft-evicted sessions (no pane, no PID) older than this are removed
 */
export const ZOMBIE_STALE_MS = 5 * 60 * 1000;

/**
 * Background staleness threshold — a background worker still at
 * `working`/`active` with no `firstTerminalAt` and no `linkScanPath` past
 * this age is rendered `idle` (covers a worker frozen at working for weeks);
 * within the window it stays `working` (preserves the genuine just-launched
 * 1-2s case). See `deriveBackgroundState`.
 */
export const BACKGROUND_FRESH_THRESHOLD_MS = 10_000;

/**
 * Log parsing configuration
 */
export const MAX_LOG_ENTRIES = 100;

/**
 * Check if a tool requires permission (settings-aware)
 */
export { toolRequiresPermission } from "./permission-resolver";

/**
 * Get daemon URL
 */
export function getDaemonUrl(): string {
  return `http://${DAEMON_HOST}:${DAEMON_PORT}`;
}
