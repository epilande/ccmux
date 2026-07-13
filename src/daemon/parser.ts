import { closeSync, openSync, readSync } from "fs";
import type { LogEntry } from "../types";

export function parseLogEntries(content: string): LogEntry[] {
  const lines = content.trim().split("\n");
  const entries: LogEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Read the last N entries from a log file
 * Uses backwards chunking to avoid loading the entire file into memory
 *
 * `maxBytes` caps how far back the doubling window may grow: entries with
 * huge payloads (large tool results) can make "the last N entries" span
 * megabytes, and each doubling re-reads and re-parses the whole window.
 * Callers on a latency-sensitive path (the TUI peek) pass a ceiling and
 * accept fewer entries.
 */
export async function readLogTail(
  path: string,
  maxEntries: number,
  maxBytes?: number,
): Promise<LogEntry[]> {
  try {
    const file = Bun.file(path);
    const size = file.size;

    if (size === 0) return [];

    const limit =
      maxBytes !== undefined ? Math.min(size, Math.max(0, maxBytes)) : size;
    if (limit === 0) return [];

    const CHUNK_SIZE = 64 * 1024;
    let readSize = Math.min(CHUNK_SIZE, limit);
    let entries: LogEntry[] = [];

    while (entries.length < maxEntries && readSize <= limit) {
      const start = Math.max(0, size - readSize);
      const content = await file.slice(start, size).text();
      const lines = content.split("\n");
      if (start > 0) lines.shift(); // Discard potentially partial first line

      entries = parseLogEntries(lines.join("\n"));

      if (entries.length >= maxEntries || readSize >= limit) break;
      readSize = Math.min(readSize * 2, limit);
    }

    return entries.slice(-maxEntries);
  } catch {
    return [];
  }
}

/**
 * Read the timestamp of the first entry in a JSONL log (the head), used to
 * derive a subagent's spawn time. Reads only the leading chunk and returns
 * the first parsed entry that carries a `timestamp`. Returns null on any
 * read/parse failure or if no timestamped entry is found in the head.
 */
export async function readFirstEntryTimestamp(
  path: string,
): Promise<string | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (size === 0) return null;

    const CHUNK_SIZE = 64 * 1024;
    const content = await file.slice(0, Math.min(CHUNK_SIZE, size)).text();
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { timestamp?: string };
        if (entry.timestamp) return entry.timestamp;
      } catch {
        // Skip malformed lines (including a possibly truncated tail line).
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract session ID (UUID) from log file path
 * Path format: ~/.claude/projects/<encoded-path>/<uuid>.jsonl
 */
export function extractSessionIdFromPath(path: string): string | null {
  const match = path.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match ? match[1] : null;
}

/**
 * Extract encoded project path from log file path
 * Path format: ~/.claude/projects/<encoded-path>/<uuid>.jsonl
 *
 * Returns the raw encoded path (e.g., "-Users-name-Code-project-name")
 * without decoding, to avoid lossy conversion of hyphens to slashes.
 */
export function extractEncodedProjectPath(logPath: string): string | null {
  const parts = logPath.split("/");
  const projectsIndex = parts.findIndex((p) => p === "projects");

  if (projectsIndex === -1 || projectsIndex >= parts.length - 2) {
    return null;
  }

  return parts[projectsIndex + 1];
}

/**
 * Decode an encoded project path from the file system path
 * Claude encodes paths by replacing / with -
 */
export function decodeProjectPath(encoded: string): string {
  // Encoded format: -Users-name-project becomes /Users/name/project
  if (encoded.startsWith("-")) {
    return encoded.replace(/-/g, "/");
  }
  return encoded;
}

/**
 * Extract project name and cwd from a log file path
 */
export function extractProjectInfo(logPath: string): {
  project: string;
  cwd: string;
} {
  // Path format: ~/.claude/projects/<encoded-path>/<uuid>.jsonl
  const parts = logPath.split("/");
  const projectsIndex = parts.findIndex((p) => p === "projects");

  if (projectsIndex === -1 || projectsIndex >= parts.length - 2) {
    return { project: "unknown", cwd: "/" };
  }

  const encodedPath = parts[projectsIndex + 1];
  const cwd = decodeProjectPath(encodedPath);
  const project = cwd.split("/").pop() || "unknown";

  return { project, cwd };
}

/**
 * Peek a transcript's early entries for the raw `cwd` field (the raw cwd
 * is the authoritative match key; the encoded project dir name is only a
 * grouping pre-filter, and its encoding is many-to-one). The cwd appears
 * on the first user/assistant entry,
 * typically within the first few lines — leading `mode`/meta entries carry
 * none — so a bounded head read suffices. Returns null when no early entry
 * carries a cwd (e.g. a transcript with no turns yet) or on read error.
 *
 * Sync by design: the binder consumes this through a pure observation
 * callback, and the read is a single bounded page-in of a local file.
 */
export function readTranscriptCwd(
  path: string,
  maxBytes = 256 * 1024,
): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    const head = buf.toString("utf-8", 0, bytes);
    const lines = head.split("\n");
    // Drop a trailing partial line unless the whole file fit in the head.
    const complete = bytes < maxBytes ? lines : lines.slice(0, -1);
    for (const line of complete.slice(0, 50)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { cwd?: unknown };
        if (typeof entry.cwd === "string" && entry.cwd.length > 0) {
          return entry.cwd;
        }
      } catch {
        // Skip malformed lines.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the first newline-terminated line of a file without loading the rest.
 *
 * Tries a 64 KB head first; on no newline, expands to `maxBytes` (default 1
 * MB). Returns `null` when the first line still doesn't fit, or on read
 * error. Used to extract `session_meta` from Codex rollouts whose `payload.
 * instructions` field can carry inlined `AGENTS.md` content well over 64 KB.
 */
export async function readFirstLine(
  path: string,
  maxBytes = 1024 * 1024,
): Promise<string | null> {
  try {
    const file = Bun.file(path);
    const initial = Math.min(64 * 1024, file.size);
    let head = await file.slice(0, initial).text();
    let newlineIdx = head.indexOf("\n");
    if (newlineIdx === -1 && initial < file.size && initial < maxBytes) {
      const expanded = Math.min(maxBytes, file.size);
      head = await file.slice(0, expanded).text();
      newlineIdx = head.indexOf("\n");
    }
    if (newlineIdx === -1) return null;
    return head.slice(0, newlineIdx);
  } catch {
    return null;
  }
}

/**
 * Read incremental log entries starting from a byte offset
 * Uses Bun.file().slice() to only read bytes from the offset, avoiding full file load
 */
export async function readLogIncremental(
  path: string,
  fromOffset: number,
): Promise<{ entries: LogEntry[]; newOffset: number }> {
  try {
    const file = Bun.file(path);
    const size = file.size;

    if (fromOffset >= size) {
      return { entries: [], newOffset: fromOffset };
    }

    const blob = file.slice(fromOffset);
    const newContent = await blob.text();
    const lastNewline = newContent.lastIndexOf("\n");
    if (lastNewline === -1) {
      return { entries: [], newOffset: fromOffset };
    }

    const completeContent = newContent.slice(0, lastNewline + 1);
    const entries = parseLogEntries(completeContent);
    const bytesConsumed = Buffer.byteLength(completeContent, "utf-8");

    return { entries, newOffset: fromOffset + bytesConsumed };
  } catch {
    return { entries: [], newOffset: fromOffset };
  }
}
