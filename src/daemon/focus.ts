/**
 * macOS frontmost-terminal detection for notification focus suppression.
 *
 * Squawk's model: walk the process ancestry of the tmux client up to the
 * `.app` bundle hosting it, resolve that bundle's identifier, and compare it
 * against whatever app is currently frontmost. Deliberately uses `lsappinfo`
 * (built-in, no permission prompt) instead of the System Events `osascript`
 * form, which triggers a macOS Automation dialog when called from a detached
 * daemon.
 *
 * Every subprocess call goes through an injectable `Spawn` so tests never
 * touch real processes; production defaults to `Bun.spawn`.
 */

/** Minimal surface of `Bun.spawn`'s `Subprocess` this module reads. */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
}

/**
 * Injected spawn function. Default wraps `Bun.spawn`; tests pass a fake
 * returning a `SpawnResult` so neither a real subprocess nor real I/O is
 * needed.
 */
export type Spawn = (argv: string[]) => SpawnResult;

const defaultSpawn: Spawn = (argv) =>
  Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as SpawnResult;

/** Ancestor walk gives up after this many hops rather than climbing to pid 1. */
const MAX_ANCESTOR_HOPS = 20;

/** Matches a `comm` value that is a binary inside a `.app` bundle, e.g. `/Applications/Ghostty.app/Contents/MacOS/ghostty`. */
const APP_BINARY_PATTERN = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/;

/** Terminal bundle id resolution never changes for a client's lifetime, so cache per pid. */
const defaultBundleIdCache = new Map<number, string | null>();

/**
 * Run argv via the injected spawn, returning trimmed-free stdout text on a
 * clean (zero) exit, or null on any spawn/exec failure. Fail-closed so
 * callers can fall back to "not viewing" without special-casing errors.
 */
async function run(spawn: Spawn, argv: string[]): Promise<string | null> {
  try {
    const proc = spawn(argv);
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return output;
  } catch {
    return null;
  }
}

function parsePsLine(output: string): { ppid: number; comm: string } | null {
  const match = output.trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return null;
  const ppid = parseInt(match[1], 10);
  if (Number.isNaN(ppid)) return null;
  return { ppid, comm: match[2] };
}

async function walkAncestorsForBundleId(
  startPid: number,
  spawn: Spawn,
): Promise<string | null> {
  let pid = startPid;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    const output = await run(spawn, [
      "ps",
      "-o",
      "ppid=,comm=",
      "-p",
      String(pid),
    ]);
    if (output === null) return null;
    const parsed = parsePsLine(output);
    if (!parsed) return null;

    const appMatch = parsed.comm.match(APP_BINARY_PATTERN);
    if (appMatch) {
      const appPath = appMatch[1];
      const bundleId = await run(spawn, [
        "defaults",
        "read",
        `${appPath}/Contents/Info`,
        "CFBundleIdentifier",
      ]);
      if (bundleId === null) return null;
      const trimmed = bundleId.trim();
      return trimmed || null;
    }

    if (parsed.ppid <= 1) return null;
    pid = parsed.ppid;
  }
  return null;
}

/**
 * Resolve the bundle id of the `.app` hosting the tmux client at `clientPid`
 * by walking its process ancestry (squawk's pattern). Cached per pid since a
 * tmux client's hosting app never changes for its lifetime; pass a fresh
 * `cache` to isolate calls (tests do this to avoid cross-test pollution).
 */
export async function resolveTerminalBundleId(
  clientPid: number,
  spawn: Spawn = defaultSpawn,
  cache: Map<number, string | null> = defaultBundleIdCache,
): Promise<string | null> {
  if (cache.has(clientPid)) {
    return cache.get(clientPid) ?? null;
  }
  const result = await walkAncestorsForBundleId(clientPid, spawn);
  cache.set(clientPid, result);
  return result;
}

/**
 * Resolve the bundle id of the currently frontmost macOS app via `lsappinfo`.
 * Deliberately not the System Events `osascript` form, which triggers a TCC
 * Automation prompt when called from a detached daemon.
 */
export async function getFrontmostBundleId(
  spawn: Spawn = defaultSpawn,
): Promise<string | null> {
  const front = await run(spawn, ["lsappinfo", "front"]);
  if (front === null) return null;
  const asn = front.trim();
  if (!asn) return null;

  const info = await run(spawn, [
    "lsappinfo",
    "info",
    "-only",
    "bundleid",
    asn,
  ]);
  if (info === null) return null;

  const match = info.match(/"CFBundleIdentifier"="([^"]*)"/);
  return match ? match[1] : null;
}

/**
 * Whether the terminal app hosting the tmux client is the frontmost app.
 * Composes `resolveTerminalBundleId` + `getFrontmostBundleId`; fails toward
 * `false` (= notify) on any error, missing client, or non-macOS platform, per
 * the notifier's focus-suppression rule (both conditions must hold to
 * suppress, and this half fails open).
 */
export async function isTerminalFrontmost(
  getClientPid: () => Promise<number | null>,
  spawn: Spawn = defaultSpawn,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "darwin") return false;

  try {
    const clientPid = await getClientPid();
    if (clientPid === null) return false;

    const [terminalBundleId, frontmostBundleId] = await Promise.all([
      resolveTerminalBundleId(clientPid, spawn),
      getFrontmostBundleId(spawn),
    ]);

    if (!terminalBundleId || !frontmostBundleId) return false;
    return terminalBundleId === frontmostBundleId;
  } catch {
    return false;
  }
}
