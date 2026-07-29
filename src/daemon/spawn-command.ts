import type { AgentDef } from "../lib/agents";

/**
 * Requested split direction, in tmux's own vocabulary: `"h"` splits the
 * target pane left/right (tmux `-h`), `"v"` splits it top/bottom (tmux
 * `-v`, which is also tmux's default and therefore what a bare
 * `--split` has always produced).
 */
export type SplitDirection = "h" | "v";

/**
 * `POST /spawn`'s `split` field. `false` means a new window, `true` keeps
 * the historical default direction, and an explicit direction pins it.
 */
export type SpawnSplit = boolean | SplitDirection;

/** Normalized split: `false` for a new window, else the tmux direction. */
export type ResolvedSplit = false | SplitDirection;

/** A tmux pane id, the only accepted shape for `target`. */
export const PANE_ID_PATTERN = /^%\d+$/;

export type BuildResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * Validate and normalize the wire `split` field. Booleans are still
 * accepted (older callers and `ccmux spawn --split` with no value);
 * `true` maps to `"v"` because that is what tmux's flagless
 * `split-window` has always done, so the default stays byte-identical.
 */
export function normalizeSplit(value: unknown): BuildResult<ResolvedSplit> {
  if (value === undefined || value === false) return { ok: true, value: false };
  if (value === true) return { ok: true, value: "v" };
  if (value === "h" || value === "v") return { ok: true, value };
  return {
    ok: false,
    error: `Invalid 'split' field: expected true, false, "h", or "v"`,
  };
}

/** Validate the wire `target` field as a tmux pane id (`%12`). */
export function normalizeTarget(
  value: unknown,
): BuildResult<string | undefined> {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (typeof value !== "string" || !PANE_ID_PATTERN.test(value)) {
    return {
      ok: false,
      error: `Invalid 'target' field: expected a tmux pane id such as "%12"`,
    };
  }
  return { ok: true, value };
}

/**
 * Escape a value for interpolation inside a single-quoted shell word.
 * The spawn command is typed into the pane's shell via `send-keys`, so
 * this is the one place prompt text is made shell-safe; `promptCommand`
 * templates receive the already-escaped value.
 */
export function escapeSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * A `promptCommand` template is only safe if its `{prompt}` placeholder
 * sits inside single quotes: that is the quoting `escapeSingleQuoted`
 * assumes. A bare or double-quoted placeholder would let prompt text
 * reach the shell as syntax, so a template that gets it wrong is
 * refused rather than silently executed. Kept module-private so the check
 * cannot be used apart from the escaping it presupposes.
 */
function promptPlaceholderIsQuoted(template: string): boolean {
  const idx = template.indexOf("{prompt}");
  if (idx < 0) return false;
  const before = template[idx - 1];
  const after = template[idx + "{prompt}".length];
  return before === "'" && after === "'";
}

export interface AgentCommandInput {
  agent: AgentDef;
  /**
   * Resolved launcher binary: `preferences.command` for claude,
   * otherwise `agent.executable ?? agent.name`. Substituted for `{bin}`
   * in `promptCommand`, so a wrapper binary survives the template.
   */
  binary: string;
  resume?: string;
  prompt?: string;
}

/**
 * Build the shell command typed into the freshly created pane.
 *
 * Resume wins over prompt (a resumed session already has its history).
 * The prompt path requires `agent.promptCommand`: there is no universal
 * flag for "start interactively with this prompt" — `--prompt` means
 * one-shot print mode for Copilot and does not exist at all for pi — so
 * an agent that has not declared its shape is refused instead of being
 * handed a command that would silently do the wrong thing.
 */
export function buildAgentSpawnCommand(
  input: AgentCommandInput,
): BuildResult<string> {
  const { agent, binary, resume, prompt } = input;

  if (resume) {
    return {
      ok: true,
      value: agent.resumeCommand
        ? agent.resumeCommand.replace("{id}", resume)
        : `${binary} --resume ${resume}`,
    };
  }

  if (prompt) {
    const template = agent.promptCommand;
    if (!template) {
      return {
        ok: false,
        error:
          `Agent '${agent.name}' does not support spawning with an initial prompt. ` +
          `Set 'agents.${agent.name}.promptCommand' in ccmux.json (e.g. "{bin} '{prompt}'").`,
      };
    }
    if (!promptPlaceholderIsQuoted(template)) {
      return {
        ok: false,
        error:
          `Invalid promptCommand for agent '${agent.name}': the {prompt} placeholder ` +
          `must be wrapped in single quotes (e.g. "{bin} '{prompt}'").`,
      };
    }
    return {
      ok: true,
      value: template
        .replace("{bin}", binary)
        .replace("{prompt}", escapeSingleQuoted(prompt)),
    };
  }

  return { ok: true, value: binary };
}

export interface TmuxSpawnArgvInput {
  split: ResolvedSplit;
  cwd: string;
  /**
   * Where to place the new pane/window. For a split this is the tmux
   * pane id to split. For a new window it must already be resolved to a
   * WINDOW id (`@7`): `new-window -t %12` fails with "can't specify pane
   * here", and targeting an occupied index without `-a` fails with
   * "index in use", so the window form is created with `-a` (insert
   * after the caller's window). Resolution lives in the caller because
   * it needs a tmux round-trip.
   */
  target?: string;
}

/** argv for the tmux command that creates the pane, minus the binary. */
export function buildTmuxSpawnArgv(input: TmuxSpawnArgvInput): string[] {
  const { split, cwd, target } = input;
  const argv: string[] = [];

  if (split) {
    argv.push("split-window", `-${split}`);
    if (target) argv.push("-t", target);
  } else {
    argv.push("new-window");
    if (target) argv.push("-a", "-t", target);
  }

  argv.push("-c", cwd, "-P", "-F", "#{pane_id}");
  return argv;
}
