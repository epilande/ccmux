import { mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { PREFS_FILE } from "./config";
import type { IconStyle } from "./icons";
import type { AttentionType, SessionStatus } from "../types/session";

/** How sessions are grouped in the TUI */
export type GroupBy = "project" | "cwd" | "session" | "window" | "none";

export const DEFAULT_GROUP_BY: GroupBy = "project";

export const VALID_GROUP_BY: GroupBy[] = [
  "project",
  "cwd",
  "session",
  "window",
  "none",
];

export interface TerminalRuleConfig {
  matchAny?: string[];
  matchAll?: string[];
  status: SessionStatus;
  attentionType?: AttentionType;
  pendingTool?: string | null;
}

interface InvokeModeConfig {
  args: string[];
  resumeArgs?: string[];
  output: { kind: "stdout" | "tmpfile" | "opencode-json" };
}

export interface AgentConfig {
  processMatch?: string;
  commandPatterns?: string[];
  versionCommand?: string;
  versionPatterns?: string[];
  terminalRules?: TerminalRuleConfig[];
  errorRules?: {
    match: string;
    kind: "rate_limit" | "agent_error";
    message?: string;
  }[];
  resumeCommand?: string;
  sessionFilePattern?: string;
  executable?: string;
  invokeMode?: InvokeModeConfig;
  /**
   * Override the regex used to detect when the agent's interactive TUI is
   * ready for input on the `ccmux invoke` tmux path. Accepts a literal
   * regex string (`"❯\\s"`) or slash-delimited form (`"/^[>❯]\\s/"`).
   * Currently consulted only for the built-in `claude` agent.
   */
  readyPattern?: string;
  hooks?: {
    markerDir?: string;
    type?: string;
  };
  /**
   * Named tmux keys sent to answer a permission prompt from a notification
   * Approve/Deny button (see `AgentDef.notificationActions`). Defining a map
   * for a custom agent is what opts its `permission` notifications into
   * buttons.
   */
  notificationActions?: {
    approve?: string[];
    deny?: string[];
  };
}

export const BREAKPOINT_NAMES = ["xs", "sm", "md", "lg"] as const;
type BreakpointName = (typeof BREAKPOINT_NAMES)[number];

/** Simple value or responsive object with named breakpoint keys (mobile-first cascade) */
export type Responsive<T> =
  | T
  | ({ default?: T } & { [K in BreakpointName]?: T });

/** Render modes for fields that have multiple display variants */
export type StatusMode = "full" | "short" | "icon";

/**
 * How the last-prompt subtitle is displayed.
 * - `inline`: prompt rides row 1, single-line per session (picker default).
 *   The narrow sidebar has no room for this, so it falls back to `row2`.
 * - `row2`: prompt on its own row below the identity line (two lines).
 * - `off`: prompt hidden entirely (and row 2 dropped wholesale with it).
 * Cycled at runtime by the `p` key; a config default lives in `promptDisplay`.
 */
export const VALID_PROMPT_DISPLAYS = ["inline", "row2", "off"] as const;
export type PromptDisplay = (typeof VALID_PROMPT_DISPLAYS)[number];

/** Prompt display mode applied when neither config nor runtime state sets one. */
export const DEFAULT_PROMPT_DISPLAY: PromptDisplay = "inline";

/**
 * How harvested hunk review comments are delivered back to the agent.
 * - `confirm`: show a confirmation dialog before sending (default).
 * - `auto`: send immediately with no dialog.
 * - `fill`: fill the composer without submitting.
 */
export const VALID_REVIEW_HANDBACK = ["auto", "confirm", "fill"] as const;
export type ReviewHandback = (typeof VALID_REVIEW_HANDBACK)[number];

/** All field identifiers placeable in a row's left or right side */
export const COLUMN_FIELDS = [
  "index",
  "status",
  "project",
  "agent",
  "version",
  "pane",
  "time",
  "prompt",
  "cwd",
  "branch",
  "pr",
] as const;
export type ColumnField = (typeof COLUMN_FIELDS)[number];

/**
 * One column entry. Shorthand string `"<field>"` or `"<field>:<mode>"`,
 * or object form for responsive mode overrides.
 */
export interface ColumnEntryObject {
  field: ColumnField;
  mode?: Responsive<string>;
}
export type ColumnEntry = string | ColumnEntryObject;

/** A row side is an array of entries, optionally responsive across breakpoints */
export type RowSide = Responsive<ColumnEntry[]>;

export interface RowConfig {
  left?: RowSide;
  right?: RowSide;
}

export interface ColumnsConfig {
  row1?: RowConfig;
  row2?: RowConfig;
}

export type BreakpointConfig = Partial<Record<BreakpointName, number>>;

interface SidebarConfig {
  width?: number; // default DEFAULT_SIDEBAR_WIDTH
  position?: "left" | "right"; // default "left"
  columns?: ColumnsConfig;
}

export const DEFAULT_SIDEBAR_WIDTH = 30;

export const VALID_NOTIFICATION_BACKENDS = [
  "auto",
  "ccmux-notifier",
  "osascript",
  "notify-send",
  "dbus",
  "command",
] as const;

export const VALID_NOTIFICATION_EVENTS = ["waiting", "finished"] as const;

/**
 * Desktop notification settings. Defaults (documented per-field below) live
 * in the consumers (`src/commands/notify.ts`, `src/daemon/notifier.ts`), not
 * here, matching the rest of this file's convention.
 */
export interface NotificationsConfig {
  /** default false (opt-in) */
  enabled?: boolean;
  /** default both; edge-triggered status transitions to notify on */
  events?: Array<(typeof VALID_NOTIFICATION_EVENTS)[number]>;
  /** default false; `true` maps to the platform default sound name */
  sound?: boolean | string;
  /** debounce (ms) for the "finished" event only; default 1000 */
  delayMs?: number;
  /** default "auto" (platform-appropriate ladder). The v1 `"terminal-notifier"`
   * value was removed in v2; a config still carrying it is treated as "auto"
   * (fail-open) with a one-line log — see `normalizeBackendConfig`. */
  backend?: (typeof VALID_NOTIFICATION_BACKENDS)[number];
  /** shell command run when backend is "command" */
  command?: string;
}

export const DEFAULT_BREAKPOINTS: Required<BreakpointConfig> = {
  xs: 40,
  sm: 60,
  md: 80,
  lg: 100,
};

/**
 * The 14 semantic palette colors. Agent/status/PR colors derive from these, so
 * they follow the theme for free. Values are `#rrggbb` hex strings.
 */
export interface SemanticColors {
  rosewater: string;
  text: string;
  subtext: string;
  overlay: string;
  surface: string;
  base: string;
  border: string;
  red: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  blue: string;
  mauve: string;
}

/**
 * The 16 ANSI terminal colors used to render captured pane output in the
 * preview (the basic 8 plus their bright variants). Values are `#rrggbb` hex.
 */
export interface Ansi16 {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** A fully resolved theme palette (semantic + ANSI). */
export interface ThemePalette {
  semantic: SemanticColors;
  ansi: Ansi16;
}

/**
 * Theme selection. Either a built-in theme name, or an object naming a built-in
 * `base` plus optional per-key overrides deep-merged over it. Mirrors the
 * simple-or-object union used by `columns`. `base` defaults to the default
 * theme. Override keys are the 14 semantic keys and the 16 ANSI keys.
 */
export type ThemeConfig =
  | string
  | {
      base?: string;
      colors?: Partial<SemanticColors>;
      ansi?: Partial<Ansi16>;
    };

export interface Preferences {
  showPreview?: boolean;
  iconStyle?: IconStyle;
  previewWidth?: number;
  command?: string;
  agents?: Record<string, AgentConfig>;
  /**
   * Additional Claude Code config directories to watch beyond the default
   * `~/.claude`. Each entry contributes its `<dir>/projects` session tree,
   * letting a single ccmux instance surface sessions from multiple Claude
   * accounts started via `CLAUDE_CONFIG_DIR` (e.g. `~/.claude` +
   * `~/.claude-personal`). The default `~/.claude` is always watched. Paths
   * may start with `~`. See `resolveClaudeProjectDirs`.
   */
  additionalClaudeConfigDirs?: string[];
  columns?: ColumnsConfig;
  breakpoints?: BreakpointConfig;
  /** Default prompt display mode (default "inline"). The runtime `p`-key
   *  toggle (persisted in UIState) overrides this. */
  promptDisplay?: PromptDisplay;
  /** Search pane content in TUI search (default true) */
  searchPaneContent?: boolean;
  /** Lines of pane content to scan in TUI search (default 100) */
  searchPaneLines?: number;
  /** Search live transcripts (Claude/Codex) via the daemon (default true) */
  searchTranscript?: boolean;
  /** Group sessions by (default "project") */
  groupBy?: GroupBy;
  /** Keep picker open after switching sessions (default false) */
  persistent?: boolean;
  /** Hunk review note delivery: confirm first (default), send automatically, or fill without submitting. */
  reviewHandback?: ReviewHandback;
  /**
   * Surface Claude Code background agents (`claude --bg` / the agent view)
   * as rows (default true; only an explicit `false` disables). Gated
   * daemon-side: off means the roster/jobs watchers never start, so the
   * feature costs nothing when disabled. Self-gating when on: with no
   * background agents dispatched, zero rows appear.
   */
  backgroundAgents?: boolean;
  /** Sidebar mode configuration */
  sidebar?: SidebarConfig;
  /** Desktop notification settings (default: disabled). See {@link NotificationsConfig}. */
  notifications?: NotificationsConfig;
  /**
   * TUI color theme, resolved once at launch (no in-TUI toggle). A built-in
   * name (e.g. `"catppuccin-latte"`) or an object with a `base` plus per-key
   * `colors`/`ansi` overrides. An unknown base falls back to the default theme;
   * an invalid hex value or unknown override key is dropped (base value kept),
   * each with a warning. See `resolveTheme` in `src/tui/theme.ts`.
   */
  theme?: ThemeConfig;
}

/**
 * Returns empty object if file doesn't exist or is malformed
 */
export async function getPreferences(): Promise<Preferences> {
  try {
    const file = Bun.file(PREFS_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // Ignore malformed file
  }
  return {};
}

/**
 * Synchronous preferences read for the few callers that can't be async
 * (e.g. `HookAdapter.isInstalled`). Returns an empty object if the file is
 * missing or malformed, matching {@link getPreferences}.
 */
export function getPreferencesSync(): Preferences {
  try {
    return JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Merge updates into the preferences file
 */
export async function setPreferences(
  updates: Partial<Preferences>,
): Promise<void> {
  const current = await getPreferences();
  const merged = { ...current, ...updates };
  mkdirSync(dirname(PREFS_FILE), { recursive: true });
  await Bun.write(PREFS_FILE, JSON.stringify(merged, null, 2) + "\n");
}
