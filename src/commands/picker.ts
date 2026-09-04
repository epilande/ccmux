import { Command } from "commander";
import { defaultReconcileDeps, probeDaemon, settleDaemon } from "./shared";
import { getPreferences } from "../lib/preferences";
import { getUIState, resolvePromptDisplay } from "../lib/state";
import {
  VALID_ICON_STYLES,
  isValidIconStyle,
  type IconStyle,
} from "../lib/icons";
import { markStartup } from "../lib/startup-timing";
import { PICKER_PANE_TITLE } from "../lib/config";
import { tmuxArgv } from "../lib/tmux-exec";
import { setPinnedTmuxClientTty } from "../lib/tmux-client";
import {
  defaultPopupHintDeps,
  detectLegacyPopupBinding,
} from "../lib/popup-hint";
import { forkableAgentNames } from "../lib/agents";

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
    .option(
      "--client-tty <tty>",
      "tmux client tty to act on (set by the popup keybinding)",
    )
    .action(
      async (options: {
        preview?: boolean;
        icons?: string;
        persistent?: boolean;
        clientTty?: string;
      }) => {
        markStartup("cli_parse");

        // Before anything can switch a client. The value is validated where it
        // is consumed, not here: a malformed one must be refused with a toast
        // the user can act on, never silently replaced by tmux's guess.
        setPinnedTmuxClientTty(options.clientTty);

        if (options.icons && !isValidIconStyle(options.icons)) {
          console.error(
            `Invalid icon style: ${options.icons}. Valid styles: ${VALID_ICON_STYLES.join(", ")}`,
          );
          process.exit(1);
        }

        // Run daemon probe, config loading, and TUI import in parallel. The
        // probe has no side effects; starting or replacing the daemon waits
        // for the join below.
        const reconcileDeps = defaultReconcileDeps({
          log: (line) => console.log(line),
        });
        // The legacy-binding check rides along here: it costs two tmux
        // queries and a `tty`, and only when no client tty was captured at
        // all. Resolved out here so the TUI never probes tmux itself, and
        // while fd 0 is still the interactive terminal.
        const [daemonProbe, prefs, uiState, tui, legacyPopupBinding] =
          await Promise.all([
            probeDaemon(reconcileDeps),
            getPreferences(),
            getUIState(),
            import("../tui"),
            detectLegacyPopupBinding(defaultPopupHintDeps()),
          ]);
        markStartup("parallel_init");

        await settleDaemon(daemonProbe, reconcileDeps);
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
          Bun.spawn(
            tmuxArgv("select-pane", "-t", selfPane, "-T", PICKER_PANE_TITLE),
          );
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
          lastSpawnAgent: uiState.lastSpawnAgent,
          reviewHandback: prefs.reviewHandback,
          forkableAgents: forkableAgentNames(prefs),
          theme: prefs.theme,
          legacyPopupBinding,
        });
      },
    );
}
