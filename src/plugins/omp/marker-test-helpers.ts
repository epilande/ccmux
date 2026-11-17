import { watch, readFileSync } from "node:fs";
import { join } from "node:path";

export async function waitForIdleMarker(directory: string, id: string) {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const check = () => {
    try {
      if (
        JSON.parse(readFileSync(join(directory, `omp-${id}.json`), "utf8"))
          .state === "idle"
      )
        resolve();
    } catch {}
  };
  const watcher = watch(directory, check);
  watcher.on("error", reject);
  const signal = AbortSignal.timeout(4000);
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  check();
  try {
    await promise;
  } finally {
    watcher.close();
    signal.removeEventListener("abort", abort);
  }
}
