/**
 * A per-repo cache that is also a per-repo lock, for answers that cost a
 * `gh` call.
 *
 * Extracted from `GET /prs`'s `openPRsFor` when `GET /issues` arrived needing
 * the identical discipline (issue #151). It is a module rather than a second
 * copy of forty lines because every subtlety in here was a bug once, and a
 * duplicate is where a subtlety goes to be quietly dropped:
 *
 * 1. The entry is registered BEFORE the first await, so a caller arriving in
 *    the same tick finds it rather than starting a second call.
 * 2. An in-flight call is joined AHEAD of the refresh check, so a refresh
 *    joins a live call instead of racing a second one against it.
 * 3. A refresh bypasses a fresh SUCCESS and never a fresh FAILURE. The whole
 *    argument for the bypass is that success goes stale on its own (a PR
 *    merged a moment ago still reads open); a failed lookup has no equivalent,
 *    and the failure TTL is what stops key-repeat on a refresh key from
 *    serial-spawning one doomed `gh` per press.
 * 4. Failures are held for their own, shorter window than successes.
 * 5. An unforeseen rejection DROPS the entry, so a repo cannot wedge
 *    permanently "in flight" for the daemon's whole life.
 * 6. With `maxEntries`, the oldest SETTLED entries are evicted past the cap.
 *    An in-flight entry is never evicted: it is the lock, and dropping it
 *    would let the next caller start the duplicate call rule 1 prevents.
 *    Per-repo keys never needed a cap; per-item keys (`<root>#<n>` for one
 *    PR's detail) grow with every row the cursor visits.
 *
 * The cached value is a {@link SourceResult} rather than an arbitrary `T` with
 * a supplied predicate: every caller here is a `gh` lister that reports its
 * own failures as `ok: false`, and a hand-written "did this succeed" callback
 * is one more thing to get backwards.
 */

import type { SourceResult } from "./gh-spawn-source";

/**
 * One repo's slot.
 *
 * `answer` exists from the moment the call STARTS; `done` is filled in when it
 * settles and is what the TTL is measured from. The two together are what let
 * one entry be both the lock and the cache.
 */
export interface RepoAnswerEntry<T> {
  answer: Promise<SourceResult<T>>;
  done: { at: number; result: SourceResult<T> } | null;
}

export interface RepoAnswerCacheOptions {
  /** How long a successful answer is served without asking `gh` again. */
  ttlMs: number;
  /** The same for a failure, deliberately shorter. See rule 3 above. */
  failureTtlMs: number;
  /** The most entries kept. Unbounded when absent. See rule 6 above. */
  maxEntries?: number;
}

export class RepoAnswerCache<T> {
  /**
   * Public, and Map-shaped, because it is the test seam: it holds the
   * in-flight promise as well as the settled answer, so a test can watch a
   * concurrent miss join rather than start a second call, and can expire a
   * TTL boundary without waiting for one. Reached through `ServerInternals`,
   * the way `gitInfoCache` is.
   */
  readonly entries = new Map<string, RepoAnswerEntry<T>>();

  constructor(private readonly options: RepoAnswerCacheOptions) {}

  /**
   * The cached answer if it is fresh, the in-flight call if there is one, and
   * only otherwise a new call to `fetch`.
   */
  answer(
    repoRoot: string,
    refresh: boolean,
    fetch: () => Promise<SourceResult<T>>,
  ): Promise<SourceResult<T>> {
    const entry = this.entries.get(repoRoot);
    if (entry) {
      // Still running. Join it rather than starting a second call: the TTL
      // cannot help here, because it is only written when a call COMPLETES.
      if (!entry.done) return entry.answer;
      const bypass = refresh && entry.done.result.ok;
      const ttl = entry.done.result.ok
        ? this.options.ttlMs
        : this.options.failureTtlMs;
      if (!bypass && Date.now() - entry.done.at < ttl) return entry.answer;
    }

    const answer = fetch();
    const fresh: RepoAnswerEntry<T> = { answer, done: null };
    // Delete first so a re-asked key moves to the newest end, which is what
    // makes insertion order the eviction order.
    this.entries.delete(repoRoot);
    this.entries.set(repoRoot, fresh);
    this.evict();
    void answer.then(
      (result) => {
        fresh.done = { at: Date.now(), result };
      },
      () => {
        // The listers report every failure they know about as `ok: false` and
        // do not throw, so this is the unforeseen case. Drop the entry rather
        // than leave the repo permanently in flight.
        if (this.entries.get(repoRoot) === fresh) {
          this.entries.delete(repoRoot);
        }
      },
    );
    return answer;
  }

  /** Drop the oldest settled entries while over `maxEntries`. In-flight ones
   *  are skipped, so a burst of concurrent misses can briefly exceed the cap
   *  rather than lose a lock. */
  private evict(): void {
    const max = this.options.maxEntries;
    if (max === undefined) return;
    let over = this.entries.size - max;
    if (over <= 0) return;
    for (const [key, entry] of this.entries) {
      if (over <= 0) break;
      if (!entry.done) continue;
      this.entries.delete(key);
      over -= 1;
    }
  }
}
