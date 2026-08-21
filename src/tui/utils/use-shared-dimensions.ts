import type { CliRenderer } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createSignal, onCleanup, type Accessor } from "solid-js";

interface TerminalDimensions {
  width: number;
  height: number;
}

interface Entry {
  dims: Accessor<TerminalDimensions>;
  refs: number;
  detach: () => void;
}

// Keyed by renderer instance: production has one CliRenderer, but each
// testRender creates its own, and entries must not leak across them.
const cache = new Map<CliRenderer, Entry>();

/**
 * Drop-in replacement for @opentui/solid's useTerminalDimensions that shares
 * ONE renderer "resize" listener across every consumer. The upstream hook
 * subscribes per call, and SessionItem mounts per row, so a 30-session picker
 * held 30+ listeners on the renderer EventEmitter and tripped Node's
 * MaxListenersExceededWarning (default max 10), which prints over the TUI.
 * Refcounted so the listener detaches when the last consumer unmounts.
 */
export function useSharedTerminalDimensions(): Accessor<TerminalDimensions> {
  const renderer = useRenderer();
  let entry = cache.get(renderer);
  if (!entry) {
    const [dims, setDims] = createSignal<TerminalDimensions>({
      width: renderer.width,
      height: renderer.height,
    });
    const onResize = (width: number, height: number) =>
      setDims({ width, height });
    renderer.on("resize", onResize);
    entry = { dims, refs: 0, detach: () => renderer.off("resize", onResize) };
    cache.set(renderer, entry);
  }
  entry.refs++;
  const claimed = entry;
  onCleanup(() => {
    claimed.refs--;
    if (claimed.refs === 0) {
      claimed.detach();
      // Guard against evicting a successor: only remove the entry this
      // consumer actually claimed, in case a fresh one was created before
      // this cleanup ran.
      if (cache.get(renderer) === claimed) {
        cache.delete(renderer);
      }
    }
  });
  return claimed.dims;
}
