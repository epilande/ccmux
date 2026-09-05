import {
  getDaemonUrl,
  isCcmuxPane,
  SIDEBAR_PANE_TITLE,
} from "../../lib/config";
import { PANE_FIELD_SEP } from "../../lib/tmux-format";
import { tmuxArgv, tmuxShellPrefix } from "../../lib/tmux-exec";
import { resolvePinnedTmuxClientTty } from "../../lib/tmux-client";
import { theme } from "../theme";

export { switchToPane } from "./client-switch";

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
    tmuxArgv("capture-pane", "-e", "-t", paneId, "-p", `-S-${lines}`),
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
  const proc = Bun.spawn(tmuxArgv("send-keys", "-t", target, ...args), {
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
  Bun.spawn(tmuxArgv("set-option", "-p", "-u", "-t", paneId, "window-style"), {
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
    tmuxArgv("set-option", "-p", "-t", paneId, "window-style", flashBg()),
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
    tmuxArgv("set-option", "-p", "-t", paneId, "window-style", flashBg()),
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  // The nested `tmux` runs from tmux's own process context, which does not
  // carry this process's environment, so it needs the socket spelled out.
  Bun.spawn(
    tmuxArgv(
      "run-shell",
      "-b",
      `sleep ${FLASH_DURATION_MS / 1000} && ${tmuxShellPrefix()} set-option -p -u -t '${paneId}' window-style`,
    ),
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
}

export async function selectPane(paneId: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(tmuxArgv("select-pane", "-t", paneId), {
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

/** Why nobody was moved to the window that is now up. `"no-client-tty"`: we
 *  never captured a client tty to name. `"switch-failed"`: we had one and
 *  tmux refused the `switch-client` (a stale tty, most often a client that
 *  detached since capture). The two blame different things, so the caller
 *  must not collapse them into one message. */
export type ClientSwitchMiss = "no-client-tty" | "switch-failed";

/**
 * The window is up. `clientSwitched` is false when nobody was moved to it,
 * i.e. the window exists but the user is still looking at wherever they were,
 * and `reason` says why: the caller must say so rather than exiting as if the
 * jump happened.
 */
export type OpenAgentsResult =
  | { ok: true; clientSwitched: true }
  | { ok: true; clientSwitched: false; reason: ClientSwitchMiss }
  | { ok: false; error: string };

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

/** Re-ask tmux whether a named window is still around, to tell a refused
 *  `switch-client` apart from one whose target vanished mid-flight. A failed
 *  query answers "gone", which falls through to spawn: an unreachable tmux
 *  must not turn into a permanent refusal to open the window. */
async function windowStillExists(windowName: string): Promise<boolean> {
  try {
    const list = Bun.spawn(
      tmuxArgv(
        "list-windows",
        "-a",
        "-F",
        ["#{window_id}", "#{window_name}"].join(PANE_FIELD_SEP),
      ),
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(list.stdout).text();
    if ((await list.exited) !== 0) return false;
    return parseWindowIdByName(out, windowName) !== null;
  } catch {
    return false;
  }
}

/** Ask tmux which session a client is attached to, so `new-window` can be
 *  aimed at it. Returns null on any failure, which the caller turns into a
 *  REFUSAL rather than an untargeted window: see `openDedupedCommandWindow`.
 *
 *  The placement matters because a popup's command client has no pane of its
 *  own, so an untargeted `new-window` falls through to tmux's
 *  `cmd_find_best_session`: the session with the newest activity time, which
 *  every keypress bumps. With two clients attached and the OTHER one typing
 *  last, the window is born in a session its owner never asked for, and the
 *  pinned `switch-client` then drags our client into someone else's session
 *  (where the next dedupe pass also finds the window). Same wrong guess the
 *  client pinning exists to avoid, one level up.
 *
 *  It has to be an UNTARGETED listing matched on the tty here, because the two
 *  obvious shortcuts both answer the wrong question:
 *   - `display-message -c <tty> "#{session_id}"` names the client only for
 *     DELIVERY. The format is still expanded against the default target
 *     session, which is that same most-recently-active session, so under the
 *     exact two-client split this exists to fix it hands back the OTHER
 *     client's session (measured on 3.6a: `-c` A answers B's `$1`).
 *   - `-t` on `list-clients` is a target SESSION, not a client. A tty there
 *     fails outright on our documented 3.2 floor, and even where a later tmux
 *     resolves one it lists every client of THAT SESSION, so the tty match has
 *     to happen here regardless. */
async function resolveClientSessionId(
  clientTty: string,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      tmuxArgv(
        "list-clients",
        "-F",
        ["#{client_tty}", "#{session_id}"].join(PANE_FIELD_SEP),
      ),
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    for (const line of out.split("\n")) {
      const [tty, sessionId] = line.split(PANE_FIELD_SEP);
      if (tty !== clientTty) continue;
      return sessionId && /^\$\d+$/.test(sessionId) ? sessionId : null;
    }
    return null;
  } catch {
    return null;
  }
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
 *
 * Every `switch-client` here names its client with `-c`, from the same
 * captured tty `switchToPane` uses. A bare `switch-client` falls through to
 * tmux's `cmd_find_best_client`, which returns the most-recently-active client
 * of any session, and a popup's own keystrokes never advance its client's
 * activity time: with two clients attached, one keypress on the other one is
 * enough to make a bare switch yank a terminal the user never touched. With no
 * tty to name we open the window and DO NOT switch anyone, because moving the
 * wrong client is a worse failure than not moving one (the rule
 * `src/daemon/spawn-command.ts` already follows). A switch tmux REFUSES lands
 * in the same place: the result reports `clientSwitched: false` with the
 * reason, never a jump that did not happen.
 *
 * The `new-window` is `-d` and targeted at the captured client's session for
 * the same reason. Left to itself tmux picks the most-recently-active session,
 * which inside a popup is whichever terminal typed last: without `-d` that
 * client's view jumps to a window it never asked for, and without `-t` the
 * window is born in that client's session, so our own switch lands us inside
 * it. Targeted and detached, nothing moves until the pinned `switch-client`
 * runs, and a bare pane id there selects the session, window and pane together.
 * `resolveClientSessionId` supplies that target, and its doc comment covers why
 * the session has to be read off an untargeted `list-clients`. When it cannot
 * answer for a tty we DID capture, the launch REFUSES with `ok: false` and
 * creates nothing, because an untargeted window is the very placement bug this
 * is here to fix. Having no tty at all is the one case that still opens an
 * untargeted window, and only because there is then no client to misplace it
 * relative to, and nobody to move into it.
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
      tmuxArgv(
        "list-windows",
        "-a",
        "-F",
        ["#{window_id}", "#{window_name}"].join(PANE_FIELD_SEP),
      ),
      { stdout: "pipe", stderr: "ignore" },
    );
    const listOut = await new Response(list.stdout).text();
    const existing =
      (await list.exited) === 0
        ? parseWindowIdByName(listOut, windowName)
        : null;
    const { tty: clientTty } = await resolvePinnedTmuxClientTty();
    if (existing) {
      if (!clientTty)
        return { ok: true, clientSwitched: false, reason: "no-client-tty" };
      const switchProc = Bun.spawn(
        tmuxArgv("switch-client", "-c", clientTty, "-t", existing),
        { stdout: "ignore", stderr: "ignore" },
      );
      if ((await switchProc.exited) === 0) {
        return { ok: true, clientSwitched: true };
      }
      // A failed switch used to mean one thing (the window vanished between
      // list and switch) and now means two: a stale captured tty fails the
      // same way. Ask again before spawning, or a broken binding would defeat
      // the name dedupe and open a second window on every activation.
      if (await windowStillExists(windowName)) {
        return { ok: true, clientSwitched: false, reason: "switch-failed" };
      }
      // Window really is gone: fall through and spawn.
    }

    // Fail closed. Dropping `-t` here would put the window wherever tmux
    // likes, which is the cross-session placement this path exists to remove,
    // and whatever broke the lookup (a stale tty, an unreachable tmux) breaks
    // the pinned switch too. The user would get a "switch failed" toast plus a
    // window in somebody else's session. Better to create nothing and say so.
    let placement: string[] = [];
    if (clientTty) {
      const sessionId = await resolveClientSessionId(clientTty);
      if (!sessionId) {
        return {
          ok: false,
          error: `no tmux session found for client ${clientTty}`,
        };
      }
      placement = ["-t", sessionId];
    }
    const spawn = Bun.spawn(
      tmuxArgv(
        "new-window",
        "-d",
        "-n",
        windowName,
        "-c",
        cwd,
        ...placement,
        "-P",
        "-F",
        "#{pane_id}",
        command,
      ),
      { stdout: "pipe", stderr: "pipe" },
    );
    if ((await spawn.exited) !== 0) {
      const stderr = (await new Response(spawn.stderr).text()).trim();
      return { ok: false, error: stderr || "tmux new-window failed" };
    }
    const paneId = (await new Response(spawn.stdout).text()).trim();

    // `-d` means nothing is selected anywhere yet, so this switch is the whole
    // jump: pinned to the captured client, and given a bare pane id, which
    // tmux resolves to its session, window and pane together. When no tty was
    // captured we leave the window detached rather than move a client the user
    // never touched, for the reason in this function's header.
    if (!clientTty)
      return { ok: true, clientSwitched: false, reason: "no-client-tty" };
    const switchFresh = Bun.spawn(
      tmuxArgv("switch-client", "-c", clientTty, "-t", paneId),
      { stdout: "ignore", stderr: "ignore" },
    );
    // The window exists either way, so this is never an error. A stale
    // captured tty fails here exactly as it does on the existing-window path,
    // and the caller has to hear about it instead of exiting over a jump that
    // did not happen.
    if ((await switchFresh.exited) !== 0) {
      return { ok: true, clientSwitched: false, reason: "switch-failed" };
    }
    return { ok: true, clientSwitched: true };
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
      tmuxArgv(
        "list-panes",
        "-F",
        ["#{pane_id}", "#{pane_title}", "#{pane_active}"].join(PANE_FIELD_SEP),
      ),
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
 * ccmux's own titled surfaces (`ccmux-sidebar`, a persistent
 * `ccmux-picker`) are always excluded: asking one of those to split "the
 * current pane" would halve the 30-column rail or the board itself.
 *
 * `excludeSelf` covers the UNTITLED case, and it is surface-dependent, not
 * a constant. A sidebar persists, so its own pane must never be the target.
 * An inline one-shot picker is the opposite: it vacates its pane the moment
 * it spawns, so its pane is exactly where the user is and exactly where the
 * split belongs. Excluding it there halves the NEIGHBOUR — someone's editor
 * — and in a single-pane window resolves to null, dropping placement
 * entirely. A popup picker is not a pane at all, so neither rule reaches it.
 *
 * Falls back to the first eligible pane when the active one is ccmux's, and
 * to null when the window holds nothing else — the caller then spawns
 * without a placement rather than guessing at a foreign window.
 */
export function parseLaunchPane(
  output: string,
  selfPane: string | null,
  options: { excludeSelf?: boolean } = {},
): string | null {
  let active: string | null = null;
  let first: string | null = null;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const [paneId, title, isActive] = line.split(PANE_FIELD_SEP);
    if (!paneId) continue;
    if (options.excludeSelf && paneId === selfPane) continue;
    if (isCcmuxPane(title ?? null)) continue;
    if (first === null) first = paneId;
    if (isActive === "1") active = paneId;
  }

  return active ?? first;
}

/**
 * Resolve the pane this TUI is sitting over, for spawn placement.
 *
 * Resolved per spawn rather than cached at launch. A cached pane goes stale:
 * a long-lived sidebar records its neighbour at startup, the neighbour is
 * closed hours later, and from then on every spawn 400s with "Unknown target
 * pane" until the sidebar restarts. Nothing else changes between launch and
 * spawn — `TMUX_PANE` is fixed for the process — so resolving late is
 * strictly more correct, and one `tmux list-panes` on an explicit user
 * action is not a cost worth caching against.
 */
export async function resolveLaunchPane(
  options: { excludeSelf?: boolean } = {},
): Promise<string | null> {
  if (!process.env.TMUX) return null;
  const selfPane = process.env.TMUX_PANE ?? null;
  try {
    const proc = Bun.spawn(
      tmuxArgv(
        "list-panes",
        // Target our OWN window when we have a pane. Bare `list-panes`
        // resolves the session's CURRENT window, which is not necessarily
        // ours — a sidebar in a background window would enumerate someone
        // else's panes and spawn there. A popup has no pane, and for it the
        // client's current window is exactly what it is drawn over.
        ...(selfPane ? ["-t", selfPane] : []),
        "-F",
        ["#{pane_id}", "#{pane_title}", "#{pane_active}"].join(PANE_FIELD_SEP),
      ),
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return parseLaunchPane(output, selfPane, options);
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

    const proc = Bun.spawn(tmuxArgv("list-panes", "-F", "#{pane_id}"), {
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
