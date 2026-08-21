import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { daemonError, readBoolean } from "../lib/daemon-json";
import { ensureDaemon } from "./shared";

export function createKillCommand(): Command {
  return new Command("kill")
    .description("Kill an agent session's process")
    .argument("<session-id>", "Session ID or pane ID")
    .action(async (sessionId: string) => {
      await ensureDaemon();

      try {
        const response = await fetch(
          `${getDaemonUrl()}/sessions/${sessionId}/kill`,
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

        // `killed: false` means the process outlived the daemon's wait and is
        // still running. A background row omits the field, so absent is success.
        const body: unknown = await response.json();

        if (readBoolean(body, "killed") === false) {
          console.error(
            `Session ${sessionId} did not exit; the process is still running.`,
          );
          process.exit(1);
        }

        console.log(`Killed session: ${sessionId}`);
      } catch (error) {
        console.error("Failed to kill session:", error);
        process.exit(1);
      }
    });
}
