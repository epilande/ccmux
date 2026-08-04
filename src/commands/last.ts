/**
 * `ccmux last <session-ref>` — print another session's last response.
 *
 * stdout stays PURE payload so `ccmux last codex | pbcopy` works; everything
 * else (the resolution echo, refusals) goes to stderr.
 */

import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import { proximityLabel } from "../daemon/session-ref";
import type { RefProximity, SessionRefCandidate } from "../daemon/session-ref";
import { MAX_TURNS } from "../daemon/transcript-read";
import type { TranscriptTurn } from "../daemon/transcript-read";

/** The frozen transcript response contract, plus the daemon's account of how
 *  it read the ref (which is what the stderr echo reports). */
interface TranscriptResponse {
  sessionId: string;
  agentType: string;
  source: "transcript" | "pane";
  turns: TranscriptTurn[];
  truncated: boolean;
  resolution?: {
    ref: string;
    tier: string;
    exact: boolean;
    proximity: RefProximity | null;
  };
}

/**
 * The one-line stderr note for a resolution the user did not spell out
 * exactly, so a surprising pick is visible without polluting stdout. Returns
 * null for exact refs, which need no explanation.
 */
export function resolutionEcho(data: TranscriptResponse): string | null {
  const resolution = data.resolution;
  if (!resolution || resolution.exact) return null;
  const where = resolution.proximity
    ? ` (${proximityLabel(resolution.proximity)})`
    : "";
  return `${resolution.ref} -> ${data.sessionId}${where}`;
}

/**
 * Render the payload. A single entry prints bare (it IS the last response);
 * several print with `user:` / `assistant:` labels so the exchange reads in
 * order.
 */
export function renderTurns(turns: TranscriptTurn[]): string {
  if (turns.length === 1) return turns[0].text;
  return turns.map((turn) => `${turn.role}:\n${turn.text}`).join("\n\n");
}

/** The candidate listing an ambiguous ref is refused with; it is the
 *  recovery path, so it carries an id and a coordinate to re-ask with. */
export function renderCandidates(
  ref: string,
  candidates: SessionRefCandidate[],
): string {
  const lines = [
    `Ambiguous session reference "${ref}" (${candidates.length} matches):`,
  ];
  for (const c of candidates) {
    lines.push(
      `  ${c.sessionId}  ${c.coordinate ?? "(no pane)"}  ${c.agentType}  ${c.status}  ${c.cwd}  [${proximityLabel(c.proximity)}]`,
    );
  }
  lines.push("Re-run with one of the ids or coordinates above.");
  return lines.join("\n");
}

export function parseTurns(value: string): number {
  const turns = parseInt(value, 10);
  if (isNaN(turns) || turns < 1 || turns > MAX_TURNS) {
    console.error(`Invalid --turns value (expected 1-${MAX_TURNS})`);
    process.exit(1);
  }
  return turns;
}

export function createLastCommand(): Command {
  return new Command("last")
    .description("Print a session's last response")
    .argument(
      "<session-ref>",
      "Session id, %pane, session:window.pane, self, agent type, or project name",
    )
    .option("-t, --turns <n>", "How many turns back to include", "1")
    .option("--json", "Print the raw transcript response")
    .action(async (ref: string, options: { turns: string; json?: boolean }) => {
      const turns = parseTurns(options.turns);
      await ensureDaemon();

      const params = new URLSearchParams({ turns: String(turns) });
      // Proximity for a fuzzy ref: the daemon can only scope the search if it
      // knows where the caller is sitting. Absent outside tmux, which simply
      // means a global search.
      if (process.env.TMUX_PANE) {
        params.set("callerPane", process.env.TMUX_PANE);
      }

      let response: Response;
      try {
        response = await fetch(
          `${getDaemonUrl()}/sessions/${encodeURIComponent(ref)}/transcript?${params}`,
        );
      } catch (error) {
        console.error("Failed to reach the daemon:", error);
        process.exit(1);
      }

      if (response.status === 409) {
        const data = (await response.json()) as {
          candidates: SessionRefCandidate[];
        };
        console.error(renderCandidates(ref, data.candidates));
        process.exit(1);
      }

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        console.error(data?.error ?? `HTTP ${response.status}`);
        process.exit(1);
      }

      const data = (await response.json()) as TranscriptResponse;

      const echo = resolutionEcho(data);
      if (echo) console.error(echo);

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(renderTurns(data.turns));
    });
}
