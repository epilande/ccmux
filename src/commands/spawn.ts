import { Command, InvalidArgumentError } from "commander";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import { PANE_ID_PATTERN, type SpawnSplit } from "../daemon/spawn-command";

interface SpawnResponse {
  success: boolean;
  paneId: string;
  command: string;
}

/**
 * `--split` with no value keeps tmux's default (stacked) direction; an
 * explicit `h`/`v` is tmux's own vocabulary, so `h` is a left/right split.
 */
function parseSplit(value: string): SpawnSplit {
  if (value === "h" || value === "v") return value;
  throw new InvalidArgumentError("Expected 'h' (left/right) or 'v' (stacked).");
}

/**
 * The pane the CLI was run from, so the daemon splits HERE rather than
 * wherever tmux considers "current" from the daemon's own context (which
 * is arbitrary, since the daemon is not attached to this client).
 */
function callerPane(): string | undefined {
  const pane = process.env.TMUX_PANE;
  return pane && PANE_ID_PATTERN.test(pane) ? pane : undefined;
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
    .option("--target <pane-id>", "tmux pane to split or place next to")
    .option("--detach", "Don't switch to the new pane after spawning")
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
        },
      ) => {
        await ensureDaemon();

        try {
          const response = await fetch(`${getDaemonUrl()}/spawn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              agent,
              cwd: options.cwd ?? process.cwd(),
              resume: options.resume,
              prompt: options.prompt,
              split: options.split ?? false,
              target: options.target ?? callerPane(),
              detach: options.detach ?? false,
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
