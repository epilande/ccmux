import { stat } from "fs/promises";
import { getPreferences, DEFAULT_SIDEBAR_WIDTH } from "../../lib/preferences";
import { PREFS_FILE } from "../../lib/config";
import { fetchWindowState, type WindowState } from "./tmux-window-state";

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

/** Gate inputs that cost nothing but local file I/O to gather. */
interface LocalDecision {
  settledWidth: number;
  configuredWidth: number;
  /** Age of the last preferences write in ms; null when unknown/no file. */
  prefsAgeMs: number | null;
}

/** Gate inputs that require querying live tmux window state (a subprocess). */
interface WindowDecision {
  settledWidth: number;
  /** Window width at settle time; null when tmux could not be queried. */
  windowWidth: number | null;
  /** Window width at the previous settle (or mount); null when unknown. */
  prevWindowWidth: number | null;
  /** Whether the sidebar's window is the active window; null when unknown. */
  windowActive: boolean | null;
  /** Whether the sidebar's session has an attached client; null when unknown. */
  sessionAttached: boolean | null;
}

type PersistDecision = LocalDecision & WindowDecision;

/**
 * The gates answerable from local state alone, split out so a settle that they
 * already reject never pays for a `tmux display-message` subprocess. Every
 * background sidebar sees the propagated resizes of every other one, so this is
 * the arm that fires most.
 *
 *   1. Degenerate widths — below MIN_PERSIST_WIDTH is a squeezed layout
 *      accident, never a preference.
 *   2. Quiet period — a recent prefs write means another sidebar just
 *      propagated a width, so this settle is that arriving, not user intent.
 *   3. No-op — settling at the configured width is the propagation echo.
 */
export function passesLocalGates(d: LocalDecision): boolean {
  if (d.settledWidth < MIN_PERSIST_WIDTH) return false;
  if (d.prefsAgeMs !== null && d.prefsAgeMs < PREFS_QUIET_MS) return false;
  return d.settledWidth !== d.configuredWidth;
}

/**
 * The gates that need live tmux window state.
 *
 * A user drag changes the pane's width while the window stays the same size.
 * Window resizes (session switch with window-size=latest, terminal resize)
 * change both, and the window-resized hook re-pins those, so they must not
 * be persisted. Unknown window widths fail safe: never persist.
 *
 * Two further gates make this safe when propagation latency exceeds the
 * settle window (the observed oscillation storm across many windows):
 *   1. Window-relative ceiling — a real drag never makes a sidebar most of the
 *      window; widths beyond half are layout artifacts (proportional rescales,
 *      dying neighbor panes) and must not become the preference.
 *   2. Focus gate — only the active window of an attached session can be under
 *      a live user drag; a background/detached sidebar settling is propagation.
 * Each gate fails safe: unknown inputs never persist.
 */
export function passesWindowGates(d: WindowDecision): boolean {
  if (d.windowWidth === null || d.prevWindowWidth === null) return false;
  if (d.windowWidth !== d.prevWindowWidth) return false;
  if (d.settledWidth * 2 > d.windowWidth) return false;
  if (d.windowActive !== true || d.sessionAttached !== true) return false;
  return true;
}

/**
 * Whether a settled pane width is a genuine user drag worth persisting.
 *
 * Every gate is a conjunct, so evaluation order cannot change the verdict —
 * only how much it costs to reach. `createSidebarWidthPersister` deliberately
 * evaluates the local half first and skips the tmux query when it already says
 * no; this predicate keeps the whole rule readable in one place.
 */
export function shouldPersistWidth(d: PersistDecision): boolean {
  return passesLocalGates(d) && passesWindowGates(d);
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

/** Seams for tests; each defaults to the real implementation. */
export interface WidthPersisterDeps {
  fetchWindowState: () => Promise<WindowState>;
  getPrefsAgeMs: () => Promise<number | null>;
  getConfiguredWidth: () => Promise<number>;
  applyWidth: (width: number) => void;
}

async function getConfiguredWidth(): Promise<number> {
  const prefs = await getPreferences();
  return prefs.sidebar?.width ?? DEFAULT_SIDEBAR_WIDTH;
}

/**
 * Returns a callback the sidebar invokes with its settled pane width.
 * When the settled width is a genuine user drag, it spawns
 * `ccmux sidebar --apply-width` to persist the preference and resize every
 * other sidebar. What counts as a drag is decided by the anti-oscillation gates
 * above; this wrapper only gathers their inputs and hands off. Propagated
 * resizes settle at the already-persisted width and no-op, so sidebars never
 * echo each other.
 *
 * Gathering is staged by cost: the local gates (prefs mtime, configured width)
 * run first, and only a settle that survives them pays for the tmux query. A
 * fleet of sidebars sees every propagated resize, so the rejected path is the
 * common one and used to cost one subprocess per sidebar per resize event.
 *
 * A skipped query also means `lastWindowWidth` is not refreshed, so a window
 * resize that happened during a suppressed settle is still visible to the next
 * one. That is the conservative direction: the "did the window change since we
 * last looked?" gate keeps a real observation instead of a settle it never
 * looked at silently consuming it.
 */
export function createSidebarWidthPersister(
  deps: Partial<WidthPersisterDeps> = {},
): (width: number) => void {
  const fetchState = deps.fetchWindowState ?? fetchWindowState;
  const prefsAge = deps.getPrefsAgeMs ?? getPrefsAgeMs;
  const configured = deps.getConfiguredWidth ?? getConfiguredWidth;
  const apply = deps.applyWidth ?? spawnApplyWidth;

  let lastWindowWidth: number | null = null;
  void fetchState().then((s) => {
    lastWindowWidth = s.windowWidth;
  });

  return (settledWidth: number) => {
    void (async () => {
      const [prefsAgeMs, configuredWidth] = await Promise.all([
        prefsAge(),
        configured(),
      ]);
      if (!passesLocalGates({ settledWidth, configuredWidth, prefsAgeMs })) {
        return;
      }

      const state = await fetchState();
      const prevWindowWidth = lastWindowWidth;
      lastWindowWidth = state.windowWidth;

      if (
        passesWindowGates({
          settledWidth,
          windowWidth: state.windowWidth,
          prevWindowWidth,
          windowActive: state.windowActive,
          sessionAttached: state.sessionAttached,
        })
      ) {
        apply(settledWidth);
      }
    })();
  };
}
