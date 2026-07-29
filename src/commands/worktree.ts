import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import type {
  PruneCandidate,
  PruneRunResult,
  PruneScan,
  PruneSkip,
} from "../daemon/worktree-prune";

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

function printCandidates(candidates: PruneCandidate[]): void {
  const width = String(candidates.length).length;
  candidates.forEach((candidate, i) => {
    const index = String(i + 1).padStart(width, " ");
    console.log(
      `  ${index}. ${candidate.repoName}/${candidate.name}  (${candidate.branch ?? "detached"})`,
    );
    console.log(
      `     ${candidate.detail}${describeSessions(candidate)}${describeDirty(candidate)}`,
    );
    console.log(`     ${candidate.path}`);
  });
}

function printSkipped(skipped: PruneSkip[]): void {
  if (skipped.length === 0) return;
  console.log(`\nNot offered (${skipped.length}):`);
  for (const skip of skipped) {
    console.log(`  ${skip.path} — ${skip.reason}`);
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
    if (state.backupPath) console.log(`    backup: ${state.backupPath}`);
  }
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

async function fetchCandidates(repo?: string): Promise<PruneScan> {
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  const response = await fetch(
    `${getDaemonUrl()}/worktrees/prune-candidates${query}`,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as PruneScan;
}

async function postPrune(body: {
  paths: string[];
  allowDirty: string[];
  dryRun: boolean;
  cleanState: boolean;
  repo?: string;
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

  const scan = await fetchCandidates(options.repo);
  const { candidates } = scan;

  if (candidates.length === 0) {
    console.log("No worktrees are ready to prune.");
    printSkipped(scan.skipped);
    if (!options.state) return;
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
      cleanState: options.state === true,
      repo: options.repo,
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

    if (selected.length === 0 && !options.state) {
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
    if (options.state) {
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
      cleanState: options.state === true,
      repo: options.repo,
    });
    printResult(result);
  } finally {
    rl.close();
  }
}

export function createWorktreeCommand(): Command {
  const worktree = new Command("worktree").description(
    "Manage git worktrees ccmux has agent sessions in",
  );

  worktree
    .command("prune")
    .description("Remove worktrees whose work is finished")
    .option("--dry-run", "Show what would be removed without removing anything")
    .option(
      "--state",
      "Also drop agent state entries for directories deleted outside ccmux",
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
