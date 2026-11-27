import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import type { DetailResult } from "./detail-fetch";

/** What a preview shows for the item under the cursor. */
export type DetailState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; detail: T }
  | { status: "error"; error: string };

export interface DetailLoaderOptions<K, T> {
  /** The item the cursor is on, or null for nothing to read. */
  target: () => K | null;
  /** The item's identity. A new object with the same id is the same item,
   *  so a list re-render under the cursor does not re-read it. */
  id: (key: K) => string;
  fetch: (key: K, refresh: boolean) => Promise<DetailResult<T>>;
  /** How long the cursor must rest on an item before it is read. */
  debounceMs: number;
  /** How long a read is reused when the cursor comes back to its item. */
  ttlMs: number;
  /** The most answers kept; the oldest goes first. */
  maxCached?: number;
  /** Bumped by `R`: re-read the current item, past this cache and (through
   *  `fetch`'s `refresh`) the daemon's. */
  refreshKey?: () => number;
}

const DEFAULT_MAX_CACHED = 50;

/**
 * The read behind a preview's body: debounced, cached, and single-flight.
 *
 * Single-flight is what bounds the cost of holding `j`: at most one read is
 * out at a time, and when it lands the loader reads whatever the cursor is
 * on NOW, so a run of rows the cursor merely passed costs nothing, rather
 * than one `gh` process each. A reply for an item the cursor has left is
 * cached but never painted.
 *
 * Failures are not cached here (the daemon holds them briefly itself), so
 * coming back to a failed row asks again; staying on one does not.
 */
export function createDetailLoader<K, T>(
  options: DetailLoaderOptions<K, T>,
): () => DetailState<T> {
  const max = options.maxCached ?? DEFAULT_MAX_CACHED;
  const cache = new Map<string, { at: number; detail: T }>();
  // Tagged with the item it answers for, so the accessor below can refuse to
  // show one row's answer under another during the tick before the effect
  // that resets it has run.
  const [tagged, setTagged] = createSignal<{
    id: string | null;
    state: DetailState<T>;
  }>({ id: null, state: { status: "idle" } });
  let inFlight: string | null = null;
  /** An item `R` asked to re-read whose read has not started yet. It wins
   *  over a cache hit until it does, however long the cursor is away. */
  let refreshId: string | null = null;
  /** `R` landed with nothing under the cursor, as when a list reload has
   *  emptied the rows and the cursor is held until they return: the next
   *  item the cursor lands on is the one to refresh. */
  let refreshNext = false;
  /** Bumped by `R`. A reply to a read started before the bump is from
   *  before the refresh: it neither repopulates the cache nor paints. */
  let epoch = 0;
  /** The item the cursor has rested on for the debounce (or `R` asked for
   *  now). An ordinary read starts only for it, so a reply that frees the
   *  slot early cannot read a row the cursor has merely crossed. */
  let settled: string | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const targetId = createMemo(() => {
    const key = options.target();
    return key === null ? null : options.id(key);
  });

  const fresh = (id: string) => {
    if (refreshId === id) return null;
    const hit = cache.get(id);
    return hit && Date.now() - hit.at < options.ttlMs ? hit : null;
  };

  /** Start the read for the current item, if its debounce is done and the
   *  slot is free; otherwise whichever of the two finishes last calls this
   *  again. */
  /** Re-read `id` past both caches, at once: an explicit refresh does not
   *  wait out the debounce, only for the slot. */
  function refresh(id: string): void {
    refreshId = id;
    settled = id;
    clearTimeout(timer);
    setTagged({ id, state: { status: "loading" } });
    pump();
  }

  function pump(): void {
    if (disposed || inFlight !== null) return;
    const key = untrack(options.target);
    if (key === null) return;
    const id = options.id(key);
    if (settled !== id) return;
    const refresh = refreshId === id;
    const hit = fresh(id);
    if (hit) {
      setTagged({ id, state: { status: "ready", detail: hit.detail } });
      return;
    }
    if (refresh) refreshId = null;
    inFlight = id;
    const started = epoch;
    void options.fetch(key, refresh).then((result) => {
      inFlight = null;
      if (disposed) return;
      const current = started === epoch;
      if (result.ok && current) {
        cache.delete(id);
        cache.set(id, { at: Date.now(), detail: result.detail });
        while (cache.size > max) cache.delete(cache.keys().next().value!);
      }
      // The cursor is still here and no refresh was asked for meanwhile:
      // this is the answer to show. Otherwise read where it is now, once
      // the cursor has rested there.
      if (untrack(targetId) === id && current)
        setTagged({
          id,
          state: result.ok
            ? { status: "ready", detail: result.detail }
            : { status: "error", error: result.error },
        });
      else pump();
    });
  }

  createEffect(() => {
    const id = targetId();
    clearTimeout(timer);
    settled = null;
    if (id === null) {
      setTagged({ id, state: { status: "idle" } });
      return;
    }
    if (refreshNext) {
      refreshNext = false;
      refresh(id);
      return;
    }
    const hit = fresh(id);
    if (hit) {
      setTagged({ id, state: { status: "ready", detail: hit.detail } });
      return;
    }
    setTagged({ id, state: { status: "loading" } });
    timer = setTimeout(() => {
      settled = id;
      pump();
    }, options.debounceMs);
  });

  if (options.refreshKey)
    createEffect(
      on(
        options.refreshKey,
        () => {
          const id = untrack(targetId);
          cache.clear();
          epoch += 1;
          if (id === null) refreshNext = true;
          else refresh(id);
        },
        { defer: true },
      ),
    );

  onCleanup(() => {
    disposed = true;
    clearTimeout(timer);
  });

  return () => {
    const id = targetId();
    const current = tagged();
    if (current.id === id) return current.state;
    return id === null ? { status: "idle" } : { status: "loading" };
  };
}
