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
import { tmuxArgv } from "../lib/tmux-exec";
import { forkableAgentNames } from "../lib/agents";

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
 * command. The resize hook needs no prefix at all: it is pure shell and never
 * starts a ccmux process (see `resizeHookCommand`).
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
const AUTO_OPEN_HOOKS = ["after-new-window[99]", "after-new-session[99]"];
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
        // --resize is no longer used by the hook this build registers (that is
        // pure shell now, see resizeHookCommand), but a tmux server running
        // since before the upgrade still holds a hook body that invokes it, and
        // hooks live in the server until the user next toggles the sidebar off.
        // Keep the path working: it runs from run-shell where TMUX is not set,
        // and skips getPreferences() since the width is baked into the command.
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
          Bun.spawn(
            tmuxArgv("select-pane", "-t", selfPane, "-T", SIDEBAR_PANE_TITLE),
          );
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
          selfPane ? repinSidebarPaneWidth(selfPane, width) : Promise.resolve(),
          repairResizeHook(width),
        ]);
        markStartup("daemon_ready");

        await tui.launchTUI({
          initialPreview: false,
          iconStyle: prefs.iconStyle ?? "dot",
          columns: prefs.sidebar?.columns ?? prefs.columns,
          promptLines: prefs.sidebar?.promptLines ?? prefs.promptLines,
          breakpoints: prefs.breakpoints,
          ageFadeAfter: prefs.ageFade?.after,
          attentionBand: prefs.attentionBand,
          searchPaneContent: prefs.searchPaneContent,
          searchPaneLines: prefs.searchPaneLines,
          searchTranscript: prefs.searchTranscript,
          groupBy: uiState.groupBy ?? prefs.groupBy,
          collapsedGroups: uiState.collapsedGroups,
          pinnedGroups: uiState.pinnedGroups,
          hideIdle: uiState.hideIdle,
          promptDisplay: resolvePromptDisplay(uiState, prefs.promptDisplay),
          sidebar: true,
          lastSpawnAgent: uiState.lastSpawnAgent,
          reviewHandback: prefs.reviewHandback,
          forkableAgents: forkableAgentNames(prefs),
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
  return AUTO_OPEN_HOOKS.some((hook) => hasHookLine(output, hook));
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

/**
 * Whether the resize hook is registered. Older builds registered a body that
 * booted `ccmux sidebar --resize`; the current one is pure shell and only
 * mentions the sidebar *pane title*. Both count: a tmux server that has been
 * running since before the upgrade still holds the old body, and recognizing it
 * is what lets the next `--apply-width` replace it with the cheap one.
 */
export function parseResizeHook(output: string): boolean {
  return output
    .split("\n")
    .some(
      (line) =>
        line.includes(RESIZE_HOOK) &&
        (line.includes(SIDEBAR_PANE_TITLE) || line.includes("ccmux sidebar")),
    );
}

async function runTmux(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim();
}

async function tmux(...args: string[]): Promise<string> {
  return runTmux(tmuxArgv(...args));
}

function tmuxWithSocket(socket?: string, ...args: string[]): Promise<string> {
  // A socket reaching here comes from a pre-upgrade hook body that already
  // names its own server (see `--resize` above), so it bypasses the builder:
  // adding this process's `-L`/`-S` on top would name two.
  if (socket) return runTmux(["tmux", "-S", socket, ...args]);
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
  // Native probes are direct. launchTUI supplies a truecolor hint to skip
  // palette queries, which use passthrough on tmux older than 3.6.
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

/**
 * One-shot boot re-pin: force this pane to the configured width.
 *
 * A sidebar pane can settle at the wrong width with no later resize event to
 * correct it: a window resized between pane creation and this process setting
 * its title evades `window-resized[99]`'s title filter (the pane is still
 * untitled), and a server left mid-upgrade can lack that hook entirely, since
 * a pre-`after-new-session` build's toggle-off removed only the hooks it
 * knew. Re-pin here so the pane converges on boot regardless of how it was
 * resized.
 */
export async function repinSidebarPaneWidth(
  paneId: string,
  width: number,
): Promise<void> {
  try {
    const current = Number.parseInt(
      await tmux("display-message", "-p", "-t", paneId, "#{pane_width}"),
      10,
    );
    if (!Number.isInteger(current) || current === width) return;
    await tmux("resize-pane", "-t", paneId, "-x", String(width));
  } catch {
    // Pane died mid-boot; nothing to pin.
  }
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
    // Auto-open and resize hooks bake in the width; a standalone sidebar has neither.
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
  await Promise.all(
    AUTO_OPEN_HOOKS.map((hook) =>
      tmux(
        "set-hook",
        "-g",
        hook,
        hook === "after-new-session[99]"
          ? sessionAutoOpenHookCommand(width, position)
          : cmd,
      ),
    ),
  );
}

/** Polls before giving up on a client and splitting at the current size. */
const ATTACH_WAIT_POLLS = 10;

/**
 * The `after-new-session[99]` body: a bounded wait for the session's first
 * client, then the sidebar split.
 *
 * Unlike `after-new-window[99]`, this hook fires while the initial window
 * may still be at its pre-client size: a detached `new-session` starts at
 * default-size, and the attaching client resizes it moments later, which
 * redistributes pane widths proportionally. Splitting at the pre-attach
 * size balloons the sidebar (a 47-column pane at 80 columns rescales to
 * ~140 at a 270-column client) until a re-pin lands, a visible flash. So the
 * body waits for `session_attached` and splits into the now-client-sized
 * window; sessions never attached still get their sidebar after the wait.
 *
 * Format escaping follows `resizeHookCommand`: the body is single-quoted at
 * the tmux layer and deliberately contains no quote of its own, so it cannot
 * nest inside an `if-shell` argument without a second escaping level — the
 * session-group guard therefore reads the same two formats from the shell.
 * `#{pane_id}`, `#{socket_path}`, and `#{pane_current_path}` are baked when
 * the hook fires; `##{...}` survives that expansion as the literal the inner
 * tmux calls must interpret at run time.
 */
export function sessionAutoOpenHookCommand(
  width: number,
  position: SidebarPosition,
): string {
  const splitArgs =
    position === "left" ? `-fhbd -l ${width}` : `-fhd -l ${width}`;
  const inner = [
    `g=$(tmux -S "#{socket_path}" display-message -p -t "#{pane_id}" -F "##{session_grouped}:##{session_group_size}" 2>/dev/null) || exit 0`,
    `[ "\${g%%:*}" = "1" ] && [ "\${g#*:}" != "1" ] && exit 0`,
    `i=0; while [ $i -lt ${ATTACH_WAIT_POLLS} ] && [ "$(tmux -S "#{socket_path}" display-message -p -t "#{pane_id}" -F "##{session_attached}" 2>/dev/null)" = "0" ]; do i=$((i+1)); sleep 0.1; done`,
    `tmux -S "#{socket_path}" split-window ${splitArgs} -c "#{pane_current_path}" -t "#{pane_id}" "${sidebarSpawnCmd(SPAWN_BASE_DELAY_S)}"`,
  ].join("; ");
  return `run-shell -b '${inner}'`;
}

async function unregisterAutoOpenHook(): Promise<void> {
  await Promise.all(
    AUTO_OPEN_HOOKS.map((hook) => tmux("set-hook", "-g", "-u", hook)),
  );
}

/**
 * The `window-resized` hook body: re-pin the resized window's sidebar to the
 * baked width, in pure shell.
 *
 * This runs on *every* window that changes size, and a client attach or a
 * session switch with `window-size=latest` resizes them all at once. Booting
 * `ccmux sidebar --resize` here cost ~120ms of CLI startup per firing and then
 * re-pinned every sidebar on the server (`list-panes -a`), so N windows meant
 * N boots x N resize-panes. Pure shell scoped to `#{hook_window}` makes each
 * firing two short-lived tmux clients and touches only its own window.
 *
 * Format escaping is load-bearing (verified live on tmux 3.6a):
 *   - `#{socket_path}` / `#{hook_window}` expand when `run-shell` fires, so the
 *     body already names the right server and window before /bin/sh sees it.
 *   - `##{pane_id}` / `##{pane_title}` must survive that expansion as literal
 *     `#{...}` for the inner `list-panes` to interpret, hence the doubled `#`.
 * The body is single-quoted at the tmux layer, which cannot escape a quote of
 * its own, so it deliberately contains no `'`.
 */
export function resizeHookCommand(width: number): string {
  const inner = [
    `tmux -S "#{socket_path}" list-panes -t "#{hook_window}"`,
    `-F "##{pane_id}" -f "##{==:##{pane_title},${SIDEBAR_PANE_TITLE}}" 2>/dev/null`,
    `| while read -r p; do tmux -S "#{socket_path}" resize-pane -t "$p" -x ${width} 2>/dev/null; done`,
  ].join(" ");
  return `run-shell -b '${inner}'`;
}

async function registerResizeHook(width: number): Promise<void> {
  await tmux("set-hook", "-g", RESIZE_HOOK, resizeHookCommand(width));
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

/**
 * Repair a hook set left lopsided by a mixed-version upgrade: a build from
 * before `after-new-session[99]` existed unregisters only the hook names it
 * knows, so its toggle-off leaves that new hook live with no
 * `window-resized[99]` left to re-pin widths after window resizes. Every
 * sidebar boot re-arms the resize hook on such a server; a standalone
 * sidebar (no auto-open hooks) still installs nothing.
 */
export async function repairResizeHook(width: number): Promise<void> {
  const [autoOpen, resize] = await Promise.all([
    isAutoOpenHookRegistered(),
    isResizeHookRegistered(),
  ]);
  if (autoOpen && !resize) await registerResizeHook(width);
}

async function handleToggle(
  width: number,
  position: SidebarPosition,
): Promise<void> {
  const state = await getAllPaneState();

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
    registerAutoOpenHook(width, position),
    registerResizeHook(width),
  ]);
}
