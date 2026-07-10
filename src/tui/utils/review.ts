import { appendFileSync } from "node:fs";
import type { CliRenderer } from "@opentui/core";
import { LOG_FILE } from "../../lib/config";
import { resolveRepoRoot } from "../../lib/git";

export const HUNK_DIFF_ARGS = ["diff", "--watch"] as const;
export const HUNK_INSTALL_HINT =
  "hunk not found: install it to review diffs (see github.com/modem-dev/hunk)";

const DISCOVERY_ATTEMPTS = 10;
const DISCOVERY_DELAY_MS = 500;
const HARVEST_DELAY_MS = 1_000;
const FINAL_READ_ATTEMPTS = 3;
const FINAL_READ_DELAY_MS = 500;
const MAX_SNIPPET_LINES = 6;
const MAX_SNIPPET_CHARS = 300;
export const MAX_REVIEW_PROMPT_CHARS = 10_000;
const TRUNCATION_MARKER = "\n\n(truncated)";

export interface HunkReviewNote {
  noteId: string;
  filePath: string;
  hunkIndex: number;
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
  sleep?: (ms: number) => Promise<void>;
  readFileLines?: (path: string) => Promise<string[]>;
  gitStatus?: (root: string) => Promise<string | null>;
}

interface HunkSessionListEntry {
  sessionId: string;
  terminal?: { locations?: Array<{ source?: string; paneId?: string }> };
}

function debugLog(message: string): void {
  try {
    appendFileSync(LOG_FILE, `[hunk-review] ${message}\n`);
  } catch {
    // Hand-back is best-effort; logging must not disturb the review flow.
  }
}

async function defaultRunHunkJson(args: string[]): Promise<unknown | null> {
  try {
    const proc = Bun.spawn(["hunk", ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
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
    if (
      typeof note.noteId !== "string" ||
      typeof note.filePath !== "string" ||
      typeof note.hunkIndex !== "number" ||
      typeof note.body !== "string"
    ) {
      return null;
    }
    const parsed: HunkReviewNote = {
      noteId: note.noteId,
      filePath: note.filePath,
      hunkIndex: note.hunkIndex,
      body: note.body,
    };
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
      try {
        const lines = await readFileLines(`${root}/${note.filePath}`);
        const [start, end] = note.newRange;
        const snippet = lines
          .slice(Math.max(0, start - 1), Math.min(end, start + MAX_SNIPPET_LINES - 1))
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
  const lines = range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
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
  const prompt = `I reviewed your changes in hunk and left ${count} review comment${count === 1 ? "" : "s"}:\n\n${blocks.join("\n")}\n\nPlease address each comment.`;
  if (prompt.length <= MAX_REVIEW_PROMPT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_REVIEW_PROMPT_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

export function isHunkAvailable(
  which: (cmd: string) => string | null = Bun.which,
): boolean {
  return which("hunk") !== null;
}

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

  try {
    renderer.suspend();
  } catch (err) {
    return { ok: false, error: `suspend failed: ${err}` };
  }

  try {
    const proc = spawnHunkDiff(root, spawn);
    let exited = false;
    const exitPromise = proc.exited.then((code) => {
      exited = true;
      return code;
    });
    let sessionId: string | null = null;
    let latestNotes: HunkReviewNote[] = [];

    if (paneId) {
      for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS && !exited; attempt++) {
        const sessions = asSessions(await runHunkJson(["session", "list", "--json"]));
        sessionId =
          sessions.find((session) =>
            session.terminal?.locations?.some(
              (location) => location.source === "tmux" && location.paneId === paneId,
            ),
          )?.sessionId ?? null;
        if (sessionId) break;
        if (!exited) await Promise.race([sleep(DISCOVERY_DELAY_MS), exitPromise]);
      }
    }

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
      if (snapshot) latestNotes = snapshot;
      if (!exited) await Promise.race([sleep(HARVEST_DELAY_MS), exitPromise]);
    }

    const exitCode = await exitPromise;
    if (exitCode !== 0) {
      return { ok: false, error: `hunk exited with code ${exitCode}` };
    }

    if (sessionId) {
      for (let attempt = 0; attempt < FINAL_READ_ATTEMPTS; attempt++) {
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
          latestNotes = snapshot;
          break;
        }
        if (attempt < FINAL_READ_ATTEMPTS - 1) await sleep(FINAL_READ_DELAY_MS);
      }
    }

    return {
      ok: true,
      notes: await addSnippets(latestNotes, root, readFileLines),
    };
  } catch (err) {
    return { ok: false, error: `${err}` };
  } finally {
    renderer.resume();
  }
}
