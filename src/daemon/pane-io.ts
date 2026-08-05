import { DaemonPerf } from "./perf";
import { tmuxArgv } from "../lib/tmux-exec";

export async function capturePane(
  paneId: string,
  lines: number = 50,
): Promise<string> {
  DaemonPerf.incPaneCapture();
  DaemonPerf.incSubprocessSpawn("tmux-capture-pane");
  const captureStartNs = DaemonPerf.paneCaptureStart();
  try {
    const proc = Bun.spawn(
      tmuxArgv("capture-pane", "-t", paneId, "-p", `-S-${lines}`),
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const output = await new Response(proc.stdout).text();
    await proc.exited;
    DaemonPerf.paneCaptureEnd(captureStartNs);
    return output;
  } catch {
    DaemonPerf.paneCaptureEnd(captureStartNs);
    return "";
  }
}

/**
 * Read the foreground process name running in a tmux pane (e.g., "zsh",
 * "bash", "node", "claude"). Returns null on failure so callers can
 * fall open rather than blocking on a transient tmux error.
 */
export async function getPaneCurrentCommand(
  paneId: string,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      tmuxArgv(
        "display-message",
        "-p",
        "-t",
        paneId,
        "-F",
        "#{pane_current_command}",
      ),
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    if (exitCode !== 0 || !output) return null;
    return output;
  } catch {
    return null;
  }
}

/**
 * Resolve the window (`@7`) and session (`$3`) containing a pane, and
 * thereby whether the pane exists at all. Needed by `POST /spawn`, which
 * gets a pane id from the caller but cannot hand one to `new-window`
 * ("can't specify pane here"). Ids rather than names: both are stable and
 * immune to a session name containing a space or colon.
 *
 * tmux exits 0 with EMPTY output for a pane that no longer exists, so an
 * empty result is folded into null alongside real failures — otherwise a
 * closed pane would silently become "no target" and land the spawn in an
 * arbitrary session.
 */
export async function resolvePaneLocation(
  paneId: string,
): Promise<{ windowId: string; sessionId: string } | null> {
  try {
    const proc = Bun.spawn(
      tmuxArgv(
        "display-message",
        "-p",
        "-t",
        paneId,
        "-F",
        "#{window_id} #{session_id}",
      ),
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const [windowId, sessionId] = output.split(" ");
    if (!windowId || !sessionId) return null;
    return { windowId, sessionId };
  } catch {
    return null;
  }
}

/**
 * Send literal text to a pane, then optionally press Enter.
 * Mirrors the pattern in server.ts handleSendToSession: uses 'send-keys -l --'
 * so strings like 'Enter', 'C-c', 'Space' inside the text are NOT interpreted
 * as named keys. Use this for prompts and any user-typed content.
 */
export async function sendLiteralToPane(
  paneId: string,
  text: string,
  pressEnter: boolean,
): Promise<boolean> {
  try {
    const literal = Bun.spawn(
      tmuxArgv("send-keys", "-t", paneId, "-l", "--", text),
      { stdout: "pipe", stderr: "pipe" },
    );
    const literalExit = await literal.exited;
    if (literalExit !== 0) return false;

    if (pressEnter) {
      // Small delay so TUIs (notably Codex 0.124+) don't batch the literal
      // text and the Enter into a single paste, which leaves the text in the
      // composer and never submits.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const enter = Bun.spawn(tmuxArgv("send-keys", "-t", paneId, "Enter"), {
        stdout: "pipe",
        stderr: "pipe",
      });
      const enterExit = await enter.exited;
      if (enterExit !== 0) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/** Monotonic suffix for {@link sendPromptToPane}'s tmux buffer names. */
let promptBufferSeq = 0;

/**
 * Send a multi-line prompt to a pane via tmux's paste buffer with the
 * bracketed-paste flag (`paste-buffer -p`). The receiving TUI (Claude
 * Code, etc.) sees the content wrapped in `ESC [ 200 ~` ... `ESC [ 201 ~`
 * and treats it as a single paste, so embedded newlines stay in the
 * input box instead of being interpreted as separate Enter presses
 * (which is what `send-keys -l` does for any string containing `\n`).
 *
 * After pasting, optionally sends an explicit Enter to submit.
 *
 * Do NOT use this for shell commands (the buffer's bracketed-paste
 * sequence is meaningless to a non-readline shell); use sendLiteralToPane
 * for those.
 */
export async function sendPromptToPane(
  paneId: string,
  text: string,
  pressEnter: boolean,
): Promise<boolean> {
  // Per-CALL buffer name, not per-pane. Two sends aimed at the same pane
  // (two /invoke calls, an /invoke racing a handoff) used to share one
  // buffer, so the second load could overwrite the first's text between its
  // load and its paste: the pane received the wrong prompt, both calls
  // reported success, and Enter was pressed twice. The name never outlives
  // this call, so a counter is enough to keep them apart. The paneId is
  // %<digits> in tmux, which is always safe in a buffer name.
  const bufferName = `ccmux-invoke${paneId.replace(/[^A-Za-z0-9]/g, "_")}-${++promptBufferSeq}`;
  try {
    const load = Bun.spawn(tmuxArgv("load-buffer", "-b", bufferName, "-"), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    load.stdin.write(text);
    await load.stdin.end();
    const loadExit = await load.exited;
    if (loadExit !== 0) return false;

    const paste = Bun.spawn(
      tmuxArgv("paste-buffer", "-p", "-b", bufferName, "-d", "-t", paneId),
      { stdout: "pipe", stderr: "pipe" },
    );
    const pasteExit = await paste.exited;
    if (pasteExit !== 0) return false;

    if (pressEnter) {
      // Same 150ms gap as sendLiteralToPane: gives the TUI a tick to
      // commit the paste before we send the submit.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const enter = Bun.spawn(tmuxArgv("send-keys", "-t", paneId, "Enter"), {
        stdout: "pipe",
        stderr: "pipe",
      });
      const enterExit = await enter.exited;
      if (enterExit !== 0) return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Send a named tmux key to a pane (Enter, C-c, Escape, etc.).
 * Do NOT pass user content here, use sendLiteralToPane instead.
 */
export async function sendKeyToPane(
  paneId: string,
  key: string,
): Promise<boolean> {
  try {
    const proc = Bun.spawn(tmuxArgv("send-keys", "-t", paneId, key), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
