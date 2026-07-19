/**
 * Copilot events.jsonl line parsing and entry types.
 *
 * Copilot writes one JSON object per line to
 * `~/.copilot/session-state/<uuid>/events.jsonl`, incrementally and in real
 * time (it does not hold the file open). Each line is an envelope
 * `{type, data, id, timestamp, parentId}` with camelCase `data` fields.
 * Pure: no I/O, no state.
 */

/** Top-level Copilot events.jsonl entry envelope. */
export interface CopilotEntry {
  type: string;
  timestamp?: string;
  data?: unknown;
}

/** `session.start` data payload (session metadata). */
export interface CopilotSessionStartData {
  sessionId?: string;
  copilotVersion?: string;
  startTime?: string;
  context?: { cwd?: string };
}

/** `user.message` data payload. */
export interface CopilotUserMessageData {
  content?: string;
}

/** `permission.requested` data payload. */
export interface CopilotPermissionRequestData {
  permissionRequest?: {
    kind?: string;
    fullCommandText?: string;
    intention?: string;
  };
}

export function parseLine(line: string): CopilotEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as CopilotEntry;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.type !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseEntries(content: string): CopilotEntry[] {
  if (!content) return [];
  const entries: CopilotEntry[] = [];
  for (const line of content.split("\n")) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Map a `permission.requested` permission kind to a display tool name.
 * Copilot's shell approvals report `kind: "shell"`, which every other agent
 * surfaces as "Command"; anything else falls back to the raw kind so the
 * picker still shows something meaningful.
 */
export function permissionToolLabel(kind: string | undefined): string | null {
  if (!kind) return null;
  if (kind === "shell") return "Command";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}
