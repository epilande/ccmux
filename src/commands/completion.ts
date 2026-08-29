/**
 * Shell completions.
 *
 * `ccmux completion <shell>` prints a small wrapper script for zsh, bash, or
 * fish. Every Tab press inside that wrapper runs the hidden
 * `ccmux __complete <shell> -- <words...>`, which walks the live Commander
 * tree (so commands, flags, and choices can never drift from the CLI) and
 * asks the daemon for the dynamic values: session refs, pane ids, invocation
 * ids. The scripts know nothing about ccmux beyond how to call it.
 *
 * Wire format, one candidate per line: `value<TAB>description`. A line that
 * starts with `:` is a directive telling the shell to complete on its own
 * (`:dir`, `:file`), which is how `--cwd` and friends get path completion in
 * the user's directory rather than in ours (`bin/ccmux` cd's into the package
 * before running).
 *
 * The `__complete` path must stay silent and side-effect free: no daemon
 * autostart (it would print and spawn from a Tab press), no tmux, and every
 * lookup fails closed to "no candidates" within a short timeout.
 */

import { Argument, Command, type Option } from "commander";
import { getDaemonUrl } from "../lib/config";
import { getAgents } from "../lib/agents";
import { getPreferences } from "../lib/preferences";
import { VALID_ICON_STYLES } from "../lib/icons";
import { completableConfigKeys, configValueChoices } from "./config";

export const COMPLETION_SHELLS = ["zsh", "bash", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export interface Candidate {
  value: string;
  description?: string;
}

/** A hand-off to the shell's own completer. */
export type CompletionDirective = "dir" | "file";

export interface Completion {
  candidates: Candidate[];
  directive?: CompletionDirective;
}

/** The slice of a daemon session row the completer reads. */
export interface SessionRow {
  id: string;
  agentType: string;
  project: string;
  status: string;
  tmuxPane: string | null;
  nativeSessionId?: string | null;
}

export interface InvocationRow {
  id: string;
  status: string;
  agent?: string;
}

/** The fields `GET /invocations` returns that the completer reads. */
export interface DaemonInvocation {
  invocationId: string;
  status: string;
  agent?: string;
}

/** Map the daemon's `invocationId` onto the completer's `id`. */
export function invocationRowsFromDaemon(
  records: readonly DaemonInvocation[],
): InvocationRow[] {
  return records
    .filter((row) => row.invocationId)
    .map((row) => ({
      id: row.invocationId,
      status: row.status,
      agent: row.agent,
    }));
}

/** Every external lookup, injected so the walk itself is pure and testable. */
export interface CompletionDeps {
  sessions(): Promise<SessionRow[]>;
  invocations(): Promise<InvocationRow[]>;
  agentNames(): Promise<string[]>;
}

interface ValueContext {
  deps: CompletionDeps;
  /** Positional words already consumed by the command being completed. */
  positionals: string[];
  root: Command;
}

type ValueSource = (ctx: ValueContext) => Promise<Completion>;

const NONE: Completion = { candidates: [] };

function fixed(values: readonly string[]): ValueSource {
  return async () => ({ candidates: values.map((value) => ({ value })) });
}

function directive(kind: CompletionDirective): ValueSource {
  return async () => ({ candidates: [], directive: kind });
}

function describeSession(row: SessionRow): string {
  return [row.agentType, row.project, row.status].filter(Boolean).join(" ");
}

/**
 * What the session-ref resolver accepts and a shell can usefully offer: ids
 * and `%pane` ids (exact tiers), plus `self` where the command takes a full
 * ref. Agent types and project names are resolvable too but are fuzzy tiers
 * that refuse on ambiguity, so listing them would offer refs that fail.
 */
function sessionRefs(options: { self: boolean }): ValueSource {
  return async ({ deps }) => {
    const rows = await deps.sessions();
    const candidates: Candidate[] = [];
    for (const row of rows) {
      candidates.push({ value: row.id, description: describeSession(row) });
    }
    for (const row of rows) {
      if (row.tmuxPane) {
        candidates.push({
          value: row.tmuxPane,
          description: describeSession(row),
        });
      }
    }
    if (options.self) {
      candidates.push({ value: "self", description: "the calling pane" });
    }
    return { candidates };
  };
}

const nativeSessionIds: ValueSource = async ({ deps }) => ({
  candidates: (await deps.sessions())
    .filter((row) => row.nativeSessionId)
    .map((row) => ({
      value: row.nativeSessionId as string,
      description: describeSession(row),
    })),
});

/** ccmux ids, plus native ids when they differ. Not pane ids. */
const forkSessions: ValueSource = async ({ deps }) => {
  const rows = await deps.sessions();
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (value: string, row: SessionRow) => {
    if (seen.has(value)) return;
    seen.add(value);
    candidates.push({ value, description: describeSession(row) });
  };
  for (const row of rows) add(row.id, row);
  for (const row of rows) {
    if (row.nativeSessionId) add(row.nativeSessionId, row);
  }
  return { candidates };
};

const paneTargets: ValueSource = async ({ deps }) => ({
  candidates: [
    ...(await deps.sessions())
      .filter((row) => row.tmuxPane)
      .map((row) => ({
        value: row.tmuxPane as string,
        description: describeSession(row),
      })),
    { value: "none", description: "ignore the current pane" },
  ],
});

const agentNames: ValueSource = async ({ deps }) => ({
  candidates: (await deps.agentNames()).map((value) => ({ value })),
});

const invocationIds: ValueSource = async ({ deps }) => ({
  candidates: (await deps.invocations()).map((row) => ({
    value: row.id,
    description: [row.agent, row.status].filter(Boolean).join(" "),
  })),
});

const configKeys: ValueSource = async () => ({
  candidates: completableConfigKeys().map((value) => ({ value })),
});

const configValues: ValueSource = async ({ positionals }) => {
  const key = positionals[0];
  const choices = key ? configValueChoices(key) : null;
  return choices ? { candidates: choices.map((value) => ({ value })) } : NONE;
};

const rootCommands: ValueSource = async ({ root }) => ({
  candidates: subcommandCandidates(root),
});

/**
 * Dynamic values for positional arguments, keyed by `<command path> <arg
 * name>` and falling back to the bare argument name, so an argument called
 * `session-id` completes the same way on every command that has one.
 */
const ARGUMENT_SOURCES: Record<string, ValueSource> = {
  "session-id": sessionRefs({ self: false }),
  "session-ref": sessionRefs({ self: true }),
  from: sessionRefs({ self: true }),
  to: sessionRefs({ self: true }),
  agent: agentNames,
  key: configKeys,
  "config set value": configValues,
  "invoke cancel id": invocationIds,
  "invoke result id": invocationIds,
  // Commander's implicit `help [command]`.
  "help command": rootCommands,
  // `invoke [args...]`: the first word may name the agent.
  "invoke args": async (ctx) =>
    ctx.positionals.length === 0 ? agentNames(ctx) : NONE,
};

/** Dynamic values for option arguments, keyed the same way by long flag. */
const OPTION_SOURCES: Record<string, ValueSource> = {
  "--cwd": directive("dir"),
  "--repo": directive("dir"),
  "--socket": directive("file"),
  "--resume": nativeSessionIds,
  "--fork": forkSessions,
  "--session": nativeSessionIds,
  "--agent": agentNames,
  "--target": paneTargets,
  "--icons": fixed(VALID_ICON_STYLES),
  "--untracked": fixed(["move", "copy", "leave"]),
  "--split": fixed(["h", "v"]),
  "--position": fixed(["left", "right"]),
  "--format": fixed(["text"]),
};

function visibleCommands(cmd: Command): Command[] {
  return cmd.createHelp().visibleCommands(cmd);
}

function visibleOptions(cmd: Command): Option[] {
  return cmd.createHelp().visibleOptions(cmd);
}

function findCommand(cmd: Command, word: string): Command | undefined {
  return visibleCommands(cmd).find(
    (sub) => sub.name() === word || sub.aliases().includes(word),
  );
}

function findOption(cmd: Command, flag: string): Option | undefined {
  const local = cmd.options.find(
    (opt) => opt.long === flag || opt.short === flag,
  );
  if (local) return local;
  const fallback = defaultSubcommand(cmd);
  return fallback?.options.find(
    (opt) => opt.long === flag || opt.short === flag,
  );
}

/**
 * Commander records `isDefault` as `_defaultCommandName` on the parent.
 * `ccmux --icons` is valid because picker is the root default.
 */
function defaultSubcommand(cmd: Command): Command | undefined {
  const name = (cmd as unknown as { _defaultCommandName?: string })
    ._defaultCommandName;
  return name ? findCommand(cmd, name) : undefined;
}

function subcommandCandidates(cmd: Command): Candidate[] {
  return visibleCommands(cmd).map((sub) => ({
    value: sub.name(),
    description: sub.description(),
  }));
}

function optionCandidates(cmd: Command): Candidate[] {
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const source of [cmd, defaultSubcommand(cmd)]) {
    if (!source) continue;
    for (const opt of visibleOptions(source)) {
      const value = opt.long ?? opt.short ?? opt.flags;
      if (seen.has(value)) continue;
      seen.add(value);
      candidates.push({ value, description: opt.description });
    }
  }
  return candidates;
}

/** The argument a positional at `index` binds to; a trailing variadic absorbs the rest. */
function argumentAt(cmd: Command, index: number): Argument | undefined {
  const args = cmd.registeredArguments;
  const last = args[args.length - 1];
  if (index < args.length) return args[index];
  return last?.variadic ? last : undefined;
}

async function argumentValues(
  path: string,
  arg: Argument,
  ctx: ValueContext,
): Promise<Completion> {
  if (arg.argChoices) return fixed(arg.argChoices)(ctx);
  const source =
    ARGUMENT_SOURCES[`${path} ${arg.name()}`] ?? ARGUMENT_SOURCES[arg.name()];
  return source ? source(ctx) : NONE;
}

async function optionValues(
  path: string,
  opt: Option,
  ctx: ValueContext,
): Promise<Completion> {
  if (opt.argChoices) return fixed(opt.argChoices)(ctx);
  const flag = opt.long ?? opt.short ?? opt.flags;
  const source = OPTION_SOURCES[`${path} ${flag}`] ?? OPTION_SOURCES[flag];
  return source ? source(ctx) : NONE;
}

function filterPrefix(completion: Completion, prefix: string): Completion {
  return {
    ...completion,
    candidates: completion.candidates.filter((c) => c.value.startsWith(prefix)),
  };
}

/**
 * Complete the last of `words` (the word under the cursor, possibly empty)
 * given everything typed before it. `words` excludes the program name.
 *
 * The walk mirrors how Commander will parse the same line: the first operand
 * of a command with subcommands selects one, an option that takes a value
 * consumes the next word, and `--` ends option parsing. It stops at the
 * current word and asks what could legally stand there.
 */
export async function completeWords(
  root: Command,
  words: string[],
  deps: CompletionDeps,
): Promise<Completion> {
  const current = words[words.length - 1] ?? "";
  const previous = words.slice(0, -1);

  let cmd = root;
  // Tracked here rather than read off `cmd.parent`: Commander's implicit
  // `help` command is a detached placeholder with no parent.
  const path: string[] = [];
  let positionals: string[] = [];
  let pendingOption: Option | null = null;
  let optionsEnded = false;

  for (let i = 0; i < previous.length; i++) {
    const word = previous[i];
    if (pendingOption) {
      // The value of the option before it, whatever it looks like.
      pendingOption = null;
      continue;
    }
    if (!optionsEnded && word === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const opt = findOption(cmd, word);
      if (opt && (opt.required || opt.optional)) {
        const next = i + 1 < previous.length ? previous[i + 1] : current;
        // Commander lets an optional value be omitted when the next word
        // is another flag; a required one is consumed regardless.
        if (opt.required || !next.startsWith("-")) pendingOption = opt;
      }
      continue;
    }
    if (positionals.length === 0) {
      const sub = findCommand(cmd, word);
      if (sub) {
        cmd = sub;
        path.push(sub.name());
        continue;
      }
    }
    positionals.push(word);
  }

  const ctx: ValueContext = { deps, positionals, root };

  if (pendingOption) {
    return filterPrefix(
      await optionValues(path.join(" "), pendingOption, ctx),
      current,
    );
  }

  if (!optionsEnded && current.startsWith("-")) {
    return filterPrefix({ candidates: optionCandidates(cmd) }, current);
  }

  const candidates: Candidate[] = [];
  let completionDirective: CompletionDirective | undefined;
  if (positionals.length === 0) candidates.push(...subcommandCandidates(cmd));
  const arg = argumentAt(cmd, positionals.length);
  if (arg) {
    const values = await argumentValues(path.join(" "), arg, ctx);
    candidates.push(...values.candidates);
    completionDirective = values.directive;
  }
  return filterPrefix({ candidates, directive: completionDirective }, current);
}

function isSafeCandidateValue(value: string): boolean {
  return !value.startsWith(":") && !/[\n\r\t]/.test(value);
}

/** Serialize for the wrapper scripts; bash cannot show descriptions, so it gets bare values. */
export function renderCompletion(
  completion: Completion,
  shell: CompletionShell,
): string {
  const lines: string[] = [];
  if (completion.directive) lines.push(`:${completion.directive}`);
  for (const c of completion.candidates) {
    if (!isSafeCandidateValue(c.value)) continue;
    const description = c.description?.replace(/\s+/g, " ").trim();
    lines.push(
      shell !== "bash" && description ? `${c.value}\t${description}` : c.value,
    );
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

async function fetchDaemon<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${getDaemonUrl()}${path}`, {
      signal: AbortSignal.timeout(300),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** The real lookups: a short-timeout daemon read that never starts one. */
export const liveCompletionDeps: CompletionDeps = {
  async sessions() {
    const body = await fetchDaemon<{ sessions?: SessionRow[] }>("/sessions");
    return body?.sessions ?? [];
  },
  async invocations() {
    const body = await fetchDaemon<{ invocations?: DaemonInvocation[] }>(
      "/invocations",
    );
    return invocationRowsFromDaemon(body?.invocations ?? []);
  },
  async agentNames() {
    try {
      return getAgents(await getPreferences()).map((agent) => agent.name);
    } catch {
      return [];
    }
  },
};

const ZSH_SCRIPT = `#compdef ccmux

_ccmux() {
  local -a lines entries
  local line directive
  lines=("\${(@f)$(ccmux __complete zsh -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  for line in "\${lines[@]}"; do
    [[ -z "$line" ]] && continue
    if [[ "$line" == :* ]]; then
      directive="\${line#:}"
      continue
    fi
    if [[ "$line" == *$'\\t'* ]]; then
      entries+=("\${\${line%%$'\\t'*}//:/\\\\:}:\${line#*$'\\t'}")
    else
      entries+=("\${line//:/\\\\:}")
    fi
  done
  case "$directive" in
    dir) _files -/ && return ;;
    file) _files && return ;;
  esac
  (( \${#entries} )) && _describe -t ccmux 'ccmux' entries
}

if [ "$funcstack[1]" = "_ccmux" ]; then
  _ccmux "$@"
else
  compdef _ccmux ccmux
fi
`;

const BASH_SCRIPT = `_ccmux() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local directive="" line i
  local -a words=()
  # An explicit copy rather than "\${COMP_WORDS[@]:1:COMP_CWORD}": bash 3.2
  # (macOS) joins that quoted slice into one word.
  for ((i = 1; i <= COMP_CWORD; i++)); do
    words+=("\${COMP_WORDS[i]}")
  done
  local IFS=$'\\n'
  COMPREPLY=()
  set -f
  for line in $(ccmux __complete bash -- "\${words[@]}" 2>/dev/null); do
    case "$line" in
      :dir|:file) directive="\${line#:}" ;;
      *) COMPREPLY+=("$line") ;;
    esac
  done
  set +f
  case "$directive" in
    dir) COMPREPLY=($(compgen -d -- "$cur")); compopt -o filenames 2>/dev/null ;;
    file) COMPREPLY=($(compgen -f -- "$cur")); compopt -o filenames 2>/dev/null ;;
  esac
}

complete -F _ccmux ccmux
`;

const FISH_SCRIPT = `function __ccmux_complete
    set -l tokens (commandline -opc)
    set -l current (commandline -ct)
    for line in (ccmux __complete fish -- $tokens[2..] "$current" 2>/dev/null)
        switch "$line"
            case ':dir'
                __fish_complete_directories "$current"
            case ':file'
                __fish_complete_path "$current"
            case '*'
                printf '%s\\n' -- "$line"
        end
    end
end

complete -c ccmux -f -a '(__ccmux_complete)'
`;

const SCRIPTS: Record<CompletionShell, string> = {
  zsh: ZSH_SCRIPT,
  bash: BASH_SCRIPT,
  fish: FISH_SCRIPT,
};

export function completionScript(shell: CompletionShell): string {
  return SCRIPTS[shell];
}

export function createCompletionCommand(): Command {
  return new Command("completion")
    .description(
      "Print the shell completion script (see README for how to install it)",
    )
    .addArgument(
      new Argument("<shell>", "Shell to generate for").choices(
        COMPLETION_SHELLS,
      ),
    )
    .action((shell: CompletionShell) => {
      process.stdout.write(completionScript(shell));
    });
}

/**
 * The hidden endpoint the scripts call. Registered on the root with
 * `hidden: true` so it never shows in help or in its own candidates.
 */
export function createCompleteCommand(): Command {
  return new Command("__complete")
    .description("Print completion candidates for the completion scripts")
    .addArgument(
      new Argument("<shell>", "Shell asking").choices(COMPLETION_SHELLS),
    )
    .argument("[words...]", "The command line so far, current word last")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(
      async (
        shell: CompletionShell,
        words: string[],
        _options: unknown,
        command: Command,
      ) => {
        const root = command.parent;
        if (!root) return;
        const completion = await completeWords(root, words, liveCompletionDeps);
        process.stdout.write(renderCompletion(completion, shell));
      },
    );
}
