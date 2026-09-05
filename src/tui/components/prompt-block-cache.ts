import { wrapToLines } from "../utils/format";

interface Entry {
  /** The RAW text the caller passed, so the key compare skips normalizing. */
  text: string;
  width: number;
  max: number;
  lines: string[];
}

/**
 * Per-session memo for the wrapped prompt block.
 *
 * `SessionList` asks for a session's block many times per render: once per
 * visible row, plus once for every PRECEDING row every time `toVisualLine`
 * measures the list. Without a cache each of those calls re-wraps the text,
 * and each returns a fresh array, which re-keys the `<For>` that draws the
 * block and rebuilds its lines even when nothing about the session changed.
 *
 * The cache is keyed by session id and validated against the whole input
 * tuple (text, width, max), so a changed prompt, a resize or a new
 * `promptLines` all produce new content. An unchanged session gets back the
 * SAME array reference, which is what keeps the `<For>` still.
 *
 * `text` is the caller's RAW prompt: normalizing before the key compare would
 * run two regex passes over the whole prompt on every one of those reads and
 * save only the wrap. The injected `normalize` runs on a miss instead, which
 * is also what keeps this module free of the TUI's column code.
 */
export interface PromptBlockCache {
  /** The wrapped lines for `id`, reusing the stored array when nothing moved. */
  lines(id: string, text: string, width: number, max: number): string[];
  /** Drop every entry whose session is no longer in the list. */
  retain(ids: Iterable<string>): void;
  /** Entry count, for tests. */
  readonly size: number;
}

/**
 * @param normalize Applied to the raw text on a cache MISS only, before the
 * wrap. Defaults to identity so a caller that has nothing to strip can omit
 * it (the tests do).
 */
export function createPromptBlockCache(
  normalize: (text: string) => string = (text) => text,
): PromptBlockCache {
  const entries = new Map<string, Entry>();
  return {
    lines(id, text, width, max) {
      const cached = entries.get(id);
      if (
        cached &&
        cached.text === text &&
        cached.width === width &&
        cached.max === max
      ) {
        return cached.lines;
      }
      const lines = wrapToLines(normalize(text), width, max);
      entries.set(id, { text, width, max, lines });
      return lines;
    },
    retain(ids) {
      const live = new Set(ids);
      for (const id of entries.keys()) {
        if (!live.has(id)) entries.delete(id);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
