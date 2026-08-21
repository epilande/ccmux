import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
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
          const data = (await response.json()) as { error: string };
          console.error(data.error);
          process.exit(1);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        // The daemon waits for the process to actually die and reports whether
        // it did. `killed: false` means SIGTERM went unanswered inside the cap
        // and the process is STILL ALIVE — saying "Killed" there would be a
        // statement the daemon has already told us is untrue. A background row
        // omits the field entirely (its teardown is the supervisor's, not
        // ours), so absent means success.
        const data = (await response.json().catch(() => null)) as {
          killed?: boolean;
        } | null;

        if (data?.killed === false) {
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
