/**
 * Finding tmux key bindings that open ccmux in a popup WITHOUT handing it the
 * invoking client's tty.
 *
 * A popup client's activity time never advances while the popup is up, not even
 * for keys typed into the popup, so tmux's "current client" is whichever OTHER
 * client typed last. A picker that was told nothing about its caller therefore
 * switches the wrong terminal as soon as a second client is attached. Passing
 * `--client-tty #{client_tty}` (or the older `-e CCMUX_CLIENT_TTY=`) pins it.
 *
 * `src/lib/legacy-popup.ts` catches this at the moment of a switch, but only
 * for a user who has two clients attached right then, and only by refusing the
 * switch. `ccmux setup` is what people run after upgrading, so it reports the
 * binding itself: the check reads `tmux list-keys` and looks for the shapes
 * that cannot pin a client.
 */

import { tmuxArgv } from "./tmux-exec";

/** One `list-keys` binding that opens ccmux in a popup with no client tty. */
export interface LegacyPopupBinding {
  /** Key table the binding lives in ("prefix", "root", ...), null if unparsed. */
  table: string | null;
  /** The key itself ("C-p"), null if unparsed. */
  key: string | null;
  /** The command the key runs, as tmux printed it. */
  command: string;
  /** The verbatim `list-keys` line. */
  line: string;
}

/**
 * The binding README documents, quoted here so `setup` prints exactly what the
 * docs say. `popup-binding-check.test.ts` asserts README still contains it
 * verbatim, so an edit to one without the other fails the suite.
 */
export const RECOMMENDED_POPUP_BINDING = `bind-key C-p run-shell -C 'display-popup -E -w 80% -h 75% "ccmux --client-tty #{client_tty}"'`;

/**
 * `bind-key [-r ...] -T <table> <key> <command...>`, the shape `list-keys`
 * always prints (a `-n` binding comes back as `-T root`, and notes are omitted
 * unless `-N` is passed, which the runner below does not pass).
 */
const BIND_LINE = /^bind-key\s+(?:-\S+\s+)*?-T\s+(\S+)\s+(\S+)\s+(.+)$/;

/**
 * Split a printed tmux command into bare words.
 *
 * `list-keys` re-quotes what the user typed, so the same binding can arrive as
 * `ccmux`, `"ccmux sidebar"`, or `\"ccmux\"` nested inside a `run-shell -C`
 * string. Unescaping and then dropping quote characters flattens all three into
 * the words that matter; nothing here needs to preserve argument boundaries.
 */
function words(command: string): string[] {
  return command
    .replace(/\\"/g, '"')
    .split(/\s+/)
    .map((token) => token.replace(/["']/g, ""))
    .filter((token) => token.length > 0);
}

/** Last path segment, so `/opt/homebrew/bin/ccmux` counts as a ccmux call. */
function basename(token: string): string {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}

/**
 * Does this command launch the ccmux PICKER?
 *
 * A binding whose every ccmux call is `ccmux sidebar` is left alone. Not
 * because a sidebar switches nothing (activating a background row does switch a
 * client), but because it takes no `--client-tty`: a sidebar belongs in a pane,
 * and one in a popup is unsupported either way.
 */
function invokesPicker(command: string): boolean {
  const tokens = words(command);
  for (let i = 0; i < tokens.length; i += 1) {
    if (basename(tokens[i]) !== "ccmux") continue;
    if (tokens[i + 1] === "sidebar") continue;
    return true;
  }
  return false;
}

/** Either supported way of handing the picker its caller's tty. */
function pinsClient(command: string): boolean {
  return (
    command.includes("--client-tty") || command.includes("CCMUX_CLIENT_TTY=")
  );
}

/**
 * The offending bindings in `tmux list-keys` output.
 *
 * Pure so the shapes can be tested against real `list-keys` text without a
 * server. A line has to name both `display-popup` and a ccmux picker call to be
 * judged at all: anything else is somebody else's binding.
 */
export function findLegacyPopupBindings(
  listKeysOutput: string,
): LegacyPopupBinding[] {
  const offenders: LegacyPopupBinding[] = [];
  for (const raw of listKeysOutput.split("\n")) {
    const line = raw.trimEnd();
    if (!line.includes("display-popup")) continue;
    const match = line.trim().match(BIND_LINE);
    // An unparsed line is still judged, on the whole line: better a report
    // naming no key than a missed binding.
    const command = match ? match[3] : line.trim();
    if (!invokesPicker(command)) continue;
    if (pinsClient(command)) continue;
    offenders.push({
      table: match ? match[1] : null,
      key: match ? match[2] : null,
      command,
      line,
    });
  }
  return offenders;
}

/**
 * `tmux list-keys` output, or null when tmux cannot answer.
 *
 * Fail soft on every arm: no server, a non-zero exit, no tmux on PATH. `ccmux
 * setup` installs agent hooks, which has nothing to do with tmux running, so an
 * unreadable tmux must cost the user nothing but this check.
 */
export async function readTmuxKeyBindings(): Promise<string | null> {
  try {
    const proc = Bun.spawn(tmuxArgv("list-keys"), {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return output;
  } catch {
    return null;
  }
}
