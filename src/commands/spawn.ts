import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";

interface SpawnResponse {
  success: boolean;
  paneId: string;
  command: string;
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
    .option("--split", "Split current pane instead of new window")
    .option("--detach", "Don't switch to the new pane after spawning")
    .action(
      async (
        agent: string,
        options: {
          cwd?: string;
          resume?: string;
          prompt?: string;
          split?: boolean;
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
