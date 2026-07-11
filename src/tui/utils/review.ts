import { appendFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { CliRenderer } from "@opentui/core";
import { LOG_FILE, MAX_SEND_TEXT_CHARS } from "../../lib/config";
import { resolveRepoRoot } from "../../lib/git";

export const HUNK_DIFF_ARGS = ["diff", "--watch"] as const;
export const HUNK_INSTALL_HINT =
  "hunk not found: install it to review diffs (see github.com/modem-dev/hunk)";

const DISCOVERY_ATTEMPTS = 20;
const DISCOVERY_DELAY_MS = 250;
// Comments live only in the hunk daemon's memory and vanish the instant the
// TUI exits, so a note saved just before quitting is only ever seen by the
// poll that lands between save and quit. Keep the cadence tight: reads go
// through the daemon's HTTP API (~ms each), so fast polling is nearly free.
export const HARVEST_DELAY_MS = 250;
const HUNK_JSON_TIMEOUT_MS = 5_000;
const HUNK_API_TIMEOUT_MS = 1_000;
const MAX_SNIPPET_LINES = 6;
const MAX_SNIPPET_CHARS = 300;
export const MAX_REVIEW_PROMPT_CHARS = MAX_SEND_TEXT_CHARS;
const TRUNCATION_MARKER = "\n\n(truncated)";

export interface HunkReviewNote {
  noteId?: string;
  filePath: string;
  hunkIndex?: number;
  newRange?: [number, number];
  oldRange?: [number, number];
  body: string;
  /** Annotated lines read from the working tree at harvest time. */
  snippet?: string;
}

export type ReviewResult =
  | { ok: true; notes: HunkReviewNote[] }
  | { ok: false; error: string };

type SpawnHunk = (
  cmd: string[],
  opts: {
    cwd: string;
    stdin: "inherit";
    stdout: "inherit";
    stderr: "inherit";
  },
) => { exited: Promise<number> };

export interface RunHunkReviewDeps {
  which?: (cmd: string) => string | null;
  spawn?: SpawnHunk;
  resolveRoot?: (cwd: string) => Promise<string | null>;
  runHunkJson?: (args: string[]) => Promise<unknown | null>;
  paneId?: string;
  /**
   * Resolve our own controlling tty (e.g. `/dev/ttys084`), or null if stdin
   * isn't a tty. hunk spawned with inherited stdio shares this tty, so matching
   * on it finds the review session even when `paneId` discovery can't — notably
   * inside a tmux `display-popup`, where hunk registers only a `tty` location
   * and no `{source:"tmux", paneId}` (a popup is not a real pane).
   */
  readTty?: () => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  readFileLines?: (path: string) => Promise<string[]>;
  gitStatus?: (root: string) => Promise<string | null>;
}

interface HunkSessionListEntry {
  sessionId: string;
  launchedAt?: string;
  terminal?: {
    locations?: Array<{ source?: string; paneId?: string; tty?: string }>;
  };
}

function debugLog(message: string): void {
  try {
    appendFileSync(LOG_FILE, `[hunk-review] ${message}\n`);
  } catch {
    // Hand-back is best-effort; logging must not disturb the review flow.
  }
}

/**
 * Map the CLI arg encoding of the two reads we do onto the hunk daemon's
 * HTTP session API (`POST /session-api`, the same endpoint the hunk CLI
 * itself calls). Returns null for arg shapes we don't map; those go through
 * the CLI.
 */
export function hunkApiPayload(args: string[]): object | null {
  if (args[0] === "session" && args[1] === "list") return { action: "list" };
  if (
    args[0] === "session" &&
    args[1] === "comment" &&
    args[2] === "list" &&
    typeof args[3] === "string"
  ) {
    return {
      action: "comment-list",
      selector: { sessionId: args[3] },
      type: "user",
    };
  }
  return null;
}

function hunkApiOrigin(): string {
  const host = process.env.HUNK_MCP_HOST?.trim() || "127.0.0.1";
  const port = Number(process.env.HUNK_MCP_PORT) || 47657;
  return `http://${host}:${port}`;
}

// Flips true after the first successful session-api response in this process.
// From then on a JSON error from the API (e.g. "No active session matches" on
// the post-exit read) is definitive and skips the CLI fallback: the hunk CLI
// is itself a client of this same endpoint, so it can only repeat the answer,
// ~300ms slower. Until proven, every HTTP failure still falls back to the CLI
// so a hunk that moved or reshaped the API degrades to slow-but-correct.
let hunkApiProven = false;

/**
 * Read hunk session JSON, preferring the daemon's HTTP API over spawning the
 * `hunk` CLI: a fetch answers in ~1ms where a CLI spawn costs ~300ms, which is
 * what makes the tight harvest cadence viable. HTTP failures fall back to the
 * CLI, which stays the compatibility authority (see hunkApiProven).
 */
async function defaultRunHunkJson(args: string[]): Promise<unknown | null> {
  const payload = hunkApiPayload(args);
  if (payload) {
    try {
      const response = await fetch(`${hunkApiOrigin()}/session-api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(HUNK_API_TIMEOUT_MS),
      });
      // Non-JSON bodies (e.g. a plain 404 from a hunk that moved the route)
      // throw here and drop through to the CLI fallback below.
      const body: unknown = await response.json();
      if (response.ok) {
        hunkApiProven = true;
        return body;
      }
      const error =
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
      debugLog(`session api ${args.join(" ")}: ${error}`);
      if (hunkApiProven) return null;
    } catch (err) {
      debugLog(`session api unreachable (${err}); falling back to hunk CLI`);
    }
  }
  try {
    const proc = Bun.spawn(["hunk", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    // A hung child would otherwise pin the poll loop forever and keep the
    // picker's renderer suspended. Kill it after a timeout; the killed child
    // exits non-zero and closes its pipes, so the exitCode branch below returns
    // null and the seam degrades to no-notes as designed. The hard deadline
    // race covers the pathological remainder (a child that traps SIGTERM, or
    // a leaked pipe held open past its exit): give up unconditionally one
    // second after the SIGTERM and escalate to SIGKILL.
    const timer = setTimeout(() => proc.kill(), HUNK_JSON_TIMEOUT_MS);
    let result: [string, string, number] | null;
    try {
      result = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        Bun.sleep(HUNK_JSON_TIMEOUT_MS + 1_000).then(() => null),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (result === null) {
      proc.kill(9);
      debugLog(`${args.join(" ")} timed out`);
      return null;
    }
    const [stdout, stderr, exitCode] = result;
    if (stderr.trim()) debugLog(`${args.join(" ")}: ${stderr.trim()}`);
    if (exitCode !== 0) {
      debugLog(`${args.join(" ")} exited ${exitCode}`);
      return null;
    }
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    debugLog(`${args.join(" ")} failed: ${err}`);
    return null;
  }
}

async function defaultGitStatus(root: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      debugLog(`git status --porcelain failed: ${stderr.trim()}`);
      return null;
    }
    return stdout;
  } catch (err) {
    debugLog(`git status --porcelain failed: ${err}`);
    return null;
  }
}

async function defaultReadTty(): Promise<string | null> {
  try {
    // `tty` reports the pathname of the terminal on stdin (fd 0). Resolve this
    // before the renderer suspends, while fd 0 is still our interactive tty; it
    // matches the `tty` location hunk records for the child we spawn with
    // inherited stdio. Exits non-zero ("not a tty") when stdin is redirected.
    const proc = Bun.spawn(["tty"], {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const tty = stdout.trim();
    return tty.startsWith("/dev/") ? tty : null;
  } catch (err) {
    debugLog(`tty resolution failed: ${err}`);
    return null;
  }
}

/**
 * Does this hunk session's terminal match the pane we're launched in or the tty
 * we share with the hunk child? Either signal is enough; the tty path is what
 * makes discovery work inside a `display-popup` (no paneId there).
 */
function sessionMatchesTerminal(
  session: HunkSessionListEntry,
  paneId: string | null | undefined,
  tty: string | null,
): boolean {
  return (
    session.terminal?.locations?.some(
      (location) =>
        (paneId != null &&
          location.source === "tmux" &&
          location.paneId === paneId) ||
        (tty != null && location.source === "tty" && location.tty === tty),
    ) ?? false
  );
}

/**
 * Pick the newest session by `launchedAt`, so the review we just spawned wins
 * over any stale session lingering on the same pane or tty (a reused
 * `/dev/ttysNNN` or a repeat review in the same popup pane). Entries without a
 * parseable `launchedAt` sort oldest so a dated match always wins.
 */
function pickFreshest(
  sessions: HunkSessionListEntry[],
): HunkSessionListEntry | null {
  let best: HunkSessionListEntry | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    const parsed = session.launchedAt
      ? Date.parse(session.launchedAt)
      : Number.NaN;
    const time = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (best === null || time >= bestTime) {
      best = session;
      bestTime = time;
    }
  }
  return best;
}

function asSessions(value: unknown): HunkSessionListEntry[] {
  const sessions =
    typeof value === "object" && value !== null && "sessions" in value
      ? (value as { sessions?: unknown }).sessions
      : value;
  if (!Array.isArray(sessions)) return [];
  return sessions.filter(
    (entry): entry is HunkSessionListEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { sessionId?: unknown }).sessionId === "string",
  );
}

function asNotes(value: unknown): HunkReviewNote[] | null {
  const comments =
    typeof value === "object" && value !== null && "comments" in value
      ? (value as { comments?: unknown }).comments
      : value;
  if (!Array.isArray(comments)) return null;
  const notes: HunkReviewNote[] = [];
  for (const entry of comments) {
    if (typeof entry !== "object" || entry === null) return null;
    const note = entry as Record<string, unknown>;
    // Only filePath and body are genuinely required (formatting depends on
    // them). noteId and hunkIndex are never consumed, so tolerate their
    // absence rather than rejecting the whole batch on benign schema drift.
    if (typeof note.filePath !== "string" || typeof note.body !== "string") {
      return null;
    }
    const parsed: HunkReviewNote = {
      filePath: note.filePath,
      body: note.body,
    };
    if (typeof note.noteId === "string") parsed.noteId = note.noteId;
    if (typeof note.hunkIndex === "number") parsed.hunkIndex = note.hunkIndex;
    if (isRange(note.newRange)) parsed.newRange = note.newRange;
    if (isRange(note.oldRange)) parsed.oldRange = note.oldRange;
    notes.push(parsed);
  }
  return notes;
}

function isRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isInteger(value[0]) &&
    Number.isInteger(value[1])
  );
}

async function addSnippets(
  notes: HunkReviewNote[],
  root: string,
  readFileLines: (path: string) => Promise<string[]>,
): Promise<HunkReviewNote[]> {
  return Promise.all(
    notes.map(async (note) => {
      if (!note.newRange) return note;
      // hunk output is treated as untrusted elsewhere (asNotes), so don't
      // let a stray filePath escape the repo root either.
      const path = resolve(root, note.filePath);
      if (path !== root && !path.startsWith(root + sep)) return note;
      try {
        const lines = await readFileLines(path);
        const [start, end] = note.newRange;
        const snippet = lines
          .slice(
            Math.max(0, start - 1),
            Math.min(end, start + MAX_SNIPPET_LINES - 1),
          )
          .join("\n")
          .slice(0, MAX_SNIPPET_CHARS);
        return snippet ? { ...note, snippet } : note;
      } catch {
        return note;
      }
    }),
  );
}

function formatRange(note: HunkReviewNote): string {
  const range = note.newRange ?? note.oldRange;
  if (!range) return note.filePath;
  const prefix = note.newRange ? "" : "old ";
  const lines =
    range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
  return `${note.filePath}:${prefix}${lines}`;
}

export function formatReviewPrompt(notes: HunkReviewNote[]): string {
  const count = notes.length;
  const blocks = notes.map((note, index) => {
    const snippet = note.snippet
      ? `\n${note.snippet
          .split("\n")
          .map((line) => `   > ${line}`)
          .join("\n")}`
      : "";
    return `${index + 1}. ${formatRange(note)}${snippet}\n   ${note.body}`;
  });
  const assembled = `I reviewed your changes in hunk and left ${count} review comment${count === 1 ? "" : "s"}:\n\n${blocks.join("\n")}\n\nPlease address each comment.`;
  // The prompt is delivered via `tmux paste-buffer -p` (bracketed paste), so
  // strip C0 controls (except \n and \t), DEL, and C1 before capping. This
  // removes ESC, killing any embedded [200~/[201~ markers (inert without their
  // escape byte) so they can never terminate the paste early and leak bytes as
  // live keystrokes. Sanitize first so the length cap stays exact.
  const prompt = assembled.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  if (prompt.length <= MAX_REVIEW_PROMPT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_REVIEW_PROMPT_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

export function isHunkAvailable(
  which: (cmd: string) => string | null = Bun.which,
): boolean {
  return which("hunk") !== null;
}

/**
 * Spawn `hunk diff --watch` in `root` with inherited stdio (`hunk` resolved via
 * PATH). Shared by the CLI `review` command and the in-picker review action;
 * both verify `hunk` is on PATH (`isHunkAvailable`) before calling.
 */
export function spawnHunkDiff(
  root: string,
  spawn: SpawnHunk = Bun.spawn as unknown as SpawnHunk,
): { exited: Promise<number> } {
  return spawn(["hunk", ...HUNK_DIFF_ARGS], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

/**
 * Suspend the picker's renderer, run `hunk diff --watch` in `cwd`'s repo root
 * with inherited stdio, then resume. Pre-flight checks (hunk on PATH, git
 * repo root) run before `suspend()` so error toasts render without a flicker.
 * `suspend()` has its own try/catch: if it throws, `resume()` is never
 * called (nothing to undo). Once suspended, `resume()` is guaranteed via
 * try/finally, even if the spawn itself throws — but it fires the moment
 * hunk exits, not after the whole harvest: the post-exit comment reads and
 * snippet extraction below all run against piped-stdio children that never
 * touch the terminal, and leaving the renderer suspended through them showed
 * the user seconds of blank screen after quitting hunk.
 *
 * While hunk runs, the picker polls hunk's session JSON to find the session
 * bound to this pane and harvest the user comments left during review,
 * returning them so the caller can hand them back to the agent.
 */
export async function runHunkReview(
  renderer: Pick<CliRenderer, "suspend" | "resume">,
  cwd: string,
  deps: RunHunkReviewDeps = {},
): Promise<ReviewResult> {
  const which = deps.which ?? Bun.which;
  const spawn = deps.spawn ?? (Bun.spawn as unknown as SpawnHunk);
  const resolveRoot = deps.resolveRoot ?? resolveRepoRoot;
  const runHunkJson = deps.runHunkJson ?? defaultRunHunkJson;
  const paneId = deps.paneId ?? process.env.TMUX_PANE;
  const readTty = deps.readTty ?? defaultReadTty;
  const sleep = deps.sleep ?? Bun.sleep;
  const readFileLines =
    deps.readFileLines ??
    (async (path: string) => (await Bun.file(path).text()).split("\n"));
  const gitStatus = deps.gitStatus ?? defaultGitStatus;

  if (!which("hunk")) return { ok: false, error: HUNK_INSTALL_HINT };
  const root = await resolveRoot(cwd);
  if (!root) return { ok: false, error: "not a git repository" };
  const status = await gitStatus(root);
  if (status === "") return { ok: false, error: "no changes to review" };

  // Resolve our tty while fd 0 is still the interactive terminal (before
  // suspend). This is the discovery fallback when there's no paneId to match,
  // e.g. inside a display-popup.
  const tty = await readTty();

  try {
    renderer.suspend();
  } catch (err) {
    return { ok: false, error: `suspend failed: ${err}` };
  }

  let resumed = false;
  const resumeOnce = () => {
    if (resumed) return;
    resumed = true;
    renderer.resume();
  };

  try {
    const proc = spawnHunkDiff(root, spawn);
    let exited = false;
    const exitPromise = proc.exited.then((code) => {
      exited = true;
      return code;
    });
    let sessionId: string | null = null;
    let latestNotes: HunkReviewNote[] = [];

    // Discovery loop: find the hunk session whose terminal matches this pane or
    // (in a popup, where there's no paneId) the tty we share with the hunk
    // child, so we harvest comments from the right review and not a sibling.
    if (paneId || tty) {
      for (
        let attempt = 0;
        attempt < DISCOVERY_ATTEMPTS && !exited;
        attempt++
      ) {
        const sessions = asSessions(
          await runHunkJson(["session", "list", "--json"]),
        );
        const matches = sessions.filter((session) =>
          sessionMatchesTerminal(session, paneId, tty),
        );
        sessionId = pickFreshest(matches)?.sessionId ?? null;
        if (sessionId) {
          debugLog(`discovered session ${sessionId} (attempt ${attempt})`);
          break;
        }
        if (!exited)
          await Promise.race([sleep(DISCOVERY_DELAY_MS), exitPromise]);
      }
    }

    // Harvest loop: re-read comments every second. Each await races the sleep
    // against exitPromise so we bail out the moment hunk exits.
    while (sessionId && !exited) {
      const snapshot = asNotes(
        await runHunkJson([
          "session",
          "comment",
          "list",
          sessionId,
          "--type",
          "user",
          "--json",
        ]),
      );
      if (snapshot) {
        if (snapshot.length !== latestNotes.length) {
          debugLog(`harvest snapshot: ${snapshot.length} note(s)`);
        }
        latestNotes = snapshot;
      }
      if (!exited) await Promise.race([sleep(HARVEST_DELAY_MS), exitPromise]);
    }

    const exitCode = await exitPromise;
    // hunk has restored the terminal: bring the picker back NOW. The final
    // read and snippet extraction below don't touch the terminal, and waiting
    // on them here is what left the screen blank for seconds after quitting.
    resumeOnce();
    if (exitCode !== 0) {
      return { ok: false, error: `hunk exited with code ${exitCode}` };
    }

    // Post-exit final read, one attempt only: a comment saved in the last
    // harvest interval can land after the loop's final read, and this catches
    // it IF the session is still readable. Usually it isn't — hunk drops the
    // session the instant the TUI exits (every logged post-exit read fails
    // with "No active session") — so retrying is pure latency between the
    // picker coming back and the hand-back dialog. The real safeguard for
    // last-second comments is the tight HARVEST_DELAY_MS cadence above.
    if (sessionId) {
      const snapshot = asNotes(
        await runHunkJson([
          "session",
          "comment",
          "list",
          sessionId,
          "--type",
          "user",
          "--json",
        ]),
      );
      if (snapshot) latestNotes = snapshot;
    }
    debugLog(`review done: ${latestNotes.length} note(s) harvested`);

    return {
      ok: true,
      notes: await addSnippets(latestNotes, root, readFileLines),
    };
  } catch (err) {
    return { ok: false, error: `${err}` };
  } finally {
    resumeOnce();
  }
}
