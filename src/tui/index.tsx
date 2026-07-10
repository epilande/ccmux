import { render } from "@opentui/solid";
import {
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
  type CliRendererConfig,
} from "@opentui/core";
import { App } from "./App";
import type { IconStyle } from "../lib/icons";
import type {
  ColumnsConfig,
  BreakpointConfig,
  PromptDisplay,
  ThemeConfig,
  Preferences,
} from "../lib/preferences";
import { applyTheme } from "./theme";
import type { GroupBy } from "./utils/grouping";
import { PERF_ENABLED } from "./utils/perf";
import { findRestorePane, selectPane } from "./utils/tmux";
import { markStartup } from "../lib/startup-timing";

interface TUIOptions {
  initialPreview?: boolean;
  iconStyle?: IconStyle;
  previewWidth?: number;
  columns?: ColumnsConfig;
  breakpoints?: BreakpointConfig;
  searchPaneContent?: boolean;
  searchPaneLines?: number;
  searchTranscript?: boolean;
  groupBy?: GroupBy;
  collapsedGroups?: string[];
  pinnedGroups?: string[];
  hideIdle?: boolean;
  promptDisplay?: PromptDisplay;
  persistent?: boolean;
  sidebar?: boolean;
  theme?: ThemeConfig;
  reviewHandback?: Preferences["reviewHandback"];
}

/** Quiet-period after the last CAPABILITIES event before we restore focus.
 * Probe replies trickle in over a few ms; a single CAPABILITIES event isn't
 * enough. Debouncing on the last one ensures all replies have been consumed
 * before we hand focus back. */
const CAPABILITY_QUIET_MS = 250;
/** Hard ceiling: if probe replies never settle (terminal dropped them),
 * restore focus anyway so we don't leave the user stranded in the sidebar. */
const CAPABILITY_HARD_CAP_MS = 5000;

/**
 * When the sidebar spawns into an unfocused pane (via `--toggle` or the
 * `after-new-window` hook's `split-window -d`), OpenTUI's terminal-
 * capability probes get sent through tmux DCS passthrough, but tmux routes
 * the replies to the focused pane (i.e. the user's shell), where they
 * echo as gibberish.
 *
 * Dance: steal focus to ourselves before probes fire, let OpenTUI consume
 * the replies, then restore focus once CAPABILITIES events quiesce.
 */
function arrangeSidebarFocusDance(
  renderer: CliRenderer,
  restoreTarget: string,
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void selectPane(restoreTarget);
  };

  renderer.on(CliRenderEvents.CAPABILITIES, () => {
    if (restored) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(restore, CAPABILITY_QUIET_MS);
  });

  setTimeout(restore, CAPABILITY_HARD_CAP_MS);
}

export async function launchTUI(options: TUIOptions = {}): Promise<void> {
  markStartup("render_start");

  // Resolve the theme into the live singleton before any component renders.
  // Launch-time only: no in-TUI toggle, no reactivity.
  applyTheme(options.theme);

  const config: CliRendererConfig = {
    useMouse: true,
    gatherStats: PERF_ENABLED,
  };

  // Sidebar spawned via -d into an unfocused pane needs the focus dance
  // to keep terminal capability probe replies from leaking into the
  // user's shell. Picker/non-sidebar TUIs run in the user's own focused
  // pane, so the dance is a no-op there.
  let rendererOrConfig: CliRenderer | typeof config = config;
  if (options.sidebar && process.env.TMUX_PANE) {
    const restoreTarget = await findRestorePane();
    if (restoreTarget) {
      await selectPane(process.env.TMUX_PANE);
      const renderer = await createCliRenderer(config);
      arrangeSidebarFocusDance(renderer, restoreTarget);
      rendererOrConfig = renderer;
    }
  }

  await render(
    () => (
      <App
        initialPreview={options.initialPreview}
        iconStyle={options.iconStyle}
        previewWidth={options.previewWidth}
        columns={options.columns}
        breakpoints={options.breakpoints}
        searchPaneContent={options.searchPaneContent}
        searchPaneLines={options.searchPaneLines}
        searchTranscript={options.searchTranscript}
        groupBy={options.groupBy}
        collapsedGroups={options.collapsedGroups}
        pinnedGroups={options.pinnedGroups}
        hideIdle={options.hideIdle}
        promptDisplay={options.promptDisplay}
        persistent={options.persistent}
        sidebar={options.sidebar}
        reviewHandback={options.reviewHandback}
      />
    ),
    rendererOrConfig,
  );
}
