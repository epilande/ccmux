import {
  getDaemonUrl,
  isCcmuxPane,
  SIDEBAR_PANE_TITLE,
} from "../../lib/config";
import { PANE_FIELD_SEP } from "../../lib/tmux-format";
import { theme } from "../theme";

/**
 * Capture a pane's visible content. THROWS on failure (spawn error or non-zero
 * `tmux capture-pane` exit — the pane is gone). We await the exit code so a dead
 * pane throws rather than returning `""`, which would silently blank the preview
 * like a genuinely empty live pane. Callers treating any failure as empty (e.g.
 * the search cache) should `.catch(() => "")`.
 */
export async function capturePane(
  paneId: string,
  lines: number = 50,
): Promise<string> {
  const proc = Bun.spawn(
    ["tmux", "capture-pane", "-e", "-t", paneId, "-p", `-S-${lines}`],
    {
      stdout: "pipe",
      // Failure shows in the exit code below; don't allocate an unread pipe.
      stderr: "ignore",
    },
  );

  const [output, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `tmux capture-pane failed for ${paneId} (exit ${exitCode})`,
    );
  }
  return output;
}

export async function switchToPane(target: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "switch-client", "-t", target], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

const SPECIAL_KEY_MAP: Record<string, string> = {
  return: "Enter",
  enter: "Enter",
  backspace: "BSpace",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  space: "Space",
  delete: "DC",
  home: "Home",
  end: "End",
  tab: "Tab",
  escape: "Escape",
};

async function tmuxSendKeys(
  target: string,
  ...args: string[]
): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "send-keys", "-t", target, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

export async function sendKeys(
  target: string,
  event: { name: string; ctrl?: boolean },
): Promise<boolean> {
  try {
    const { name, ctrl } = event;

    if (ctrl && name.length === 1) {
      return tmuxSendKeys(target, `C-${name}`);
    }

    const mapped = SPECIAL_KEY_MAP[name];
    if (mapped) {
      return tmuxSendKeys(target, mapped);
    }

    if (name.length === 1) {
      return tmuxSendKeys(target, "-l", name);
    }

    return false;
  } catch {
    return false;
  }
}

const FLASH_DURATION_MS = 500;

/** Pane-flash background, read at call time so it follows the active theme
 * (a module-scope const would freeze the default palette at import). Uses the
 * `surface` semantic color (Mocha's #313244, the prior hardcoded value). */
function flashBg(): string {
  return `bg=${theme.surface}`;
}

let flashTimer: Timer | null = null;
let flashingPaneId: string | null = null;

function resetPaneStyle(paneId: string): void {
  Bun.spawn(["tmux", "set-option", "-p", "-u", "-t", paneId, "window-style"], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * Briefly flash a pane's background (500ms).
 * Uses per-pane window-style to avoid stealing focus.
 * Skips if the pane is already being flashed. Defers reset of the
 * previous pane, guarded against A->B->A races.
 */
export function flashPane(paneId: string): void {
  if (flashingPaneId === paneId && flashTimer) return;

  if (flashTimer) {
    clearTimeout(flashTimer);
    if (flashingPaneId && flashingPaneId !== paneId) {
      const oldPane = flashingPaneId;
      setTimeout(() => {
        if (flashingPaneId !== oldPane) resetPaneStyle(oldPane);
      }, 0);
    }
  }

  flashingPaneId = paneId;

  Bun.spawn(
    ["tmux", "set-option", "-p", "-t", paneId, "window-style", flashBg()],
    { stdout: "ignore", stderr: "ignore" },
  );

  flashTimer = setTimeout(() => {
    resetPaneStyle(paneId);
    flashTimer = null;
    flashingPaneId = null;
  }, FLASH_DURATION_MS);
}

/**
 * Spawn a detached flash that self-resets after 500ms.
 * Use when the calling process is about to exit (e.g. picker in a tmux popup).
 * Uses `tmux run-shell -b` so the reset runs in tmux's own process context
 * and survives popup teardown, which kills the entire child process group.
 */
export function flashPaneDetached(paneId: string): void {
  Bun.spawn(
    ["tmux", "set-option", "-p", "-t", paneId, "window-style", flashBg()],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  Bun.spawn(
    [
      "tmux",
      "run-shell",
      "-b",
      `sleep ${FLASH_DURATION_MS / 1000} && tmux set-option -p -u -t '${paneId}' window-style`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
}

export async function selectPane(paneId: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "select-pane", "-t", paneId], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/** Window name tagging the shared `claude agents` window for dedupe. */
export const AGENTS_WINDOW_NAME = "ccmux-agents";

/** Window name tagging a per-agent `claude attach` window for dedupe. */
export function agentAttachWindowName(shortId: string): string {
  return `ccmux-agent-${shortId}`;
}

/**
 * Find the window id of an existing window with the given name in
 * `list-windows -a` output (lines of "#{window_id}<sep>#{window_name}").
 * Pure, for tests.
 */
export function parseWindowIdByName(
  output: string,
  windowName: string,
): string | null {
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [windowId, name] = line.split(PANE_FIELD_SEP);
    if (windowId && name === windowName) return windowId;
  }
  return null;
}

export type OpenAgentsResult = { ok: true } | { ok: false; error: string };

/**
 * Roster short ids are hex in practice, but they arrive from Claude's
 * roster.json (external JSON) and end up inside a `sh -c` command line, so
 * refuse anything outside the boring character set rather than trusting it.
 * Pure, for tests (the launcher itself is process-wide-mocked in TUI tests).
 */
export function isSafeAgentShortId(shortId: string): boolean {
  return /^[\w-]+$/.test(shortId);
}

/**
 * Resolve the `claude` binary with THIS process's PATH (the user's shell
 * env). The spawned window's command runs under the tmux server's env via
 * `sh -c`, which may lack the user's rc-file PATH additions, so passing an
 * absolute path keeps the launch from dying instantly in a closed window.
 */
function resolveClaudeBin(): string | null {
  return Bun.which("claude");
}

/**
 * Open the global Claude agent view (the full background-agent list) in the
 * shared `ccmux-agents` window. Browse/dispatch surface; row activation uses
 * the per-agent attach below.
 */
export async function openAgentsWindow(cwd: string): Promise<OpenAgentsResult> {
  const claude = resolveClaudeBin();
  if (!claude) return { ok: false, error: "claude not found in PATH" };
  return openDedupedCommandWindow(
    AGENTS_WINDOW_NAME,
    cwd,
    `"${claude}" agents`,
  );
}

/**
 * Attach to one background agent (`claude attach <short>`) in a window
 * deduped per agent, so re-activating row A refocuses A's window while row B
 * gets its own. Ctrl+Z detaches (the agent keeps running) and exits the
 * process, which closes the window (the command IS the pane process).
 */
export async function openAgentAttachWindow(
  shortId: string,
  cwd: string,
): Promise<OpenAgentsResult> {
  if (!isSafeAgentShortId(shortId)) {
    return { ok: false, error: `unexpected agent id: ${shortId}` };
  }
  const claude = resolveClaudeBin();
  if (!claude) return { ok: false, error: "claude not found in PATH" };
  return openDedupedCommandWindow(
    agentAttachWindowName(shortId),
    cwd,
    `"${claude}" attach ${shortId}`,
  );
}

/**
 * Switch to an existing window with the given name if one is live, else spawn
 * one (cwd = the row's cwd) running `command` and switch to it. The command
 * is passed to `new-window` itself (tmux runs it via a non-interactive
 * `sh -c`), so it IS the pane process: the window's lifetime equals the
 * command's, no interactive shell init can swallow input, and a failed
 * command closes the window instead of leaving a bare shell behind. That
 * keeps the name-based dedupe honest: `new-window -n` pins the name with
 * automatic-rename off, so a lingering shell would otherwise keep the name
 * and the next launch would switch to that dead shell instead of
 * relaunching. The paneless analog of pane click-through for
 * `trackingMode:"background"` rows.
 */
async function openDedupedCommandWindow(
  windowName: string,
  cwd: string,
  command: string,
): Promise<OpenAgentsResult> {
  // Outside tmux there is no client to switch: new-window would land the
  // window in some unattached session while the picker exits claiming
  // success. Fail loudly instead.
  if (!process.env.TMUX) {
    return { ok: false, error: "not inside tmux" };
  }
  try {
    const list = Bun.spawn(
      [
        "tmux",
        "list-windows",
        "-a",
        "-F",
        ["#{window_id}", "#{window_name}"].join(PANE_FIELD_SEP),
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const listOut = await new Response(list.stdout).text();
    const existing =
      (await list.exited) === 0
        ? parseWindowIdByName(listOut, windowName)
        : null;
    if (existing) {
      const switchProc = Bun.spawn(["tmux", "switch-client", "-t", existing], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if ((await switchProc.exited) === 0) return { ok: true };
      // Window vanished between list and switch: fall through and spawn.
    }

    const spawn = Bun.spawn(
      [
        "tmux",
        "new-window",
        "-n",
        windowName,
        "-c",
        cwd,
        "-P",
        "-F",
        "#{pane_id}",
        command,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if ((await spawn.exited) !== 0) {
      const stderr = (await new Response(spawn.stderr).text()).trim();
      return { ok: false, error: stderr || "tmux new-window failed" };
    }
    const paneId = (await new Response(spawn.stdout).text()).trim();

    // new-window already selects within its session; switch-client covers
    // the popup / other-session contexts (same approach as switchToPane).
    await Bun.spawn(["tmux", "switch-client", "-t", paneId], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Notify the daemon about the active pane so all TUI clients stay in sync. */
export function notifyActivePane(paneId: string): void {
  fetch(`${getDaemonUrl()}/active-pane`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paneId }),
  }).catch(() => {});
}

/**
 * Pick the sibling pane to restore focus to after the sidebar's OpenTUI
 * capability probes drain. Returns null when:
 *  - we're already the active pane (user-launched, no probe leak to fix)
 *  - no other non-sidebar pane exists in our window (lone sidebar)
 *  - self isn't in the output (race: pane was killed mid-query)
 *
 * Expected line format: "#{pane_id}<sep>#{pane_title}<sep>#{pane_active}".
 * `pane_active` is "1" for the window's active pane, "0" otherwise.
 */
export function parseRestoreCandidate(
  output: string,
  selfPane: string,
): string | null {
  let active: string | null = null;
  let selfSeen = false;
  let selfIsActive = false;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const [paneId, title, isActive] = line.split(PANE_FIELD_SEP);
    if (!paneId) continue;
    if (paneId === selfPane) {
      selfSeen = true;
      selfIsActive = isActive === "1";
      continue;
    }
    if (title === SIDEBAR_PANE_TITLE) continue;
    if (isActive === "1") active = paneId;
  }

  if (!selfSeen || selfIsActive) return null;
  return active;
}

/**
 * Find the active sibling pane to restore focus to. Returns null when
 * the dance isn't needed (already focused) or when no candidate exists.
 */
export async function findRestorePane(): Promise<string | null> {
  const self = process.env.TMUX_PANE;
  if (!self) return null;

  try {
    const proc = Bun.spawn(
      [
        "tmux",
        "list-panes",
        "-F",
        ["#{pane_id}", "#{pane_title}", "#{pane_active}"].join(PANE_FIELD_SEP),
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return parseRestoreCandidate(output, self);
  } catch {
    return null;
  }
}

/**
 * Pick the pane a TUI surface was launched over, from
 * "#{pane_id}<sep>#{pane_title}<sep>#{pane_active}" lines for its window.
 *
 * ccmux's own surfaces are excluded, and that is the point rather than a
 * detail: a sidebar asked to split "the current pane" would otherwise
 * halve the 30-column rail it lives in. `selfPane` covers the untitled
 * cases (a picker run straight from a shell) that the title check misses.
 * A popup picker is not a pane at all, so it contributes neither.
 *
 * Falls back to the first eligible pane when the active one is ccmux's,
 * and to null when the window holds nothing else — the caller then spawns
 * without a placement rather than guessing at a foreign window.
 */
export function parseLaunchPane(
  output: string,
  selfPane: string | null,
): string | null {
  let active: string | null = null;
  let first: string | null = null;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const [paneId, title, isActive] = line.split(PANE_FIELD_SEP);
    if (!paneId || paneId === selfPane) continue;
    if (isCcmuxPane(title ?? null)) continue;
    if (first === null) first = paneId;
    if (isActive === "1") active = paneId;
  }

  return active ?? first;
}

/**
 * Resolve the pane this TUI was launched over, for spawn placement.
 * Resolved once at launch: by the time the user opens the new-session
 * dialog, "the current pane" as tmux sees it may be the picker itself.
 */
export async function resolveLaunchPane(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  try {
    const proc = Bun.spawn(
      [
        "tmux",
        "list-panes",
        "-F",
        ["#{pane_id}", "#{pane_title}", "#{pane_active}"].join(PANE_FIELD_SEP),
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return parseLaunchPane(output, process.env.TMUX_PANE ?? null);
  } catch {
    return null;
  }
}

/**
 * Check if a pane is in the current window (visible to the user).
 * Uses the sidebar's own pane to determine which window is active.
 */
export async function isPaneInCurrentWindow(paneId: string): Promise<boolean> {
  try {
    const selfPane = process.env.TMUX_PANE;
    if (!selfPane) return false;

    const proc = Bun.spawn(["tmux", "list-panes", "-F", "#{pane_id}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return false;

    const paneIds = new Set(output.trim().split("\n"));
    return paneIds.has(paneId);
  } catch {
    return false;
  }
}
