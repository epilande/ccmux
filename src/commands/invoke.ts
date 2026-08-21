import { Command } from "commander";
import { randomUUID } from "crypto";
import { getDaemonUrl } from "../lib/config";
import { daemonBody } from "../lib/daemon-json";
import { getAgents } from "../lib/agents";
import { getPreferences } from "../lib/preferences";
import {
  mergePromptWithStdin,
  resolveInvokePositionals,
  isValidInvocationId,
} from "../lib/invoke-helpers";
import { ensureDaemon } from "./shared";
// Type-only imports (fully erased at build, no runtime coupling to the
// daemon) so the CLI and daemon share ONE definition of the wire shapes
// rather than a hand-maintained copy that drifts (esp. `kind`/`status`).
import type { InvocationRecord } from "../daemon/invocation-manager";
import type { InvokeErrorKind } from "../daemon/invokers/types";

interface InvokeResponse {
  success: boolean;
  invocationId?: string;
  sessionId?: string;
  paneId?: string;
  text?: string;
  durationMs?: number;
  kind?: InvokeErrorKind;
  message?: string;
}

/** Shape of `GET /invocations/:id/result`. */
interface InvocationResultResponse {
  available: boolean;
  output?: string;
  message?: string;
}

function generateInvocationId(): string {
  return "inv_" + randomUUID().replaceAll("-", "");
}

// Re-exported so existing importers (and the CLI unit tests) keep resolving
// `isValidInvocationId` from this module after the canonical definition moved
// to `invoke-helpers` (shared with the daemon).
export { isValidInvocationId };

/**
 * Validate a user-supplied invocation id for the `cancel`/`result`
 * subcommands, exiting with a clear error on a malformed id rather than
 * letting the daemon reject it generically. Shared so both verbs surface
 * the identical message and exit code.
 */
function assertValidInvocationId(id: string): void {
  if (!isValidInvocationId(id)) {
    console.error(`Invalid id: ${id} (must match inv_<4-32 alphanumerics>)`);
    process.exit(1);
  }
}

function kindToExitCode(kind: InvokeErrorKind | undefined): number {
  switch (kind) {
    case "rate_limit":
      return 2;
    case "hooks_missing":
      return 3;
    case "agent_error":
      return 4;
    case "timeout":
      return 124;
    case "cancelled":
      return 130;
    default:
      return 1;
  }
}

async function readStdinIfPiped(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await Bun.stdin.text();
}

export function createInvokeCommand(): Command {
  const command = new Command("invoke")
    .description(
      "Run a single agent turn and write the final response to stdout",
    )
    .argument("[args...]", "agent and/or prompt (default agent: claude)")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option("--timeout <ms>", "Timeout in milliseconds", "300000")
    .option("--session <id>", "Continue an existing session by native agent ID")
    .option(
      "--id <id>",
      "Caller-set invocation id (must match inv_<4-32 alphanumerics>); generated when omitted",
    )
    .option(
      "--format <fmt>",
      "Output format (only 'text' supported in v1)",
      "text",
    )
    .action(
      async (
        args: string[],
        options: {
          cwd: string;
          timeout: string;
          session?: string;
          id?: string;
          format: string;
        },
      ) => {
        if (options.format !== "text") {
          console.error(
            `--format=${options.format} is not supported in this build; only 'text' is available.`,
          );
          process.exit(1);
        }

        const timeoutMs = Number.parseInt(options.timeout, 10);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          console.error(`Invalid --timeout: ${options.timeout}`);
          process.exit(1);
        }

        // Resolve agent names from live preferences so custom agents
        // declared under `agents.*` in ccmux.json are routable. Using the
        // static `BUILTIN_AGENTS` list would silently treat any custom
        // agent name as a prompt fragment.
        const preferences = await getPreferences();
        const knownAgentNames = getAgents(preferences).map((a) => a.name);
        const { agent, promptArg } = resolveInvokePositionals(
          args,
          knownAgentNames,
        );

        let stdin = "";
        try {
          stdin = await readStdinIfPiped();
        } catch (err) {
          // Surface the underlying cause: a closed pipe mid-read is rare
          // but otherwise the user sees "No prompt provided" and has no
          // way to tell the stdin read failed.
          console.error(
            "ccmux invoke: stdin read failed:",
            err instanceof Error ? err.message : String(err),
          );
          stdin = "";
        }

        let prompt: string;
        try {
          prompt = mergePromptWithStdin(promptArg, stdin);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }

        // A caller-set --id lets an orchestrator name an invoke, then
        // poll/cancel/read its output by that name. Validate locally so
        // the user gets a clear error instead of the daemon's generic
        // "Missing or invalid 'invocationId'" rejection.
        if (options.id !== undefined && !isValidInvocationId(options.id)) {
          console.error(
            `Invalid --id: ${options.id} (must match inv_<4-32 alphanumerics>)`,
          );
          process.exit(1);
        }
        const invocationId = options.id ?? generateInvocationId();

        await ensureDaemon();

        let cancelled = false;
        const sigintHandler = () => {
          if (cancelled) return;
          cancelled = true;
          fetch(`${getDaemonUrl()}/invoke/${invocationId}/cancel`, {
            method: "POST",
          })
            .catch(() => {})
            .finally(() => process.exit(130));
          setTimeout(() => process.exit(130), 1500).unref();
        };
        process.on("SIGINT", sigintHandler);

        try {
          const response = await fetch(`${getDaemonUrl()}/invoke`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              invocationId,
              agent,
              prompt,
              cwd: options.cwd,
              sessionId: options.session,
              timeoutMs,
            }),
          });

          const data = await daemonBody<InvokeResponse>(response, "invoke");
          if (data.success && typeof data.text === "string") {
            // Wait for the kernel pipe buffer to drain before exiting:
            // `process.exit(0)` does not flush async stdout, so large
            // responses (the headline `git diff | ccmux invoke` use case)
            // can lose their tail without this.
            process.stdout.write(data.text, () => process.exit(0));
            return;
          }

          if (data.message) console.error(data.message);
          process.exit(kindToExitCode(data.kind));
        } catch (error) {
          console.error("Failed to invoke agent:", error);
          process.exit(1);
        }
      },
    );

  command.addCommand(createInvokeListCommand());
  command.addCommand(createInvokeCancelCommand());
  command.addCommand(createInvokeResultCommand());

  return command;
}

/**
 * Relative age of an invocation, for the `list` rendering. `startedAt` is
 * the daemon's `Date.now()` at admission; the live age of a running
 * worker has no other source (durationMs is success-only and post-finish).
 */
export function formatAge(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/**
 * One single-line row per invocation, matching `ccmux show`'s
 * single-line-per-row style (no table library). On a failure, the error
 * kind is shown so the orchestrator can decide retry from it.
 */
export function formatInvocation(record: InvocationRecord): string {
  const age =
    record.status === "running"
      ? `${formatAge(record.startedAt)} running`
      : record.durationMs !== undefined
        ? `${Math.round(record.durationMs / 1000)}s`
        : formatAge(record.startedAt);
  const outcome =
    record.status === "failed"
      ? `failed${record.kind ? ` (${record.kind})` : ""}`
      : record.status;
  return `${record.invocationId} - ${record.agent} - ${outcome} - ${age}`;
}

/** `ccmux invoke list`: one-shot snapshot of the daemon's invocation store. */
function createInvokeListCommand(): Command {
  return new Command("list")
    .description("List active and recently-finished invocations")
    .option("-j, --json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      await ensureDaemon();
      try {
        const response = await fetch(`${getDaemonUrl()}/invocations`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { invocations } = await daemonBody<{
          invocations: InvocationRecord[];
        }>(response, "invocation list");

        if (options.json) {
          console.log(JSON.stringify(invocations, null, 2));
          return;
        }
        if (invocations.length === 0) {
          console.log("No invocations");
          return;
        }
        console.log(`\nInvocations (${invocations.length}):\n`);
        for (const record of invocations) {
          console.log(formatInvocation(record));
        }
        console.log();
      } catch (error) {
        console.error("Failed to fetch invocations:", error);
        process.exit(1);
      }
    });
}

/** `ccmux invoke cancel <id>`: wraps POST /invoke/:id/cancel. */
function createInvokeCancelCommand(): Command {
  return new Command("cancel")
    .description("Cancel a running invocation by id")
    .argument("<id>", "invocation id")
    .action(async (id: string) => {
      assertValidInvocationId(id);
      await ensureDaemon();
      try {
        const response = await fetch(`${getDaemonUrl()}/invoke/${id}/cancel`, {
          method: "POST",
        });
        const data = await daemonBody<{
          success?: boolean;
          state?: "cancelling" | "already_finished" | "not_found";
          message?: string;
        }>(response, "cancel");
        if (!data.success && data.message) {
          console.error(data.message);
          process.exit(1);
        }
        // Render the daemon's classification truthfully rather than always
        // claiming "Cancelled": the id may have already finished or never
        // have run.
        switch (data.state) {
          case "already_finished":
            console.log(`${id} already finished (nothing to cancel)`);
            break;
          case "not_found":
            console.log(`${id} not found (cancel recorded in case it starts)`);
            break;
          case "cancelling":
            console.log(`Cancelling ${id}`);
            break;
          default:
            // Older daemon without the `state` field: preserve prior ack.
            console.log(`Cancelled ${id}`);
        }
      } catch (error) {
        console.error("Failed to cancel invocation:", error);
        process.exit(1);
      }
    });
}

/**
 * `ccmux invoke result <id>`: returns the invoke's full captured output
 * from the daemon's ephemeral result store. Reap-tolerant: a gone file
 * yields a clean "result no longer available" miss (exit 2), distinct from
 * a transport error (exit 1), so a consumer can tell them apart.
 */
function createInvokeResultCommand(): Command {
  return new Command("result")
    .description(
      "Print an invocation's full captured output (subprocess-agent invokes only in v1; Claude invokes always report no output). Exit 0 with output, 2 if no longer available, 1 on error",
    )
    .argument("<id>", "invocation id")
    .action(async (id: string) => {
      assertValidInvocationId(id);
      await ensureDaemon();
      try {
        const response = await fetch(
          `${getDaemonUrl()}/invocations/${id}/result`,
        );
        const data = await daemonBody<InvocationResultResponse>(
          response,
          "invocation result",
        );
        if (data.available && typeof data.output === "string") {
          // Flush-then-exit: process.exit does not drain async stdout, so
          // a large captured output would lose its tail without the
          // callback form (same contract as the invoke turn write above).
          process.stdout.write(data.output, () => process.exit(0));
          return;
        }
        // Exit 2 (not 1): a reap-tolerant miss is a normal outcome, so a
        // consumer (the orchestration skill) can distinguish "result
        // reaped/never-written" from "daemon unreachable" (exit 1 below).
        console.error(`result no longer available for ${id}`);
        process.exit(2);
      } catch (error) {
        console.error("Failed to fetch invocation result:", error);
        process.exit(1);
      }
    });
}
