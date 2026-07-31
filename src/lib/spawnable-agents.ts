import { BUILTIN_AGENTS, getAgentDisplayName, type AgentDef } from "./agents";

/**
 * One entry in `GET /agents`: an agent this machine can actually start.
 * Deliberately narrow — the TUI needs a label, a key, and whether a prompt
 * is accepted, not the detection regexes and hook wiring an `AgentDef`
 * carries.
 */
export interface SpawnableAgent {
  name: string;
  displayName: string;
  shortCode: string;
  /** Whether `POST /spawn` accepts a `prompt` for this agent, i.e. whether
   *  its `promptCommand` shape has been verified. See `buildAgentSpawnCommand`. */
  supportsPrompt: boolean;
}

/**
 * The launcher binary a fresh interactive session runs, matching what
 * `POST /spawn` builds its command from. Claude alone honors the
 * `command` preference (a wrapper or a non-PATH install), so a user who
 * points ccmux at one must not have Claude vanish from the dialog.
 */
export function spawnBinaryFor(
  agent: AgentDef,
  claudeCommand?: string,
): string {
  if (agent.name === "claude") return claudeCommand ?? "claude";
  return agent.executable ?? agent.name;
}

/**
 * The binary each built-in launches when the user has declared nothing:
 * `agent.executable ?? agent.name`, which is what `spawnBinaryFor` returns
 * for an unconfigured def. A resolved binary that differs from its entry was
 * hand-declared (`agents.<name>.executable`, or claude's `command`); a name
 * with no entry at all is a custom agent.
 */
const BUILTIN_BINARIES = new Map(
  BUILTIN_AGENTS.map((agent) => [agent.name, agent.executable ?? agent.name]),
);

/**
 * The agents worth offering in the new-session dialog, in `getAgents` order
 * (built-ins first, custom ones after).
 *
 * Built-ins are PATH-gated: they are the full catalogue of agents ccmux
 * knows how to talk to, most of which any given machine does not have, and
 * a menu whose entries fail on Enter is worse than a short menu. Custom
 * agents from `ccmux.json` are listed unconditionally: the user declared
 * one by hand, and its `executable` is as likely to be a shell function or
 * a wrapper `Bun.which` cannot see as it is to be missing — so the honest
 * answer comes from the spawn attempt, not from hiding it. A built-in whose
 * binary the user declared (claude's `command`, or any built-in's
 * `executable` override) is hand-declared in exactly the same way, so it is
 * listed unconditionally too.
 */
export function listSpawnableAgents(
  agents: AgentDef[],
  options: {
    claudeCommand?: string;
    which?: (cmd: string) => string | null;
  } = {},
): SpawnableAgent[] {
  const which = options.which ?? Bun.which;
  const spawnable: SpawnableAgent[] = [];
  for (const agent of agents) {
    // Any hand-declared binary is as good as a custom agent's `executable`,
    // and the same argument applies: it is documented as possibly being a
    // bare alias (`c`), a `~`-relative path, or `$HOME/.local/bin/claude`
    // (see `buildAgentSpawnCommand`), and `Bun.which` resolves none of
    // those. It is typed into an interactive shell, where it does resolve —
    // so gating on `which` here hides an agent that would spawn perfectly
    // well. One test covers claude's `command` and every built-in's
    // `executable` override alike: only a binary still equal to the
    // catalogue default is PATH-gated.
    const binary = spawnBinaryFor(agent, options.claudeCommand);
    if (binary === BUILTIN_BINARIES.get(agent.name)) {
      if (which(binary) === null) continue;
    }
    spawnable.push({
      name: agent.name,
      displayName: agent.displayName ?? getAgentDisplayName(agent.name),
      shortCode: agent.shortCode,
      supportsPrompt: typeof agent.promptCommand === "string",
    });
  }
  return spawnable;
}
