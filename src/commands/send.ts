import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { daemonError } from "../lib/daemon-json";
import { ensureDaemon } from "./shared";

export function createSendCommand(): Command {
  return new Command("send")
    .description("Send text to a session's tmux pane")
    .argument("<session-id>", "Session ID or pane ID")
    .argument("[text]", "Text to send (omit with --stdin)")
    .option("--no-enter", "Do not press Enter after sending text")
    .option(
      "--stdin",
      "Read text from stdin instead of the positional argument (mutually exclusive with it)",
    )
    .action(
      async (
        sessionId: string,
        text: string | undefined,
        options: { enter: boolean; stdin?: boolean },
      ) => {
        if (options.stdin && text !== undefined) {
          console.error(
            "--stdin and a positional text argument are mutually exclusive",
          );
          process.exit(1);
        }

        let payload: string;
        if (options.stdin) {
          payload = await Bun.stdin.text();
        } else if (text !== undefined) {
          payload = text;
        } else {
          console.error("Missing text argument (or use --stdin)");
          process.exit(1);
        }

        await ensureDaemon();

        try {
          const response = await fetch(
            `${getDaemonUrl()}/sessions/${sessionId}/send`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: payload, enter: options.enter }),
            },
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

          console.log(`Sent to session: ${sessionId}`);
        } catch (error) {
          console.error("Failed to send to session:", error);
          process.exit(1);
        }
      },
    );
}
