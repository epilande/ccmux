import { wrapToLines } from "../utils/format";

interface Entry {
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
 */
export interface PromptBlockCache {
  /** The wrapped lines for `id`, reusing the stored array when nothing moved. */
  lines(id: string, text: string, width: number, max: number): string[];
  /** Drop every entry whose session is no longer in the list. */
  retain(ids: Iterable<string>): void;
  /** Entry count, for tests. */
  readonly size: number;
}

export function createPromptBlockCache(): PromptBlockCache {
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
      const lines = wrapToLines(text, width, max);
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
