import { readFile } from "node:fs/promises";
import type { AgentDef, InvokeMode } from "../../lib/agents";
import type {
  AssistantLogEntry,
  LogEntry,
  SystemLogEntry,
  TextBlock,
} from "../../types/log";
import type { InvokeErrorKind, InvokeFailure, InvokeInput } from "./types";
import { substituteAll } from "../spawn-command";

/**
 * Walk a list of Claude transcript entries looking for a turn-end marker
 * (`assistant` with `stop_reason === "end_turn"`, `system` with
 * `turn_duration` / `stop_hook_summary` subtype, or a `result` row) and,
 * when found, return the concatenated text of the immediately-preceding
 * assistant entry. Returns `null` while the turn is still in flight.
 *
 * Exported for unit testing. Callers should pass entries scoped to the
 * current turn (e.g. via `readLogIncremental` from a pre-prompt byte
 * offset) to avoid stale prior-turn end markers satisfying the scan.
 */
export function scanForTurnEnd(entries: LogEntry[]): { text: string } | null {
  let endIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "assistant") {
      const msg = (e as AssistantLogEntry).message;
      if (msg.stop_reason === "end_turn") {
        endIdx = i;
        break;
      }
    } else if (e.type === "system") {
      const sub = (e as SystemLogEntry).subtype;
      if (sub === "turn_duration" || sub === "stop_hook_summary") {
        endIdx = i;
        break;
      }
    } else if (e.type === "result") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  for (let i = endIdx; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "assistant") {
      const msg = (e as AssistantLogEntry).message;
      const text = (msg.content ?? [])
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { text };
    }
  }
  return { text: "" };
}

/**
 * OpenCode `run --format json` emits one event object per line. The
 * model's response arrives in `{ type: "text", part: { type: "text",
 * text } }` events; we concatenate them in order. Tool calls, step
 * boundaries, and usage events are intentionally dropped.
 *
 * Exported for unit testing.
 */
export function extractOpencodeJsonText(jsonlText: string): string {
  const texts: string[] = [];
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isOpencodeTextEvent(event)) continue;
    texts.push(event.part.text);
  }
  return texts.join("").replace(/\n+$/, "");
}

interface OpencodeTextEvent {
  type: "text";
  part: { type: "text"; text: string };
}

function isOpencodeTextEvent(value: unknown): value is OpencodeTextEvent {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.type !== "text") return false;
  const part = obj.part;
  if (!part || typeof part !== "object") return false;
  const partObj = part as Record<string, unknown>;
  return partObj.type === "text" && typeof partObj.text === "string";
}

/**
 * Build the shell command typed into the tmux pane to launch claude.
 * NEW path returns the binary alone; RESUME substitutes the session id
 * into `agent.resumeCommand` if set, otherwise appends `--resume <id>`
 * to the binary. Exported for unit tests so the placeholder substitution
 * and resume-vs-new branching are pinned without spawning a real claude.
 */
export function buildClaudeLaunchCommand(input: InvokeInput): string {
  const binary = input.claudeBinary ?? "claude";
  if (!input.sessionId) return binary;
  if (input.agent.resumeCommand) {
    return substituteAll(input.agent.resumeCommand, "{id}", input.sessionId);
  }
  return `${binary} --resume ${input.sessionId}`;
}

/**
 * Active argv template for an invoke: `resumeArgs` when a session id is
 * present and defined, else `args`. Shared so `buildSubprocessArgv` and
 * `subprocessPromptInArgs` can't disagree on which template is live.
 */
function selectBaseArgs(mode: InvokeMode, sessionId?: string): string[] {
  return sessionId && mode.resumeArgs ? mode.resumeArgs : mode.args;
}

/**
 * Build the argv passed to `Bun.spawn` for the subprocess invoke path.
 * Picks `mode.resumeArgs` over `mode.args` when a session id is present,
 * and substitutes `{id}` / `{tmpfile}` / `{prompt}` placeholders in either.
 * Exported so per-agent argv shape (codex `-o {tmpfile}`, opencode
 * `--session {id}`, gemini `-p {prompt}`, etc.) can be table-driven tested
 * against InvokeMode definitions.
 */
export function buildSubprocessArgv(
  mode: InvokeMode,
  ctx: { sessionId?: string; tmpfile: string | null; prompt?: string },
): string[] {
  return selectBaseArgs(mode, ctx.sessionId).map((arg) => {
    if (arg === "{id}") return ctx.sessionId ?? "";
    if (arg === "{tmpfile}") return ctx.tmpfile ?? "";
    if (arg === "{prompt}") return ctx.prompt ?? "";
    return arg;
  });
}

/**
 * Whether the agent's active argv (resume vs fresh, via the shared
 * `selectBaseArgs` selection) carries the prompt as a `{prompt}`
 * argument. When true, the subprocess invoker passes the prompt via that
 * arg and must NOT also pipe it to stdin: gemini's headless `-p` mode reads
 * the argument, not stdin, and hangs on an empty `-p` plus piped stdin.
 */
export function subprocessPromptInArgs(
  mode: InvokeMode,
  sessionId?: string,
): boolean {
  return selectBaseArgs(mode, sessionId).includes("{prompt}");
}

/**
 * Pull the agent's response text out of stdout (Cursor/Gemini), the
 * tmpfile pointed at by `-o {tmpfile}` (Codex), or the JSONL event
 * stream on stdout (OpenCode). Returns "" when the tmpfile is missing
 * or unreadable; the caller treats `text === ""` plus non-empty stderr
 * as an `agent_error`. Exported for unit tests.
 */
export async function extractSubprocessResponse(
  mode: InvokeMode,
  ctx: { stdout: string; tmpfilePath: string | null },
): Promise<string> {
  switch (mode.output.kind) {
    case "stdout":
      return ctx.stdout.replace(/\n+$/, "");
    case "tmpfile": {
      if (!ctx.tmpfilePath) return "";
      try {
        const contents = await readFile(ctx.tmpfilePath, "utf8");
        return contents.replace(/\n+$/, "");
      } catch {
        return "";
      }
    }
    case "opencode-json":
      return extractOpencodeJsonText(ctx.stdout);
  }
}

/**
 * Best-effort native session-id extraction for subprocess-path agents.
 * Only OpenCode's JSONL exposes a stable session id in stdout; codex's
 * id is in the chrome banner (skipped when using `-o`), cursor doesn't
 * emit one in `--print` mode, gemini doesn't expose one in `-p` mode.
 * Returning undefined is fine, the CLI doesn't read this field.
 * Exported for unit tests.
 */
export function extractSubprocessSessionId(
  mode: InvokeMode,
  stdout: string,
): string | undefined {
  if (mode.output.kind !== "opencode-json") return undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as { sessionID?: unknown };
      if (typeof event.sessionID === "string") return event.sessionID;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Returns true when ALL of:
 * - a `readyPattern` is configured (undefined means "skip the wait")
 * - the current capture differs from the pre-launch baseline (otherwise
 *   a user's shell prompt that uses the same glyph as the agent, e.g.
 *   Starship/Pure with `❯`, would satisfy the pattern instantly,
 *   before the agent has even started)
 * - some line in the capture matches `readyPattern`
 */
export function isPromptReady(
  capture: string,
  baseline: string,
  readyPattern: RegExp | undefined,
): boolean {
  if (!readyPattern) return true;
  if (capture === baseline) return false;
  return capture.split("\n").some((line) => {
    // Reset for /g-flagged user regexes; `.test()` is stateful.
    readyPattern.lastIndex = 0;
    return readyPattern.test(line);
  });
}

/**
 * Shared `agent_error` message for the "agent is not invokable" case. Used
 * by `DaemonServer.handleInvoke` (front-door short-circuit when
 * `getInvokerFor` returns undefined) and `InvocationManager.invoke`
 * (defense-in-depth for any future non-server caller). Centralizing keeps
 * the CLI matchers and the test regex on `/invokeMode/` aligned across
 * both sites.
 */
export function noInvokeModeMessage(agent: AgentDef): string {
  return `${agent.name} does not support invoke (no invokeMode configured)`;
}

/**
 * Build the InvokeFailure shape both invokers and the manager need.
 * Centralizing keeps the discriminated-union construction in one place.
 */
export function fail(
  invocationId: string,
  kind: InvokeErrorKind,
  message: string,
  paneId?: string,
): InvokeFailure {
  return { success: false, invocationId, kind, message, paneId };
}

/**
 * Map an aborted operation to the failure shape. `signal.reason` is the
 * disambiguator: the manager calls `abort("cancelled")` from `cancel()`
 * and `abort("timeout")` from the timeout timer, so whoever aborts first
 * wins. `AbortController.abort()` is idempotent, so a later abort with a
 * different reason is a no-op.
 */
export function abortToFailure(
  invocationId: string,
  signal: AbortSignal,
  paneId?: string,
): InvokeFailure {
  if (signal.reason === "timeout") {
    return fail(invocationId, "timeout", "invocation timed out", paneId);
  }
  return fail(invocationId, "cancelled", "cancelled", paneId);
}
