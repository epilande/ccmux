import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import type {
  PruneCandidate,
  PruneRunResult,
  PruneScan,
  PruneSkip,
} from "../daemon/worktree-prune";
import { describeIgnoredFiles } from "../daemon/worktree-prune";
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
 */

function describeSessions(candidate: PruneCandidate): string {
  if (candidate.sessions.length === 0) return "";
  const parts = candidate.sessions.map((s) => `${s.agentType} ${s.status}`);
  return ` [${parts.join(", ")}]`;
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
      `     ${candidate.detail}${describeSessions(candidate)}${describeDirty(candidate)}${describeIgnored(candidate)}`,
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
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  // Normalized, not cast: a daemon older than the `open` bucket sends a body
  // without it, and a bare cast would hand every reader a field the type
  // promises and the wire does not have.
  const data = (await response.json()) as Partial<PruneScan>;
  return {
    candidates: data.candidates ?? [],
    skipped: data.skipped ?? [],
    open: data.open ?? [],
  };
}

async function postPrune(body: {
  paths: string[];
  allowDirty: string[];
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
}): Promise<PruneRunResult> {
  const response = await fetch(`${getDaemonUrl()}/worktrees/prune`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, source: "cli" }),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as PruneRunResult;
}

interface PruneOptions {
  dryRun?: boolean;
  state?: boolean;
  repo?: string;
}

async function runPruneCommand(options: PruneOptions): Promise<void> {
  await ensureDaemon();

  const cleanState = options.state === true;
  const repo = resolveRepoOption(options.repo);
  // The cwd goes with every request of this run (both the listing and the
  // run itself, or the run re-derives over fewer repos and 409s), and only
  // when no `--repo` filter was given, which is the narrower ask. It is what
  // lets you prune the repo you are standing in when no agent session has
  // ever run there.
  const cwd = repo ? undefined : callerCwd();
  const scan = await fetchCandidates(repo, cwd);
  const { candidates } = scan;

  if (candidates.length === 0) {
    console.log("No worktrees are ready to prune.");
    printSkipped(scan.skipped);
    if (!cleanState) return;
  } else {
    console.log(`\nPrunable worktrees (${candidates.length}):\n`);
    printCandidates(candidates);
    printSkipped(scan.skipped);
  }

  if (options.dryRun) {
    const result = await postPrune({
      paths: candidates.map((c) => c.path),
      allowDirty: [],
      dryRun: true,
      cleanState,
      repo,
      cwd,
      callerPane: process.env.TMUX_PANE,
    });
    printResult(result);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(
      "\nRefusing to prune without a confirmation prompt. Run this in a terminal, or use --dry-run.",
    );
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let selected: PruneCandidate[] = [];
    if (candidates.length > 0) {
      const answer = await rl.question(
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
      const answer = await rl.question(
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
    if (cleanState) {
      console.log("It will also drop state entries for paths already deleted.");
    }
    const confirm = await rl.question("Proceed? [y/N] ");
    if (confirm.trim().toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }

    const result = await postPrune({
      paths: selected.map((c) => c.path),
      allowDirty,
      dryRun: false,
      cleanState,
      repo,
      cwd,
      callerPane: process.env.TMUX_PANE,
    });
    printResult(result);
  } finally {
    rl.close();
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
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as WorktreeListResponse;
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
