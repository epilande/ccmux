import { mkdirSync } from "fs";
import { dirname } from "path";
import { STATE_FILE } from "./config";
import type { GroupBy, PromptDisplay } from "./preferences";

/**
 * Runtime UI state persisted across sessions.
 * Separate from preferences (ccmux.json) to avoid race conditions
 * when the user edits config while the TUI writes state.
 */
export interface UIState {
  collapsedGroups?: string[];
  pinnedGroups?: string[];
  previewWidth?: number;
  showPreview?: boolean;
  /** Runtime prompt display mode, cycled by the `p` key. */
  promptDisplay?: PromptDisplay;
  /** @deprecated Legacy on/off flag superseded by `promptDisplay`. Still read
   *  once for migration: a persisted `showPrompt: false` maps to
   *  `promptDisplay: "off"` until the next `p` press writes `promptDisplay`. */
  showPrompt?: boolean;
  hideIdle?: boolean;
  groupBy?: GroupBy;
  /** Agent last spawned from the picker's new-session dialog. Persisted
   *  because the one-shot picker exits as soon as it spawns, so the
   *  "last agent" default only survives on disk. */
  lastSpawnAgent?: string;
}

/**
 * Resolve the effective prompt display mode: the runtime toggle (UIState)
 * wins, then a config default, then a legacy `showPrompt: false` migrates to
 * `off`. Returns `undefined` when nothing is set, leaving the store's own
 * default (`inline`) to apply.
 */
export function resolvePromptDisplay(
  uiState: UIState,
  configDefault?: PromptDisplay,
): PromptDisplay | undefined {
  if (uiState.promptDisplay !== undefined) return uiState.promptDisplay;
  // A freshly-set config default outranks a stale legacy toggle; the legacy
  // `showPrompt: false` only applies when there's no config default to honor.
  if (configDefault !== undefined) return configDefault;
  if (uiState.showPrompt === false) return "off";
  return undefined;
}

/**
 * Returns empty object if file doesn't exist or is malformed
 */
export async function getUIState(): Promise<UIState> {
  try {
    const file = Bun.file(STATE_FILE);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // Ignore malformed file
  }
  return {};
}

/**
 * Merge updates into the state file
 */
export async function setUIState(updates: Partial<UIState>): Promise<void> {
  const current = await getUIState();
  const merged = { ...current, ...updates };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  await Bun.write(STATE_FILE, JSON.stringify(merged, null, 2) + "\n");
}
