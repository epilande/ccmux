import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { resolveRepoRoot } from "../lib/git";
import { HUNK_DIFF_ARGS, HUNK_INSTALL_HINT } from "../tui/utils/review";
import { ensureDaemon } from "./shared";

export function createReviewCommand(): Command {
  return new Command("review")
    .description("Review a session's diff with hunk")
    .argument("[session-id]", "Session ID (defaults to the current directory)")
    .action(async (sessionId?: string) => {
      const hunk = Bun.which("hunk");
      if (!hunk) {
        console.error(HUNK_INSTALL_HINT);
        process.exit(1);
      }

      // bin/ccmux cds into the package root for module resolution;
      // CCMUX_CALLER_PWD carries the caller's real invocation directory back
      // (see src/commands/sidebar.ts for the same restoration).
      let cwd = process.env.CCMUX_CALLER_PWD ?? process.cwd();
      if (sessionId) {
        await ensureDaemon();

        try {
          const response = await fetch(
            `${getDaemonUrl()}/sessions/${sessionId}`,
          );

          if (response.status === 404) {
            console.error(`Session not found: ${sessionId}`);
            process.exit(1);
          }

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = (await response.json()) as {
            session: { paneCwd: string | null; cwd: string };
          };
          cwd = data.session.paneCwd ?? data.session.cwd;
        } catch (error) {
          console.error("Failed to look up session:", error);
          process.exit(1);
        }
      }

      const root = await resolveRepoRoot(cwd);
      if (!root) {
        console.error(`Not a git repository: ${cwd}`);
        process.exit(1);
      }

      const proc = Bun.spawn([hunk, ...HUNK_DIFF_ARGS], {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await proc.exited);
    });
}
