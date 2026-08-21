import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { daemonError } from "../lib/daemon-json";
import { ensureDaemon } from "./shared";

export function createRestartCommand(): Command {
  return new Command("restart")
    .description("Restart an agent session (kill + resume in same pane)")
    .argument("<session-id>", "Session ID or pane ID")
    .action(async (sessionId: string) => {
      await ensureDaemon();

      try {
        const response = await fetch(
          `${getDaemonUrl()}/sessions/${sessionId}/restart`,
          { method: "POST" },
        );

        if (response.status === 404) {
          console.error(`Session not found: ${sessionId}`);
          process.exit(1);
        }

        if (response.status === 400) {
          const error = await daemonError(response);
          console.error(error ?? `HTTP ${response.status}`);
          process.exit(1);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        console.log(`Restarted session: ${sessionId}`);
      } catch (error) {
        console.error("Failed to restart session:", error);
        process.exit(1);
      }
    });
}
