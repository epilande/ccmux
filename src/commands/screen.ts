import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { daemonError, daemonBody } from "../lib/daemon-json";
import { ensureDaemon } from "./shared";
import type { EnrichedSession } from "../types";

interface ScreenResponse {
  content: string;
  sessionId: string;
  paneId: string;
  lines: number;
}

interface GrepMatch {
  line: number;
  text: string;
}

interface SessionGrepResult {
  sessionId: string;
  project: string;
  agentType: string;
  paneId: string;
  matches: GrepMatch[];
}

interface ScreenOptions {
  lines: string;
  json?: boolean;
  grep?: string;
  ignoreCase?: boolean;
  regex?: boolean;
}

export function grepContent(
  content: string,
  pattern: string,
  ignoreCase: boolean,
  useRegex: boolean,
): GrepMatch[] {
  const lines = content.split("\n");
  const matches: GrepMatch[] = [];

  let test: (line: string) => boolean;
  if (useRegex) {
    const flags = ignoreCase ? "i" : "";
    const regex = new RegExp(pattern, flags);
    test = (line) => regex.test(line);
  } else if (ignoreCase) {
    const needle = pattern.toLowerCase();
    test = (line) => line.toLowerCase().includes(needle);
  } else {
    test = (line) => line.includes(pattern);
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (trimmed && test(trimmed)) {
      matches.push({ line: i + 1, text: trimmed });
    }
  }
  return matches;
}

async function fetchScreen(
  daemonUrl: string,
  sessionId: string,
  lines: number,
): Promise<ScreenResponse | null> {
  try {
    const response = await fetch(
      `${daemonUrl}/sessions/${sessionId}/screen?lines=${lines}`,
    );
    if (!response.ok) return null;
    return await daemonBody<ScreenResponse>(response, "screen");
  } catch {
    return null;
  }
}

async function handleSingleSession(
  sessionId: string,
  options: ScreenOptions,
): Promise<void> {
  const lines = parseLines(options.lines);
  const response = await fetch(
    `${getDaemonUrl()}/sessions/${sessionId}/screen?lines=${lines}`,
  );

  if (response.status === 404) {
    console.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }

  if (response.status === 400) {
    const error = await daemonError(response);
    console.error(error ?? `HTTP ${response.status}`);
    process.exit(1);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await daemonBody<ScreenResponse>(response, "screen");

  if (!options.grep) {
    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      process.stdout.write(data.content);
    }
    return;
  }

  const matches = grepContent(
    data.content,
    options.grep,
    options.ignoreCase ?? false,
    options.regex ?? false,
  );

  if (matches.length === 0) {
    console.log("No matches found");
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify({ ...data, pattern: options.grep, matches }, null, 2),
    );
  } else {
    for (const m of matches) {
      console.log(`  Line ${m.line}: ${m.text}`);
    }
  }
}

async function handleGlobalGrep(options: ScreenOptions): Promise<void> {
  const pattern = options.grep!;
  const lines = parseLines(options.lines);
  const daemonUrl = getDaemonUrl();

  const sessionsRes = await fetch(`${daemonUrl}/sessions`);
  if (!sessionsRes.ok) {
    throw new Error(`HTTP ${sessionsRes.status}`);
  }

  const { sessions } = await daemonBody<{ sessions: EnrichedSession[] }>(
    sessionsRes,
    "session list",
  );

  if (sessions.length === 0) {
    console.log("No active sessions");
    return;
  }

  const screens = await Promise.all(
    sessions.map(async (s) => ({
      session: s,
      screen: await fetchScreen(daemonUrl, s.id, lines),
    })),
  );

  const results: SessionGrepResult[] = [];
  for (const { session, screen } of screens) {
    if (!screen) continue;
    const matches = grepContent(
      screen.content,
      pattern,
      options.ignoreCase ?? false,
      options.regex ?? false,
    );
    if (matches.length > 0) {
      results.push({
        sessionId: session.id,
        project: session.project,
        agentType: session.agentType,
        paneId: session.tmuxPane ?? "",
        matches,
      });
    }
  }

  if (options.json) {
    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
    console.log(
      JSON.stringify(
        {
          pattern,
          results,
          summary: {
            matchedSessions: results.length,
            totalSessions: sessions.length,
            totalMatches,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  if (results.length === 0) {
    console.log("No matches found");
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (i > 0) console.log();
    console.log(`[${r.sessionId}] ${r.project} (${r.agentType}) ${r.paneId}`);
    for (const m of r.matches) {
      console.log(`  Line ${m.line}: ${m.text}`);
    }
  }

  console.log(
    `\n${results.length} session${results.length === 1 ? "" : "s"} matched (of ${sessions.length} active)`,
  );
}

function parseLines(value: string): number {
  const lines = parseInt(value, 10);
  if (isNaN(lines) || lines < 1) {
    console.error("Invalid lines value");
    process.exit(1);
  }
  return lines;
}

export function createScreenCommand(): Command {
  return new Command("screen")
    .description("Capture pane content, or search across all sessions")
    .argument(
      "[session-id]",
      "Session ID or pane ID (omit with --grep to search all)",
    )
    .option("-l, --lines <n>", "Number of lines to capture", "50")
    .option("--json", "Output as JSON with metadata")
    .option("-g, --grep <pattern>", "Search for pattern in pane content")
    .option("-i, --ignore-case", "Case-insensitive matching")
    .option("--regex", "Treat pattern as regex")
    .action(async (sessionId: string | undefined, options: ScreenOptions) => {
      if (!sessionId && !options.grep) {
        console.error(
          "Provide a session-id, or use --grep <pattern> to search all sessions",
        );
        process.exit(1);
      }

      if (options.regex && options.grep) {
        try {
          new RegExp(options.grep);
        } catch {
          console.error(`Invalid regex: ${options.grep}`);
          process.exit(1);
        }
      }

      await ensureDaemon();

      try {
        if (sessionId) {
          await handleSingleSession(sessionId, options);
        } else {
          await handleGlobalGrep(options);
        }
      } catch (error) {
        console.error("Failed to capture screen:", error);
        process.exit(1);
      }
    });
}
