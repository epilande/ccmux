import { join, sep } from "path";
import type { ProcessInfo } from "../types/session";
import type { AgentDef } from "../lib/agents";
import { findAgentForProcess } from "../lib/agents";
import { CODEX_DIR } from "../lib/config";
import { normalizeTty } from "./pane-discovery";
import { DaemonPerf } from "./perf";

/**
 * Codex ships bundled plugins (e.g. the computer-use MCP server, argv[0]
 * `.../SkyComputerUseClient mcp`) that run with their cwd set inside
 * `<CODEX_DIR>/plugins/...`. `findAgentForProcess` takes the basename of the
 * first whitespace-delimited argv[0] token ("Codex"), which matches the codex
 * agent's unanchored `processMatch` (`/\bcodex\b/i`). Without this guard ccmux
 * surfaces the plugin host as a user agent session, and because a session's
 * project is derived from `basename(cwd)`, every such host groups under the
 * plugin's version directory (e.g. "1.0.793"), collapsing unrelated panes
 * together.
 *
 * Filter the process out at discovery so it never becomes a session. The
 * signal is the cwd alone: nothing a user legitimately runs an agent from
 * lives under `<CODEX_DIR>/plugins/`. Dropping only the plugin-host process
 * (rather than filtering a session by cwd later) means a real `codex` sharing
 * the same pane still populates the session with its own repo cwd.
 */
export function isCodexPluginHostCwd(cwd: string | null): boolean {
  if (!cwd) return false;
  return cwd.startsWith(join(CODEX_DIR, "plugins") + sep);
}

/**
 * Codex 0.146 starts an internal code-mode host in the agent's cwd. Its
 * executable contains the standalone word `codex`, so the built-in Codex
 * process matcher sees it as another agent process. Because it is a child of
 * the real Codex binary on the same tty, wrapper collapsing would then keep
 * the host and discard Codex itself. Besides reporting the wrong PID, that
 * makes the hook marker look dead and removes the authoritative hook state.
 */
export function isCodexCodeModeHostCommand(command: string): boolean {
  const firstToken = command.trim().split(/\s+/)[0] ?? "";
  const executable = firstToken.replace(/^['"]|['"]$/g, "");
  return /(?:^|[/\\])codex-code-mode-host(?:\.exe)?$/i.test(executable);
}

/**
 * Format: [[DD-]HH:]MM:SS
 * Examples: "00:05", "01:30:15", "2-05:30:00"
 */
export function parseElapsedTime(etime: string): number | null {
  if (!etime || etime === "??" || etime === "-") return null;

  const trimmed = etime.trim();

  try {
    if (trimmed.includes("-")) {
      const [dayPart, timePart] = trimmed.split("-");
      const days = parseInt(dayPart, 10);
      const timeParts = timePart.split(":").map(Number);

      if (timeParts.length === 3) {
        const [hours, minutes, seconds] = timeParts;
        return days * 86400 + hours * 3600 + minutes * 60 + seconds;
      }
      return null;
    }

    const parts = trimmed.split(":").map(Number);

    if (parts.length === 3) {
      const [hours, minutes, seconds] = parts;
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Drop wrapper processes when their child is also a match for the same agent
 * on the same tty, keeping only the deepest (real) process.
 *
 * npm/brew/mise launchers commonly re-exec: `node /opt/homebrew/bin/gemini`
 * spawns another `node .../gemini` child, and both share the pane's tty with
 * command lines that match the same agent def (for gemini they are literally
 * identical, so no commandPatterns tweak can tell them apart — unlike
 * copilot, whose wrapper fix could simply stop matching the wrapper form).
 * Without this filter the per-scan pane-session upsert flip-flops `pid`
 * between wrapper and child, tripping the pane-reuse identity reset every
 * cycle: status wipes to idle and re-derives, `statusChangedAt` /
 * `attentionGeneration` churn (rejecting valid notification-action presses
 * as stale), and `nativeSessionId`/`logPath`/`lastPrompt` are cleared as
 * fast as enrichment writes them.
 *
 * The rule is deliberately narrow: an entry is dropped only when another
 * entry of the SAME agentType on the SAME tty lists it as its parent. A
 * shim -> wrapper -> binary chain collapses to the binary (every ancestor
 * is some child's ppid); unrelated same-type processes on different ttys,
 * or different agents sharing a tty, are untouched. Accepted tradeoff: a
 * genuinely nested same-agent session (e.g. codex started from a shell
 * inside a codex pane, same tty) collapses to the innermost process.
 */
export function dropWrapperParents<
  T extends {
    pid: number;
    ppid: number | null;
    agentType: string;
    tty: string;
  },
>(entries: T[]): T[] {
  const parentPidsByGroup = new Map<string, Set<number>>();
  for (const entry of entries) {
    if (entry.ppid === null) continue;
    const key = `${entry.agentType}\0${entry.tty}`;
    let parents = parentPidsByGroup.get(key);
    if (!parents) {
      parents = new Set();
      parentPidsByGroup.set(key, parents);
    }
    parents.add(entry.ppid);
  }
  return entries.filter((entry) => {
    const parents = parentPidsByGroup.get(`${entry.agentType}\0${entry.tty}`);
    return !parents?.has(entry.pid);
  });
}

/**
 * Thrown by {@link discoverAgentProcessesOrThrow} when `ps` itself fails
 * (spawn exception, non-zero exit, or empty output). Distinct from a
 * genuinely-empty agent list so callers can fail closed on a transient
 * `ps` hiccup instead of treating it as "every agent exited".
 */
export class ProcessDiscoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProcessDiscoveryError";
  }
}

/**
 * What discovery asks its two subprocesses for. The `psColumns` list is the
 * single source of truth: omitting `tty` from it is what moves the tty to
 * lsof, and every column index is derived from it.
 */
export interface DiscoveryPlatform {
  /** `ps -eo` column list. `command` must be last (it contains spaces). */
  psColumns: string;
  /** lsof argv for one batch of pids. */
  lsofArgv(pidList: string): string[];
}

/**
 * macOS: leave `tty` out of `ps` and harvest it from lsof instead.
 *
 * The column costs BSD `ps` a full device-name table build — ~136ms with it
 * vs ~55ms without on a 1200-process machine, a fixed cost that restricting
 * to specific pids does not avoid. Discovery already runs lsof for cwd, and
 * the same call reports the pane tty as the name of fds 0/1/2 for ~free.
 */
export const FD_TTY_DISCOVERY: DiscoveryPlatform = {
  psColumns: "pid,ppid,etime,command",
  lsofArgv: (pidList) => [
    "lsof",
    "-a",
    "-p",
    pidList,
    "-d",
    "cwd,0,1,2",
    "-Ffn",
  ],
};

/**
 * Everywhere else: keep the `ps` column and leave lsof untightened.
 *
 * Linux `ps` reads tty straight from procfs with no table build, so there is
 * nothing to win, and lsof builds differ across distros in how they honor
 * `-d`. A silent "no fds reported" would drop every session, so the harvest
 * would have to be verified per build before it could be trusted here.
 */
export const PS_TTY_DISCOVERY: DiscoveryPlatform = {
  psColumns: "pid,ppid,tty,etime,command",
  lsofArgv: (pidList) => ["lsof", "-p", pidList, "-Ffn"],
};

const PLATFORM: DiscoveryPlatform =
  process.platform === "darwin" ? FD_TTY_DISCOVERY : PS_TTY_DISCOVERY;

/** True when lsof is the tty source, because `ps` was not asked for it. */
function harvestsTtyFromFds(platform: DiscoveryPlatform): boolean {
  return !platform.psColumns.split(",").includes("tty");
}

/** `ps` renders "no controlling terminal" as `??` (BSD) or `?` (Linux). */
function normalizePsTty(tty: string | undefined): string | null {
  if (!tty || tty === "??" || tty === "?" || tty === "-") return null;
  return tty;
}

/**
 * Discover supported agent processes, resolving each one's tty and cwd.
 * Uses batched lsof to reduce subprocess spawning.
 *
 * THROWS {@link ProcessDiscoveryError} on a hard `ps` failure (spawn threw,
 * non-zero exit, or no output — `ps` always prints a header, so empty output
 * means it did not run). A genuinely-empty result (ps ran, no agent matched)
 * still returns `[]`. The scan loop uses this variant so a transient `ps`
 * failure skips the cycle rather than being read as "all agents gone", which
 * would wipe every session and delete every hook marker. Callers that prefer
 * fail-soft behavior use {@link discoverAgentProcesses}.
 */
export async function discoverAgentProcessesOrThrow(
  agents: AgentDef[],
  platform: DiscoveryPlatform = PLATFORM,
): Promise<ProcessInfo[]> {
  let output: string;
  let exitCode: number;
  try {
    DaemonPerf.incSubprocessSpawn("ps-agents");
    const proc = Bun.spawn(["ps", "-eo", platform.psColumns], {
      stdout: "pipe",
      stderr: "pipe",
    });

    output = await new Response(proc.stdout).text();
    exitCode = await proc.exited;
  } catch (error) {
    throw new ProcessDiscoveryError("ps spawn failed", { cause: error });
  }

  if (exitCode !== 0 || !output.trim()) {
    throw new ProcessDiscoveryError(
      `ps exited ${exitCode}${output.trim() ? "" : " with no output"}`,
    );
  }

  const matched = parsePsOutput(output, agents, platform, Date.now());
  if (matched.length === 0) return [];

  const ttyFromFds = harvestsTtyFromFds(platform);

  // When lsof supplies the tty, it must see every command-matched process —
  // the extra targets cost ~nothing (agents essentially always have a tty, and
  // the tty-less matches are a handful of pipe-stdio helpers like MCP servers
  // and language servers). When `ps` already settled the tty, the tty-less
  // rows are dropped by `resolveDiscoveredProcesses` regardless, so asking
  // about them would only widen the lsof call for nothing.
  const lsofTargets = ttyFromFds ? matched : matched.filter((p) => p.tty);

  const lsof = await batchGetProcessFdInfo(
    lsofTargets.map((p) => p.pid),
    platform,
  );

  // Fail closed when lsof is the tty source and it did not run. Every row
  // would take `tty: null` and be filtered out, so discovery would return an
  // empty list WITHOUT throwing — indistinguishable from "no agents are
  // running", which is exactly the wipe-every-session-and-marker outcome
  // ProcessDiscoveryError exists to prevent (see the scan loop's comment in
  // `daemon/index.ts`). A partial lsof result is not this case: it degrades
  // to a few dropped rows and one scan of cleanup hysteresis absorbs it.
  if (ttyFromFds && lsof.hardFailed) {
    throw new ProcessDiscoveryError(
      `lsof failed for ${lsofTargets.length} matched process(es); no tty resolvable`,
    );
  }

  // One source or the other, never a mix: falling back across them would
  // surface processes the platform's own `ps` reports as having no terminal.
  const sourced = ttyFromFds
    ? matched.map((p) => ({ ...p, tty: lsof.byPid.get(p.pid)?.tty ?? null }))
    : matched;

  return resolveDiscoveredProcesses(sourced, lsof.byPid);
}

/** A ps line that matched an agent def, before cwd resolution. */
export interface MatchedProcess {
  pid: number;
  ppid: number | null;
  /** Normalized like a pane tty ("ttys061"); null if the process has none. */
  tty: string | null;
  command: string;
  agentType: string;
  startTime: number | null;
}

/**
 * Parse `ps` output into the agent-matched rows, reading every column index
 * off `platform.psColumns` so the layout is stated exactly once.
 */
export function parsePsOutput(
  output: string,
  agents: AgentDef[],
  platform: DiscoveryPlatform,
  now: number,
): MatchedProcess[] {
  const columns = platform.psColumns.split(",");
  const pidIndex = columns.indexOf("pid");
  const ppidIndex = columns.indexOf("ppid");
  const ttyIndex = columns.indexOf("tty");
  const etimeIndex = columns.indexOf("etime");
  const commandIndex = columns.indexOf("command");

  const matched: MatchedProcess[] = [];
  for (const line of output.trim().split("\n").slice(1)) {
    // `command` is last and holds the only spaces, so a well-formed row has
    // at least one token per column.
    const parts = line.trim().split(/\s+/);
    if (parts.length < columns.length) continue;

    const pid = parseInt(parts[pidIndex], 10);
    if (isNaN(pid)) continue;

    const command = parts.slice(commandIndex).join(" ");
    const agent = findAgentForProcess(command, agents);
    if (!agent) continue;

    const ppid = parseInt(parts[ppidIndex], 10);
    const elapsedSeconds = parseElapsedTime(parts[etimeIndex]);

    matched.push({
      pid,
      ppid: isNaN(ppid) ? null : ppid,
      tty: ttyIndex === -1 ? null : normalizePsTty(parts[ttyIndex]),
      command,
      agentType: agent.name,
      startTime: elapsedSeconds !== null ? now - elapsedSeconds * 1000 : null,
    });
  }
  return matched;
}

/**
 * Fold agent-matched ps rows, tty already resolved, together with their lsof
 * cwds into the final process list. Pure, so the filter order it encodes is
 * testable; platform-blind, because the tty is settled before it runs.
 *
 * That order is load-bearing:
 *
 * 1. **tty filter** — what keeps daemonized and pipe-stdio processes from
 *    becoming sessions. A subprocess-mode invoke (`codex exec` and friends,
 *    spawned with piped stdio) is dropped here.
 * 2. **internal-host filters BEFORE `dropWrapperParents`** (see
 *    {@link isCodexPluginHostCwd} and {@link isCodexCodeModeHostCommand}):
 *    these hosts run on the same tty as, and are children of, the real Codex
 *    process. If retained, they evict the real Codex as a "wrapper" via their
 *    ppid links.
 */
export function resolveDiscoveredProcesses(
  matched: MatchedProcess[],
  lsofByPid: Map<number, ProcessFdInfo>,
): ProcessInfo[] {
  const withTty = matched.flatMap((p) =>
    p.tty ? [{ ...p, tty: p.tty, cwd: lsofByPid.get(p.pid)?.cwd ?? null }] : [],
  );

  const nonPluginHosts = withTty.filter(
    (p) =>
      !isCodexPluginHostCwd(p.cwd) &&
      !(p.agentType === "codex" && isCodexCodeModeHostCommand(p.command)),
  );

  return dropWrapperParents(nonPluginHosts).map((p) => ({
    pid: p.pid,
    command: p.command,
    agentType: p.agentType,
    tty: p.tty,
    cwd: p.cwd,
    startTime: p.startTime,
  }));
}

/**
 * Fail-soft discovery: returns `[]` on any failure (including a hard `ps`
 * error). Used where a momentary miss is harmless (hook-adapter linking,
 * boot-time migration) and callers do not perform destructive cleanup off the
 * result. The scan loop must use {@link discoverAgentProcessesOrThrow} instead.
 */
export async function discoverAgentProcesses(
  agents: AgentDef[],
): Promise<ProcessInfo[]> {
  try {
    return await discoverAgentProcessesOrThrow(agents);
  } catch (error) {
    // Fail soft, but stay observable: a persistent `ps` failure would
    // otherwise be silent on every non-scan caller (hook linking, migration).
    console.error("discoverAgentProcesses error:", error);
    return [];
  }
}

/** What discovery reads out of a process's open file descriptors. */
export interface ProcessFdInfo {
  cwd: string | null;
  /** Normalized like the ps column ("ttys061"), or null if no fd holds a tty. */
  tty: string | null;
}

/**
 * A concrete terminal device: `/dev/ttys001`, `/dev/tty1`, `/dev/pts/3`.
 *
 * Deliberately requires a numbered device, so `/dev/null` (codex runs with
 * fd2 there) and the bare `/dev/tty` controlling-terminal alias — which names
 * no specific device and so could never match a pane — are both rejected.
 */
const TTY_DEVICE_PATH = /^\/dev\/(tty[a-z]*\d+|pts\/\d+)$/;

/**
 * fds whose name can be the pane's tty.
 *
 * All three are needed and nothing beyond them may be read: codex runs with
 * fd2 on `/dev/null` while fd0/fd1 hold the pane tty, so no single fd
 * suffices; and ccmux's own OSC notification backend opens OTHER panes' ttys
 * on high fds (`src/lib/notify-osc.ts`, observed on fds 4/5/11 of a live
 * claude process), so a blanket "any tty-looking fd" rule would mis-attribute
 * a process to someone else's pane.
 */
const TTY_FDS = new Set(["0", "1", "2"]);

/**
 * Parse `lsof -Ffn` field output into per-pid cwd and tty.
 *
 * The format is a flat line stream: `p<pid>` opens a process, then each open
 * file is an `f<fd>` line followed by its `n<name>` line. Robustness the live
 * output demands:
 *
 * - an `f` record can carry an EMPTY `n` payload (observed), so a name is
 *   only recorded when non-empty;
 * - unrelated records (`ftxt`, `fmem`, …) interleave freely with the fds we
 *   care about, so each `n` is attributed to the `f` immediately preceding it
 *   rather than to a sticky "am I in the cwd record" flag;
 * - any other field line is ignored without disturbing that pairing.
 */
export function parseLsofFdOutput(output: string): Map<number, ProcessFdInfo> {
  const results = new Map<number, ProcessFdInfo>();
  let currentPid: number | null = null;
  let pendingFd: string | null = null;

  const entryFor = (pid: number): ProcessFdInfo => {
    let entry = results.get(pid);
    if (!entry) {
      entry = { cwd: null, tty: null };
      results.set(pid, entry);
    }
    return entry;
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = parseInt(line.slice(1), 10);
      currentPid = isNaN(pid) ? null : pid;
      pendingFd = null;
    } else if (line.startsWith("f")) {
      pendingFd = line.slice(1);
    } else if (line.startsWith("n")) {
      const name = line.slice(1);
      const fd = pendingFd;
      pendingFd = null;
      if (currentPid === null || fd === null || !name) continue;

      if (fd === "cwd") {
        entryFor(currentPid).cwd = name;
      } else if (TTY_FDS.has(fd) && TTY_DEVICE_PATH.test(name)) {
        // Lowest fd wins: fd0 is the least likely of the three to have been
        // redirected away from the pane.
        const entry = entryFor(currentPid);
        entry.tty ??= normalizeTty(name);
      }
    }
  }

  return results;
}

/** One batched lsof call's result, and whether the call itself held up. */
interface FdInfoBatch {
  byPid: Map<number, ProcessFdInfo>;
  /**
   * lsof produced nothing usable: the spawn threw, or it exited non-zero with
   * no parseable records. Callers that depend on lsof for the tty must fail
   * closed on this.
   *
   * Deliberately NOT set for a non-zero exit that still carried records: lsof
   * reports a pid that died between `ps` and here as an error while printing
   * every other process normally, and that routine partial result must keep
   * degrading gracefully.
   */
  hardFailed: boolean;
}

/**
 * Batch-resolve cwd (and on macOS the tty) for multiple processes in a single
 * lsof call.
 *
 * The `f` field selector is required: lsof 4.99+ (e.g. the Nix build) emits no
 * fd-type lines for a bare `-Fn`, so `fcwd` never appears and every cwd lookup
 * silently fails (0 sessions ever get a cwd → nothing binds to a pane). Older
 * builds (macOS system lsof) include `f` even with `-Fn`, which is why this
 * only bites on some setups. `-Ffn` is correct on both.
 *
 * `-a` is mandatory alongside `-d`: without it lsof ORs the `-p` and `-d`
 * selectors and enumerates every process on the machine (measured: 142ms and
 * 860 pids for a 26-pid request, vs 25ms and exactly 26 pids with `-a`). It
 * fails silently — the requested pids are all present in the flood — so the
 * flag reads as optional and is not.
 */
async function batchGetProcessFdInfo(
  pids: number[],
  platform: DiscoveryPlatform,
): Promise<FdInfoBatch> {
  if (pids.length === 0) return { byPid: new Map(), hardFailed: false };

  try {
    const pidList = pids.join(",");
    DaemonPerf.incSubprocessSpawn("lsof-fds");
    const proc = Bun.spawn(platform.lsofArgv(pidList), {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    const byPid = parseLsofFdOutput(output);

    if (exitCode !== 0) {
      console.error(`lsof exited with code ${exitCode} for PIDs: ${pidList}`);
    }

    // Exit 0 with nothing to report is a real (if unusual) answer — every
    // requested pid raced away. Non-zero with nothing parseable is lsof
    // refusing to run at all.
    return { byPid, hardFailed: exitCode !== 0 && byPid.size === 0 };
  } catch (error) {
    console.error("batchGetProcessFdInfo error:", error);
    return { byPid: new Map(), hardFailed: true };
  }
}
