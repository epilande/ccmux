/**
 * ProcessTree - Build and query process hierarchy in a single pass.
 * Eliminates N pgrep calls by building tree from one ps command.
 */
import { basename } from "path";
import { DaemonPerf } from "./perf";

export interface ProcessNode {
  pid: number;
  ppid: number;
  comm: string;
}

/**
 * Exact-match shell basename derived from a raw `comm` value: drop trailing
 * argv, strip one leading `-` (login shells report `-zsh`), then take the
 * path basename. Substring matching on raw `comm` false-positives on macOS,
 * where `comm` is a full path (e.g. `~/.local/share/...` contains "sh").
 */
export function shellCommKey(comm: string): string {
  const trimmed = comm.trim();
  const spaceIndex = trimmed.indexOf(" ");
  const firstToken = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const unwrapped = firstToken.startsWith("-")
    ? firstToken.slice(1)
    : firstToken;
  return basename(unwrapped);
}

export class ProcessTree {
  private processes = new Map<number, ProcessNode>();
  /** Map of ppid -> child pids (parent->children index) */
  private children = new Map<number, number[]>();
  public readonly builtAt: number;

  private constructor() {
    this.builtAt = Date.now();
  }

  static async build(): Promise<ProcessTree> {
    try {
      DaemonPerf.incSubprocessSpawn("ps-tree");
      const proc = Bun.spawn(["ps", "-axo", "pid,ppid,comm"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      return ProcessTree.fromPsOutput(output);
    } catch {
      // Return empty tree on error
      return new ProcessTree();
    }
  }

  /**
   * Parse `ps -axo pid,ppid,comm` output (header row + one process per line)
   * into a tree. Exposed so tests can build a tree from canned ps output
   * instead of spawning a real `ps`.
   */
  static fromPsOutput(output: string): ProcessTree {
    const tree = new ProcessTree();
    const lines = output.trim().split("\n").slice(1);

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;

      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      const comm = parts.slice(2).join(" ");

      if (isNaN(pid) || isNaN(ppid)) continue;

      const node: ProcessNode = { pid, ppid, comm };
      tree.processes.set(pid, node);

      const siblings = tree.children.get(ppid) ?? [];
      siblings.push(pid);
      tree.children.set(ppid, siblings);
    }

    return tree;
  }

  getChildPids(parentPid: number): number[] {
    return this.children.get(parentPid) ?? [];
  }

  getProcess(pid: number): ProcessNode | undefined {
    return this.processes.get(pid);
  }

  /**
   * Find an agent process that is a descendant of the given root PID
   * Uses BFS traversal through the in-memory tree (no subprocess spawning)
   */
  findAgentDescendant(rootPid: number, agentPids: Set<number>): number | null {
    const queue = [rootPid];
    const visited = new Set<number>();

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      if (agentPids.has(pid)) {
        return pid;
      }

      const childPids = this.getChildPids(pid);
      queue.push(...childPids);
    }

    return null;
  }

  /**
   * Shell process names to detect running Bash commands. Matched by EXACT
   * equality against the derived basename (see `shellCommKey`), never by
   * substring against the raw `comm` string.
   */
  static readonly SHELL_NAMES = [
    "bash",
    "sh",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "ash",
  ];

  /** O(1) lookup mirror of `SHELL_NAMES`, checked per descendant in the BFS below. */
  private static readonly SHELL_NAMES_SET = new Set(ProcessTree.SHELL_NAMES);

  /**
   * Find all shell descendant processes of a given root PID
   * Used to detect when a Bash tool is actively executing
   */
  findShellDescendants(rootPid: number): number[] {
    const shellPids: number[] = [];
    const queue = this.getChildPids(rootPid);
    const visited = new Set<number>();

    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);

      const proc = this.getProcess(pid);
      if (proc && ProcessTree.SHELL_NAMES_SET.has(shellCommKey(proc.comm))) {
        shellPids.push(pid);
      }
      queue.push(...this.getChildPids(pid));
    }
    return shellPids;
  }

  get size(): number {
    return this.processes.size;
  }
}
