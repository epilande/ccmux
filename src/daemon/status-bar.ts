import {
  isStatusBarColor,
  isStatusBarIcon,
  type StatusBarConfig,
  type Preferences,
} from "../lib/preferences";
import {
  getStatusIcon,
  getAttentionIcon,
  isValidIconStyle,
  DOT_SPINNER_FRAMES,
  NERDFONT_SPINNER_FRAMES,
  type IconStyle,
} from "../lib/icons";
import { tmuxArgv } from "../lib/tmux-exec";
import type { Session, SessionStatus, TmuxPane } from "../types/session";
import { isVisibleSession, type SessionManager } from "./sessions";

const GLOBAL_OPTIONS = [
  "@ccmux_waiting",
  "@ccmux_unread",
  "@ccmux_working",
  "@ccmux_status",
] as const;

// ANSI names follow the terminal's palette, like the picker's status colors.
const DEFAULT_COLORS = {
  waiting: "red",
  unread: "green",
  working: "yellow",
  idle: "brightblack",
} as const;

type StatusSession = Pick<
  Session,
  "status" | "attentionState" | "tmuxPane" | "trackingMode" | "logPath"
>;
type WindowPane = Pick<TmuxPane, "paneId" | "windowId">;
type RunTmux = (args: string[]) => Promise<boolean>;

type MarkState = SessionStatus | "unread";
const STATE_PRIORITY: Record<MarkState, number> = {
  idle: 0,
  working: 1,
  unread: 2,
  waiting: 3,
};
const DOT_ACTIVITY_ICONS = { working: "◐", idle: "○" } as const;
const ANIMATED_WORKING_ICONS = {
  dot: `#{A/2:${DOT_SPINNER_FRAMES.join(",")}}`,
  nerdfont: `#{A/2:${NERDFONT_SPINNER_FRAMES.join(",")}}`,
};

function marker(
  config: StatusBarConfig,
  state: MarkState,
  style: IconStyle,
  count = "",
  animateWorking = false,
): string {
  const attention = state === "waiting" || state === "unread" ? state : null;
  const icon = attention ? config[`${attention}Icon`] : undefined;
  const defaultIcon =
    state === "working" &&
    animateWorking &&
    (style === "dot" || style === "nerdfont")
      ? ANIMATED_WORKING_ICONS[style]
      : state === "unread"
        ? getAttentionIcon("unread", style)
        : style === "dot" && (state === "working" || state === "idle")
          ? DOT_ACTIVITY_ICONS[state]
          : getStatusIcon(state, null, style);
  const text = [isStatusBarIcon(icon) ? icon : defaultIcon, count]
    .filter(Boolean)
    .join(" ");
  if (!text) return "";
  const configured = attention ? config[`${attention}Color`] : undefined;
  // Inheriting by default rendered black on themed bars that leave
  // status-style's fg alone; empty is the explicit opt-out.
  const color = isStatusBarColor(configured)
    ? configured
    : DEFAULT_COLORS[state];
  return color ? `#[fg=${color}]${text}#[fg=default]` : text;
}

export function statusBarValues(
  sessions: readonly StatusSession[],
  panes: readonly WindowPane[],
  config: StatusBarConfig,
  iconStyle: IconStyle = "dot",
  animationSupported = false,
) {
  const style = isValidIconStyle(iconStyle) ? iconStyle : "dot";
  let waiting = 0;
  let unread = 0;
  let working = 0;
  const paneWindows = new Map(
    panes.map((pane) => [pane.paneId, pane.windowId]),
  );
  const states = new Map<string, MarkState>();
  for (const session of sessions) {
    // Count only what the picker lists: a soft-evicted pane session keeps its
    // last status until reaped, and a count with no row behind it misleads.
    if (!isVisibleSession(session)) continue;
    if (session.status === "waiting") waiting++;
    if (session.attentionState === "unread") unread++;
    if (session.status === "working") working++;
    const state =
      session.status === "waiting"
        ? "waiting"
        : session.attentionState === "unread"
          ? "unread"
          : session.status;
    const window = session.tmuxPane && paneWindows.get(session.tmuxPane);
    if (window && session.trackingMode !== "background") {
      const current = states.get(window);
      if (
        current === undefined ||
        STATE_PRIORITY[state] > STATE_PRIORITY[current]
      )
        states.set(window, state);
    }
  }
  const globals = new Map<string, string>([
    ["@ccmux_waiting", String(waiting)],
    ["@ccmux_unread", String(unread)],
    ["@ccmux_working", String(working)],
    [
      "@ccmux_status",
      [
        waiting ? marker(config, "waiting", style, String(waiting)) : "",
        unread ? marker(config, "unread", style, String(unread)) : "",
      ]
        .filter(Boolean)
        .join(" "),
    ],
  ]);
  // Include quiet windows so startup also clears marks left by a crashed daemon.
  const windows = new Map<string, string | null>();
  const stateMarks = new Map<string, string | null>();
  for (const pane of panes) {
    if (!pane.windowId) continue;
    const state = states.get(pane.windowId);
    const mark =
      state === "waiting" || state === "unread" ? marker(config, state, style) : "";
    // The mark carries its own leading space so a plain `#W#{@ccmux_mark}`
    // separates it from the name, and a quiet window adds nothing.
    windows.set(pane.windowId, mark ? ` ${mark}` : null);
    const stateMark = state
      ? marker(
          config,
          state,
          style,
          "",
          config.animateWorking === true && animationSupported,
        )
      : "";
    stateMarks.set(pane.windowId, stateMark ? ` ${stateMark}` : null);
  }
  return { globals, windows, stateMarks };
}

async function runTmux(args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(tmuxArgv(...args), {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function readTmuxServerVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn(tmuxArgv("display-message", "-p", "#{version}"), {
      stdout: "pipe",
      stderr: "ignore",
    });
    const version = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? version.trim() : null;
  } catch {
    return null;
  }
}

/** One serialized writer: change bursts coalesce, and shutdown drains before unsetting. */
export class StatusBar {
  private active = false;
  // Stay quiet until a pane scan confirms a server, including during startup.
  private serverAvailable = false;
  private dirty = false;
  private resetCache = false;
  private pending: Promise<void> | null = null;
  private panes: readonly WindowPane[] = [];
  private globals = new Map<string, string>();
  private windows = new Map<string, string | null>();
  private stateMarks = new Map<string, string | null>();
  private animationSupported: boolean | undefined;
  private readonly listener = () => {
    this.refresh();
  };

  constructor(
    private readonly sessions: SessionManager,
    private readonly prefs: Pick<Preferences, "statusBar" | "iconStyle"> = {},
    private readonly run: RunTmux = runTmux,
    private readonly readVersion: () => Promise<string | null> =
      readTmuxServerVersion,
  ) {}

  start(): void {
    if (this.active || this.prefs.statusBar?.enabled === false) return;
    this.active = true;
    this.sessions.on("change", this.listener);
    this.refresh();
  }

  /** The existing daemon scan supplies topology changes even when session state is unchanged. */
  updatePanes(panes: readonly WindowPane[], noServer = false): void {
    this.panes = panes;
    this.serverAvailable = !noServer;
    // tmux restarts can reuse window IDs; old successful writes no longer exist.
    if (noServer) {
      this.resetCache = true;
    }
    this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.active || !this.serverAvailable) return Promise.resolve();
    this.dirty = true;
    if (!this.pending) {
      this.pending = Promise.resolve().then(async () => {
        try {
          while (this.active && this.dirty) {
            this.dirty = false;
            await this.sync();
          }
        } finally {
          this.pending = null;
        }
      });
    }
    return this.pending;
  }

  private async write(args: string[]): Promise<boolean> {
    // A no-server scan can arrive while the preceding write is in flight.
    if (!this.serverAvailable) return false;
    try {
      return await this.run(args);
    } catch {
      return false;
    }
  }

  private async sync(): Promise<void> {
    if (!this.serverAvailable) return;
    if (this.resetCache) {
      this.globals.clear();
      this.windows.clear();
      this.resetCache = false;
      this.stateMarks.clear();
      this.animationSupported = undefined;
    }
    if (
      this.prefs.statusBar?.animateWorking === true &&
      this.animationSupported === undefined
    ) {
      const version = await this.readVersion();
      if (!this.serverAvailable || this.resetCache) return;
      if (version !== null) {
        const match = /^(\d+)\.(\d+)(?:[a-z]|-next)?$/.exec(version);
        this.animationSupported =
          match !== null &&
          (Number(match[1]) > 3 ||
            (Number(match[1]) === 3 && Number(match[2]) >= 8));
      }
    }
    const { globals, windows, stateMarks } = statusBarValues(
      this.sessions.getSessions(),
      this.panes,
      this.prefs.statusBar ?? {},
      this.prefs.iconStyle,
      this.animationSupported,
    );
    for (const [name, value] of globals) {
      if (this.globals.get(name) === value) continue;
      if (await this.write(["set-option", "-g", name, value]))
        this.globals.set(name, value);
    }
    await this.syncWindows(windows, this.windows, "@ccmux_mark");
    await this.syncWindows(stateMarks, this.stateMarks, "@ccmux_state_mark");
  }

  private async syncWindows(
    values: ReadonlyMap<string, string | null>,
    cache: Map<string, string | null>,
    option: "@ccmux_mark" | "@ccmux_state_mark",
  ): Promise<void> {
    for (const window of cache.keys()) {
      if (!values.has(window)) {
        await this.write(["set-option", "-qwu", "-t", window, option]);
        // No longer on the tracked server: a destroyed window needs no retry.
        cache.delete(window);
      }
    }
    for (const [window, value] of values) {
      if (cache.has(window) && cache.get(window) === value) continue;
      const args =
        value === null
          ? ["set-option", "-qwu", "-t", window, option]
          : ["set-option", "-w", "-t", window, option, value];
      if (await this.write(args)) cache.set(window, value);
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.sessions.off("change", this.listener);
    await this.pending;
    for (const name of GLOBAL_OPTIONS)
      await this.write(["set-option", "-gu", name]);
    // Windows cached as null are already clear.
    for (const [option, cache] of [
      ["@ccmux_mark", this.windows],
      ["@ccmux_state_mark", this.stateMarks],
    ] as const) {
      for (const [window, value] of cache) {
        if (value === null) continue;
        await this.write(["set-option", "-qwu", "-t", window, option]);
      }
      cache.clear();
    }
    this.globals.clear();
    this.animationSupported = undefined;
  }
}
