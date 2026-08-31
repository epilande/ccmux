import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { getDaemonUrl } from "../lib/config";
import { daemonError, daemonBody } from "../lib/daemon-json";
import { ensureDaemon } from "./shared";
import type {
  PruneCandidate,
  PruneRunResult,
  PruneScan,
  PruneSkip,
  ScanResponse,
} from "../daemon/worktree-prune";
import {
  describeHttpFailure,
  describeIgnoredFiles,
  normalizeScan,
} from "../daemon/worktree-prune";
import type {
  WorktreeListResponse,
  WorktreeRepo,
  WorktreeRow,
} from "../daemon/worktree-list";
import { displayWidth } from "../tui/utils/format";

/**
 * `ccmux worktree prune` — the CLI half of issue #68's cleanup.
 *
 * Deliberately interactive-only for real removals. There is no `--yes`: the
 * feature deletes directories and branches, and a flag that skips the
 * confirmation is exactly the automatic mode the design rules out. `--dry-run`
 * covers every scripted use (see what would go), and the confirmation itself
 * is the one thing that cannot be delegated to a flag.
 *
 * `--end-idle` is an INCLUSION opt-in, not a confirmation skip. It widens the
 * offered list to worktrees whose only occupant is an idle agent on a merged
 * PR, and removing one of those ends that agent. The confirmation still runs,
 * and the daemon still refuses such a removal unless the request names the
 * path in `allowEndIdle`.
 */

function describeSessions(candidate: PruneCandidate): string {
  if (candidate.sessions.length === 0) return "";
  const parts = candidate.sessions.map((s) => `${s.agentType} ${s.status}`);
  return ` [${parts.join(", ")}]`;
}

/**
 * What removing a candidate an idle agent still occupies actually does.
 *
 * Spelled out on the row rather than left to the ` [claude idle]` tag, which
 * reads as a status while the consequence is that the agent is stopped. Only
 * reachable under `--end-idle`, since nothing else offers these rows.
 */
function describeEndIdle(candidate: PruneCandidate): string {
  if (candidate.sessions.length === 0) return "";
  return candidate.sessions.length === 1
    ? "  removal ends this session"
    : "  removal ends these sessions";
}

function describeDirty(candidate: PruneCandidate): string {
  if (!candidate.dirty) return "";
  const bits: string[] = [];
  if (candidate.modified > 0) bits.push(`${candidate.modified} modified`);
  if (candidate.untracked > 0) bits.push(`${candidate.untracked} untracked`);
  return `  DIRTY: ${bits.join(", ") || "uninspectable"}`;
}

function describeIgnored(candidate: PruneCandidate): string {
  const summary = describeIgnoredFiles(candidate.ignoredFiles);
  return summary ? `  also deletes ${summary}` : "";
}

function printCandidates(candidates: PruneCandidate[]): void {
  const width = String(candidates.length).length;
  candidates.forEach((candidate, i) => {
    const index = String(i + 1).padStart(width, " ");
    console.log(
      `  ${index}. ${candidate.repoName}/${candidate.name}  (${candidate.branch ?? "detached"})`,
    );
    console.log(
      `     ${candidate.detail}${describeSessions(candidate)}${describeEndIdle(candidate)}${describeDirty(candidate)}${describeIgnored(candidate)}`,
    );
    console.log(`     ${candidate.path}`);
  });
}

function printSkipped(skipped: PruneSkip[]): void {
  if (skipped.length === 0) return;
  console.log(`\nNot offered (${skipped.length}):`);
  for (const skip of skipped) {
    console.log(`  ${skip.path}: ${skip.reason}`);
  }
}

function printResult(result: PruneRunResult): void {
  const verb = result.dryRun ? "Would prune" : "Pruned";
  const removed = result.outcomes.filter((o) => o.removed);
  console.log(`\n${verb} ${removed.length}/${result.outcomes.length}:\n`);
  for (const outcome of result.outcomes) {
    console.log(`  ${outcome.path}`);
    for (const step of outcome.steps) {
      console.log(`    ${step.ok ? "ok " : "!! "}${step.step}: ${step.detail}`);
    }
    if (outcome.error) console.log(`    !! ${outcome.error}`);
  }
  for (const state of result.state) {
    if (state.error) {
      console.log(
        `\n  !! ${state.agent} state (${state.file}): ${state.error}`,
      );
      continue;
    }
    const action = result.dryRun ? "would drop" : "dropped";
    console.log(
      `\n  ${state.agent} state: ${action} ${state.removed.length} entr${state.removed.length === 1 ? "y" : "ies"} from ${state.file}`,
    );
    // Named, not just counted. `--state` sweeps every recorded directory that
    // is absent right now, which on a real machine is dominated by ordinary
    // repos that simply are not checked out, so a bare count tells the user
    // nothing about what they just agreed to lose.
    for (const path of state.removed) console.log(`      ${path}`);
    if (state.backupPath) console.log(`    backup: ${state.backupPath}`);
  }
}

/**
 * The directory the user actually ran the command from.
 *
 * `bin/ccmux` cds into the package root for module resolution and carries the
 * real invocation directory in `CCMUX_CALLER_PWD` (`spawn.ts` and `review.ts`
 * restore it the same way). `process.cwd()` alone is therefore the ccmux
 * INSTALL, which for cwd-based repo discovery is not a near miss: every
 * `ccmux worktree list` would answer for the ccmux checkout no matter where
 * the user was standing.
 */
export function callerCwd(): string {
  return process.env.CCMUX_CALLER_PWD ?? process.cwd();
}

/**
 * A `--repo` as the user meant it. Resolved client-side and against the
 * CALLER's directory, because nothing downstream can do it: the daemon runs
 * chdir'd to `/`, so a relative path sent as typed resolves against the root.
 */
export function resolveRepoOption(
  repo: string | undefined,
): string | undefined {
  return repo ? resolve(callerCwd(), repo) : undefined;
}

/**
 * Why a worktree an idle agent occupies is withheld without `--end-idle`.
 *
 * Names the flag, because the daemon offered this row and the user cannot
 * otherwise tell a withheld candidate from one that was never removable.
 */
export const END_IDLE_SKIP_REASON =
  "an agent is idle here; pass --end-idle to include it (removal ends the session)";

/**
 * Split the daemon's scan by the `--end-idle` opt-in.
 *
 * The daemon offers a worktree whose bound sessions are ALL idle when the
 * branch's PR is verifiably merged; removing it ends that agent. Without the
 * flag those rows move to the withheld list in one move, which is what keeps
 * them out of the count, out of `--dry-run`'s paths, and out of the selection
 * the user types a number into.
 */
export function planPrune(
  scan: PruneScan,
  endIdle: boolean,
): { candidates: PruneCandidate[]; skipped: PruneSkip[] } {
  if (endIdle) return { candidates: scan.candidates, skipped: scan.skipped };
  const withheld = scan.candidates.filter((c) => c.sessions.length > 0);
  return {
    candidates: scan.candidates.filter((c) => c.sessions.length === 0),
    skipped: [
      ...scan.skipped,
      ...withheld.map((c) => ({
        path: c.path,
        repoRoot: c.repoRoot,
        branch: c.branch,
        reason: END_IDLE_SKIP_REASON,
      })),
    ],
  };
}

/** The paths of the candidates an agent still occupies, for `allowEndIdle`. */
function pathsWithSessions(candidates: PruneCandidate[]): string[] {
  return candidates.filter((c) => c.sessions.length > 0).map((c) => c.path);
}

/**
 * The confirmation line for selected worktrees an idle agent occupies, or
 * null when none were selected.
 *
 * At the decision point rather than only on the rows, for the same reason the
 * ignored files are: someone who selected with 'a' never read them. It says
 * the transcripts survive because that is the difference between ending a
 * session and losing it.
 */
export function endIdleSummary(selected: PruneCandidate[]): string | null {
  const count = selected.reduce((n, c) => n + c.sessions.length, 0);
  if (count === 0) return null;
  const one = count === 1;
  return (
    `It will also end ${count} idle agent session${one ? "" : "s"}. ` +
    `Transcripts persist, so ${one ? "that session stays" : "those sessions stay"} resumable.`
  );
}

/**
 * Parse a selection like `1,3-5` into candidate indices. Returns null on
 * anything unparseable or out of range, so a typo cancels the run instead of
 * silently removing a different worktree than the user meant.
 */
export function parseSelection(input: string, count: number): number[] | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return null;
  if (trimmed === "a" || trimmed === "all") {
    return Array.from({ length: count }, (_, i) => i);
  }

  const picked = new Set<number>();
  for (const part of trimmed.split(/[,\s]+/)) {
    if (part === "") continue;
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from < 1 || to > count || from > to) return null;
      for (let i = from; i <= to; i++) picked.add(i - 1);
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 1 || n > count) return null;
    picked.add(n - 1);
  }
  return picked.size > 0 ? [...picked].sort((a, b) => a - b) : null;
}

async function fetchCandidates(
  repo?: string,
  cwd?: string,
): Promise<PruneScan> {
  const params = new URLSearchParams();
  if (repo) params.set("repo", repo);
  if (cwd) params.set("cwd", cwd);
  const query = params.size > 0 ? `?${params}` : "";
  const response = await fetch(
    `${getDaemonUrl()}/worktrees/prune-candidates${query}`,
  );
  if (!response.ok) {
    const error = await daemonError(response);
    throw new Error(error ?? describeHttpFailure(response.status));
  }
  // Normalized, not cast: a daemon older than the `open` bucket sends a body
  // without it, and a bare cast would hand every reader a field the type
  // promises and the wire does not have.
  return normalizeScan(await daemonBody<ScanResponse>(response, "scan"));
}

export interface PrunePostBody {
  paths: string[];
  allowDirty: string[];
  /**
   * Worktree paths the user opted in to removing even though an idle agent
   * lives in them, the mirror of `allowDirty` on its own axis. Sent raw; the
   * daemon normalizes both lists before comparing them, and re-checks each
   * session's live status right before signalling, so this consent can never
   * outrun an agent that started working since the scan.
   */
  allowEndIdle: string[];
  dryRun: boolean;
  cleanState: boolean;
  repo?: string;
  /**
   * This pane, exempt from the daemon's last-moment occupancy guard.
   *
   * Not a nicety: while this command runs, its own pane's foreground command
   * is `ccmux` itself, not a shell. Pruning a worktree from a pane sitting
   * inside it — the most natural way to do it — would otherwise see this
   * process as the live occupant and refuse the removal the user just
   * confirmed.
   */
  callerPane?: string;
  /**
   * Must be the SAME cwd the candidate list was fetched with. The daemon
   * re-derives every candidate from a fresh scan over the repos this
   * discovery reaches, so a run that omits it is offered a smaller set than
   * the user just chose from and refuses the selection with a 409.
   */
  cwd?: string;
}

async function postPrune(body: PrunePostBody): Promise<PruneRunResult> {
  const response = await fetch(`${getDaemonUrl()}/worktrees/prune`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, source: "cli" }),
  });
  if (!response.ok) {
    const error = await daemonError(response);
    throw new Error(error ?? describeHttpFailure(response.status));
  }
  return await daemonBody<PruneRunResult>(response, "prune");
}

interface PruneOptions {
  dryRun?: boolean;
  state?: boolean;
  repo?: string;
  endIdle?: boolean;
}

/**
 * The daemon-facing edges of the command, injectable so the flag's effect on
 * the request body can be asserted without a running daemon. Defaults are the
 * real ones; nothing production passes this.
 */
export interface PruneCommandDeps {
  ensureDaemon?: () => Promise<void>;
  fetchScan?: (repo?: string, cwd?: string) => Promise<PruneScan>;
  postPrune?: (body: PrunePostBody) => Promise<PruneRunResult>;
  /**
   * Answer a confirmation prompt. Supplying it also stands in for the TTY:
   * the non-interactive refusal below exists to stop an unattended removal,
   * and a caller that can answer is by definition not one.
   */
  ask?: (question: string) => Promise<string>;
}

interface Asker {
  ask: (question: string) => Promise<string>;
  close: () => void;
}

function readlineAsker(): Asker {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (question) => rl.question(question), close: () => rl.close() };
}

export async function runPruneCommand(
  options: PruneOptions,
  deps: PruneCommandDeps = {},
): Promise<void> {
  const startDaemon = deps.ensureDaemon ?? ensureDaemon;
  const fetchScan = deps.fetchScan ?? fetchCandidates;
  const post = deps.postPrune ?? postPrune;
  await startDaemon();

  const cleanState = options.state === true;
  const repo = resolveRepoOption(options.repo);
  // The cwd goes with every request of this run (both the listing and the
  // run itself, or the run re-derives over fewer repos and 409s), and only
  // when no `--repo` filter was given, which is the narrower ask. It is what
  // lets you prune the repo you are standing in when no agent session has
  // ever run there.
  const cwd = repo ? undefined : callerCwd();
  const endIdle = options.endIdle === true;
  const { candidates, skipped } = planPrune(await fetchScan(repo, cwd), endIdle);

  if (candidates.length === 0) {
    console.log("No worktrees are ready to prune.");
    printSkipped(skipped);
    if (!cleanState) return;
  } else {
    console.log(`\nPrunable worktrees (${candidates.length}):\n`);
    printCandidates(candidates);
    printSkipped(skipped);
  }

  if (options.dryRun) {
    const result = await post({
      paths: candidates.map((c) => c.path),
      allowDirty: [],
      // Sent under `--dry-run` too, so the run reports the agent it would
      // stop rather than the refusal it would hit without the opt-in.
      allowEndIdle: endIdle ? pathsWithSessions(candidates) : [],
      dryRun: true,
      cleanState,
      repo,
      cwd,
      callerPane: process.env.TMUX_PANE,
    });
    printResult(result);
    return;
  }

  if (!deps.ask && !process.stdin.isTTY) {
    console.error(
      "\nRefusing to prune without a confirmation prompt. Run this in a terminal, or use --dry-run.",
    );
    process.exit(1);
  }

  const asker: Asker = deps.ask
    ? { ask: deps.ask, close: () => {} }
    : readlineAsker();
  try {
    let selected: PruneCandidate[] = [];
    if (candidates.length > 0) {
      const answer = await asker.ask(
        "\nPrune which? (numbers like 1,3-4, 'a' for all, empty to cancel): ",
      );
      const indices = parseSelection(answer, candidates.length);
      if (!indices) {
        console.log("Cancelled.");
        return;
      }
      selected = indices.map((i) => candidates[i]);
    }

    // Dirty rows need their own opt-in on top of being selected: everything
    // else here is recoverable from git, and this is the one thing that isn't.
    const dirty = selected.filter((c) => c.dirty);
    let allowDirty: string[] = [];
    if (dirty.length > 0) {
      console.log(
        `\n${dirty.length} of these have uncommitted or untracked changes:`,
      );
      for (const candidate of dirty) {
        console.log(`  ${candidate.path}${describeDirty(candidate)}`);
      }
      const answer = await asker.ask(
        "Delete that work too? Type 'yes' to include them, anything else to skip them: ",
      );
      if (answer.trim().toLowerCase() === "yes") {
        allowDirty = dirty.map((c) => c.path);
      } else {
        selected = selected.filter((c) => !c.dirty);
        console.log(`Skipping ${dirty.length} dirty worktree(s).`);
      }
    }

    if (selected.length === 0 && !cleanState) {
      console.log("Nothing selected.");
      return;
    }

    const branches = selected.filter(
      (c) => c.branch && c.branchDeletion !== "none",
    );
    const panes = selected.flatMap((c) =>
      c.sessions
        .filter((s) => s.tmuxPane)
        .map((s) => s.tmuxTarget ?? s.tmuxPane),
    );
    console.log(
      `\nThis will delete ${selected.length} director${selected.length === 1 ? "y" : "ies"}` +
        `, ${branches.length} local branch${branches.length === 1 ? "" : "es"}` +
        `, and close ${panes.length} pane${panes.length === 1 ? "" : "s"}.`,
    );
    // Listed at the decision point, not only on the rows: someone who picked
    // with 'a' never read the rows, and these files exist in no git history
    // and no backup.
    const ignoring = selected.filter((c) => c.ignoredFiles.length > 0);
    if (ignoring.length > 0) {
      const total = ignoring.reduce((n, c) => n + c.ignoredFiles.length, 0);
      console.log(
        `It will also delete ${total} ignored file${total === 1 ? "" : "s"} that git does not track:`,
      );
      for (const candidate of ignoring) {
        console.log(
          `  ${candidate.name}: ${candidate.ignoredFiles.slice(0, 5).join(", ")}` +
            (candidate.ignoredFiles.length > 5
              ? `, +${candidate.ignoredFiles.length - 5} more`
              : ""),
        );
      }
    }
    const endingSessions = endIdleSummary(selected);
    if (endingSessions) console.log(endingSessions);
    if (cleanState) {
      console.log("It will also drop state entries for paths already deleted.");
    }
    const confirm = await asker.ask("Proceed? [y/N] ");
    if (confirm.trim().toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }

    const result = await post({
      paths: selected.map((c) => c.path),
      allowDirty,
      allowEndIdle: endIdle ? pathsWithSessions(selected) : [],
      dryRun: false,
      cleanState,
      repo,
      cwd,
      callerPane: process.env.TMUX_PANE,
    });
    printResult(result);
  } finally {
    asker.close();
  }
}

/**
 * `ccmux worktree list` — the CLI half of the Worktrees panel, and a thin
 * formatter over `GET /worktrees` rather than its own scan: the daemon is the
 * only process that knows which sessions live where, and duplicating the
 * discovery here would give the two surfaces different answers.
 *
 * Read-only, so unlike `prune` it works fine non-interactively.
 */

/** `↑2 ↓1`, `gone`, or "" when there is nothing to say. */
function describeTracking(row: WorktreeRow): string {
  const upstream = row.upstream;
  if (!upstream) return "";
  // A gone upstream carries no counts, and "in sync" would be the wrong
  // reading of the two zeros it leaves behind.
  if (upstream.gone) return "gone";
  const parts: string[] = [];
  if (upstream.ahead > 0) parts.push(`↑${upstream.ahead}`);
  if (upstream.behind > 0) parts.push(`↓${upstream.behind}`);
  return parts.join(" ");
}

/** `2m 1u` — modified and untracked counts, or "" when clean. */
function describeDirtyCounts(row: WorktreeRow): string {
  if (!row.dirty.dirty) return "";
  const parts: string[] = [];
  if (row.dirty.modified > 0) parts.push(`${row.dirty.modified}m`);
  if (row.dirty.untracked > 0) parts.push(`${row.dirty.untracked}u`);
  // Dirty with no counts means `git status` itself failed, which
  // `readDirtyState` reports as dirty on purpose.
  return parts.join(" ") || "dirty";
}

function describeRowSessions(row: WorktreeRow): string {
  return row.sessions.map((s) => `${s.agentType} ${s.status}`).join(", ");
}

/** The cells of one row, in column order. */
function cellsFor(row: WorktreeRow): string[] {
  return [
    row.isMain ? `${row.name} (main)` : row.name,
    row.branch ?? "(detached)",
    describeTracking(row),
    describeDirtyCounts(row),
    describeRowSessions(row),
  ];
}

function padCell(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * Render the whole listing. Column widths are computed across EVERY repo, so
 * the groups line up with each other rather than each being its own table.
 */
export function formatWorktreeList(repos: WorktreeRepo[]): string[] {
  if (repos.length === 0) return ["No worktrees found."];

  const cells = new Map<WorktreeRow, string[]>();
  for (const repo of repos) {
    for (const row of repo.worktrees) cells.set(row, cellsFor(row));
  }
  const widths: number[] = [];
  for (const row of cells.values()) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell));
    });
  }

  const grouped = repos.length > 1;
  const lines: string[] = [];
  for (const repo of repos) {
    if (grouped) {
      if (lines.length > 0) lines.push("");
      lines.push(`${repo.repoName}  (${repo.repoRoot})`);
    }
    for (const row of repo.worktrees) {
      const rendered = (cells.get(row) ?? [])
        .map((cell, i) => padCell(cell, widths[i] ?? 0))
        .join("  ");
      lines.push(`${grouped ? "  " : ""}${rendered}`.trimEnd());
    }
  }
  return lines;
}

async function fetchWorktrees(options: {
  repo?: string;
  cwd?: string;
}): Promise<WorktreeListResponse> {
  const params = new URLSearchParams();
  if (options.repo) params.set("repo", options.repo);
  if (options.cwd) params.set("cwd", options.cwd);
  const query = params.size > 0 ? `?${params}` : "";
  const response = await fetch(`${getDaemonUrl()}/worktrees${query}`);
  if (!response.ok) {
    const error = await daemonError(response);
    throw new Error(error ?? describeHttpFailure(response.status));
  }
  return await daemonBody<WorktreeListResponse>(response, "worktree list");
}

async function runListCommand(options: { repo?: string }): Promise<void> {
  await ensureDaemon();
  // The cwd is sent unconditionally (except under `--repo`, which is a
  // filter): it is what puts the repo you are standing in on the list even
  // when no agent session has ever run there.
  const repo = resolveRepoOption(options.repo);
  const { repos } = await fetchWorktrees({
    repo,
    cwd: repo ? undefined : callerCwd(),
  });
  for (const line of formatWorktreeList(repos)) console.log(line);
}

export function createWorktreeCommand(): Command {
  const worktree = new Command("worktree").description(
    "Manage git worktrees ccmux has agent sessions in",
  );

  worktree
    .command("list")
    .description(
      "List every worktree of the repos ccmux knows about, plus this one",
    )
    .option("--repo <path>", "Limit to one repository's worktrees")
    .action(async (options: { repo?: string }) => {
      try {
        await runListCommand(options);
      } catch (error) {
        console.error(
          `Failed to list worktrees: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  worktree
    .command("prune")
    .description("Remove worktrees whose work is finished")
    .option(
      "--dry-run",
      "Show what would be removed without removing anything (still runs 'git fetch --prune' per repo, which updates remote-tracking refs)",
    )
    .option(
      "--state",
      "Also drop agent state entries for recorded directories that do not exist right now",
    )
    .option(
      "--end-idle",
      "Include worktrees whose only occupant is an idle agent on a merged PR; removal ends that agent session",
    )
    .option("--repo <path>", "Limit to one repository's worktrees")
    .action(async (options: PruneOptions) => {
      try {
        await runPruneCommand(options);
      } catch (error) {
        console.error(
          `Failed to prune worktrees: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
    });

  return worktree;
}
