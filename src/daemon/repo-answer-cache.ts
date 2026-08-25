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
    this.entries.set(repoRoot, fresh);
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
}
