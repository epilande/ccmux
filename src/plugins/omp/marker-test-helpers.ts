import { watch, readFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";

const TIMEOUT_MS = 4000;
// fs.watch on macOS can miss or coalesce a fast tmp+rename write, so the
// watcher alone can leave the wait stuck on a marker that is already idle.
// The poll is the guarantee; the watcher just makes the common case fast.
const POLL_MS = 25;

export async function waitForIdleMarker(directory: string, id: string) {
  const file = join(directory, `omp-${id}.json`);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let lastState: unknown;
  const check = () => {
    try {
      lastState = JSON.parse(readFileSync(file, "utf8")).state;
      if (lastState === "idle") resolve();
    } catch {}
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(directory, check);
    // Polling covers a broken watcher, so its errors are not fatal.
    watcher.on("error", () => {});
  } catch {}
  const poll = setInterval(check, POLL_MS);
  const timeout = setTimeout(
    () =>
      reject(
        new Error(
          `timed out after ${TIMEOUT_MS}ms waiting for ${file} to be idle (last state: ${JSON.stringify(lastState)})`,
        ),
      ),
    TIMEOUT_MS,
  );
  check();
  try {
    await promise;
  } finally {
    clearInterval(poll);
    clearTimeout(timeout);
    watcher?.close();
  }
}
