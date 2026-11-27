import { mkdirSync, renameSync, unlinkSync } from "fs";
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
  /** Group names the user gave, per groupBy mode: raw group key to name
   *  (`{ project: { "px-api": "ProjectX" } }`). Always written whole, since
   *  `setUIState` merges only the top level, and never pruned for liveness. */
  groupAliases?: Partial<Record<GroupBy, Record<string, string>>>;
  /** Per mode, what a reset needs to give merged-away groups their own pin
   *  and collapse back. Cleared with the mode's last merge, and written whole
   *  beside `groupAliases`. */
  groupLayouts?: Partial<Record<GroupBy, MergeRecord>>;
  /** Agent last spawned from the picker's new-session dialog. Persisted
   *  because the one-shot picker exits as soon as it spawns, so the
   *  "last agent" default only survives on disk. */
  lastSpawnAgent?: string;
  /** One-time notices already decided (`claimNotice`): shown, or skipped on
   *  an install that never had the behavior they announce. */
  seenNotices?: string[];
}

/** One groupBy mode's record of its merges, for a reset to undo them. */
export interface MergeRecord {
  /**
   * Each merged-away raw key's own collapse. An entry is also what marks a
   * key as merged in: a key renamed without merging has none.
   */
  merged: Record<string, { collapsed: boolean }>;
  /**
   * `pinnedGroups` in raw keys, as of the last merge: each pin as the keys
   * renamed to it without merging, or its own key where nothing was, with
   * every merged-away key that was pinned still where it stood. A
   * merged-away key goes back pinned exactly when it is here. Raw keys, not
   * names: a name is whatever a group was called then (`Beta`), while a
   * reset puts back raw keys (`beta`).
   */
  pins: string[];
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
 * Merge updates into the state file.
 *
 * Written to a temp file and renamed, the same way the session markers are.
 * The rename is atomic, so a reader (or a crash) sees either the old file or
 * the new one, never a half-written one — which matters because
 * `getUIState` swallows a parse error and returns `{}`, so a truncated file
 * silently discards every persisted setting rather than reporting anything.
 *
 * This is still a read-modify-write with no lock, and it is genuinely
 * concurrent: every picker and sidebar writes here, and so does the daemon's
 * `AttentionTracker`. Atomicity bounds the damage to "one writer's keys lose
 * to another's" instead of "the file is gone"; a lock would be the next step
 * if that ever proves not enough.
 *
 * The temp name carries the pid so two processes renaming at the same moment
 * cannot land on each other's partial file.
 */
export async function setUIState(updates: Partial<UIState>): Promise<void> {
  const current = await getUIState();
  const merged = { ...current, ...updates };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    await Bun.write(tmp, JSON.stringify(merged, null, 2) + "\n");
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up, or we never got as far as creating it.
    }
    throw err;
  }
}

/** The one-time notice naming the keys 1.5 changed (`tui/key-changes-notice.ts`). */
export const KEY_CHANGES_NOTICE_ID = "keys-1.5";

/**
 * What a 1.5 process puts in a state.json it CREATES: every one-time notice
 * marked seen, since a new install has nothing to unlearn.
 *
 * This is what makes "a file without the flag" mean "a pre-1.5 file". The
 * file merely existing proves nothing, because the daemon's attention
 * tracker writes it in ordinary use (1.4's did too), so every 1.5 creator
 * stamps it: `claimNotice` for the picker and sidebar, and
 * `AttentionTracker.save()` for the daemon.
 */
export function stampNewStateFile(): Pick<UIState, "seenNotices"> {
  return { seenNotices: [KEY_CHANGES_NOTICE_ID] };
}

/**
 * Whether one-time notice `id` is owed, from the state file's contents, or
 * null when there is no file: `fresh` for no file, `seen` once recorded, and
 * `show` for a file a pre-1.5 process wrote.
 */
export function decideNotice(
  state: UIState | null,
  id: string,
): "seen" | "show" | "fresh" {
  if (state === null) return "fresh";
  return state.seenNotices?.includes(id) ? "seen" : "show";
}

/**
 * Decide notice `id` for this launch and record it. True when the caller
 * should show it now.
 *
 * A fresh install is recorded by any surface (`stampNewStateFile`). A
 * surface that may not show it (`mayShow: false`) leaves an owed notice for
 * one that may. The record is written when the notice is SHOWN, not when it
 * is dismissed, so a picker that exits under it does not raise it again.
 */
export async function claimNotice(
  id: string,
  { mayShow }: { mayShow: boolean },
): Promise<boolean> {
  const exists = await Bun.file(STATE_FILE).exists();
  const state = exists ? await getUIState() : null;
  const decision = decideNotice(state, id);
  if (decision === "seen" || (decision === "show" && !mayShow)) return false;
  if (decision === "fresh") {
    await setUIState(stampNewStateFile());
    return false;
  }
  const seen = (await getUIState()).seenNotices ?? [];
  if (!seen.includes(id)) await setUIState({ seenNotices: [...seen, id] });
  return true;
}
