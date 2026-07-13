import { DaemonPerf } from "./perf";

export async function capturePane(
  paneId: string,
  lines: number = 50,
): Promise<string> {
  DaemonPerf.incPaneCapture();
  DaemonPerf.incSubprocessSpawn("tmux-capture-pane");
  const captureStartNs = DaemonPerf.paneCaptureStart();
  try {
    const proc = Bun.spawn(
      ["tmux", "capture-pane", "-t", paneId, "-p", `-S-${lines}`],
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
      [
        "tmux",
        "display-message",
        "-p",
        "-t",
        paneId,
        "-F",
        "#{pane_current_command}",
      ],
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
      ["tmux", "send-keys", "-t", paneId, "-l", "--", text],
      { stdout: "pipe", stderr: "pipe" },
    );
    const literalExit = await literal.exited;
    if (literalExit !== 0) return false;

    if (pressEnter) {
      // Small delay so TUIs (notably Codex 0.124+) don't batch the literal
      // text and the Enter into a single paste, which leaves the text in the
      // composer and never submits.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const enter = Bun.spawn(["tmux", "send-keys", "-t", paneId, "Enter"], {
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
  // Per-pane buffer name keeps concurrent invocations from clobbering
  // each other's buffer if tmux ever schedules paste-buffer out of order.
  // The paneId is %<digits> in tmux, which is always safe in a buffer name.
  const bufferName = `ccmux-invoke${paneId.replace(/[^A-Za-z0-9]/g, "_")}`;
  try {
    const load = Bun.spawn(["tmux", "load-buffer", "-b", bufferName, "-"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    load.stdin.write(text);
    await load.stdin.end();
    const loadExit = await load.exited;
    if (loadExit !== 0) return false;

    const paste = Bun.spawn(
      ["tmux", "paste-buffer", "-p", "-b", bufferName, "-d", "-t", paneId],
      { stdout: "pipe", stderr: "pipe" },
    );
    const pasteExit = await paste.exited;
    if (pasteExit !== 0) return false;

    if (pressEnter) {
      // Same 150ms gap as sendLiteralToPane: gives the TUI a tick to
      // commit the paste before we send the submit.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const enter = Bun.spawn(["tmux", "send-keys", "-t", paneId, "Enter"], {
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
    const proc = Bun.spawn(["tmux", "send-keys", "-t", paneId, key], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
