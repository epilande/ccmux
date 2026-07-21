import { stat } from "fs/promises";
import { getPreferences, DEFAULT_SIDEBAR_WIDTH } from "../../lib/preferences";
import { PREFS_FILE } from "../../lib/config";
import { PANE_FIELD_SEP } from "../../lib/tmux-format";

/** Quiet period after the last pane-width change before we treat it as settled.
 * First line of defense against oscillation: lets a transient proportional
 * rescale collapse back before we ever look at it. Not sufficient alone — see
 * the anti-oscillation gates in `shouldPersistWidth` for what keeps the system
 * safe once propagation latency exceeds this window. */
export const WIDTH_SETTLE_MS = 800;

/** Widths below this are layout accidents (squeezed panes), never preferences. */
const MIN_PERSIST_WIDTH = 10;

/** Quiet period after the preferences file last changed during which we refuse
 * to persist. A recent prefs write means another sidebar just propagated a
 * width and this settle is the propagation arriving, not user intent. Sized to
 * outlast propagation latency on a heavily loaded machine (measured ~3s per
 * subprocess spawn under load), with generous headroom for staggered fan-out.
 * Deliberately keys off ANY prefs write (the mtime is file-wide, not
 * width-specific): a false suppress self-heals on the next settle, while a
 * missed suppress re-arms the oscillation. */
export const PREFS_QUIET_MS = 15_000;

interface PersistDecision {
  settledWidth: number;
  configuredWidth: number;
  /** Window width at settle time; null when tmux could not be queried. */
  windowWidth: number | null;
  /** Window width at the previous settle (or mount); null when unknown. */
  prevWindowWidth: number | null;
  /** Whether the sidebar's window is the active window; null when unknown. */
  windowActive: boolean | null;
  /** Whether the sidebar's session has an attached client; null when unknown. */
  sessionAttached: boolean | null;
  /** Age of the last preferences write in ms; null when unknown/no file. */
  prefsAgeMs: number | null;
}

/**
 * A user drag changes the pane's width while the window stays the same size.
 * Window resizes (session switch with window-size=latest, terminal resize)
 * change both, and the window-resized hook re-pins those, so they must not
 * be persisted. Unknown window widths fail safe: never persist.
 *
 * Three further gates make this safe when propagation latency exceeds the
 * settle window (the observed oscillation storm across many windows):
 *   1. Window-relative ceiling — a real drag never makes a sidebar most of the
 *      window; widths beyond half are layout artifacts (proportional rescales,
 *      dying neighbor panes) and must not become the preference.
 *   2. Focus gate — only the active window of an attached session can be under
 *      a live user drag; a background/detached sidebar settling is propagation.
 *   3. Quiet period — a recent prefs write means another sidebar just
 *      propagated a width, so this settle is that arriving, not user intent.
 * Each gate fails safe: unknown inputs never persist.
 */
export function shouldPersistWidth(d: PersistDecision): boolean {
  if (d.settledWidth < MIN_PERSIST_WIDTH) return false;
  if (d.windowWidth === null || d.prevWindowWidth === null) return false;
  if (d.windowWidth !== d.prevWindowWidth) return false;
  if (d.settledWidth * 2 > d.windowWidth) return false;
  if (d.windowActive !== true || d.sessionAttached !== true) return false;
  if (d.prefsAgeMs !== null && d.prefsAgeMs < PREFS_QUIET_MS) return false;
  return d.settledWidth !== d.configuredWidth;
}

interface WindowState {
  windowWidth: number | null;
  windowActive: boolean | null;
  sessionAttached: boolean | null;
}

const UNKNOWN_WINDOW_STATE: WindowState = {
  windowWidth: null,
  windowActive: null,
  sessionAttached: null,
};

async function getWindowState(): Promise<WindowState> {
  const pane = process.env.TMUX_PANE;
  if (!pane) return UNKNOWN_WINDOW_STATE;
  try {
    const format = [
      "#{window_width}",
      "#{window_active}",
      "#{session_attached}",
    ].join(PANE_FIELD_SEP);
    const proc = Bun.spawn(
      ["tmux", "display-message", "-p", "-t", pane, format],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const parts = out.split(PANE_FIELD_SEP);
    if (parts.length < 3) return UNKNOWN_WINDOW_STATE;
    const width = Number.parseInt(parts[0], 10);
    const active = Number.parseInt(parts[1], 10);
    // session_attached is a count of attached clients (>0 means attached).
    const attached = Number.parseInt(parts[2], 10);
    return {
      windowWidth: Number.isInteger(width) ? width : null,
      windowActive: Number.isInteger(active) ? active === 1 : null,
      sessionAttached: Number.isInteger(attached) ? attached > 0 : null,
    };
  } catch {
    return UNKNOWN_WINDOW_STATE;
  }
}

/** Age of the last preferences write in ms, or null when the file is missing or
 * cannot be stat'd (no file → no propagation in flight → persist allowed). */
async function getPrefsAgeMs(): Promise<number | null> {
  try {
    const s = await stat(PREFS_FILE);
    return Date.now() - s.mtimeMs;
  } catch {
    return null;
  }
}

function spawnApplyWidth(width: number): void {
  Bun.spawn(["ccmux", "sidebar", "--apply-width", String(width)], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * Returns a callback the sidebar invokes with its settled pane width.
 * When the settled width is a genuine user drag, it spawns
 * `ccmux sidebar --apply-width` to persist the preference and resize every
 * other sidebar. What counts as a drag is decided by `shouldPersistWidth`'s
 * anti-oscillation gates; this wrapper only gathers their inputs (tmux window
 * state, prefs age) and hands off. Propagated resizes settle at the
 * already-persisted width and no-op, so sidebars never echo each other.
 */
export function createSidebarWidthPersister(): (width: number) => void {
  let lastWindowWidth: number | null = null;
  void getWindowState().then((s) => {
    lastWindowWidth = s.windowWidth;
  });

  return (settledWidth: number) => {
    void (async () => {
      const [state, prefsAgeMs, prefs] = await Promise.all([
        getWindowState(),
        getPrefsAgeMs(),
        getPreferences(),
      ]);
      const prevWindowWidth = lastWindowWidth;
      lastWindowWidth = state.windowWidth;

      const configuredWidth = prefs.sidebar?.width ?? DEFAULT_SIDEBAR_WIDTH;
      if (
        shouldPersistWidth({
          settledWidth,
          configuredWidth,
          windowWidth: state.windowWidth,
          prevWindowWidth,
          windowActive: state.windowActive,
          sessionAttached: state.sessionAttached,
          prefsAgeMs,
        })
      ) {
        spawnApplyWidth(settledWidth);
      }
    })();
  };
}
