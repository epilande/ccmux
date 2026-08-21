import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { daemonBody } from "../lib/daemon-json";
import { getAgents } from "../lib/agents";
import { getPreferences } from "../lib/preferences";
import { isDaemonRunningAsync } from "../daemon";
import { discoverAgentProcesses } from "../daemon/processes";
import { listTmuxPanes, normalizeTty } from "../daemon/pane-discovery";
import { isPaneTrackedClaudeSession } from "../daemon/sessions";
import type { ProcessInfo, TmuxPane, EnrichedSession } from "../types/session";

interface DebugReport {
  claudeProcesses: ProcessInfo[];
  tmuxPanes: TmuxPane[];
  trackedSessions: EnrichedSession[];
  untrackedProcesses: Array<{
    process: ProcessInfo;
    reason: string;
  }>;
  panesWithoutClaude: TmuxPane[];
}

function getTrackingModeLabel(
  session: Partial<EnrichedSession>,
): "native" | "pane" | "unknown" {
  if (session.trackingMode === "native" || session.trackingMode === "pane") {
    return session.trackingMode;
  }

  if (typeof session.id === "string" && session.id.includes("_pane")) {
    return "pane";
  }

  return "unknown";
}

function formatElapsed(startTime: number | null): string {
  if (!startTime) return "??";
  const elapsed = Date.now() - startTime;
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}-${String(hours % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

async function fetchTrackedSessions(): Promise<EnrichedSession[]> {
  try {
    const response = await fetch(`${getDaemonUrl()}/sessions?all=true`);
    if (!response.ok) return [];
    const data = await daemonBody<{ sessions: EnrichedSession[] }>(
      response,
      "session list",
    );
    return data.sessions ?? [];
  } catch {
    return [];
  }
}

async function generateDebugReport(): Promise<DebugReport> {
  const preferences = await getPreferences();
  const agents = getAgents(preferences);
  const [claudeProcesses, tmuxPanes, trackedSessions] = await Promise.all([
    discoverAgentProcesses(agents),
    listTmuxPanes(),
    fetchTrackedSessions(),
  ]);

  const trackedPids = new Set(
    trackedSessions.filter((s) => s.pid !== null).map((s) => s.pid),
  );
  const paneByTty = new Map<string, TmuxPane>();
  for (const pane of tmuxPanes) {
    const normalizedTty = normalizeTty(pane.tty);
    if (normalizedTty) {
      paneByTty.set(normalizedTty, pane);
    }
  }

  const untrackedProcesses: DebugReport["untrackedProcesses"] = [];

  for (const proc of claudeProcesses) {
    if (trackedPids.has(proc.pid)) continue;

    let reason: string;

    const normalizedTty = normalizeTty(proc.tty);
    const matchingPane = normalizedTty ? paneByTty.get(normalizedTty) : null;

    if (!matchingPane) {
      reason = `TTY ${proc.tty} does not match any tmux pane`;
    } else if (!proc.cwd) {
      reason = "CWD lookup failed (lsof returned no result)";
    } else {
      reason =
        "No tracked pane-tracked Claude session matched this live pane/process";
    }

    untrackedProcesses.push({ process: proc, reason });
  }

  const panesWithClaude = new Set<string>();
  for (const proc of claudeProcesses) {
    if (proc.tty) {
      const normalizedTty = normalizeTty(proc.tty);
      const pane = normalizedTty ? paneByTty.get(normalizedTty) : null;
      if (pane) {
        panesWithClaude.add(pane.paneId);
      }
    }
  }

  const panesWithoutClaude = tmuxPanes.filter(
    (p) => !panesWithClaude.has(p.paneId),
  );

  return {
    claudeProcesses,
    tmuxPanes,
    trackedSessions,
    untrackedProcesses,
    panesWithoutClaude,
  };
}

function formatReport(report: DebugReport, verbose: boolean): string {
  const {
    claudeProcesses,
    tmuxPanes,
    trackedSessions,
    untrackedProcesses,
    panesWithoutClaude,
  } = report;

  const lines: string[] = [];

  lines.push("Agent Sessions Debug Report");
  lines.push("============================\n");

  lines.push(
    `Agent Processes (${claudeProcesses.length} found via ps -eo pid,tty,etime,comm):`,
  );
  if (claudeProcesses.length === 0) {
    lines.push("  (none)\n");
  } else {
    lines.push("  PID       TTY        ETIME      CWD");
    for (const proc of claudeProcesses) {
      const pid = String(proc.pid).padEnd(9);
      const tty = (proc.tty ?? "??").padEnd(10);
      const etime = formatElapsed(proc.startTime).padEnd(10);
      const cwd = proc.cwd
        ? proc.cwd.length > 40
          ? "..." + proc.cwd.slice(-37)
          : proc.cwd
        : "(unknown)";
      lines.push(`  ${pid} ${tty} ${etime} ${cwd}`);
    }
    lines.push("");
  }

  if (verbose) {
    lines.push(`Tmux Panes (${tmuxPanes.length} total):`);
    if (tmuxPanes.length === 0) {
      lines.push("  (none)\n");
    } else {
      lines.push("  PANE_ID   TTY        TARGET");
      for (const pane of tmuxPanes) {
        const paneId = pane.paneId.padEnd(9);
        const tty = normalizeTty(pane.tty)?.padEnd(10) ?? "??".padEnd(10);
        lines.push(`  ${paneId} ${tty} ${pane.target}`);
      }
      lines.push("");
    }
  }

  lines.push(`Tracked Sessions (${trackedSessions.length} from daemon):`);
  if (trackedSessions.length === 0) {
    lines.push("  (none)\n");
  } else {
    lines.push(
      "  SESSION_ID                              MODE       PID       PANE      STATUS    CWD",
    );
    for (const session of trackedSessions) {
      const id = session.id.slice(0, 8) + "...";
      const mode = getTrackingModeLabel(session);
      const pid =
        session.pid !== null ? String(session.pid).padEnd(9) : "-".padEnd(9);
      const pane = (session.tmuxPane ?? "-").padEnd(9);
      const status = session.status.padEnd(9);
      const cwd =
        session.cwd.length > 30 ? "..." + session.cwd.slice(-27) : session.cwd;
      lines.push(
        `  ${id.padEnd(41)} ${mode.padEnd(10)} ${pid} ${pane} ${status} ${cwd}`,
      );
      if (verbose && isPaneTrackedClaudeSession(session)) {
        lines.push(
          `    nativeSessionId: ${session.nativeSessionId ?? "(unresolved)"}${session.logPath ? `  log: ${session.logPath}` : ""}`,
        );
      }
    }
    lines.push("");
  }

  if (untrackedProcesses.length > 0) {
    lines.push(`Untracked Processes (${untrackedProcesses.length}):`);
    for (const { process: proc, reason } of untrackedProcesses) {
      lines.push(`  PID=${proc.pid}: ${reason}`);
      if (verbose && proc.cwd) {
        lines.push(`    CWD: ${proc.cwd}`);
      }
    }
    lines.push("");
  }

  if (verbose && panesWithoutClaude.length > 0) {
    lines.push(`Panes Without Agents (${panesWithoutClaude.length}):`);
    for (const pane of panesWithoutClaude) {
      lines.push(`  ${pane.paneId}: ${pane.target}`);
    }
    lines.push("");
  }

  lines.push("Summary:");
  lines.push(`  Processes found:   ${claudeProcesses.length}`);
  lines.push(`  Sessions tracked:  ${trackedSessions.length}`);
  lines.push(`  Untracked:         ${untrackedProcesses.length}`);
  if (untrackedProcesses.length > 0) {
    lines.push("\nUntracked Reasons Breakdown:");
    const reasons = new Map<string, number>();
    for (const { reason } of untrackedProcesses) {
      const key = reason.split(" - ")[0].split(" (")[0];
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    for (const [reason, count] of reasons) {
      lines.push(`  ${count}x ${reason}`);
    }
  }

  return lines.join("\n");
}

async function showWithPager(content: string): Promise<void> {
  const proc = Bun.spawn(["less", "-R"], {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });

  proc.stdin.write(content);
  proc.stdin.end();

  await proc.exited;
}

export function createDebugCommand(): Command {
  return new Command("debug")
    .description("Diagnose session tracking discrepancies")
    .option("-v, --verbose", "Show detailed output including all panes")
    .option("-p, --pager", "Show output in a pager (less)")
    .action(async (options: { verbose?: boolean; pager?: boolean }) => {
      const daemonRunning = await isDaemonRunningAsync();

      let output = "";
      if (!daemonRunning) {
        output +=
          "Warning: Daemon is not running. Session data unavailable.\n\n";
      }

      const report = await generateDebugReport();
      output += formatReport(report, options.verbose ?? false);

      if (options.pager) {
        await showWithPager(output);
      } else {
        console.log(output);
      }
    });
}
