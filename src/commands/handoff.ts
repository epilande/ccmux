/**
 * `ccmux handoff <from> <to>` — give one session's last response to another.
 *
 * The headline flow is an AGENT running this about itself: `ccmux handoff self
 * codex --note "..."` hands its own conclusion to a peer without the text ever
 * transiting a third context. Both ends go through the shared session-ref
 * resolver, and an ambiguous ref at either end is refused with the candidate
 * list rather than guessed at.
 *
 * Every outcome prints one readable line: delivered, queued, spawned, or the
 * refusal's own reason verbatim.
 */

import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import { MAX_TURNS } from "../daemon/transcript-read";
import { proximityLabel } from "../daemon/session-ref";
import type { RefProximity, SessionRefCandidate } from "../daemon/session-ref";
import { renderCandidates } from "./last";

interface HandoffEnd {
  sessionId?: string;
  agentType?: string;
  cwd?: string;
  paneId?: string | null;
  resolution?: {
    ref: string;
    tier: string;
    exact: boolean;
    proximity: RefProximity | null;
  };
}

interface HandoffResponse {
  status: "delivered" | "queued" | "spawned";
  from: HandoffEnd;
  to: HandoffEnd;
  chars: number;
  truncated: boolean;
  queuedAt?: string;
  expiresAt?: string;
  replaced?: { fromSessionId: string };
  notes?: string[];
}

interface HandoffError {
  error?: string;
  reason?: string;
  end?: "from" | "to";
  candidates?: SessionRefCandidate[];
}

/** One stderr line per end the user did not spell out exactly, so a
 *  surprising pick is visible without polluting stdout. */
export function resolutionEchoes(data: HandoffResponse): string[] {
  const lines: string[] = [];
  for (const [label, end] of [
    ["from", data.from],
    ["to", data.to],
  ] as const) {
    const resolution = end.resolution;
    if (!resolution || resolution.exact) continue;
    const where = resolution.proximity
      ? ` (${proximityLabel(resolution.proximity)})`
      : "";
    lines.push(`${label}: ${resolution.ref} -> ${end.sessionId}${where}`);
  }
  return lines;
}

/** The one line stdout gets for a successful handoff. */
export function renderOutcome(data: HandoffResponse): string {
  const size = `${data.chars.toLocaleString("en-US")} chars${data.truncated ? ", truncated" : ""}`;
  if (data.status === "queued") {
    return (
      `Queued for ${data.to.sessionId} (${data.to.agentType} is working): ${size}. ` +
      `It will be delivered when the turn ends.` +
      (data.replaced
        ? `\nReplaced a pending handoff from ${data.replaced.fromSessionId}.`
        : "")
    );
  }
  if (data.status === "spawned") {
    return (
      `Spawned ${data.to.agentType} in ${data.to.cwd}` +
      (data.to.paneId ? ` (pane ${data.to.paneId})` : "") +
      ` with the handoff as its opening prompt: ${size}.`
    );
  }
  return `Delivered ${data.from.sessionId} -> ${data.to.sessionId} (${data.to.agentType}): ${size}.`;
}

export function parseHandoffTurns(value: string): number {
  const turns = parseInt(value, 10);
  if (isNaN(turns) || turns < 1 || turns > MAX_TURNS) {
    console.error(`Invalid --turns value (expected 1-${MAX_TURNS})`);
    process.exit(1);
  }
  return turns;
}

export function createHandoffCommand(): Command {
  return new Command("handoff")
    .description("Hand a session's last response to another session")
    .argument(
      "<from>",
      "Source ref: session id, %pane, session:window.pane, self, agent type, or project name",
    )
    .argument("[to]", "Target ref, same forms (omit with --spawn)")
    .option("-t, --turns <n>", "How many turns of context to include", "1")
    .option("-n, --note <text>", "One-line note for the receiving agent")
    .option(
      "--spawn",
      "Open a new session for the handoff instead of naming one",
    )
    .option("--agent <name>", "Agent for --spawn (default: the source's agent)")
    .option("--cwd <path>", "Directory for --spawn (default: the source's cwd)")
    .option("--json", "Print the raw handoff response")
    .action(
      async (
        from: string,
        to: string | undefined,
        options: {
          turns: string;
          note?: string;
          spawn?: boolean;
          agent?: string;
          cwd?: string;
          json?: boolean;
        },
      ) => {
        const turns = parseHandoffTurns(options.turns);

        if (options.spawn && to !== undefined) {
          console.error(
            "--spawn and a <to> argument are mutually exclusive: a handoff either goes to an existing session or opens a new one",
          );
          process.exit(1);
        }
        if (!options.spawn && to === undefined) {
          console.error("Missing <to> argument (or use --spawn)");
          process.exit(1);
        }
        if (!options.spawn && (options.agent || options.cwd)) {
          console.error("--agent and --cwd only apply with --spawn");
          process.exit(1);
        }

        await ensureDaemon();

        const body: Record<string, unknown> = { from, turns };
        if (to !== undefined) body.to = to;
        if (options.note !== undefined) body.note = options.note;
        // Proximity for a fuzzy ref, and placement for a --spawn: the daemon
        // can only scope the search, and put the new pane next to the caller,
        // if it knows where the caller is sitting.
        if (process.env.TMUX_PANE) body.callerPane = process.env.TMUX_PANE;
        if (options.spawn) {
          const spawn: Record<string, unknown> = {};
          if (options.agent) spawn.agent = options.agent;
          if (options.cwd) spawn.cwd = options.cwd;
          body.spawn = Object.keys(spawn).length > 0 ? spawn : true;
        }

        let response: Response;
        try {
          response = await fetch(`${getDaemonUrl()}/handoff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (error) {
          console.error("Failed to reach the daemon:", error);
          process.exit(1);
        }

        if (!response.ok) {
          const data = (await response
            .json()
            .catch(() => null)) as HandoffError | null;
          if (data?.candidates) {
            // The listing IS the recovery path, so it names which end was
            // ambiguous and carries an id/coordinate to re-ask with.
            const ref = data.end === "to" ? (to ?? "") : from;
            console.error(renderCandidates(ref, data.candidates));
          } else {
            console.error(data?.error ?? `HTTP ${response.status}`);
          }
          process.exit(1);
        }

        const data = (await response.json()) as HandoffResponse;

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        for (const echo of resolutionEchoes(data)) console.error(echo);
        console.log(renderOutcome(data));
        for (const note of data.notes ?? []) console.error(`note: ${note}`);
      },
    );
}
