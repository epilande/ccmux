import { isSameServerCached } from "./server-guard";
import { flashPane, isPaneInCurrentWindow } from "./tmux";

/** Debounce before probing tmux, so rapid j/k never spawns per keypress. */
export const FLASH_DEBOUNCE_MS = 80;

export interface FlashSchedulerOptions {
  /**
   * Whether this process's window is on screen. A flash painted in a
   * background window or a detached session is never seen, so an invisible
   * scheduler drops the request before arming its timer — no debounce, no
   * `tmux list-panes` spawn.
   */
  visible?: () => boolean;
  /** Whether the daemon and this process share a tmux server. */
  sameServer?: () => boolean;
  paneInCurrentWindow?: (paneId: string) => Promise<boolean>;
  flash?: (paneId: string) => void;
  debounceMs?: number;
}

export interface FlashScheduler {
  /** Request a flash of `paneId`; coalesced and gated. */
  schedule: (paneId: string) => void;
  cancel: () => void;
}

/**
 * Debounced "flash the selected pane if it is on screen" scheduler for the
 * sidebar. Extracted from App so the gating (visibility, cross-server pane-id
 * collision, same-window check) is testable without booting a renderer.
 */
export function createFlashScheduler(
  options: FlashSchedulerOptions = {},
): FlashScheduler {
  const visible = options.visible ?? (() => true);
  const sameServer = options.sameServer ?? isSameServerCached;
  const paneInCurrentWindow =
    options.paneInCurrentWindow ?? isPaneInCurrentWindow;
  const flash = options.flash ?? flashPane;
  const debounceMs = options.debounceMs ?? FLASH_DEBOUNCE_MS;

  let debounce: Timer | null = null;

  const cancel = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = null;
  };

  return {
    schedule(paneId: string) {
      if (!paneId) return;
      // Cheapest gate first: nothing about a hidden window is worth a spawn.
      if (!visible()) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        // Cross-server `%N` collision: this pane id belongs to the daemon's
        // server, so "visible here" would be a different pane. Skip silently;
        // a toast per j/k keypress would spam.
        if (!sameServer()) return;
        void paneInCurrentWindow(paneId).then((inWindow) => {
          if (inWindow) flash(paneId);
        });
      }, debounceMs);
    },
    cancel,
  };
}
