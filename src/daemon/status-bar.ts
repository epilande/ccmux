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
  type IconStyle,
} from "../lib/icons";
import { tmuxArgv } from "../lib/tmux-exec";
import type { Session, TmuxPane } from "../types/session";
import type { SessionManager } from "./sessions";

const GLOBAL_OPTIONS = [
  "@ccmux_waiting",
  "@ccmux_unread",
  "@ccmux_working",
  "@ccmux_status",
] as const;

type StatusSession = Pick<
  Session,
  "status" | "attentionState" | "tmuxPane" | "trackingMode"
>;
type WindowPane = Pick<TmuxPane, "paneId" | "windowId">;
type RunTmux = (args: string[]) => Promise<boolean>;

function marker(
  config: StatusBarConfig,
  state: "waiting" | "unread",
  style: IconStyle,
  count = "",
): string {
  const icon = config[`${state}Icon`];
  const defaultIcon =
    state === "waiting"
      ? getStatusIcon("waiting", null, style)
      : getAttentionIcon("unread", style);
  const text = `${isStatusBarIcon(icon) ? icon : defaultIcon}${count}`;
  if (!text) return "";
  const color = config[`${state}Color`];
  return color && isStatusBarColor(color)
    ? `#[fg=${color}]${text}#[fg=default]`
    : text;
}

export function statusBarValues(
  sessions: readonly StatusSession[],
  panes: readonly WindowPane[],
  config: StatusBarConfig,
  iconStyle: IconStyle = "dot",
) {
  const style = isValidIconStyle(iconStyle) ? iconStyle : "dot";
  let waiting = 0;
  let unread = 0;
  let working = 0;
  const paneWindows = new Map(
    panes.map((pane) => [pane.paneId, pane.windowId]),
  );
  const urgency = new Map<string, "waiting" | "unread">();
  for (const session of sessions) {
    if (session.status === "waiting") waiting++;
    if (session.attentionState === "unread") unread++;
    if (session.status === "working") working++;
    const state =
      session.status === "waiting"
        ? "waiting"
        : session.attentionState === "unread"
          ? "unread"
          : null;
    const window = session.tmuxPane && paneWindows.get(session.tmuxPane);
    if (
      state &&
      window &&
      session.trackingMode !== "background" &&
      urgency.get(window) !== "waiting"
    ) {
      urgency.set(window, state);
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
  for (const pane of panes) {
    if (!pane.windowId) continue;
    const state = urgency.get(pane.windowId);
    windows.set(
      pane.windowId,
      state ? marker(config, state, style) || null : null,
    );
  }
  return { globals, windows };
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

/** One serialized writer: change bursts coalesce, and shutdown drains before unsetting. */
export class StatusBar {
  private active = false;
  private dirty = false;
  private resetCache = false;
  private pending: Promise<void> | null = null;
  private panes: readonly WindowPane[] = [];
  private globals = new Map<string, string>();
  private windows = new Map<string, string | null>();
  private readonly listener = () => {
    this.refresh();
  };

  constructor(
    private readonly sessions: SessionManager,
    private readonly prefs: Pick<Preferences, "statusBar" | "iconStyle"> = {},
    private readonly run: RunTmux = runTmux,
  ) {}

  start(): void {
    if (this.active || this.prefs.statusBar?.enabled !== true) return;
    this.active = true;
    this.sessions.on("change", this.listener);
    this.refresh();
  }

  /** The existing daemon scan supplies topology changes even when session state is unchanged. */
  updatePanes(panes: readonly WindowPane[], noServer = false): void {
    if (!this.active) return;
    this.panes = panes;
    // tmux restarts can reuse window IDs; old successful writes no longer exist.
    if (noServer) {
      this.resetCache = true;
    }
    this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.active) return Promise.resolve();
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
    try {
      return await this.run(args);
    } catch {
      return false;
    }
  }

  private async sync(): Promise<void> {
    if (this.resetCache) {
      this.globals.clear();
      this.windows.clear();
      this.resetCache = false;
    }
    const { globals, windows } = statusBarValues(
      this.sessions.getSessions(),
      this.panes,
      this.prefs.statusBar ?? {},
      this.prefs.iconStyle,
    );
    for (const [name, value] of globals) {
      if (this.globals.get(name) === value) continue;
      if (await this.write(["set-option", "-g", name, value]))
        this.globals.set(name, value);
    }
    for (const window of this.windows.keys()) {
      if (!windows.has(window)) {
        await this.write(["set-option", "-qwu", "-t", window, "@ccmux_mark"]);
        // No longer on the tracked server: a destroyed window needs no retry.
        this.windows.delete(window);
      }
    }
    for (const [window, value] of windows) {
      if (this.windows.has(window) && this.windows.get(window) === value)
        continue;
      const args =
        value === null
          ? ["set-option", "-qwu", "-t", window, "@ccmux_mark"]
          : ["set-option", "-w", "-t", window, "@ccmux_mark", value];
      if (await this.write(args)) this.windows.set(window, value);
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.sessions.off("change", this.listener);
    await this.pending;
    for (const name of GLOBAL_OPTIONS)
      await this.write(["set-option", "-gu", name]);
    for (const window of this.windows.keys()) {
      await this.write(["set-option", "-qwu", "-t", window, "@ccmux_mark"]);
    }
    this.globals.clear();
    this.windows.clear();
  }
}
