import { render } from "@opentui/solid";
import { createCliRenderer, type CliRendererConfig } from "@opentui/core";
import { App } from "./App";
import type { IconStyle } from "../lib/icons";
import type {
  ColumnsConfig,
  BreakpointConfig,
  PromptDisplay,
  ThemeConfig,
  Preferences,
  ColumnHeaderMode,
} from "../lib/preferences";
import { applyTheme } from "./theme";
import type { GroupBy } from "./utils/grouping";
import { PERF_ENABLED } from "./utils/perf";
import { markStartup } from "../lib/startup-timing";

interface TUIOptions {
  initialPreview?: boolean;
  iconStyle?: IconStyle;
  previewWidth?: number;
  columns?: ColumnsConfig;
  promptLines?: number;
  breakpoints?: BreakpointConfig;
  ageFadeAfter?: number;
  columnHeader?: ColumnHeaderMode;
  attentionBand?: boolean;
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
  lastSpawnAgent?: string;
  theme?: ThemeConfig;
  reviewHandback?: Preferences["reviewHandback"];
  forkableAgents?: string[];
}

export async function launchTUI(options: TUIOptions = {}): Promise<void> {
  markStartup("render_start");

  // Resolve the theme into the live singleton before any component renders.
  // Launch-time only: no in-TUI toggle, no reactivity.
  applyTheme(options.theme);

  const config: CliRendererConfig = {
    useMouse: true,
    gatherStats: PERF_ENABLED,
    ...(options.sidebar && process.env.TMUX
      ? { environment: { COLORTERM: "truecolor" } }
      : {}),
  };

  const renderer = await createCliRenderer(config);

  // Quit paths exit via process.exit(), which skips OpenTUI's `beforeExit`
  // cleanup (its signal handlers do fire, but `process.exit` emits only
  // `exit`), leaving mouse tracking and the alternate screen armed on the
  // host terminal (issue #125). destroy() is idempotent, so it is safe here
  // even when a signal-driven destroy already ran, and it restores the
  // terminal synchronously as long as no frame callback awaits real I/O
  // (destroy() during a live render pass defers the restore to the render
  // loop, which never resumes once process.exit is in flight). The catch
  // matters: destroy() runs every Solid onCleanup before the native restore,
  // and a throw there would skip the restore and reinstate #125.
  process.on("exit", () => {
    try {
      renderer.destroy();
    } catch {}
  });

  await render(
    () => (
      <App
        initialPreview={options.initialPreview}
        iconStyle={options.iconStyle}
        previewWidth={options.previewWidth}
        columns={options.columns}
        promptLines={options.promptLines}
        breakpoints={options.breakpoints}
        ageFadeAfter={options.ageFadeAfter}
        columnHeader={options.columnHeader}
        attentionBand={options.attentionBand}
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
        lastSpawnAgent={options.lastSpawnAgent}
        reviewHandback={options.reviewHandback}
        forkableAgents={options.forkableAgents}
      />
    ),
    renderer,
  );
}
