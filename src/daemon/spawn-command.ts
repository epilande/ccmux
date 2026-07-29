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

/**
 * The only accepted shape for a session id that gets interpolated into a
 * shell command (`resume`, `fork`). Deliberately narrower than any agent's
 * real id format: everything in it is inert to the shell, so no escaping is
 * needed downstream and no template can be broken out of.
 */
export const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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

/** Validate a wire pane-id field (`target` / `callerPane`). */
export function normalizeTarget(
  value: unknown,
  field = "target",
): BuildResult<string | undefined> {
  if (value === undefined || value === null || value === "")
    return { ok: true, value: undefined };
  if (typeof value !== "string" || !PANE_ID_PATTERN.test(value)) {
    return {
      ok: false,
      error: `Invalid '${field}' field: expected a tmux pane id such as "%12"`,
    };
  }
  return { ok: true, value };
}

/**
 * Control characters the prompt may not contain. A NUL in particular
 * survives shell escaping but makes `Bun.spawn` reject the argv — and it
 * would do so AFTER the pane exists, leaving an orphan behind and
 * returning an opaque 500, which is a repeatable pane leak. Tab, newline,
 * and carriage return are deliberately allowed: multi-line prompts are
 * normal, and single quotes keep them inert.
 */
const FORBIDDEN_PROMPT_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

/**
 * Validate the wire `prompt` field. Absent stays absent; anything present
 * must be a non-blank string free of control characters. Empty is
 * rejected rather than ignored: `--prompt ""` silently spawning a bare
 * agent (and slipping past the refusal an agent without `promptCommand`
 * would otherwise get) is worse than a clear error.
 */
export function normalizePrompt(
  value: unknown,
): BuildResult<string | undefined> {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, error: `Invalid 'prompt' field: expected a string` };
  }
  if (value.trim() === "") {
    return { ok: false, error: `Invalid 'prompt' field: must not be empty` };
  }
  if (FORBIDDEN_PROMPT_CONTROL_CHARS.test(value)) {
    return {
      ok: false,
      error: `Invalid 'prompt' field: must not contain control characters`,
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
 * Substitute every placeholder in ONE pass.
 *
 * Two properties matter, and both are load-bearing:
 *
 * A function replacer, never a string one. With a string replacement,
 * `$&`, "$`", "$'", and `$$` in the REPLACEMENT are expansion patterns,
 * so a prompt containing "$`" would splice the text before the match back
 * into the command — closing the quoted word and handing the rest of the
 * prompt to the shell as syntax. A function replacer's return value is
 * used literally.
 *
 * One pass, never sequential passes. Substituting `{bin}` and then
 * `{prompt}` lets a value substituted first contain a later placeholder:
 * a `command` preference or `executable` of `x{prompt}` would relocate
 * the prompt to wherever the binary landed, outside the quotes the guard
 * verified. A single regex alternation consumes each placeholder exactly
 * once and never revisits substituted text.
 */
export function substitutePlaceholders(
  template: string,
  values: Record<string, string>,
): string {
  const names = Object.keys(values);
  if (names.length === 0) return template;
  const pattern = new RegExp(`\\{(${names.join("|")})\\}`, "g");
  return template.replace(pattern, (_match, name: string) => values[name]!);
}

type QuoteState = "none" | "single" | "double";

/**
 * Walk a template the way `sh` reads it, recording the quoting state at
 * each `{prompt}` and whether the template ends with every quote closed.
 *
 * Both placeholders are skipped as inert text, which is what their
 * substituted values are: the prompt is single-quote escaped, and the
 * binary is separately required to be quote-neutral (see
 * `binaryIsQuoteNeutral`) precisely so that skipping it here is sound.
 */
function scanPromptPlaceholders(template: string): {
  balanced: boolean;
  states: QuoteState[];
} {
  const PROMPT = "{prompt}";
  const BIN = "{bin}";
  let state: QuoteState = "none";
  const states: QuoteState[] = [];

  for (let i = 0; i < template.length; ) {
    if (template.startsWith(PROMPT, i)) {
      states.push(state);
      i += PROMPT.length;
      continue;
    }
    if (template.startsWith(BIN, i)) {
      i += BIN.length;
      continue;
    }
    const char = template[i];
    if (state === "single") {
      // Single quotes are literal all the way to the closing quote;
      // backslash has no special meaning inside them.
      if (char === "'") state = "none";
      i += 1;
      continue;
    }
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (state === "none") {
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
    } else if (char === '"') {
      state = "none";
    }
    i += 1;
  }

  return { balanced: state === "none", states };
}

/**
 * Constructs that make a template impossible to reason about safely. A
 * double quote means the single quotes around `{prompt}` may be inert
 * (`{bin} "pre'{prompt}'post"` expands `$(...)` straight out of prompt
 * text); backticks and `$(` mean part of the command is the OUTPUT of
 * another command, so even a correctly quoted prompt is re-split by the
 * shell after substitution. None of them are needed to name a launcher,
 * and false assurance is worse than no check, so they are refused
 * outright rather than modelled.
 */
const UNSAFE_TEMPLATE_CONSTRUCT = /["`]|\$\(/;

/**
 * A `promptCommand` template is only safe if every `{prompt}` sits in a
 * genuine single-quoted context, because that is the quoting
 * `escapeSingleQuoted` produces. Checking only the adjacent characters is
 * not enough: in `sh -c "{bin} '{prompt}'"` the placeholder is flanked by
 * single quotes, but the enclosing word is double-quoted, where `'` is an
 * ordinary character and the escaping is inert. Templates come from the
 * user's config file, which is trusted to name a command but must not be
 * able to turn prompt text into shell syntax, so anything this cannot
 * prove safe is refused. Module-private: the check presupposes the
 * escaping it guards.
 */
function promptPlaceholderIsQuoted(template: string): boolean {
  if (UNSAFE_TEMPLATE_CONSTRUCT.test(template)) return false;
  const { balanced, states } = scanPromptPlaceholders(template);
  return (
    balanced && states.length > 0 && states.every((state) => state === "single")
  );
}

/**
 * The binary is substituted into the template AFTER its quoting has been
 * verified, so it must not be able to change how the rest of the command
 * parses. That is what lets `scanPromptPlaceholders` skip over `{bin}`.
 *
 * Refused: quotes and backslash (they move the quote state directly), and
 * the command-substitution openers, which swallow the prompt into a
 * command rather than passing it as an argument (`x$(` yields
 * `x$( 'prompt'`, and a stray backtick does the same).
 *
 * Allowed: ordinary parameter expansion. `$HOME/.local/bin/claude` is a
 * thoroughly plausible `command` preference that the shell expands when
 * the line is typed into the pane, exactly as it did before this guard
 * existed. Expansion happens after quote parsing and its result is not
 * re-scanned for quotes, so it cannot reach the prompt's quoting.
 * Refusing it would also have been asymmetric: the same config still
 * worked on the bare-spawn path and only errored with `--prompt`.
 */
function binaryIsQuoteNeutral(binary: string): boolean {
  return !/['"`\\]/.test(binary) && !binary.includes("$(");
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
        ? substitutePlaceholders(agent.resumeCommand, { id: resume })
        : `${binary} --resume ${resume}`,
    };
  }

  // `prompt !== undefined`, not truthiness: an empty prompt must reach the
  // refusal below rather than quietly spawning a bare agent. The route
  // rejects blank prompts before this, so anything arriving here is real.
  if (prompt !== undefined) {
    const template = agent.promptCommand;
    if (template === undefined) {
      return {
        ok: false,
        error:
          `Agent '${agent.name}' does not support spawning with an initial prompt. ` +
          `Set 'agents.${agent.name}.promptCommand' in ccmux.json (e.g. "{bin} '{prompt}'").`,
      };
    }
    // A config file can hold any JSON, and this runs outside the route's
    // try block, so a non-string would surface as an opaque 500.
    if (typeof template !== "string") {
      return {
        ok: false,
        error: `Invalid 'agents.${agent.name}.promptCommand': expected a string.`,
      };
    }
    if (!binaryIsQuoteNeutral(binary)) {
      return {
        ok: false,
        error:
          `Cannot spawn '${agent.name}' with a prompt: its launcher (${binary}) contains ` +
          `a quote, a backslash, or a command substitution, which would break the quoting ` +
          `around the prompt.`,
      };
    }
    if (!promptPlaceholderIsQuoted(template)) {
      return {
        ok: false,
        error:
          `Invalid 'agents.${agent.name}.promptCommand': every {prompt} placeholder must sit ` +
          `inside balanced single quotes, and the template may not contain double quotes, ` +
          `backticks, or '$(' (e.g. "{bin} '{prompt}'").`,
      };
    }
    return {
      ok: true,
      value: substitutePlaceholders(template, {
        bin: binary,
        prompt: escapeSingleQuoted(prompt),
      }),
    };
  }

  return { ok: true, value: binary };
}

export interface AgentForkCommandInput {
  agent: AgentDef;
  /** Resolved launcher binary, substituted for `{bin}` (see above). */
  binary: string;
  /** The SOURCE session's native id, substituted for `{id}`. */
  sessionId: string;
}

/**
 * Build the shell command that continues `sessionId`'s conversation in a
 * new session, leaving the source untouched.
 *
 * Kept separate from `buildAgentSpawnCommand` and from every placement
 * concern (`buildTmuxSpawnArgv`, the route's `SpawnPlacement` resolution)
 * on purpose: forking into a git worktree is the same command with a
 * different `cwd` and destination, so that feature reuses this function
 * unchanged and only swaps the placement half.
 *
 * There is no quoting scan like `promptCommand`'s, because nothing
 * free-form is interpolated: `{id}` is constrained to
 * `NATIVE_SESSION_ID_PATTERN` right here, and `{bin}` is the same value
 * the bare-spawn path already sends to the shell verbatim.
 */
export function buildAgentForkCommand(
  input: AgentForkCommandInput,
): BuildResult<string> {
  const { agent, binary, sessionId } = input;
  const template = agent.forkCommand;

  if (template === undefined) {
    return {
      ok: false,
      error:
        `Agent '${agent.name}' does not support forking a session. ` +
        `Set 'agents.${agent.name}.forkCommand' in ccmux.json (e.g. "{bin} --resume {id} --fork-session") ` +
        `once you have verified that resuming a live session leaves it undisturbed.`,
    };
  }
  // A config file can hold any JSON, and this runs outside the route's try
  // block, so a non-string would surface as an opaque 500.
  if (typeof template !== "string") {
    return {
      ok: false,
      error: `Invalid 'agents.${agent.name}.forkCommand': expected a string.`,
    };
  }
  // Without `{id}` the command starts a FRESH session: the pane appears, the
  // agent runs, and the history the user asked to branch is silently absent.
  // A refusal is far easier to act on than that.
  if (!template.includes("{id}")) {
    return {
      ok: false,
      error:
        `Invalid 'agents.${agent.name}.forkCommand': must contain the {id} placeholder, ` +
        `otherwise the fork would start a fresh session instead of continuing this one.`,
    };
  }
  if (!NATIVE_SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, error: `Invalid session id: ${sessionId}` };
  }

  return {
    ok: true,
    value: substitutePlaceholders(template, { id: sessionId, bin: binary }),
  };
}

/**
 * Where tmux should put the new pane or window. Resolution needs a tmux
 * round-trip, so the caller does it and passes the answer in.
 *
 * - `pane` (`%12`) splits that pane. Only meaningful for a split.
 * - `window` (`@7`) inserts a new window immediately after it, which
 *   RENUMBERS every later window in that session. That is the right
 *   behavior only when the user named a target explicitly.
 * - `session` (`$3`) appends at the end of that session, renumbering
 *   nothing. This is the implicit case: the caller just wants the window
 *   in their own session rather than in whichever session the daemon
 *   happens to consider current.
 *
 * `new-window` cannot take a pane id at all ("can't specify pane here"),
 * and targeting an occupied index without `-a` fails with "index in use",
 * which is why neither form is a raw pane id.
 */
export type SpawnPlacement =
  | { kind: "pane"; id: string }
  | { kind: "window"; id: string }
  | { kind: "session"; id: string };

export interface TmuxSpawnArgvInput {
  split: ResolvedSplit;
  cwd: string;
  placement?: SpawnPlacement;
  /**
   * Leave the caller's view where it is. Passed to tmux as `-d`, which is
   * the only thing that actually prevents the switch: BOTH `new-window`
   * and `split-window` make what they create current by default, so
   * merely skipping the follow-up `select-window` left `--detach` still
   * yanking the caller to the new window.
   */
  detach?: boolean;
}

/** argv for the tmux command that creates the pane, minus the binary. */
export function buildTmuxSpawnArgv(input: TmuxSpawnArgvInput): string[] {
  const { split, cwd, placement, detach = false } = input;
  const argv: string[] = [];

  if (split) {
    argv.push("split-window", `-${split}`);
    if (detach) argv.push("-d");
    if (placement?.kind === "pane") argv.push("-t", placement.id);
  } else {
    argv.push("new-window");
    if (detach) argv.push("-d");
    if (placement?.kind === "window") argv.push("-a", "-t", placement.id);
    else if (placement?.kind === "session") argv.push("-t", `${placement.id}:`);
  }

  argv.push("-c", cwd, "-P", "-F", "#{pane_id}");
  return argv;
}
