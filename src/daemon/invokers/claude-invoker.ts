import { matchErrorRules } from "../../lib/invoke-helpers";
import { stripAnsi } from "../../lib/strip-ansi";
import type { LogEntry } from "../../types/log";
import type { Session } from "../../types/session";
import { readLogIncremental } from "../parser";
import type { SessionEvent } from "../sessions";
import {
  createDetachedTmuxSession,
  killTmuxSession,
} from "../detached-session";
import {
  capturePane,
  getPaneCurrentCommand,
  sendKeyToPane,
  sendLiteralToPane,
  sendPromptToPane,
} from "../pane-io";
import { CANCEL_GRACE_MS, ERROR_CHROME_TAIL_LINES } from "./constants";
import {
  abortToFailure,
  buildClaudeLaunchCommand,
  fail,
  isPromptReady,
  scanForTurnEnd,
} from "./helpers";
import type { Invoker } from "./invoker";
import type { InvokeFailure, InvokeInput, InvokeResult } from "./types";

const PROMPT_READY_TIMEOUT_MS = 15_000;
const SESSION_CORRELATION_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const PROMPT_READY_CAPTURE_LINES = 100;
const CLAUDE_FAILURE_CAPTURE_LINES = 400;

/**
 * Structural view of the `SessionManager` surface the invoker needs.
 * Avoids `Pick<SessionManager, "on" | "off" | "getSessions">` because the
 * inherited `EventEmitter.on/off` return `this`, which forces test fakes
 * to claim full `SessionManager` identity. The structural form lets a
 * `FakeSessionManager extends EventEmitter` satisfy the type.
 */
interface InvokerSessionManager {
  getSessions(): Readonly<Session>[];
  on(event: "change", handler: (event: SessionEvent) => void): unknown;
  off(event: "change", handler: (event: SessionEvent) => void): unknown;
}

export interface ClaudeInvokerDeps {
  sessionManager: InvokerSessionManager;
  tmux: {
    createDetachedTmuxSession: typeof createDetachedTmuxSession;
    sendLiteralToPane: typeof sendLiteralToPane;
    sendPromptToPane: typeof sendPromptToPane;
    sendKeyToPane: typeof sendKeyToPane;
    capturePane: typeof capturePane;
    getPaneCurrentCommand: typeof getPaneCurrentCommand;
    killTmuxSession: typeof killTmuxSession;
  };
  readLogIncremental: typeof readLogIncremental;
  /**
   * Wraps `Bun.file(path).size`. Injected so tests don't need a real file
   * on disk for the RESUME baseline anchor.
   */
  getLogFileSize: (path: string) => number;
  now: () => number;
  /**
   * Override for `SESSION_CORRELATION_TIMEOUT_MS`. Lets the natural-timeout
   * branch of `waitForSessionByPane` be exercised without a 30s real-time
   * wait. Defaults to the constant when unset.
   */
  sessionCorrelationTimeoutMs?: number;
}

export function defaultClaudeInvokerDeps(
  sessionManager: InvokerSessionManager,
): ClaudeInvokerDeps {
  return {
    sessionManager,
    tmux: {
      createDetachedTmuxSession,
      sendLiteralToPane,
      sendPromptToPane,
      sendKeyToPane,
      capturePane,
      getPaneCurrentCommand,
      killTmuxSession,
    },
    readLogIncremental,
    getLogFileSize: (path) => Bun.file(path).size,
    now: () => Date.now(),
  };
}

/**
 * The invoker owns cancel choreography (C-c + grace + kill) rather than
 * the manager because the `Invoker` contract is `invoke(input, signal)`
 * with no mid-flight inspection methods. Exposing `paneId` for the manager
 * to drive C-c would leak invoker state. On `signal.aborted`, the
 * in-invoker abort handler flips a flag; the `finally` block awaits the
 * graceful C-c and grace before tearing down the tmux session.
 */
export class ClaudeInvoker implements Invoker {
  readonly kind = "claude-interactive" as const;

  constructor(private deps: ClaudeInvokerDeps) {}

  async invoke(input: InvokeInput, signal: AbortSignal): Promise<InvokeResult> {
    if (signal.aborted) return abortToFailure(input.invocationId, signal);

    const sessionName = "ccmux-invoke-" + input.invocationId;
    const tStart = this.deps.now();
    let paneId: string | null = null;
    let cancelTriggered = false;
    // Timeout and cancel both land here; the `finally` below runs C-c +
    // grace + kill on either. Pre-2.4, the manager hard-killed on timeout
    // with no C-c grace. The new behavior costs ~1.5s of extra latency on
    // the timeout response in exchange for letting Claude flush its log
    // (and matches what cancel already does), which is the cheaper win.
    const onAbort = () => {
      cancelTriggered = true;
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const pane = await this.deps.tmux.createDetachedTmuxSession(
        sessionName,
        input.cwd,
      );
      if (!pane) {
        return fail(input.invocationId, "unknown", "tmux new-session failed");
      }
      paneId = pane.paneId;
      if (signal.aborted) {
        return abortToFailure(input.invocationId, signal, paneId);
      }

      const cmd = buildClaudeLaunchCommand(input);

      // Capture the pre-launch pane (typically the user's bare shell
      // prompt) so `waitForClaudePromptReady` can require a transition
      // before declaring the agent's TUI ready. Without this baseline, a
      // shell theme using the same glyph as Claude's prompt would satisfy
      // the pattern instantly, before claude has even started.
      const preLaunchBaseline = stripAnsi(
        await this.deps.tmux.capturePane(paneId, PROMPT_READY_CAPTURE_LINES),
      );
      // Snapshot the pane's foreground process so we can verify after the
      // readyPattern matches that claude actually took over the pane. If
      // claude crashes immediately and the shell returns to a new prompt,
      // the readyPattern + baseline-transition gate both pass, but
      // pane_current_command still names the shell.
      const preLaunchCommand =
        await this.deps.tmux.getPaneCurrentCommand(paneId);

      const launched = await this.deps.tmux.sendLiteralToPane(
        paneId,
        cmd,
        true,
      );
      if (!launched) {
        if (signal.aborted) {
          return abortToFailure(input.invocationId, signal, paneId);
        }
        return fail(
          input.invocationId,
          "unknown",
          "failed to send launch command",
          paneId,
        );
      }

      const promptReady = await this.waitForClaudePromptReady(
        paneId,
        input.agent.readyPattern,
        preLaunchBaseline,
        signal,
      );
      if (promptReady === "aborted") {
        return abortToFailure(input.invocationId, signal, paneId);
      }
      if (promptReady === "expired") {
        return fail(
          input.invocationId,
          "agent_error",
          `Claude prompt did not appear within ${PROMPT_READY_TIMEOUT_MS / 1000}s`,
          paneId,
        );
      }

      // Defense-in-depth against the post-crash-to-shell case: the
      // baseline-transition gate above protects the instant-collision case
      // (shell themes that share Claude's prompt glyph), but not the
      // delayed case where claude crashes immediately, the shell returns
      // to a new prompt line, and the new line still matches the pattern.
      // Without this guard, sendPromptToPane would type the user's prompt
      // into the shell and press Enter, executing arbitrary text.
      if (preLaunchCommand !== null) {
        const postReadyCommand =
          await this.deps.tmux.getPaneCurrentCommand(paneId);
        if (
          postReadyCommand !== null &&
          postReadyCommand === preLaunchCommand
        ) {
          return fail(
            input.invocationId,
            "agent_error",
            "Claude did not take over the pane (binary missing or crashed?)",
            paneId,
          );
        }
      }

      // Correlation timing is asymmetric for NEW vs RESUME:
      //
      // - NEW: the daemon creates the Session only once chokidar sees
      //   `<session_id>.jsonl`, and Claude doesn't write that file until
      //   the first turn fires. Send the prompt BEFORE correlating; the
      //   log baseline is safely 0 because the file starts empty.
      // - RESUME: the prior transcript is already known, so correlation
      //   succeeds pre-prompt, letting us anchor on the transcript byte
      //   offset before sending the new turn.
      let logBaseline = 0;
      let session: Session;

      if (!input.sessionId) {
        const sentPrompt = await this.deps.tmux.sendPromptToPane(
          paneId,
          input.prompt,
          true,
        );
        if (!sentPrompt) {
          if (signal.aborted) {
            return abortToFailure(input.invocationId, signal, paneId);
          }
          return fail(
            input.invocationId,
            "unknown",
            "failed to send prompt",
            paneId,
          );
        }
        const correlated = await this.correlateSession(
          paneId,
          signal,
          input.invocationId,
        );
        if (!correlated.ok) return correlated.failure;
        session = correlated.session;
      } else {
        const correlated = await this.correlateSession(
          paneId,
          signal,
          input.invocationId,
        );
        if (!correlated.ok) return correlated.failure;
        session = correlated.session;
        if (session.logPath) {
          try {
            logBaseline = this.deps.getLogFileSize(session.logPath);
          } catch {
            // Transcript may not exist yet; readLogIncremental from 0
            // will see everything once it appears.
          }
        }
        const sentPrompt = await this.deps.tmux.sendPromptToPane(
          paneId,
          input.prompt,
          true,
        );
        if (!sentPrompt) {
          if (signal.aborted) {
            return abortToFailure(input.invocationId, signal, paneId);
          }
          return fail(
            input.invocationId,
            "unknown",
            "failed to send prompt",
            paneId,
          );
        }
      }

      const turnText = await this.awaitClaudeTurnEnd(
        session,
        logBaseline,
        signal,
      );
      if (signal.aborted) {
        return abortToFailure(input.invocationId, signal, paneId);
      }
      const text = turnText.text;

      // Failure-mode errorRule check: the transcript is authoritative when
      // we have text, so only scan the chrome region when the turn produced
      // no assistant message (typically a rate-limit banner instead of a
      // response). Unlike the subprocess path, an unexplained empty `text`
      // here is returned as a successful empty response: Claude's turn-end
      // markers are reliable enough that empty text genuinely means "the
      // assistant said nothing this turn" once errorRules have ruled out
      // the rate-limit case.
      const errorRules = input.agent.errorRules ?? [];
      if (errorRules.length > 0 && text === "") {
        const afterPane = await this.deps.tmux.capturePane(
          paneId,
          CLAUDE_FAILURE_CAPTURE_LINES,
        );
        const chromeRegion = stripAnsi(afterPane)
          .split("\n")
          .slice(-ERROR_CHROME_TAIL_LINES)
          .join("\n");
        const errorMatch = matchErrorRules(chromeRegion, errorRules);
        if (errorMatch) {
          return fail(
            input.invocationId,
            errorMatch.kind,
            errorMatch.message,
            paneId,
          );
        }
      }

      return {
        success: true,
        invocationId: input.invocationId,
        // session.id is a ccmux-internal UUID; passing it back as
        // `--session <id>` would fail at `claude --resume`. Emit only the
        // native id, which is what claude --resume understands.
        sessionId: session.nativeSessionId,
        paneId,
        text,
        durationMs: this.deps.now() - tStart,
      };
    } finally {
      // Cancel-choreography delta vs the manager: in invocation-manager.ts,
      // `cancel()` awaits C-c + grace + kill synchronously, so the HTTP
      // caller doesn't see a response until teardown is done. Here the
      // same sequence runs only on invoke()'s unwind, so 2.4's
      // orchestrator must `await` the invoke promise from its own
      // `cancel()` if HTTP `POST /invoke/:id/cancel` is still expected to
      // return after teardown completes.
      signal.removeEventListener("abort", onAbort);
      if (cancelTriggered && paneId) {
        try {
          await this.deps.tmux.sendKeyToPane(paneId, "C-c");
        } catch {
          // Best-effort graceful shutdown; the kill below is the actual
          // teardown.
        }
        await sleep(CANCEL_GRACE_MS);
      }
      await this.deps.tmux.killTmuxSession(sessionName);
    }
  }

  private async waitForClaudePromptReady(
    paneId: string,
    readyPattern: RegExp | undefined,
    baseline: string,
    signal: AbortSignal,
  ): Promise<"ready" | "aborted" | "expired"> {
    if (!readyPattern) return "ready";
    const start = this.deps.now();
    while (this.deps.now() - start < PROMPT_READY_TIMEOUT_MS) {
      if (signal.aborted) return "aborted";
      const stripped = stripAnsi(
        await this.deps.tmux.capturePane(paneId, PROMPT_READY_CAPTURE_LINES),
      );
      if (isPromptReady(stripped, baseline, readyPattern)) return "ready";
      await sleepUntilAborted(POLL_INTERVAL_MS, signal);
    }
    return signal.aborted ? "aborted" : "expired";
  }

  private async correlateSession(
    paneId: string,
    signal: AbortSignal,
    invocationId: string,
  ): Promise<
    { ok: true; session: Session } | { ok: false; failure: InvokeFailure }
  > {
    const timeoutMs =
      this.deps.sessionCorrelationTimeoutMs ?? SESSION_CORRELATION_TIMEOUT_MS;
    const correlated = await this.waitForSessionByPane(
      paneId,
      timeoutMs,
      signal,
    );
    if (correlated.kind === "aborted") {
      return {
        ok: false,
        failure: abortToFailure(invocationId, signal, paneId),
      };
    }
    if (correlated.kind === "timeout") {
      return {
        ok: false,
        failure: fail(
          invocationId,
          "agent_error",
          `Agent did not produce a session within ${timeoutMs / 1000}s`,
          paneId,
        ),
      };
    }
    return { ok: true, session: correlated.session };
  }

  private async waitForSessionByPane(
    paneId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<
    { kind: "ok"; session: Session } | { kind: "timeout" } | { kind: "aborted" }
  > {
    const existing = this.deps.sessionManager
      .getSessions()
      .find((s) => s.tmuxPane === paneId);
    if (existing) return { kind: "ok", session: existing as Session };

    if (signal.aborted) return { kind: "aborted" };

    return new Promise((resolve) => {
      const cleanup = () => {
        this.deps.sessionManager.off("change", onChange);
        signal.removeEventListener("abort", onAbort);
        clearTimeout(timer);
      };
      const onChange = (event: SessionEvent) => {
        if (event.session && event.session.tmuxPane === paneId) {
          cleanup();
          resolve({ kind: "ok", session: event.session });
        }
      };
      const onAbort = () => {
        cleanup();
        resolve({ kind: "aborted" });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ kind: "timeout" });
      }, timeoutMs);
      this.deps.sessionManager.on("change", onChange);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async awaitClaudeTurnEnd(
    session: Session,
    logBaseline: number,
    signal: AbortSignal,
  ): Promise<{ text: string }> {
    // Rolling offset + in-memory accumulator: total file I/O is O(K) per
    // turn regardless of duration. The scan still walks the full
    // accumulator so a prior assistant block paired with a later
    // end-marker is matched correctly.
    const accumulated: LogEntry[] = [];
    let offset = logBaseline;
    while (!signal.aborted) {
      const logPath = session.logPath;
      if (logPath) {
        const { entries, newOffset } = await this.deps.readLogIncremental(
          logPath,
          offset,
        );
        offset = newOffset;
        if (entries.length > 0) {
          accumulated.push(...entries);
          const result = scanForTurnEnd(accumulated);
          if (result !== null) return result;
        }
      }
      await sleepUntilAborted(POLL_INTERVAL_MS, signal);
    }
    return { text: "" };
  }
}

function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
