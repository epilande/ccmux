import { join, sep } from "path";
import type { ProcessInfo } from "../types/session";
import type { AgentDef } from "../lib/agents";
import { findAgentForProcess } from "../lib/agents";
import { CODEX_DIR } from "../lib/config";
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
 * Discover supported agent processes using ps with TTY information.
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
): Promise<ProcessInfo[]> {
  let output: string;
  let exitCode: number;
  try {
    DaemonPerf.incSubprocessSpawn("ps-agents");
    const proc = Bun.spawn(["ps", "-eo", "pid,tty,etime,command"], {
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

  {
    const now = Date.now();
    const agentProcesses: Array<{
      pid: number;
      tty: string | null;
      command: string;
      agentType: string;
      startTime: number | null;
    }> = [];
    const lines = output.trim().split("\n").slice(1); // Skip header

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;

      const pid = parseInt(parts[0], 10);
      const tty = parts[1];
      const etime = parts[2];
      const command = parts.slice(3).join(" ");

      if (isNaN(pid)) continue;
      const agent = findAgentForProcess(command, agents);
      if (!agent) continue;

      const normalizedTty = tty === "??" || tty === "-" ? null : tty;
      if (!normalizedTty) continue;
      const elapsedSeconds = parseElapsedTime(etime);
      const startTime =
        elapsedSeconds !== null ? now - elapsedSeconds * 1000 : null;

      agentProcesses.push({
        pid,
        tty: normalizedTty,
        command,
        agentType: agent.name,
        startTime,
      });
    }

    if (agentProcesses.length === 0) {
      return [];
    }

    const pids = agentProcesses.map((p) => p.pid);
    const cwdMap = await batchGetProcessCwds(pids);

    const processes: ProcessInfo[] = agentProcesses
      .map((p) => ({
        pid: p.pid,
        command: p.command,
        agentType: p.agentType,
        tty: p.tty,
        cwd: cwdMap.get(p.pid) ?? null,
        startTime: p.startTime,
      }))
      // Drop Codex's bundled plugin hosts (see isCodexPluginHostCwd) so they
      // never become sessions or collapse unrelated panes under a version dir.
      .filter((p) => !isCodexPluginHostCwd(p.cwd));

    return processes;
  }
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

/**
 * Batch get working directories for multiple processes in a single lsof call
 * Parses lsof -Ffn output format: p<pid>, fcwd, n<path>
 *
 * The `f` field selector is required: lsof 4.99+ (e.g. the Nix build) emits no
 * fd-type lines for a bare `-Fn`, so `fcwd` never appears and every cwd lookup
 * silently fails (0 sessions ever get a cwd → nothing binds to a pane). Older
 * builds (macOS system lsof) include `f` even with `-Fn`, which is why this
 * only bites on some setups. `-Ffn` is correct on both.
 */
async function batchGetProcessCwds(
  pids: number[],
): Promise<Map<number, string>> {
  const results = new Map<number, string>();
  if (pids.length === 0) return results;

  try {
    const pidList = pids.join(",");
    DaemonPerf.incSubprocessSpawn("lsof-cwds");
    const proc = Bun.spawn(["lsof", "-p", pidList, "-Ffn"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`lsof exited with code ${exitCode} for PIDs: ${pidList}`);
    }

    const lines = output.split("\n");
    let currentPid: number | null = null;
    let isCwd = false;

    for (const line of lines) {
      if (line.startsWith("p")) {
        currentPid = parseInt(line.slice(1), 10);
        isCwd = false;
      } else if (line === "fcwd") {
        isCwd = true;
      } else if (isCwd && line.startsWith("n") && currentPid !== null) {
        results.set(currentPid, line.slice(1));
        isCwd = false;
      } else if (line.startsWith("f")) {
        isCwd = false;
      }
    }

    return results;
  } catch (error) {
    console.error("batchGetProcessCwds error:", error);
    return results;
  }
}
