/**
 * Putting text on the user's clipboard from inside the TUI.
 *
 * Two tiers, because neither one covers both places the picker runs:
 *
 * - A local clipboard COMMAND (`pbcopy`, `wl-copy`, `xclip`). Its exit code is
 *   ground truth: the text is on the clipboard or the process said why not.
 * - OSC 52, an escape sequence the terminal itself acts on, which is the only
 *   tier that reaches the machine the user is SITTING at when the picker is
 *   running over SSH.
 *
 * The command goes first everywhere except an SSH session, and the reason is
 * that OSC 52 cannot be verified from this side. Measured on this machine
 * (2026-08-03): inside tmux, OpenTUI wraps the sequence in tmux's DCS
 * passthrough and reports success for the WRITE, which tells us nothing about
 * whether anything received it: tmux forwards the wrapper verbatim only when
 * `allow-passthrough` is on (off by default since tmux 3.3), and the outer
 * terminal then has to honour OSC 52 as well. Both are invisible from here, so
 * a locally-running picker that led with OSC 52 could show "Copied" over an
 * unchanged clipboard. Over SSH the order flips: the local command would copy
 * to the REMOTE machine's clipboard, which is worse than unverifiable.
 *
 * Size is not guarded here. The only caller feeds this one transcript turn,
 * which the daemon already caps at 20,000 chars, comfortably under the ~100 KB
 * base64 ceiling terminals impose on an OSC 52 payload.
 */

/** Which tier actually took the text. */
export type ClipboardVia = "command" | "osc52";

export interface CopyResult {
  ok: boolean;
  /** The tier that succeeded, or null when none did. */
  via: ClipboardVia | null;
}

export interface CopyDeps {
  /** Emit an OSC 52 write; `CliRenderer.copyToClipboardOSC52` in the TUI.
   *  Returns whether the sequence was written at all (see the header: that is
   *  not the same as the clipboard having changed). */
  osc52: (text: string) => boolean;
  /** Run one clipboard command with `text` on stdin; resolves to whether it
   *  exited 0. Injected so tests never spawn. */
  runCommand?: (argv: string[], text: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

/**
 * The clipboard commands to try, in order, for a platform.
 *
 * Wayland before X11 on Linux: `xclip` under a Wayland session talks to XWayland
 * and can succeed into a clipboard nothing reads. An empty list is a platform
 * we know no command for, which leaves OSC 52 as the only tier.
 */
export function clipboardCommands(platform: NodeJS.Platform): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "linux") {
    return [["wl-copy"], ["xclip", "-selection", "clipboard"]];
  }
  return [];
}

/** Whether OSC 52 should be tried FIRST: the picker is running on a machine
 *  the user is not sitting at, so a local clipboard is the wrong clipboard. */
export function prefersOsc52(env: Record<string, string | undefined>): boolean {
  return Boolean(env.SSH_TTY || env.SSH_CONNECTION);
}

/** Spawn one clipboard command with the text on stdin. A missing binary
 *  throws, and reads here as "this tier declined", same as a non-zero exit. */
async function spawnClipboardCommand(
  argv: string[],
  text: string,
): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: argv,
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/** Put `text` on the clipboard, trying each tier until one takes it. */
export async function copyToClipboard(
  text: string,
  deps: CopyDeps,
): Promise<CopyResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const runCommand = deps.runCommand ?? spawnClipboardCommand;

  const tryCommand = async (): Promise<boolean> => {
    for (const argv of clipboardCommands(platform)) {
      if (await runCommand(argv, text)) return true;
    }
    return false;
  };
  // A throw here (a renderer torn down while the fetch was in flight) is this
  // tier declining, not the whole ladder failing: the tier below it may still
  // have a clipboard to write to.
  const tryOsc52 = async (): Promise<boolean> => {
    try {
      return deps.osc52(text);
    } catch {
      return false;
    }
  };

  const tiers: { via: ClipboardVia; run: () => Promise<boolean> }[] =
    prefersOsc52(env)
      ? [
          { via: "osc52", run: tryOsc52 },
          { via: "command", run: tryCommand },
        ]
      : [
          { via: "command", run: tryCommand },
          { via: "osc52", run: tryOsc52 },
        ];

  for (const tier of tiers) {
    if (await tier.run()) return { ok: true, via: tier.via };
  }
  return { ok: false, via: null };
}
