import { Command } from "commander";
import { isDaemonRunningAsync } from "../daemon";
import { launchDaemon } from "./shared";
import { getPreferences } from "../lib/preferences";
import { getUIState, resolvePromptDisplay } from "../lib/state";
import {
  VALID_ICON_STYLES,
  isValidIconStyle,
  type IconStyle,
} from "../lib/icons";
import { markStartup } from "../lib/startup-timing";
import { PICKER_PANE_TITLE } from "../lib/config";

/**
 * Resolves the effective `persistent` setting from CLI flag and config,
 * in that precedence order: CLI flag (either `--persistent` or
 * `--no-persistent`) > config value > default (false).
 */
export function resolvePersistent(
  cliPersistent: boolean | undefined,
  configPersistent: boolean | undefined,
): boolean {
  return cliPersistent ?? configPersistent ?? false;
}

export function createPickerCommand(): Command {
  return new Command("picker")
    .description("Launch the TUI session picker")
    .option("--preview", "Show preview panel")
    .option("--no-preview", "Hide preview panel")
    .option("--icons <style>", "Icon style: none, emoji, nerdfont, dot")
    .option("--persistent", "Keep picker open after switching sessions")
    .option("--no-persistent", "Close picker after switching sessions")
    .action(
      async (options: {
        preview?: boolean;
        icons?: string;
        persistent?: boolean;
      }) => {
        markStartup("cli_parse");

        if (options.icons && !isValidIconStyle(options.icons)) {
          console.error(
            `Invalid icon style: ${options.icons}. Valid styles: ${VALID_ICON_STYLES.join(", ")}`,
          );
          process.exit(1);
        }

        // Run daemon check, config loading, and TUI import in parallel
        const [daemonOk, prefs, uiState, tui] = await Promise.all([
          isDaemonRunningAsync(),
          getPreferences(),
          getUIState(),
          import("../tui"),
        ]);
        markStartup("parallel_init");

        if (!daemonOk) {
          console.log("Starting daemon...");
          await launchDaemon();
        }
        markStartup("daemon_ready");

        const showPreview =
          options.preview ?? uiState.showPreview ?? prefs.showPreview ?? false;
        const iconStyle =
          (options.icons as IconStyle) ?? prefs.iconStyle ?? "dot";
        // State file takes precedence over prefs for previewWidth
        const previewWidth = uiState.previewWidth ?? prefs.previewWidth;
        const persistent = resolvePersistent(
          options.persistent,
          prefs.persistent,
        );

        // Tag persistent picker panes so the daemon ignores them for active-pane tracking
        const selfPane = process.env.TMUX_PANE;
        if (persistent && selfPane) {
          Bun.spawn([
            "tmux",
            "select-pane",
            "-t",
            selfPane,
            "-T",
            PICKER_PANE_TITLE,
          ]);
        }

        await tui.launchTUI({
          initialPreview: showPreview,
          iconStyle,
          previewWidth,
          columns: prefs.columns,
          breakpoints: prefs.breakpoints,
          searchPaneContent: prefs.searchPaneContent,
          searchPaneLines: prefs.searchPaneLines,
          searchTranscript: prefs.searchTranscript,
          groupBy: uiState.groupBy ?? prefs.groupBy,
          collapsedGroups: uiState.collapsedGroups,
          pinnedGroups: uiState.pinnedGroups,
          hideIdle: uiState.hideIdle,
          promptDisplay: resolvePromptDisplay(uiState, prefs.promptDisplay),
          persistent,
          reviewHandback: prefs.reviewHandback,
          theme: prefs.theme,
        });
      },
    );
}
