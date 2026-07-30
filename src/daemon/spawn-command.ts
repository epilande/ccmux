import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
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
 * Validate a wire boolean field (`detach`). Every other spawn field goes
 * through a normalizer that rejects anything not in its accepted shape; this
 * one used to be an unchecked cast, so a truthy non-boolean like the string
 * `"false"` silently reached tmux as `true`. `undefined` is left for the
 * caller to default.
 */
export function normalizeBoolean(
  value: unknown,
  field: string,
): BuildResult<boolean | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === "boolean") return { ok: true, value };
  return {
    ok: false,
    error: `Invalid '${field}' field: expected true or false`,
  };
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
 * Budget for the BUILT spawn command, which reaches tmux as one argv element
 * (`send-keys -t <pane> <command> Enter`). Linux rejects an `execve` whose
 * single argument exceeds `MAX_ARG_STRLEN` (128 KiB on 4 KiB pages) however
 * small the rest of the argv is, so that per-argument limit, not the ~1 MB of
 * total argv macOS enforces, is what decides whether `Bun.spawn` throws. Set
 * conservatively below it by design, matching `MAX_ARGV_PROMPT_BYTES` in
 * `invokers/constants.ts`, which caps the same OS limit for the same reason.
 *
 * Deliberately NOT the 256 KiB `/invoke` allows: an invoked prompt is written
 * to stdin or chunked into a pane rather than travelling as one argument, so
 * it has no per-argument ceiling to respect. The two numbers diverge because
 * the transports do.
 */
export const MAX_SPAWN_COMMAND_BYTES = 120 * 1024;

/**
 * Upper bound on a spawn `prompt`'s byte size: the command budget less
 * headroom for the template that wraps it. This is the friendlier of the two
 * checks (it names the field the caller actually sent) but it cannot be the
 * guarantee on its own, because the command is longer than the prompt: the
 * template adds bytes, and `escapeSingleQuoted` turns every `'` into four.
 * {@link spawnCommandTooLarge} is what makes the promise true.
 */
export const MAX_SPAWN_PROMPT_BYTES = MAX_SPAWN_COMMAND_BYTES - 2 * 1024;

/**
 * Validate the wire `prompt` field. Absent stays absent; anything present
 * must be a non-blank string free of control characters, within the byte
 * cap. Empty is rejected rather than ignored: `--prompt ""` silently
 * spawning a bare agent (and slipping past the refusal an agent without
 * `promptCommand` would otherwise get) is worse than a clear error.
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
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > MAX_SPAWN_PROMPT_BYTES) {
    return {
      ok: false,
      error:
        `Invalid 'prompt' field: exceeds maximum size of ` +
        `${MAX_SPAWN_PROMPT_BYTES} bytes (got ${byteLength})`,
    };
  }
  return { ok: true, value };
}

/**
 * Why the built command cannot be handed to tmux, or undefined when it fits.
 *
 * Asked of the string a builder produced, since that is the argv element the
 * OS measures. Everything the builders do is pure string work, so the caller
 * can ask before it creates a pane or a worktree and turn what used to be a
 * throw-then-500 into a 400 with nothing behind it.
 */
export function spawnCommandTooLarge(command: string): string | undefined {
  const byteLength = Buffer.byteLength(command, "utf8");
  if (byteLength <= MAX_SPAWN_COMMAND_BYTES) return undefined;
  return (
    `The command this spawn would run is ${byteLength} bytes, over the ` +
    `${MAX_SPAWN_COMMAND_BYTES}-byte limit for a single command argument. ` +
    `Shorten the prompt (quoting it grows it: every single quote becomes four bytes).`
  );
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

/**
 * Placeholders whose value is free-form text made safe by
 * `escapeSingleQuoted`, so each occurrence has to land in a genuine
 * single-quoted context. `path` is here for the same reason `prompt` is: a
 * filesystem path can hold quotes, spaces and shell metacharacters.
 *
 * Everything else a template can carry (`bin`, `id`) is inert by
 * construction and validated separately.
 */
const QUOTED_PLACEHOLDERS = ["prompt", "path"] as const;

const QUOTED_PLACEHOLDER_NAMES: ReadonlySet<string> = new Set(
  QUOTED_PLACEHOLDERS,
);
const QUOTED_TOKENS = QUOTED_PLACEHOLDERS.map((name) => `{${name}}`);

/**
 * Escape the free-form values and substitute the whole template in ONE
 * pass. `prompt` and `path` are escaped for a single-quoted word; every
 * other value (`bin`, `id`) goes in verbatim, because it is inert by
 * construction rather than by escaping.
 *
 * Callers must have cleared `quotedTemplateProblem` first: the escaping
 * only holds inside the quoting that check proves is there.
 */
export function substituteQuotedTemplate(
  template: string,
  values: Record<string, string>,
): string {
  const substitutions: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    substitutions[name] = QUOTED_PLACEHOLDER_NAMES.has(name)
      ? escapeSingleQuoted(value)
      : value;
  }
  return substitutePlaceholders(template, substitutions);
}

type QuoteState = "none" | "single" | "double";

/**
 * Walk a template the way `sh` reads it, recording the quoting state at
 * each `{prompt}` / `{path}` and whether the template ends with every quote
 * closed.
 *
 * Every placeholder is skipped as inert text, which is what its substituted
 * value is: `{prompt}` and `{path}` are single-quote escaped, and the binary
 * is separately required to be quote-neutral (see `binaryIsQuoteNeutral`)
 * precisely so that skipping it here is sound.
 *
 * There is no backslash handling because a backslash anywhere in the
 * template is refused before this runs (see `UNSAFE_TEMPLATE_CONSTRUCTS`).
 * Modelling it here is what caused the original bypass: consuming two
 * characters at once swallowed the `{` of a following `{prompt}`, so the
 * scan missed an occurrence that `substitutePlaceholders` still replaced.
 */
function scanQuotedPlaceholders(template: string): {
  balanced: boolean;
  placeholders: { token: string; state: QuoteState }[];
} {
  const BIN = "{bin}";
  let state: QuoteState = "none";
  const placeholders: { token: string; state: QuoteState }[] = [];

  for (let i = 0; i < template.length; ) {
    const token = QUOTED_TOKENS.find((candidate) =>
      template.startsWith(candidate, i),
    );
    if (token !== undefined) {
      placeholders.push({ token, state });
      i += token.length;
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
    if (state === "none") {
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
    } else if (char === '"') {
      state = "none";
    }
    i += 1;
  }

  return { balanced: state === "none", placeholders };
}

/**
 * Constructs that make a template impossible to reason about safely, each
 * paired with the wording used to refuse it so someone hand-writing a
 * template is told WHICH construct was rejected.
 *
 * A double quote means the single quotes around `{prompt}` may be inert
 * (`{bin} "pre'{prompt}'post"` expands `$(...)` straight out of prompt
 * text); backticks and `$(` mean part of the command is the OUTPUT of
 * another command, so even a correctly quoted prompt is re-split by the
 * shell after substitution. A backslash desynchronizes any quote scan from
 * what the shell does (`{bin} '{prompt}' \{prompt}` emitted a second,
 * unquoted copy of the prompt), which is also why `binaryIsQuoteNeutral`
 * already refuses one in the launcher. `$'` opens bash and zsh ANSI-C
 * quoting, where backslashes ARE interpreted, so `escapeSingleQuoted`'s
 * `'\''` idiom is inert and prompt text breaks straight out; refusing it
 * costs nothing, since the escaper only ever produces plain single-quoted
 * output.
 *
 * None of them are needed to name a launcher, and false assurance is worse
 * than no check, so they are refused outright rather than modelled.
 */
const UNSAFE_TEMPLATE_CONSTRUCTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/"/, "a double quote"],
  [/`/, "a backtick"],
  [/\$\(/, "a '$(' command substitution"],
  [/\\/, "a backslash"],
  [/\$'/, 'a "$\'" ANSI-C quote'],
];

/**
 * A template is only safe if every `{prompt}` and `{path}` sits in a genuine
 * single-quoted context, because that is the quoting `escapeSingleQuoted`
 * produces. Checking only the adjacent characters is not enough: in
 * `sh -c "{bin} '{prompt}'"` the placeholder is flanked by single quotes,
 * but the enclosing word is double-quoted, where `'` is an ordinary
 * character and the escaping is inert. Templates come from the user's config
 * file, which is trusted to name a command but must not be able to turn
 * prompt text or a path into shell syntax, so anything this cannot prove
 * safe is refused.
 *
 * Returns the reason it could not be proven safe, or `undefined` when it is.
 * Presupposes the escaping it guards, so it belongs with
 * `substituteQuotedTemplate` and callers must run the two as a pair. Says
 * nothing about WHICH placeholders a template needs; that is the caller's
 * contract with its own config field.
 */
export function quotedTemplateProblem(template: string): string | undefined {
  for (const [pattern, name] of UNSAFE_TEMPLATE_CONSTRUCTS) {
    if (pattern.test(template)) return `it contains ${name}`;
  }
  const { balanced, placeholders } = scanQuotedPlaceholders(template);
  if (!balanced) return "its quotes are not balanced";
  const unquoted = placeholders.find((entry) => entry.state !== "single");
  if (unquoted !== undefined) {
    return `${unquoted.token} is not inside single quotes`;
  }
  return undefined;
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
    // Without `{prompt}` the prompt is silently dropped and the agent comes
    // up with nothing to answer, which looks like the spawn half-worked.
    if (!template.includes("{prompt}")) {
      return {
        ok: false,
        error:
          `Invalid 'agents.${agent.name}.promptCommand': must contain the {prompt} ` +
          `placeholder, otherwise the prompt would be dropped (e.g. "{bin} '{prompt}'").`,
      };
    }
    const problem = quotedTemplateProblem(template);
    if (problem !== undefined) {
      return {
        ok: false,
        error:
          `Invalid 'agents.${agent.name}.promptCommand': ${problem}. Every {prompt} ` +
          `placeholder must sit inside balanced single quotes, and the template may not ` +
          `contain double quotes, backticks, backslashes, '$(' or "$'" ` +
          `(e.g. "{bin} '{prompt}'").`,
      };
    }
    return {
      ok: true,
      value: substituteQuotedTemplate(template, { bin: binary, prompt }),
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
  /**
   * The SOURCE session's transcript file, substituted for `{path}`. Only
   * templates that use `{path}` need it, and it is validated here rather
   * than by the caller (see `resolveForkTranscript`), so no route can lose
   * the check.
   */
  logPath?: string | null;
}

/**
 * The transcript file a `{path}` fork will resume, or why `logPath` cannot
 * be handed to a resume flag.
 *
 * The point of resuming by path is that the agent opens the file instead of
 * deriving a directory, so a path that does not resolve to a readable
 * transcript produces the exact failure the path form exists to avoid: a
 * live pane that found no conversation, which nothing downstream can see.
 * Better to refuse before the pane exists.
 *
 * The `.jsonl` requirement is a shape guard, not a filesystem one:
 * `Session.logPath` is whatever the source recorded (for a background row it
 * is `state.json`'s scan path verbatim), so "a readable file" alone would
 * happily pass a value that is not a transcript at all.
 */
function resolveForkTranscript(
  logPath: string | null | undefined,
): BuildResult<string> {
  const refuse = (error: string): BuildResult<string> => ({ ok: false, error });
  if (!logPath) return refuse("ccmux has recorded no transcript path for it");
  if (!isAbsolute(logPath)) {
    return refuse(`its recorded transcript path is not absolute (${logPath})`);
  }
  if (!logPath.endsWith(".jsonl")) {
    return refuse(
      `its recorded transcript path is not a .jsonl transcript (${logPath})`,
    );
  }
  try {
    if (!statSync(logPath).isFile()) {
      return refuse(`its transcript path is not a file (${logPath})`);
    }
    accessSync(logPath, constants.R_OK);
  } catch {
    return refuse(`its transcript is missing or unreadable (${logPath})`);
  }
  return { ok: true, value: logPath };
}

/** Whether a fork template resumes by transcript path (see the builder). */
function templateUsesTranscriptPath(template: string): boolean {
  return template.includes("{path}");
}

/**
 * Whether this agent's fork template resumes by `{id}` alone, which makes the
 * fork REPO-SCOPED and its destination not free.
 *
 * `claude --resume <id>` resolves the id against project directories derived
 * from the launch cwd, falling back to every checkout `git worktree list`
 * reports: it finds the conversation from anywhere inside the source's repo
 * and nowhere outside it, where it prints "No conversation found" and drops to
 * a shell (a live pane no ccmux surface can tell from a working fork).
 * `{path}` skips that resolution entirely, so only the id form constrains
 * where a fork may land. The route asks before it creates anything; see
 * `buildAgentForkCommand` for the two forms.
 */
export function forkResumesByIdAlone(agent: AgentDef): boolean {
  const template = agent.forkCommand;
  if (typeof template !== "string" || template === "") return false;
  return !templateUsesTranscriptPath(template) && template.includes("{id}");
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
 * A template resumes by `{path}` (the source's transcript file) or by
 * `{id}` (the source's native session id), and the difference is not
 * cosmetic. `claude --resume <id>` resolves the id against project
 * directories derived from the launch cwd, falling back to every checkout
 * `git worktree list` reports, so it is REPO-scoped: it finds the
 * conversation from anywhere inside the repo and nowhere outside it.
 * `claude --resume <absolute path>` skips that resolution entirely and works
 * from any directory, which is why the built-in template uses it and why the
 * route no longer has to constrain the destination cwd.
 *
 * `{path}` is undocumented (absent from `claude --help`), verified on Claude
 * Code 2.1.218 through 2.1.220 in print and interactive mode, and not
 * publicly guaranteed. `{id}` therefore stays a first-class placeholder: if
 * a release breaks the path form, `agents.claude.forkCommand` can be set
 * back to the id form in ccmux.json without a ccmux change.
 *
 * `{id}` needs no quoting scan (`NATIVE_SESSION_ID_PATTERN` makes it inert
 * to the shell). `{path}` does, and gets exactly `{prompt}`'s treatment:
 * `quotedTemplateProblem` plus `substituteQuotedTemplate`.
 */
export function buildAgentForkCommand(
  input: AgentForkCommandInput,
): BuildResult<string> {
  const { agent, binary, sessionId, logPath } = input;
  const template = agent.forkCommand;

  // Empty string shares this branch, not the placeholder check below. It is
  // the config-file way to say "do not offer this" (the picker's gate reads
  // it as unforkable), so `ccmux spawn --fork`, which bypasses that gate,
  // has to give the same answer rather than complaining about a malformed
  // template the user never wrote.
  if (!template) {
    return {
      ok: false,
      error:
        `Agent '${agent.name}' does not support forking a session. ` +
        `Set 'agents.${agent.name}.forkCommand' in ccmux.json (e.g. "{bin} --resume {id} --fork-session") ` +
        `once you have verified that resuming a live session leaves it undisturbed. ` +
        // The daemon resolves its agent list once at boot while the picker
        // reads ccmux.json live, so a just-added forkCommand shows the menu
        // item and still lands here.
        `If you just added it, restart the daemon.`,
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
  // Naming neither the transcript nor the id starts a FRESH session: the pane
  // appears, the agent runs, and the history the user asked to branch is
  // silently absent. A refusal is far easier to act on than that.
  if (!templateUsesTranscriptPath(template) && !template.includes("{id}")) {
    return {
      ok: false,
      error:
        `Invalid 'agents.${agent.name}.forkCommand': must contain the {path} placeholder ` +
        `(the source's transcript file) or {id} (its native session id), otherwise the ` +
        `fork would start a fresh session instead of continuing this one.`,
    };
  }
  // Checked whether or not `{id}` is used: the id is what identifies the
  // source everywhere else, so a value this loose is a bug worth surfacing
  // even when it never reaches the shell.
  if (!NATIVE_SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, error: `Invalid session id: ${sessionId}` };
  }

  if (!templateUsesTranscriptPath(template)) {
    return {
      ok: true,
      value: substitutePlaceholders(template, { id: sessionId, bin: binary }),
    };
  }

  const transcript = resolveForkTranscript(logPath);
  if (!transcript.ok) {
    return {
      ok: false,
      error:
        `Cannot fork session ${sessionId}: ${transcript.error}. ` +
        `'agents.${agent.name}.forkCommand' resumes by transcript path, so the fork ` +
        `cannot be built without one. Install hooks with 'ccmux setup' so ccmux records ` +
        `the transcript, take a turn in the session, or set that template to the id form ` +
        `("{bin} --resume {id} --fork-session") to resume by session id instead.`,
    };
  }
  if (!binaryIsQuoteNeutral(binary)) {
    return {
      ok: false,
      error:
        `Cannot fork '${agent.name}': its launcher (${binary}) contains a quote, a ` +
        `backslash, or a command substitution, which would break the quoting around the ` +
        `transcript path.`,
    };
  }
  const problem = quotedTemplateProblem(template);
  if (problem !== undefined) {
    return {
      ok: false,
      error:
        `Invalid 'agents.${agent.name}.forkCommand': ${problem}. Every {path} ` +
        `placeholder must sit inside balanced single quotes, and the template may not ` +
        `contain double quotes, backticks, backslashes, '$(' or "$'" ` +
        `(e.g. "{bin} --resume '{path}' --fork-session").`,
    };
  }

  return {
    ok: true,
    value: substituteQuotedTemplate(template, {
      id: sessionId,
      bin: binary,
      path: transcript.value,
    }),
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

/** A request to spawn into a worktree rather than the given cwd. */
export interface WorktreeRequest {
  name?: string;
  base?: string;
}

/**
 * Validate and normalize the wire `worktree` field.
 *
 * Absent (or `null`/`false`) means the ordinary spawn into `cwd`. An object
 * opts in, with both members optional: no `name` derives one from the prompt,
 * no `base` branches from the main checkout's current branch.
 *
 * Deliberately one shape rather than also accepting `true`. The CLI's bare
 * `--worktree` sends `{}`, which says the same thing, and every extra
 * accepted spelling is another path that has to stay correct.
 */
export function normalizeWorktreeRequest(
  value: unknown,
): BuildResult<WorktreeRequest | undefined> {
  if (value === undefined || value === null || value === false) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error:
        "Invalid 'worktree' field: expected an object such as { name, base }",
    };
  }

  const raw = value as { name?: unknown; base?: unknown };
  const request: WorktreeRequest = {};
  for (const key of ["name", "base"] as const) {
    const member = raw[key];
    if (member === undefined || member === null || member === "") continue;
    if (typeof member !== "string") {
      return {
        ok: false,
        error: `Invalid 'worktree.${key}' field: expected a string`,
      };
    }
    request[key] = member;
  }
  return { ok: true, value: request };
}
