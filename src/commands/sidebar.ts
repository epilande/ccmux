import { Command } from "commander";
import { ensureDaemon } from "./shared";
import {
  getPreferences,
  setPreferences,
  DEFAULT_SIDEBAR_WIDTH,
  type Preferences,
} from "../lib/preferences";
import { getUIState, resolvePromptDisplay } from "../lib/state";
import { markStartup } from "../lib/startup-timing";
import { SIDEBAR_PANE_TITLE, parseCcmuxPort } from "../lib/config";
import { PANE_FIELD_SEP } from "../lib/tmux-format";

type SidebarPosition = "left" | "right";

/**
 * Sidebars in other windows are spawned via tmux `split-window`, whose command
 * runs with the tmux *server's* environment, not this process's. A `CCMUX_PORT`
 * set in the shell that launched `ccmux sidebar --toggle` is therefore dropped,
 * silently repointing the spawned fleet at the default daemon. Forward the
 * normalized port into every spawn/hook command string so the whole fleet (and
 * the persisted auto-open hook) targets the same daemon as the toggle that
 * created it. Returns "" when `CCMUX_PORT` is unset or not a valid port, using
 * the same `parseCcmuxPort` validation as config's `DAEMON_PORT`; the value is
 * an integer in (0, 65535] before interpolation, so nothing unsafe reaches the
 * command. The `--resize` hook is intentionally left bare: it only drives tmux
 * resize-pane and never connects to the daemon.
 */
export function ccmuxPortEnvPrefix(): string {
  const port = parseCcmuxPort(process.env.CCMUX_PORT);
  if (port === null) return "";
  return `env CCMUX_PORT=${port} `;
}

/** Shell command for spawning a sidebar pane (used by split-window and auto-open hook). */
export function sidebarSpawnCmd(delaySeconds: number): string {
  return `sleep ${delaySeconds.toFixed(2)} && exec ${ccmuxPortEnvPrefix()}ccmux sidebar`;
}

/** Base pty-settle delay before the sidebar process boots (seconds). */
const SPAWN_BASE_DELAY_S = 0.1;
/** Head start for active-window sidebars before any background boot (seconds). */
const SPAWN_HEAD_START_S = 0.6;
/** How many background sidebars may boot per stagger step. */
const SPAWN_BATCH_SIZE = 4;
/** Stagger step between background boot batches (seconds). */
const SPAWN_BATCH_STEP_S = 0.25;

/**
 * Boot delay for the Nth background (non-active-window) sidebar.
 *
 * Each sidebar boot costs ~0.6s of CPU loading the TUI module graph, so a
 * toggle across dozens of windows launching every process at once starves
 * the one the user is actually looking at. Active windows boot at the base
 * delay; background windows wait out the active boot (SPAWN_HEAD_START_S),
 * then boot in batches of SPAWN_BATCH_SIZE, one SPAWN_BATCH_STEP_S apart.
 */
export function spawnDelaySeconds(backgroundIndex: number): number {
  const batch = Math.floor(backgroundIndex / SPAWN_BATCH_SIZE);
  return SPAWN_BASE_DELAY_S + SPAWN_HEAD_START_S + batch * SPAWN_BATCH_STEP_S;
}
const AUTO_OPEN_HOOK = "after-new-window[99]";
// window-resized fires on any actual size change (client attach, session
// switch with window-size=latest, terminal resize). The previous hook name,
// after-resize-window, only fired after an explicit resize-window COMMAND,
// so sidebars in other sessions kept their proportionally rescaled width.
const RESIZE_HOOK = "window-resized[99]";
/** Hook name used by older builds; removed on toggle-off so it can't linger. */
const LEGACY_RESIZE_HOOK = "after-resize-window[99]";

export function createSidebarCommand(): Command {
  return new Command("sidebar")
    .description("Launch sidebar TUI mode (narrow, no preview/footer)")
    .option(
      "--toggle",
      "Smart toggle: spawn/kill sidebars across all tmux sessions",
    )
    .option("--resize", "Resize all sidebar panes to configured width")
    .option(
      "--apply-width <number>",
      "Persist a new width preference and resize all sidebars (spawned by sidebar panes on manual resize)",
      parseInt,
    )
    .option("--position <position>", "Sidebar position: left or right")
    .option("--width <number>", "Sidebar width in columns", parseInt)
    .option("--socket <path>", "tmux socket path (used by hooks)")
    .action(
      async (options: {
        toggle?: boolean;
        resize?: boolean;
        applyWidth?: number;
        position?: string;
        width?: number;
        socket?: string;
      }) => {
        // --resize runs from run-shell hooks where TMUX is not set.
        // Skip getPreferences() since width is baked into the hook command.
        if (options.resize) {
          await handleResize(options.width ?? 30, options.socket);
          return;
        }

        const prefs = await getPreferences();
        const width =
          options.width ?? prefs.sidebar?.width ?? DEFAULT_SIDEBAR_WIDTH;

        if (!process.env.TMUX) {
          console.error("Sidebar requires tmux");
          process.exit(1);
        }

        const rawPosition =
          options.position ?? prefs.sidebar?.position ?? "left";

        if (rawPosition !== "left" && rawPosition !== "right") {
          console.error("Invalid position: must be 'left' or 'right'");
          process.exit(1);
        }
        const position: SidebarPosition = rawPosition;

        if (options.applyWidth !== undefined) {
          await handleApplyWidth(options.applyWidth, position, prefs);
          return;
        }

        if (options.toggle) {
          await handleToggle(width, position);
          return;
        }

        const selfPane = process.env.TMUX_PANE;
        if (selfPane) {
          Bun.spawn([
            "tmux",
            "select-pane",
            "-t",
            selfPane,
            "-T",
            SIDEBAR_PANE_TITLE,
          ]);
        }

        // The bin/ccmux launcher cds to the project root for bun module
        // resolution. Restore the caller's cwd so tmux reports the correct
        // pane_current_path.
        const callerPwd = process.env.CCMUX_CALLER_PWD;
        if (callerPwd) process.chdir(callerPwd);

        markStartup("cli_parse");

        const [, uiState, tui] = await Promise.all([
          ensureDaemon(),
          getUIState(),
          import("../tui"),
        ]);
        markStartup("daemon_ready");

        await tui.launchTUI({
          initialPreview: false,
          iconStyle: prefs.iconStyle ?? "dot",
          columns: prefs.sidebar?.columns ?? prefs.columns,
          breakpoints: prefs.breakpoints,
          searchPaneContent: prefs.searchPaneContent,
          searchPaneLines: prefs.searchPaneLines,
          searchTranscript: prefs.searchTranscript,
          groupBy: uiState.groupBy ?? prefs.groupBy,
          collapsedGroups: uiState.collapsedGroups,
          pinnedGroups: uiState.pinnedGroups,
          hideIdle: uiState.hideIdle,
          promptDisplay: resolvePromptDisplay(uiState, prefs.promptDisplay),
          sidebar: true,
          theme: prefs.theme,
        });
      },
    );
}

function hasHookLine(output: string, hookName: string): boolean {
  return output
    .split("\n")
    .some((line) => line.includes(hookName) && line.includes("ccmux sidebar"));
}

/** Check if auto-open hook is registered from tmux show-hooks output */
export function parseAutoOpenHook(output: string): boolean {
  return hasHookLine(output, AUTO_OPEN_HOOK);
}

/** Parse pane IDs of sidebar panes from "#{pane_id}<sep>#{pane_title}" format */
export function parseSidebarPaneIds(output: string): string[] {
  if (!output) return [];
  const ids: string[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [paneId, title] = line.split(PANE_FIELD_SEP);
    if (paneId && title === SIDEBAR_PANE_TITLE) ids.push(paneId);
  }
  return ids;
}

export function parseResizeHook(output: string): boolean {
  return hasHookLine(output, RESIZE_HOOK);
}

async function tmux(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim();
}

function tmuxWithSocket(socket?: string, ...args: string[]): Promise<string> {
  if (socket) return tmux("-S", socket, ...args);
  return tmux(...args);
}

interface ToggleState {
  /** All window targets with the path of the first non-sidebar pane */
  windows: Map<string, string | undefined>;
  /** Pane IDs of existing sidebar panes (for killing) */
  sidebarPaneIds: string[];
  /** Window targets that already have a sidebar */
  sidebarWindows: Set<string>;
  /** Window targets that are the active window of an attached session */
  activeWindows: Set<string>;
}

/**
 * Parse all pane info needed for toggle in a single pass.
 * Expected format: "#{pane_id}<sep>#{session_name}:#{window_index}<sep>#{pane_title}<sep>#{pane_current_path}<sep>#{session_attached}<sep>#{window_active}"
 */
export function parseToggleState(output: string): ToggleState {
  const windows = new Map<string, string | undefined>();
  const sidebarPaneIds: string[] = [];
  const sidebarWindows = new Set<string>();
  const activeWindows = new Set<string>();

  if (!output)
    return { windows, sidebarPaneIds, sidebarWindows, activeWindows };

  for (const line of output.split("\n")) {
    if (!line) continue;
    const [paneId, target, title, path, attached, windowActive] =
      line.split(PANE_FIELD_SEP);
    if (!paneId || !target) continue;

    if (windowActive === "1" && attached !== undefined && attached !== "0") {
      activeWindows.add(target);
    }

    if (title === SIDEBAR_PANE_TITLE) {
      sidebarPaneIds.push(paneId);
      sidebarWindows.add(target);
    } else if (!windows.has(target)) {
      // First non-sidebar pane determines the window's path
      windows.set(target, path || undefined);
    }
  }

  return { windows, sidebarPaneIds, sidebarWindows, activeWindows };
}

async function getAllPaneState(): Promise<ToggleState> {
  const output = await tmux(
    "list-panes",
    "-a",
    "-F",
    [
      "#{pane_id}",
      "#{session_name}:#{window_index}",
      "#{pane_title}",
      "#{pane_current_path}",
      "#{session_attached}",
      "#{window_active}",
    ].join(PANE_FIELD_SEP),
  );
  return parseToggleState(output);
}

async function spawnSidebarInWindow(
  target: string,
  width: number,
  position: SidebarPosition,
  delaySeconds: number,
  cwd?: string,
): Promise<void> {
  const splitFlag = position === "left" ? "-fhbd" : "-fhd";
  const spawnCmd = sidebarSpawnCmd(delaySeconds);

  // The sidebar process sets its own pane title on startup (via select-pane
  // -t $TMUX_PANE -T). We avoid setting the title from here because
  // select-pane switches focus cross-window (triggering aggressive-resize
  // layout distortion) and corrupts last-pane history.
  //
  // The sidebar boots into an unfocused pane (`-d`), then briefly steals
  // focus to itself, lets OpenTUI's terminal-capability probes drain, and
  // hands focus back. Without that dance, tmux routes passthrough probe
  // replies to whichever pane is focused (i.e., the user's shell), and
  // the replies leak as gibberish. The sidebar self-discovers the pane to
  // restore focus to (see findRestorePane in src/tui/index.tsx) since
  // tmux doesn't expand `#{pane_id}` inside `-e VAR=...`.
  const args = ["split-window", splitFlag];
  if (cwd) args.push("-c", cwd);
  args.push("-l", String(width), "-t", target, spawnCmd);
  await tmux(...args);
}

async function getSidebarPaneIds(socket?: string): Promise<string[]> {
  const output = await tmuxWithSocket(
    socket,
    "list-panes",
    "-a",
    "-F",
    ["#{pane_id}", "#{pane_title}"].join(PANE_FIELD_SEP),
  );
  return parseSidebarPaneIds(output);
}

async function handleResize(width: number, socket?: string): Promise<void> {
  const paneIds = await getSidebarPaneIds(socket);
  if (paneIds.length === 0) return;
  await Promise.all(
    paneIds.map((id) =>
      tmuxWithSocket(socket, "resize-pane", "-t", id, "-x", String(width)),
    ),
  );
}

/** Bounds on widths persisted from manual pane resizes. */
const MIN_APPLY_WIDTH = 10;
const MAX_APPLY_WIDTH = 500;

async function handleApplyWidth(
  width: number,
  position: SidebarPosition,
  prefs: Preferences,
): Promise<void> {
  if (
    !Number.isInteger(width) ||
    width < MIN_APPLY_WIDTH ||
    width > MAX_APPLY_WIDTH
  ) {
    return;
  }
  // Propagation echo: another sidebar already persisted this width.
  if ((prefs.sidebar?.width ?? DEFAULT_SIDEBAR_WIDTH) === width) return;

  // Persist before resizing, so sidebars observing the propagated resize
  // compare their settled width against the new preference and no-op
  // instead of re-propagating.
  await setPreferences({ sidebar: { ...prefs.sidebar, width } });

  const [paneIds, autoOpenRegistered, resizeHookRegistered] = await Promise.all(
    [getSidebarPaneIds(), isAutoOpenHookRegistered(), isResizeHookRegistered()],
  );

  await Promise.all([
    ...paneIds.map((id) => tmux("resize-pane", "-t", id, "-x", String(width))),
    // Both hooks bake the width into their commands; refresh them, but only
    // when registered (a lone `ccmux sidebar` never installs hooks).
    ...(autoOpenRegistered ? [registerAutoOpenHook(width, position)] : []),
    ...(resizeHookRegistered ? [registerResizeHook(width)] : []),
  ]);
}

async function killSidebars(paneIds: string[]): Promise<void> {
  await Promise.all(paneIds.map((id) => tmux("kill-pane", "-t", id)));
}

async function registerAutoOpenHook(
  width: number,
  position: SidebarPosition,
): Promise<void> {
  const splitArgs =
    position === "left" ? `-fhbd -l ${width}` : `-fhd -l ${width}`;
  const cmd = `split-window ${splitArgs} -c '#{pane_current_path}' '${sidebarSpawnCmd(SPAWN_BASE_DELAY_S)}'`;
  await tmux("set-hook", "-g", AUTO_OPEN_HOOK, cmd);
}

async function unregisterAutoOpenHook(): Promise<void> {
  await tmux("set-hook", "-g", "-u", AUTO_OPEN_HOOK);
}

async function registerResizeHook(width: number): Promise<void> {
  const cmd = `run-shell -b 'ccmux sidebar --resize --width ${width} --socket #{socket_path} >/dev/null 2>&1'`;
  await tmux("set-hook", "-g", RESIZE_HOOK, cmd);
}

async function unregisterResizeHook(): Promise<void> {
  await Promise.all([
    tmux("set-hook", "-g", "-u", RESIZE_HOOK),
    tmux("set-hook", "-g", "-u", LEGACY_RESIZE_HOOK),
  ]);
}

async function isAutoOpenHookRegistered(): Promise<boolean> {
  try {
    const output = await tmux("show-hooks", "-g");
    return parseAutoOpenHook(output);
  } catch {
    return false;
  }
}

// window-resized is a window-scoped hook: set-hook -g stores it in the
// global window options, so it's listed by show-hooks -gw, not -g.
async function isResizeHookRegistered(): Promise<boolean> {
  try {
    const output = await tmux("show-hooks", "-gw");
    return parseResizeHook(output);
  } catch {
    return false;
  }
}

async function handleToggle(
  width: number,
  position: SidebarPosition,
): Promise<void> {
  const [state, hookRegistered] = await Promise.all([
    getAllPaneState(),
    isAutoOpenHookRegistered(),
  ]);

  const allWindows = [...state.windows.keys()];

  if (
    allWindows.length > 0 &&
    allWindows.every((w) => state.sidebarWindows.has(w))
  ) {
    await Promise.all([
      killSidebars(state.sidebarPaneIds),
      unregisterAutoOpenHook(),
      unregisterResizeHook(),
    ]);
    return;
  }

  const missing = allWindows.filter((w) => !state.sidebarWindows.has(w));
  const active = missing.filter((w) => state.activeWindows.has(w));
  const background = missing.filter((w) => !state.activeWindows.has(w));
  await Promise.all([
    ...active.map((w) =>
      spawnSidebarInWindow(
        w,
        width,
        position,
        SPAWN_BASE_DELAY_S,
        state.windows.get(w),
      ),
    ),
    ...background.map((w, i) =>
      spawnSidebarInWindow(
        w,
        width,
        position,
        spawnDelaySeconds(i),
        state.windows.get(w),
      ),
    ),
    ...(!hookRegistered ? [registerAutoOpenHook(width, position)] : []),
    registerResizeHook(width),
  ]);
}
