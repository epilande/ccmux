import { Command, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import { PANE_ID_PATTERN, type SpawnSplit } from "../daemon/spawn-command";
import { isSameTmuxServer } from "../lib/tmux-server";
import { BUILTIN_AGENTS } from "../lib/agents";

interface SpawnResponse {
  success: boolean;
  paneId: string;
  command: string;
  /** Present only when `--worktree` asked for one. */
  worktree?: {
    name: string;
    path: string;
    branch: string;
    created: boolean;
  };
}

/**
 * `--split` with no value keeps tmux's default (stacked) direction; an
 * explicit `h`/`v` is tmux's own vocabulary, so `h` is a left/right split.
 */
function parseSplit(value: string): SpawnSplit {
  if (value === "h" || value === "v") return value;
  // `ccmux spawn --split codex` is an easy slip, and the generic message
  // reads like the direction is wrong rather than the argument order.
  const hint = BUILTIN_AGENTS.some((a) => a.name === value)
    ? ` To spawn ${value} in a split, put the agent first: ccmux spawn ${value} --split.`
    : "";
  throw new InvalidArgumentError(
    `Expected 'h' (left/right) or 'v' (stacked).${hint}`,
  );
}

/**
 * The pane the CLI was run from. Sent as `callerPane` rather than
 * `target`: it means "my session/pane", not "put the window here", and
 * the daemon treats the two differently (an explicit target inserts a
 * window next to it and renumbers later windows; the caller's pane only
 * pins the session).
 *
 * Dropped when the daemon is watching a DIFFERENT tmux server, because
 * `%N` ids are unique only within one server and collide across them
 * (see lib/tmux-server.ts and the invariant in pane-discovery.ts); a
 * stale-looking id would otherwise resolve to an unrelated pane.
 */
function callerPane(daemonSocket: string | null): string | undefined {
  const pane = process.env.TMUX_PANE;
  if (!pane || !PANE_ID_PATTERN.test(pane)) return undefined;
  return isSameTmuxServer(daemonSocket) ? pane : undefined;
}

/**
 * The directory the new agent should start in.
 *
 * `bin/ccmux` cds into the package root for module resolution and carries
 * the real invocation directory in `CCMUX_CALLER_PWD`, so `process.cwd()`
 * alone would start every agent inside the ccmux install (see
 * `src/commands/review.ts` and `src/commands/sidebar.ts` for the same
 * restoration). An explicit `--cwd` is resolved against the caller's
 * directory too, so a relative one means what the user typed rather than
 * something relative to the install.
 */
function resolveSpawnCwd(explicit?: string): string {
  const callerPwd = process.env.CCMUX_CALLER_PWD ?? process.cwd();
  return explicit ? resolve(callerPwd, explicit) : callerPwd;
}

/** The daemon's tmux socket, or null when it can't be determined. */
async function daemonTmuxSocket(): Promise<string | null> {
  const res = await fetch(`${getDaemonUrl()}/server-info`).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { socketPath: string | null };
  return data.socketPath;
}

export function createSpawnCommand(): Command {
  return new Command("spawn")
    .description("Spawn a new agent session in a tmux pane")
    .argument(
      "[agent]",
      "Agent to spawn (claude, codex, copilot, opencode, gemini)",
      "claude",
    )
    .option("--cwd <dir>", "Working directory")
    .option("--resume <session-id>", "Resume an existing session")
    .option("--prompt <text>", "Initial prompt to send")
    .option(
      "--split [direction]",
      "Split current pane instead of new window ('h' left/right, 'v' stacked)",
      parseSplit,
    )
    .option(
      "--target <pane-id>",
      "tmux pane to split or place next to ('none' to ignore the current pane)",
    )
    .option("--detach", "Don't switch to the new pane after spawning")
    .option(
      "--worktree [name]",
      "Spawn into a git worktree at <repo>/.claude/worktrees/<name>, creating it if needed (name derived from --prompt when omitted)",
    )
    .option(
      "--base <ref>",
      "Branch the new worktree from this ref (default: the repository's current branch)",
    )
    .action(
      async (
        agent: string,
        options: {
          cwd?: string;
          resume?: string;
          prompt?: string;
          split?: SpawnSplit;
          target?: string;
          detach?: boolean;
          worktree?: string | boolean;
          base?: string;
        },
      ) => {
        await ensureDaemon();

        // `--target none` (or an empty value) opts out of placement
        // entirely, letting tmux pick as it did before targeting existed.
        const explicitTarget =
          options.target === "none" || options.target === ""
            ? undefined
            : options.target;
        const optedOut = options.target !== undefined && !explicitTarget;

        // `--worktree` bare is `true` from commander, `--worktree x` is the
        // string. Both become an object, since the daemon accepts one shape;
        // `--base` without `--worktree` is a no-op flag rather than an error,
        // matching how the other placement options behave in isolation.
        const worktree =
          options.worktree === undefined
            ? undefined
            : {
                name:
                  typeof options.worktree === "string"
                    ? options.worktree
                    : undefined,
                base: options.base,
              };

        try {
          const response = await fetch(`${getDaemonUrl()}/spawn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent,
              cwd: resolveSpawnCwd(options.cwd),
              resume: options.resume,
              prompt: options.prompt,
              split: options.split ?? false,
              target: explicitTarget,
              callerPane: optedOut
                ? undefined
                : callerPane(await daemonTmuxSocket()),
              detach: options.detach ?? false,
              worktree,
            }),
          });

          if (response.status === 400) {
            const data = (await response.json()) as { error: string };
            console.error(data.error);
            process.exit(1);
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = (await response.json()) as SpawnResponse;
          if (data.worktree) {
            const { name, path, branch, created } = data.worktree;
            console.log(
              `${created ? "Created" : "Reusing"} worktree ${name} on branch ${branch}: ${path}`,
            );
          }
          console.log(
            `Spawned ${agent} in pane ${data.paneId}: ${data.command}`,
          );
        } catch (error) {
          console.error("Failed to spawn session:", error);
          process.exit(1);
        }
      },
    );
}
