import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { isSameTmuxServer } from "../lib/tmux-server";
import { resolveActiveTmuxClientTty } from "../lib/tmux-client";
import { ensureDaemon } from "./shared";

export function createSwitchCommand(): Command {
  return new Command("switch")
    .description("Switch tmux client to a session's pane")
    .argument("<session-id>", "Session ID or pane ID")
    .action(async (sessionId: string) => {
      await ensureDaemon();

      try {
        const response = await fetch(`${getDaemonUrl()}/sessions/${sessionId}`);

        if (response.status === 404) {
          console.error(`Session not found: ${sessionId}`);
          process.exit(1);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = (await response.json()) as {
          session: { tmuxPane: string | null; tmuxTarget: string | null };
        };

        // Prefer the stable `%N` pane id over the `session:window.pane`
        // coordinate: the coordinate goes stale when a lower-indexed window
        // closes within the daemon's scan interval, jumping the client to the
        // wrong pane. `%N` is immutable for the pane's life and is a valid
        // switch-client target. Fall back to the coordinate if pane id is absent.
        const target = data.session.tmuxPane ?? data.session.tmuxTarget;
        if (!target) {
          console.error("Session has no associated tmux pane");
          process.exit(1);
        }

        // Refuse a `%N` from a different tmux server: ids are unique only
        // within one server, so switching would land on an unrelated pane
        // that happens to share the id. Fail-open when either socket is
        // unknown (see lib/tmux-server.ts).
        const infoRes = await fetch(`${getDaemonUrl()}/server-info`).catch(
          () => null,
        );
        const daemonSocket =
          infoRes && infoRes.ok
            ? ((await infoRes.json()) as { socketPath: string | null })
                .socketPath
            : null;
        if (!isSameTmuxServer(daemonSocket)) {
          console.error(
            "Target pane is on a different tmux server; refusing to switch",
          );
          process.exit(1);
        }

        // Outside tmux (e.g. a notification click from Notification Center)
        // there is no implicit current client for `switch-client` to act
        // on, so target the most-recently-active attached client
        // explicitly. Inside tmux this is skipped entirely: argv is
        // unchanged from today's path.
        const switchArgs = ["tmux", "switch-client"];
        if (!process.env.TMUX) {
          const clientTty = await resolveActiveTmuxClientTty();
          if (!clientTty) {
            console.error(
              "No attached tmux client found; run this from inside tmux, or attach a client first",
            );
            process.exit(1);
          }
          switchArgs.push("-c", clientTty);
        }
        switchArgs.push("-t", target);

        const proc = Bun.spawn(switchArgs, {
          stdout: "pipe",
          stderr: "pipe",
        });

        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          console.error("Failed to switch tmux client");
          process.exit(1);
        }

        // Mark session as seen (fire-and-forget)
        fetch(`${getDaemonUrl()}/sessions/${sessionId}/seen`, {
          method: "POST",
        }).catch(() => {});
      } catch (error) {
        console.error("Failed to switch to session:", error);
        process.exit(1);
      }
    });
}
