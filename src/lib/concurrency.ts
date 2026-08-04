/**
 * `Promise.all` with a ceiling on how many run at once, preserving input
 * order in the result.
 *
 * Every caller here is fanning out subprocesses (a `gh pr list` per branch, a
 * `git status` per worktree), where unbounded parallelism means one repo with
 * dozens of worktrees opens dozens of processes at once from inside the
 * daemon's own thread.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
