import { MARKERS_DIR } from "./config";
import type {
  AgentConfig,
  Preferences,
  TerminalRuleConfig,
} from "./preferences";
import type { AttentionType, SessionStatus } from "../types/session";

export interface TerminalRule {
  matchAny?: string[];
  matchAll?: string[];
  status: SessionStatus;
  attentionType: AttentionType;
  pendingTool: string | null;
}

export type ErrorKind = "rate_limit" | "agent_error";

export interface ErrorRule {
  match: RegExp;
  kind: ErrorKind;
  message?: string;
}

/**
 * Where the response text comes from when an agent runs in non-interactive
 * invoke mode.
 * - `stdout`: capture stdout verbatim (claude --print, cursor-agent --print, gemini -p)
 * - `tmpfile`: read from a per-invocation tmpfile referenced by the `{tmpfile}`
 *   placeholder in `args` (codex exec -o)
 * - `opencode-json`: parse stdout as JSONL events and concatenate every
 *   `type === "text"` part (opencode run --format json)
 */
type InvokeOutputSource =
  | { kind: "stdout" }
  | { kind: "tmpfile" }
  | { kind: "opencode-json" };

export interface InvokeMode {
  /**
   * argv for a fresh invocation. By default the prompt is piped via stdin
   * so it can carry newlines and shell metacharacters without quoting.
   * Placeholders: `{tmpfile}` is replaced with a per-invocation tmpfile
   * path (used when `output.kind === "tmpfile"`); `{prompt}` is replaced
   * with the prompt text and, when present, the prompt is passed as that
   * argument instead of being piped to stdin (for agents like gemini whose
   * headless mode reads the prompt from `-p`, not stdin). A `{prompt}` arg
   * is visible in `ps` and OS-bounded in size (rejected over
   * `MAX_ARGV_PROMPT_BYTES`).
   */
  args: string[];
  /**
   * argv for resuming a session by id. Placeholders: `{tmpfile}` as above,
   * and `{id}` for the session id. When undefined, `--session <id>` is
   * rejected for this agent.
   */
  resumeArgs?: string[];
  output: InvokeOutputSource;
}

export interface AgentDef {
  name: string;
  displayName?: string;
  shortCode: string;
  processMatch: RegExp;
  commandPatterns?: RegExp[];
  versionCommand?: string;
  versionPatterns?: RegExp[];
  terminalRules: TerminalRule[];
  errorRules?: ErrorRule[];
  resumeCommand?: string;
  /**
   * Shell command template that starts an INTERACTIVE session with an
   * initial prompt already submitted, used by `POST /spawn`. `{prompt}`
   * is the prompt text and must sit in a genuine single-quoted context:
   * the spawn builder parses the template's quoting the way `sh` does and
   * refuses anything it cannot prove safe, including single quotes nested
   * inside double quotes, where the escaping would be inert. `{bin}` is
   * the resolved launcher binary, so a `command` preference or an
   * `executable` override survives the template.
   *
   * Undefined means "this agent has no verified interactive-with-prompt
   * invocation", and prompt spawns are refused for it. There is no safe
   * default: `--prompt` is one-shot print mode for Copilot and does not
   * exist for pi, so guessing produces a session that silently does the
   * wrong thing. Per-agent findings live in `docs/agent-adapters.md`.
   */
  promptCommand?: string;
  /**
   * Shell command template that starts a session whose conversation
   * CONTINUES the given session's history while leaving that session
   * untouched, used by `POST /spawn`'s fork path. It must name the source
   * with `{path}` (its transcript file, single-quoted) or `{id}` (its native
   * session id); `{bin}` is the resolved launcher binary. All are substituted
   * in one pass (see `buildAgentForkCommand`, which explains why the built-in
   * prefers the path form and why the id form stays).
   *
   * Undefined means "forking this agent has not been verified", and fork is
   * refused for it — both at the route and in the picker's menu. There is no
   * safe default: resuming a session that is still live can contend over the
   * agent's own rollout/session state, so an agent earns this field only once
   * someone has checked its resume semantics against a LIVE original. Claude
   * Code's `--fork-session` writes a new transcript under a new id, which is
   * why it is the only built-in that defines one.
   */
  forkCommand?: string;
  /**
   * argv to stop a paneless background session (`trackingMode: "background"`)
   * given its daemon-short id. Only meaningful for agents with a background
   * mode whose worker pid is owned by a supervisor process, not by ccmux —
   * the daemon refuses to SIGTERM that pid directly and instead shells out to
   * this command. Agents without a background mode leave this undefined,
   * which keeps `handleKillSession` returning a 400 for their background rows
   * (moot in practice, since none currently produce them).
   */
  backgroundStopCommand?: (id: string) => string[];
  /**
   * Matches `backgroundStopCommand`'s stderr when it exited nonzero only
   * because the worker was already gone. Removal of a background row is
   * event-driven and therefore lags the stop by a beat, so a second `x` in
   * that window re-runs the command against a short the supervisor has
   * already dropped; without this the daemon would report a 500 for a stop
   * that in fact succeeded. Treated as success.
   */
  backgroundStopAlreadyGone?: RegExp;
  sessionFilePattern?: RegExp;
  /**
   * Binary to invoke when launching a fresh interactive session.
   * Defaults to `name` when unset; Cursor needs `cursor-agent` because
   * `cursor` on PATH is typically the IDE GUI launcher.
   */
  executable?: string;
  /**
   * Non-interactive command shape used by `ccmux invoke`. When absent, the
   * agent isn't invokable and the daemon returns `agent_error`. Distinct
   * from `executable`/`resumeCommand` (which describe the interactive
   * launcher) because most agents' interactive entry point produces UI
   * chrome we'd have to scrape; the non-interactive subcommand produces
   * clean text.
   */
  invokeMode?: InvokeMode;
  /**
   * Regex matched per-line against a stripped pane capture to detect
   * when the agent's interactive TUI is ready for `send-keys`. See the
   * inline comment on `BUILTIN_AGENTS.claude.readyPattern` for the glyph
   * history and override path.
   */
  readyPattern?: RegExp;
  hooks?: {
    markerDir?: string;
    type?: string;
  };
  /**
   * Named tmux keys (or literal characters) an actionable notification sends
   * to answer this agent's permission prompt, applied sequentially via
   * `sendKeyToPane`. `approve`/`deny` gate the Approve/Deny buttons on a
   * `permission` notification; without them it is click-jump only.
   *
   * `answerPrelude` keys are sent before the reply text on the `answer` action.
   * Claude's AskUserQuestion picker ignores typed text, so `["Escape"]` cancels
   * it back to the composer where the reply lands as a user message (see
   * `handleNotificationAction`).
   *
   * `replyOnQuestion` opts `question` waits into inline Reply. The capability
   * convention is the PAIR: `replyOnQuestion: true` AND a non-empty
   * `answerPrelude` (notifier and handler both gate on it — without a cancel
   * key the press could only 409, so the button is never offered). This is
   * def-presence, not agent-name: any agent whose def carries the pair gets
   * question Reply. `replyOnFinished`
   * opts `finished` (idle) waits into one. Idle Reply carries NO prelude: at
   * Claude's idle composer Escape clears a draft and double-Escape opens history
   * rewind, so a prelude there is harmful (see `resolveActionPlan`).
   *
   * `permissionReplyPrelude` opts a `permission` notification into Reply and
   * legalizes `answer` on a permission wait. This IS a deny: its keys cancel the
   * prompt (Claude: `Escape`), then the reply text arrives as the next user
   * message. Presence is the legality gate: without the cancel, text + Enter at
   * a numbered picker would select the highlighted (approve) option.
   *
   * `planApprove`/`planDeny`/`planReplyPrelude` are the ExitPlanMode analogues
   * of `approve`/`deny`/`permissionReplyPrelude`. ExitPlanMode renders a
   * different picker (separate approve key; see the Claude def for the auto-mode
   * footgun). `planApprove`/`planDeny` gate the buttons; `planReplyPrelude` gates
   * the plan Reply.
   *
   * `unsafeReplyPattern` matches reply text this agent's composer would
   * misparse as a command or mode trigger that the delivery path's
   * leading-space defuse does NOT neutralize. Most agents strip leading
   * whitespace before their trigger detection (e.g. Codex runs a `!`-leading
   * reply as a shell command with no approval, so `/^\s*!/`); Cursor's
   * slash-autocomplete additionally fuzzy-matches a `/token` ANYWHERE whose
   * tail matches a real command and swallows the submitting Enter, so its
   * pattern is positional (`/(^|\s)\/\S/`). A matching reply is refused
   * fail-closed at the accept path (409, text preserved via re-notify)
   * instead of typed into the pane.
   */
  notificationActions?: {
    approve?: string[];
    deny?: string[];
    answerPrelude?: string[];
    permissionReplyPrelude?: string[];
    planApprove?: string[];
    planDeny?: string[];
    planReplyPrelude?: string[];
    replyOnQuestion?: boolean;
    replyOnFinished?: boolean;
    unsafeReplyPattern?: RegExp;
  };
  /**
   * This agent's permission-prompt marker cannot be trusted to mean a real
   * permission wait: Claude fires the `Notification` hook for its
   * AskUserQuestion option picker with the EXACT same payload as a real
   * permission prompt (`{"notification_type":"permission_prompt"}`, verified on
   * Claude Code 2.1.209/2.1.210), and does NOT flush the picker's `tool_use` to
   * its JSONL during the wait. Only the pane distinguishes the two, so the
   * reconciler relabels a `permission` marker as a `question` when the terminal
   * source sees the picker (see `correctAmbiguousPermissionMarker`). Opt-in;
   * off for agents whose permission markers are unambiguous.
   */
  ambiguousPermissionMarker?: boolean;
  /**
   * This agent's HOOK MARKER, not its pane, is the authority on whether a
   * permission wait is still live — so a `permission` terminal-rule match
   * must not re-assert a wait the log has already moved past.
   *
   * Codex is the one agent that needs this. Its `PermissionRequest` hook
   * establishes the wait, but NO hook fires when the permission resolves, so
   * the marker stays `waiting_permission` until end of turn and the log
   * adapter is what infers the resolution (`function_call_output` flushes,
   * `applyResponseItem`). That leaves a window where the freshest truth is a
   * log-derived `working` while the marker still claims a wait — and the
   * terminal source is `upgradeOnly`, which `evaluateCascade` applies with NO
   * freshness comparison. Any leftover approval-widget text in the 50-line
   * pane capture (or a `terminalRuleCache` entry taken during the wait and
   * replayed after it) would then re-pin `waiting` every tick.
   *
   * Consumed by `dropsStalePermissionTerminalUpgrade` in the reconciler; see
   * that function for the exact predicate and why re-pinning is destructive
   * (retract + 60s renotify cooldown = the banner is gone for good). Off for
   * every other agent: Cursor's hooks have no permission event at all, so its
   * `terminalRules` ARE its only wait source, and dropping them would delete
   * permission detection outright.
   *
   * Deliberately NOT user-overridable (unlike `terminalRules` /
   * `ambiguousPermissionMarker`): it encodes a fact about an agent's hook
   * contract, not a tuning knob.
   */
  markerOwnsPermissionWait?: boolean;
}

function parseRegex(pattern: string, fieldName: string): RegExp {
  const trimmed = pattern.trim();
  const slashMatch = trimmed.match(/^\/(.+)\/([a-z]*)$/i);
  if (slashMatch) {
    try {
      return new RegExp(slashMatch[1], slashMatch[2]);
    } catch {
      throw new Error(`Invalid regex for ${fieldName}: ${pattern}`);
    }
  }

  try {
    return new RegExp(trimmed, "i");
  } catch {
    throw new Error(`Invalid regex for ${fieldName}: ${pattern}`);
  }
}

function normalizeTerminalRule(
  rule: TerminalRuleConfig,
  fieldName: string,
): TerminalRule {
  const hasMatchAny = rule.matchAny !== undefined;
  const hasMatchAll = rule.matchAll !== undefined;

  if (hasMatchAny === hasMatchAll) {
    throw new Error(
      `Invalid terminal rule for ${fieldName}: exactly one of matchAny or matchAll is required`,
    );
  }

  const patterns = hasMatchAny ? rule.matchAny : rule.matchAll;
  if (!patterns || patterns.length === 0) {
    throw new Error(
      `Invalid terminal rule for ${fieldName}: match patterns must not be empty`,
    );
  }

  const normalizedPatterns = patterns.map((pattern, idx) => {
    const trimmed = pattern.trim();
    if (!trimmed) {
      throw new Error(
        `Invalid terminal rule for ${fieldName}: pattern at index ${idx} must not be empty`,
      );
    }
    return trimmed;
  });

  if (
    rule.status !== "waiting" &&
    (rule.attentionType !== undefined ||
      (rule.pendingTool !== undefined && rule.pendingTool !== null))
  ) {
    throw new Error(
      `Invalid terminal rule for ${fieldName}: attentionType and pendingTool are only valid for waiting rules`,
    );
  }

  return {
    matchAny: hasMatchAny ? normalizedPatterns : undefined,
    matchAll: hasMatchAll ? normalizedPatterns : undefined,
    status: rule.status,
    attentionType:
      rule.status === "waiting" ? (rule.attentionType ?? null) : null,
    pendingTool: rule.status === "waiting" ? (rule.pendingTool ?? null) : null,
  };
}

function normalizeTerminalRules(
  rules: TerminalRuleConfig[] | undefined,
  fieldName: string,
): TerminalRule[] {
  return (rules ?? []).map((rule, idx) =>
    normalizeTerminalRule(rule, `${fieldName}[${idx}]`),
  );
}

function normalizeErrorRules(
  rules: NonNullable<AgentConfig["errorRules"]> | undefined,
  fieldName: string,
): ErrorRule[] {
  return (rules ?? []).map((rule, idx) => ({
    match: parseRegex(rule.match, `${fieldName}[${idx}].match`),
    kind: rule.kind,
    message: rule.message,
  }));
}

function mergeAgentConfig(base: AgentDef, override: AgentConfig): AgentDef {
  const merged: AgentDef = {
    ...base,
    terminalRules:
      override.terminalRules !== undefined
        ? normalizeTerminalRules(
            override.terminalRules,
            `agents.${base.name}.terminalRules`,
          )
        : base.terminalRules,
    errorRules:
      override.errorRules !== undefined
        ? normalizeErrorRules(
            override.errorRules,
            `agents.${base.name}.errorRules`,
          )
        : base.errorRules,
  };

  if (override.processMatch) {
    merged.processMatch = parseRegex(
      override.processMatch,
      `agents.${base.name}.processMatch`,
    );
  }
  if (override.commandPatterns !== undefined) {
    merged.commandPatterns = override.commandPatterns.map((pattern, idx) =>
      parseRegex(pattern, `agents.${base.name}.commandPatterns[${idx}]`),
    );
  }
  if (override.versionCommand !== undefined) {
    merged.versionCommand = override.versionCommand;
  }
  if (override.versionPatterns !== undefined) {
    merged.versionPatterns = override.versionPatterns.map((pattern, idx) =>
      parseRegex(pattern, `agents.${base.name}.versionPatterns[${idx}]`),
    );
  }
  if (override.resumeCommand !== undefined) {
    merged.resumeCommand = override.resumeCommand;
  }
  if (override.promptCommand !== undefined) {
    merged.promptCommand = override.promptCommand;
  }
  if (override.forkCommand !== undefined) {
    merged.forkCommand = override.forkCommand;
  }
  if (override.sessionFilePattern !== undefined) {
    merged.sessionFilePattern = parseRegex(
      override.sessionFilePattern,
      `agents.${base.name}.sessionFilePattern`,
    );
  }
  if (override.executable !== undefined) {
    merged.executable = override.executable;
  }
  if (override.invokeMode !== undefined) {
    merged.invokeMode = normalizeInvokeMode(
      override.invokeMode,
      `agents.${base.name}.invokeMode`,
    );
  }
  if (override.readyPattern !== undefined) {
    merged.readyPattern = parseRegex(
      override.readyPattern,
      `agents.${base.name}.readyPattern`,
    );
  }
  if (override.hooks !== undefined) {
    merged.hooks = {
      ...base.hooks,
      ...override.hooks,
    };
  }
  if (override.notificationActions !== undefined) {
    // Whole-object replace, not a per-key merge: a custom map is authored as a
    // complete set, and grafting builtin default keys onto it would apply
    // Claude's keystrokes to a different agent's prompt. The spread copies every
    // field, so a new key needs no line here and can't be silently dropped.
    // `unsafeReplyPattern` arrives as a regex STRING from config and must be
    // parsed (same contract as `readyPattern`).
    merged.notificationActions = parseNotificationActions(
      override.notificationActions,
      `agents.${base.name}.notificationActions`,
    );
    // Deliberate exception to the whole-object replace above: unsafeReplyPattern
    // is a safety default describing THIS builtin's composer, not a keystroke
    // default, so an override that omits it still needs it. Carry the base
    // guard forward unless the override explicitly re-specifies it, so a
    // partial override can't silently re-arm unapproved shell execution on the
    // `!`/`/`-executing agents. To intentionally disable the guard, an override
    // must set an explicit never-match pattern.
    if (
      merged.notificationActions.unsafeReplyPattern === undefined &&
      base.notificationActions?.unsafeReplyPattern !== undefined
    ) {
      merged.notificationActions.unsafeReplyPattern =
        base.notificationActions.unsafeReplyPattern;
    }
  }
  if (override.ambiguousPermissionMarker !== undefined) {
    merged.ambiguousPermissionMarker = override.ambiguousPermissionMarker;
  }

  return merged;
}

/**
 * Convert a config-file `notificationActions` map (where `unsafeReplyPattern`
 * is a regex STRING) into the runtime shape (compiled RegExp). Shared by the
 * builtin-override merge and the custom-agent construction so the parse can't
 * diverge between them.
 */
function parseNotificationActions(
  config: NonNullable<AgentConfig["notificationActions"]>,
  fieldName: string,
): NonNullable<AgentDef["notificationActions"]> {
  const { unsafeReplyPattern, ...rest } = config;
  const parsed: NonNullable<AgentDef["notificationActions"]> = { ...rest };
  if (unsafeReplyPattern !== undefined) {
    parsed.unsafeReplyPattern = parseRegex(
      unsafeReplyPattern,
      `${fieldName}.unsafeReplyPattern`,
    );
  }
  return parsed;
}

function normalizeInvokeMode(
  config: NonNullable<AgentConfig["invokeMode"]>,
  fieldName: string,
): InvokeMode {
  if (!Array.isArray(config.args) || config.args.length === 0) {
    throw new Error(
      `Invalid ${fieldName}: args must be a non-empty argv array`,
    );
  }
  const validOutputKinds: InvokeOutputSource["kind"][] = [
    "stdout",
    "tmpfile",
    "opencode-json",
  ];
  const outputKind = config.output?.kind;
  if (!outputKind || !validOutputKinds.includes(outputKind)) {
    throw new Error(
      `Invalid ${fieldName}.output.kind: must be one of ${validOutputKinds.join(", ")}`,
    );
  }
  if (
    outputKind === "tmpfile" &&
    !config.args.some((a) => a.includes("{tmpfile}"))
  ) {
    throw new Error(
      `Invalid ${fieldName}: output.kind="tmpfile" requires a {tmpfile} placeholder in args`,
    );
  }
  return {
    args: [...config.args],
    resumeArgs: config.resumeArgs ? [...config.resumeArgs] : undefined,
    output: { kind: outputKind } as InvokeOutputSource,
  };
}

/**
 * Codex rollout filenames embed the native session UUID. Exported so the
 * `CodexLogAdapter` can resolve session IDs from paths without duplicating
 * the regex literal. User-config overrides via `agents.codex.sessionFilePattern`
 * are applied to the agent definition only; the adapter always uses this
 * constant as the canonical source.
 */
export const CODEX_SESSION_FILE_PATTERN =
  /rollout-[^/]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * Copilot keeps `session-state/<uuid>/session.db` open (lsof-discoverable),
 * unlike its append-and-close `events.jsonl`. The daemon's `resolveNativeSessionId`
 * matches this against the open `.db` fd to recover the session UUID for a
 * pane-tracked Copilot session when hooks are not installed. Capture group 1
 * is the UUID. The log adapter uses its own events.jsonl pattern instead.
 */
export const COPILOT_SESSION_FILE_PATTERN =
  /session-state\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/session\.db$/i;

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: "claude",
    shortCode: "cc",
    processMatch: /\bclaude\b/i,
    versionCommand: "claude --version",
    // "claude [options] [command] [prompt]" — "starts an interactive session
    // by default, use -p/--print for non-interactive output" (claude --help).
    promptCommand: "{bin} '{prompt}'",
    // `--fork-session` resumes the transcript into a NEW session id rather
    // than appending to the source, so the original keeps its history and can
    // carry on being used. Verified against a live original, including one
    // mid-turn: the source writes to its own transcript and the fork only
    // reads it (`docs/agent-adapters.md#forking-a-session`).
    //
    // `{path}` (the transcript file), not `{id}`: an id is resolved against
    // project directories derived from the launch cwd plus every checkout
    // `git worktree list` reports, so it is repo-scoped, while an absolute
    // path skips resolution and resumes from any directory. That form is
    // undocumented (absent from `claude --help`), verified on Claude Code
    // 2.1.218 through 2.1.220, and not publicly guaranteed, so `{id}` remains
    // supported and this is revertable from ccmux.json alone.
    forkCommand: "{bin} --resume '{path}' --fork-session",
    sessionFilePattern:
      /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
    terminalRules: [
      {
        matchAny: ["requires approval", "permission rule"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: null,
      },
      {
        matchAll: ["type something.", "enter to select"],
        status: "waiting",
        attentionType: "question",
        pendingTool: null,
      },
      {
        matchAll: ["what would you like to work on", "enter to select"],
        status: "waiting",
        attentionType: "question",
        pendingTool: null,
      },
    ],
    // Match Claude's chrome-only error phrasing: a limit noun adjacent to
    // an "ended/done" verb. Avoids false positives from the assistant's own
    // prose discussion of rate limits.
    errorRules: [
      {
        match:
          /(?:rate|usage|message|hourly|daily|weekly|5-?hour)\s*limit\s+(?:was\s+)?(?:reached|exceeded|exhausted)/i,
        kind: "rate_limit",
      },
    ],
    // Claude intentionally has NO `invokeMode`: the daemon's Claude invoker
    // launches the binary interactively in a detached tmux session and
    // parses the resulting JSONL transcript. `claude --print` is its own
    // billing surface (pay-per-token API) and we want subscription-priced
    // interactive turns instead.
    //
    // Prompt-ready pattern: a line that contains ONLY a `>` or `❯` glyph
    // and whitespace. The glyph has changed across Claude versions (`> `
    // → `❯ `). Anchoring `$` at end-of-line is important — without it,
    // `❯ claude` (the shell about to launch claude) also matches, and
    // many popular shell themes (Starship, Pure) use `❯` as the prompt.
    // The transition check in `waitForClaudePromptReady` handles the
    // bare-shell-prompt collision separately. Users can override via
    // `agents.claude.readyPattern` in ccmux.json when Claude's glyph
    // changes again.
    readyPattern: /^[>❯]\s*$/,
    hooks: { markerDir: MARKERS_DIR, type: "claude" },
    // Stops a paneless `claude --bg` worker via Claude's own supervisor CLI.
    // The worker pid belongs to that supervisor, not ccmux, so a direct
    // SIGTERM would be unsafe; `claude stop <short>` asks the supervisor to
    // tear it down, and the row disappears once the supervisor drops the
    // short from `roster.json` (picked up by the Background Source's watcher).
    backgroundStopCommand: (id: string) => ["claude", "stop", id],
    // `claude stop <gone-short>` exits 1 with
    // "No job matching '<short>'. Run 'claude agents' to list running
    // sessions." Reported as success: the worker is stopped either way.
    backgroundStopAlreadyGone: /\bNo job matching\b/i,
    // Claude's numbered permission prompt: "1" quick-selects the first option
    // (approve) and submits immediately, so no trailing Enter is needed; Escape
    // cancels/denies. The lone-"1" choice is unverified against every prompt
    // variant — the notification-action e2e pass MUST confirm it approves (and
    // switch to ["1", "Enter"] if the prompt turns out to need submission).
    // `answerPrelude: ["Escape"]` cancels the AskUserQuestion picker before the
    // reply text (the picker ignores typed literals; Escape returns to the
    // composer where the reply sends as a user message).
    // Remaining rows verified on Claude Code 2.1.211 (full detail in
    // docs/agent-adapters.md, Claude caveats): every reply prelude is Escape,
    // cancelling the prompt/picker to a composer where text + Enter sends as a
    // user message; the idle (`replyOnFinished`) Reply intentionally has NO
    // prelude. At the ExitPlanMode picker option 1 is "Yes, and use auto mode",
    // option 2 is "manually approve edits", so `planApprove` MUST be ["2"],
    // never ["1"] (which silently enables auto mode); the digit submits with
    // no Enter.
    notificationActions: {
      approve: ["1"],
      deny: ["Escape"],
      answerPrelude: ["Escape"],
      permissionReplyPrelude: ["Escape"],
      planApprove: ["2"],
      planDeny: ["Escape"],
      planReplyPrelude: ["Escape"],
      replyOnQuestion: true,
      replyOnFinished: true,
    },
    // AskUserQuestion fires the same `permission_prompt` payload as a real
    // permission prompt, so its marker lands as `waiting_permission`; the pane
    // is the only disambiguator (see `ambiguousPermissionMarker` doc above).
    ambiguousPermissionMarker: true,
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    shortCode: "oc",
    processMatch: /\bopencode\b/i,
    versionCommand: "opencode --version",
    terminalRules: [
      {
        matchAny: ["allow once", "allow always", "reject", "[y/n]", "(y/n)"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Command",
      },
      {
        matchAny: [
          "esc interrupt",
          "esc again to interrupt",
          "ctrl+c to interrupt",
        ],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
    ],
    errorRules: [
      {
        match:
          /(?:rate|usage|message|hourly|daily|weekly)\s*limit\s+(?:was\s+)?(?:reached|exceeded|exhausted)/i,
        kind: "rate_limit",
      },
    ],
    // Prefer continuing in-pane without requiring session ID extraction.
    resumeCommand: "opencode --continue",
    // The lone flag-shaped case: opencode's default TUI command documents
    // "--prompt  prompt to use", and its positional is a PROJECT PATH, not a
    // prompt. (`opencode run` is the non-interactive one.)
    promptCommand: "{bin} --prompt '{prompt}'",
    // OpenCode's permission dialog is a horizontal option row
    // (`Allow once  Allow always  Reject`) navigated with Left/Right arrows;
    // Enter confirms the highlighted option. Verified e2e on OpenCode 1.18.3:
    // the dialog ALWAYS opens with "Allow once" (approve) highlighted, so a
    // bare Enter approves — Reject is never the initial highlight. Digits,
    // letters, Home/End, and Tab are all inert (only arrows move the
    // highlight), so there is no absolute selector; Deny navigates two steps
    // right to Reject, then Enter. Escape is NOT a clean reject — it interrupts
    // the whole turn and leaves the session hung in `working`, so it is not
    // used for Deny and no `permissionReplyPrelude` is offered (a reply would
    // have no safe cancel-to-composer key). No question detection exists for
    // OpenCode, so no `answerPrelude`/`replyOnQuestion`. Buttons are
    // additionally suppressed at delivery when this row aggregates >1
    // concurrently-waiting server-side session (`Session.ambiguousWait`; see
    // `aggregateOpenCodeMarkers`) — a keystroke lands on the shared pane's
    // currently-rendered dialog, which may not be the one the notification
    // described.
    //
    // `replyOnFinished` verified live on OpenCode 1.18.3 (issue #35): plain
    // text + Enter submits verbatim, and a leading space defuses `/`. But
    // OpenCode trims the leading space in front of `!` and enters SHELL MODE,
    // where Enter EXECUTES the text as a real shell command. Hence the
    // unsafeReplyPattern.
    notificationActions: {
      approve: ["Enter"],
      deny: ["Right", "Right", "Enter"],
      replyOnFinished: true,
      unsafeReplyPattern: /^\s*!/,
    },
    invokeMode: {
      // `--format json` emits one event per line; default output prints a
      // colored 2-line banner above the response that's annoying to strip
      // reliably. We aggregate every `type === "text"` part, which is the
      // model's textual response.
      args: ["opencode", "run", "--format", "json"],
      resumeArgs: ["opencode", "run", "--format", "json", "--session", "{id}"],
      output: { kind: "opencode-json" },
    },
  },
  {
    name: "codex",
    shortCode: "cx",
    processMatch: /\bcodex\b/i,
    versionCommand: "codex --version",
    // Pane strings below were re-captured live from a real Codex pane on
    // codex-cli 0.146.0 (2026-08-03) as well as the earlier 0.144.5 pass;
    // `strings` on the binary is NOT sufficient evidence (it lists widget
    // variants the TUI may never render for a given config). Capture setup:
    // sandbox CODEX_HOME, `approval_policy = "on-request"`,
    // `sandbox_mode = "workspace-write"`, no approvals reviewer, no hooks.
    //
    // 0.146.0 command approval, verbatim:
    //     Would you like to run the following command?
    //     Environment: local
    //     Reason: <model's reason>
    //     $ git ls-remote https://github.com/... HEAD
    //   › 1. Yes, proceed (y)
    //     2. Yes, and don't ask again for commands that start with `git ls-remote` (p)
    //     3. No, and tell Codex what to do differently (esc)
    //     Press enter to confirm or esc to cancel
    //
    // 0.146.0 edit approval, verbatim:
    //     Would you like to make the following edits?
    //   › 1. Yes, proceed (y)
    //     2. Yes, and don't ask again for these files (a)
    //     3. No, and tell Codex what to do differently (esc)
    //     Press enter to confirm or esc to cancel
    //
    // 0.146.0 working footer, verbatim:
    //     • Working (12s • esc to interrupt) · 1 background terminal running · …
    //
    // So "press enter to confirm or esc to cancel" and "esc to interrupt"
    // both SURVIVED into 0.146.0; what changed is that the widget now leads
    // with a "Would you like to …?" heading, and the binary also carries a
    // third heading, "Would you like to grant these permissions?", for the
    // newer permission-escalation flow (that one is binary-observed only —
    // it did not render under the capture config above, so it is listed but
    // not live-verified). The headings are matched because they are the one
    // part of the widget guaranteed present across all three variants, and
    // are specific enough not to collide with ordinary command output.
    terminalRules: [
      {
        matchAny: [
          // >= 0.146 approval widget headings (live-captured 2026-08-03,
          // except the "grant these permissions" variant — see above).
          "would you like to run the following command?",
          "would you like to make the following edits?",
          "would you like to grant these permissions?",
          // Present in BOTH the <= 0.144.x and >= 0.146 widgets.
          "press enter to confirm or esc to cancel",
          // Legacy (<= 0.144.x) shapes, kept for back-compat with older
          // Codex builds. `allow command?` is a whole phrase and safe;
          // `[y/n]` / `(y/n)` are loose two-character literals that appear
          // in ordinary tool output (help text, prompts echoed by scripts,
          // a README quoted into the pane) and WILL false-positive. They
          // are last on purpose: `matchTerminalRule` returns on first rule
          // match, not first literal, so ordering does not change semantics
          // here, but it keeps the reliable evidence at the top for anyone
          // reading or pruning this list. Remove them once pre-0.146 Codex
          // is no longer worth supporting.
          "allow command?",
          "[y/n]",
          "(y/n)",
        ],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Command",
      },
      {
        // "esc to interrupt" is the 0.146.0 footer verbatim (and the
        // <= 0.144.x one). It renders as literal text, not a styled key
        // glyph, so it survives the ANSI strip + lowercase in
        // `matchTerminalRule`. "ctrl+c to interrupt" is the legacy
        // (<= 0.144.x) variant, kept for back-compat.
        matchAny: ["esc to interrupt", "ctrl+c to interrupt"],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
    ],
    errorRules: [
      {
        match:
          /(?:rate|usage|message|hourly|daily|weekly)\s*limit\s+(?:was\s+)?(?:reached|exceeded|exhausted)/i,
        kind: "rate_limit",
      },
    ],
    resumeCommand: "codex resume {id}",
    // "codex [OPTIONS] [PROMPT]" — "[PROMPT] Optional user prompt to start the
    // session"; `codex exec` is the non-interactive subcommand.
    promptCommand: "{bin} '{prompt}'",
    sessionFilePattern: CODEX_SESSION_FILE_PATTERN,
    // The marker, not the pane, decides when a Codex permission wait ends:
    // no hook fires on resolution, so the log adapter infers it and the pane
    // must not re-assert the wait afterwards. See the field's doc on
    // `AgentDef` and `dropsStalePermissionTerminalUpgrade`.
    markerOwnsPermissionWait: true,
    // Codex's permission picker (verified e2e on codex-cli 0.144.5, and
    // re-verified on 0.146.0 — the option list and the enter/esc footer are
    // unchanged; 0.146 only adds the "Would you like to …?" heading above
    // them, see the `terminalRules` capture notes):
    //   › 1. Yes, proceed (y)
    //     2. Yes, and don't ask again for `<prefix>` (p)
    //     3. No, and tell Codex what to do differently (esc)
    //     Press enter to confirm or esc to cancel
    // Option 1 ("Yes, proceed") is initially highlighted, so `approve: ["Enter"]`
    // confirms it (curl ran, HTTP 200 observed). `deny: ["Escape"]` selects
    // option 3: it cancels the request ("✗ You canceled the request to run
    // <cmd>", the tool does NOT run) and returns Codex to its idle composer —
    // it interrupts the turn but does NOT kill the session, which is the desired
    // Deny. There is no `permissionReplyPrelude`/Reply: Escape here interrupts
    // the whole turn (not a cancel-to-composer that keeps the tool pending), and
    // Codex has no question wait. This map targets the enter/esc picker shape
    // (the authoritative path is the `PermissionRequest` hook marker, Codex
    // >= 0.122); the legacy `[y/n]` prompt in `terminalRules` is a pre-0.122
    // fallback that this Enter/Escape map does not claim to cover.
    //
    // `replyOnFinished` verified live on codex-cli 0.144.5 (issue #35): plain
    // text + Enter submits verbatim, and a leading space defuses `/`. But
    // Codex keys shell mode on the first NON-whitespace char, so a `!`-leading
    // reply RUNS as a shell command with no approval. Hence the
    // unsafeReplyPattern.
    notificationActions: {
      approve: ["Enter"],
      deny: ["Escape"],
      replyOnFinished: true,
      unsafeReplyPattern: /^\s*!/,
    },
    invokeMode: {
      // `codex exec` still prints a banner + session metadata + hook events
      // on stdout; `-o <tmpfile>` writes only the final agent message to a
      // file. We read the file to get the clean response. `--skip-git-repo-check`
      // is included unconditionally because invoke is dispatched against
      // arbitrary cwds (e.g., /tmp) and codex otherwise aborts.
      args: ["codex", "exec", "--skip-git-repo-check", "-o", "{tmpfile}"],
      resumeArgs: [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "-o",
        "{tmpfile}",
        "resume",
        "{id}",
      ],
      output: { kind: "tmpfile" },
    },
  },
  {
    name: "cursor",
    displayName: "Cursor",
    shortCode: "cu",
    // Matches the stock `cursor-agent` binary and the bare `agent` shim
    // cursor ships as an alias. findAgentForProcess anchors on argv[0]
    // basename, so the bare `agent` variant won't collide with arbitrary
    // shell commands that include the word "agent".
    processMatch: /^(cursor-agent|agent)$/i,
    versionCommand: "cursor-agent --version",
    // Cursor's approval overlays. "Run this command?" is the shell-exec
    // discriminator (verified empirically against cursor-agent
    // 2026.04.17-787b533); "Allow this web fetch?" is the web-fetch
    // discriminator (verified against cursor-agent 2026.05.20). The
    // daemon itself only pivots on attentionType, but the TUI's attention
    // label (SessionItem's getAttentionLabel) renders `pendingTool`
    // verbatim, so we split the rules to surface "Command" vs "WebFetch"
    // in the picker. Co-occurring strings like "Not in allowlist:" aren't
    // used because they disappear once the user allowlists the target.
    // The workspace-trust prompt ("Workspace Trust Required") is a
    // separate state and is out of scope for v1.
    terminalRules: [
      {
        matchAny: ["run this command?"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Command",
      },
      {
        matchAny: ["allow this web fetch?"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "WebFetch",
      },
      // Cursor's footer shows "ctrl+c to stop" only while a turn is in
      // flight. Verified against cursor-agent 2026.05.09. Without a
      // working rule, the reconciler always reports cursor as idle and
      // status transitions never fire, which makes ccmux invoke hang
      // until timeout on any non-permission turn.
      {
        matchAny: ["ctrl+c to stop"],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
    ],
    errorRules: [
      {
        match:
          /(?:rate|usage|message|hourly|daily|weekly)\s*limit\s+(?:was\s+)?(?:reached|exceeded|exhausted)/i,
        kind: "rate_limit",
      },
    ],
    // Cursor's approval overlay (verified e2e on cursor-agent
    // 2026.07.01-41b2de7):
    //   Run this command?
    //     → Run (once) (y)
    //       Add Shell(<cmd>) to allowlist? (tab)
    //       Run Everything (shift+tab)
    //       Skip (esc or n)
    // `approve: ["y"]` is the absolute "Run (once)" selector (curl ran, HTTP/2
    // 200 observed). It is deliberately NOT `["Enter"]`: the overlay is a
    // navigable list where Enter selects the highlight, and Deny cannot rely on
    // the highlight position.
    //
    // Deny is the hard case. Both `esc` and `n` open a "Reason for rejection
    // (Enter to submit, Esc to cancel)" TEXT sub-dialog (a 2026.04.17+ change) —
    // there is NO single-key skip. The obvious `["Escape", "Enter"]` is UNSAFE:
    // the notification keys path fires keys only KEY_SEQUENCE_GAP_MS apart with
    // no settle/recheck, and an Escape immediately followed by Enter can be read
    // as one Alt+Enter (or the sub-dialog hasn't opened yet), so the Enter
    // lands on the still-live overlay and selects the highlighted "Run (once)" —
    // reproduced: a deny press SILENTLY APPROVED and ran curl. So Deny is
    // `["C-c"]`: Ctrl+C interrupts the turn (the command does NOT run — verified
    // 3/3 with cleared scrollback) and STRUCTURALLY cannot select "Run (once)",
    // so it can never mis-approve. Cursor's Auto-review may re-request approval
    // afterward (a fresh permission the user can deny again); that retry is
    // Cursor behavior, not the keystroke. No `permissionReplyPrelude`/Reply: the
    // reject-reason sub-dialog can't be driven safely from the prelude path
    // (same ESC-coalescing footgun), and Cursor has no question wait. The
    // workspace-trust prompt ("Workspace Trust Required") is out of scope: it
    // has no `terminalRules` entry, so it never becomes a `permission` wait and
    // needs no extra gating.
    //
    // `replyOnFinished` verified live on cursor-agent 2026.07.16-899851b
    // (issue #35): plain text + Enter submits verbatim, and `!` is NOT a
    // Cursor composer trigger. But Cursor's slash autocomplete is POSITIONAL,
    // not just leading: any leading or whitespace-preceded `/token` (a
    // defusing space in front included) opens a fuzzy popup, and when its
    // query matches a real command the popup SWALLOWS the submitting Enter
    // and executes the highlighted command instead. Path slashes
    // (`src/main.ts`) and matchless queries submit fine. An Escape-then-Enter
    // dismissal was rejected for the same ESC-coalescing footgun as Deny
    // above, so the unsafeReplyPattern blocks any leading or
    // whitespace-preceded `/` token instead.
    notificationActions: {
      approve: ["y"],
      deny: ["C-c"],
      replyOnFinished: true,
      unsafeReplyPattern: /(^|\s)\/\S/,
    },
    // `--resume <chatId>` restores the chat transcript only when invoked
    // from the original workspace; cursor scopes chats per workspace_roots.
    // ccmux resumes inside the pane's shell which preserves cwd, so this
    // is fine in practice.
    resumeCommand: "cursor-agent --resume {id}",
    // "agent [options] [command] [prompt...]" — "prompt  Initial prompt for
    // the agent"; -p/--print is the non-interactive mode.
    promptCommand: "{bin} '{prompt}'",
    // `cursor` on PATH is the IDE GUI launcher (Cursor.app/.../bin/code);
    // the CLI agent ships as `cursor-agent`.
    executable: "cursor-agent",
    invokeMode: {
      args: ["cursor-agent", "--print"],
      resumeArgs: ["cursor-agent", "--print", "--resume", "{id}"],
      output: { kind: "stdout" },
    },
    hooks: { markerDir: MARKERS_DIR, type: "cursor" },
  },
  {
    name: "antigravity",
    displayName: "Antigravity",
    shortCode: "ag",
    processMatch: /^agy$/i,
    // Path form only (like gemini): the argv[0] basename match above covers
    // bare `agy ...`, and a bare-word pattern would false-positive on `agy`
    // appearing as an argument. Must not match the desktop IDE launcher
    // (.../Antigravity.app/Contents/Resources/app/bin/antigravity).
    commandPatterns: [/\/agy(?:\s|$)/i],
    versionCommand: "agy --version",
    terminalRules: [
      {
        matchAny: ["requesting permission for:", "do you want to proceed?"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Command",
      },
      {
        // The footer is present only while a turn is active. Captions can
        // also occur in transcript text, so they are not detection keys.
        matchAny: ["esc to cancel"],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
    ],
    errorRules: [
      {
        match:
          /(?:rate|usage|message|hourly|daily|weekly)\s*limit\s+(?:was\s+)?(?:reached|exceeded|exhausted)/i,
        kind: "rate_limit",
      },
      {
        match:
          /Authentication required\. Please visit the URL to log in|Error: authentication failed or timed out/i,
        kind: "agent_error",
      },
    ],
    // Antigravity's permission list (verified e2e on agy 1.1.1):
    //   Requesting permission for: <cmd>
    //   Do you want to proceed?
    //   > 1. Yes
    //     2./3. "Yes, and always allow ..." variants
    //     4. No   (sometimes followed by 5./6. "No, and always deny ...")
    // Digits are absolute select-and-submit: "1" alone approved and ran the
    // gated curl. Deny is deliberately NOT ["4"] even though it verified
    // ("User declined the tool call"): the option list is DYNAMIC — the same
    // prompt rendered 4 options on one wait and 6 on the next — so a deny
    // digit can land on a different row and must not be trusted. Escape uses
    // the constant "esc to cancel" affordance: the tool does NOT run and the
    // turn interrupts to the composer ("Interrupted · What should Antigravity
    // CLI do instead?"), which structurally cannot approve. No waiting-state
    // Reply keys: there is no question wait, and Escape interrupts the turn
    // rather than cancelling to a composer with the tool still pending.
    //
    // `replyOnFinished` verified live on agy 1.1.4 (issue #35): plain text +
    // Enter submits verbatim. But Antigravity TRIMS leading whitespace on
    // submit and re-parses the prefixes, so the space defuse neutralizes
    // NEITHER: ` /help ...` executed /help and DISCARDED the trailing text,
    // and ` !...` entered shell mode. Hence the `[/!]`-leading
    // unsafeReplyPattern.
    notificationActions: {
      approve: ["1"],
      deny: ["Escape"],
      replyOnFinished: true,
      unsafeReplyPattern: /^\s*[/!]/,
    },
    resumeCommand: "agy --conversation {id}",
    // agy's `--prompt` is documented as "Alias for --print" (one-shot), so the
    // interactive form is the separate "-i / --prompt-interactive  Run an
    // initial prompt interactively and continue the session".
    promptCommand: "{bin} -i '{prompt}'",
    executable: "agy",
    invokeMode: {
      args: ["agy", "-p", "{prompt}"],
      output: { kind: "stdout" },
    },
    // The idle footer line also carries the model name right-aligned
    // ("? for shortcuts        Gemini 3.5 Flash (Medium)"), so no end anchor.
    readyPattern: /^\? for shortcuts\b/i,
    hooks: { markerDir: MARKERS_DIR, type: "antigravity" },
  },
  {
    name: "gemini",
    shortCode: "gm",
    processMatch: /\bgemini\b/i,
    versionCommand: "gemini --version",
    // gemini's `-p/--prompt` is headless mode. The positional query is
    // interactive "by default", but "-i, --prompt-interactive  Execute the
    // provided prompt and continue in interactive mode" says so explicitly and
    // cannot be flipped by a future default change.
    promptCommand: "{bin} -i '{prompt}'",
    commandPatterns: [
      /(?:^|\s)(?:npx|npm\s+exec)\s+@google\/gemini-cli(?:\s|$)/i,
      /\/\.bin\/gemini(?:\s|$)/i,
      /\/gemini(?:\s|$)/i,
    ],
    terminalRules: [
      {
        matchAny: [
          "yes, allow once",
          "allow once",
          "allow for this session",
          "[y/n]",
        ],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Command",
      },
      {
        matchAny: ["esc to interrupt", "esc to cancel"],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
    ],
    // Gemini's permission picker (verified e2e on gemini-cli 0.29.5):
    //   ● 1. Allow once
    //     2. Allow for this session
    //     3. No, suggest changes (esc)
    // Digits are absolute select-and-submit: "1" alone approved and ran the
    // gated curl (no trailing Enter), independent of the highlight. Escape is
    // option 3: "Request cancelled", the tool does NOT run, and the turn ends
    // back at the composer. Both actions are single keys, so the no-settle
    // keys path has no coalescing surface. No waiting-state Reply keys: Gemini
    // has no question wait and no verified cancel-to-composer prelude from the
    // picker. Detection is terminal-rules-only (no hooks adapter), so these
    // presses ride the pane-tracked staleness tokens alone.
    //
    // `replyOnFinished` verified live on gemini-cli 0.29.5 (issue #35): plain
    // text + Enter submits verbatim. But Gemini TRIMS leading whitespace
    // before its trigger detection, so the space defuse neutralizes NEITHER
    // prefix: ` /help ...` executed the /help panel on Enter, and ` !...`
    // flipped shell mode pre-Enter. Hence the `[/!]`-leading
    // unsafeReplyPattern.
    notificationActions: {
      approve: ["1"],
      deny: ["Escape"],
      replyOnFinished: true,
      unsafeReplyPattern: /^\s*[/!]/,
    },
    invokeMode: {
      // gemini reads its prompt from the `-p` argument. `{prompt}` is
      // substituted with the prompt text and, because the arg carries it,
      // the prompt is NOT piped to stdin. gemini >= ~0.29 stopped reading
      // stdin when `-p` is empty, so the old empty-`-p`-plus-piped-stdin
      // form hung headlessly. `--resume` takes an index, not a session id,
      // so we do not expose resumeArgs (sessionId is rejected at the daemon).
      args: ["gemini", "-p", "{prompt}"],
      output: { kind: "stdout" },
    },
  },
  {
    name: "omp",
    displayName: "omp",
    shortCode: "om",
    // MUST stay immediately BEFORE the `pi` entry: `findAgentForProcess` is
    // first-match-wins over this array, and pi's `commandPatterns` regex also
    // matches omp's resolved launcher path (the fork kept the npm package name
    // `@oh-my-pi/pi-coding-agent`), so pi-first would label omp sessions Pi.
    //
    // Detection cannot rely on `process.title` (omp sets it, but its Bun bin
    // shim never propagates it to `ps`). `processMatch` and the `bin/omp`
    // pattern below cover two different launch shapes and both are required;
    // dropping either makes the pid invisible to detection, and
    // `cleanupStaleMarkers` then reaps the extension's valid marker. Full
    // evidence in docs/agent-adapters.md#omp-specific-caveats.
    processMatch: /^omp$/i,
    commandPatterns: [
      // Bun-shim launches, where `ps` shows only the shim symlink path. The
      // trailing `(?:\s|$)` keeps `/bin/ompx` out, and the required `/bin/`
      // component keeps a bare word `omp` in someone's prompt from matching.
      /[/\\]bin[/\\]omp(?:\s|$)/i,
      // Direct `dist/cli.js` launches, scoped to the `oh-my-pi` dir so it
      // can't also claim upstream pi's launcher path.
      /oh-my-pi[/\\]pi-coding-agent[/\\]dist[/\\]cli\.js/i,
    ],
    versionCommand: "omp --version",
    // No-hooks fallback; the extension marker is the authoritative source via
    // the cascade when `ccmux setup --agent omp` has run. Waiting stays FIRST
    // (`matchTerminalRule` returns the first match): the working label is
    // model-supplied and unpredictable, so waiting-first keeps any overlap
    // from masking a real permission wait.
    terminalRules: [
      {
        // Body of omp's approval prompt (`Allow tool: <name>`, rendered above
        // an Approve/Deny select). `pendingTool` is null because terminal
        // rules match fixed substrings; the marker path fills in the real
        // name.
        matchAny: ["allow tool:"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: null,
      },
      {
        // `Working…` (real U+2026, unlike pi's ASCII `Working...`) is only
        // omp's default loader label. Once the model streams an intent, the
        // label becomes that intent text (e.g. `⠧ Run touch command ⟦esc⟧`),
        // so this rule only covers the pre-intent window; the marker carries
        // `working` the rest of the time. There is no `Thinking…` label. Same
        // caveat as pi: do NOT key on "interrupt".
        matchAny: ["working…"],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
    ],
    errorRules: [
      {
        match:
          /(?:rate|usage|message|hourly|daily|weekly)\s*limit\s+(?:was\s+)?(?:reached|exceeded|exhausted)/i,
        kind: "rate_limit",
      },
    ],
    // Approvals are where omp diverges from Pi. Its Approve/Deny select opens
    // on index 0, so `Enter` approves; there are no digit shortcuts, because
    // printable keys feed the selector's fuzzy search. `Escape` is the Deny
    // itself (fail-closed, the gated tool does not run), not a
    // cancel-to-composer, which is why no `permissionReplyPrelude` is set.
    // `unsafeReplyPattern` must stay and must keep covering `/` as well as
    // `!`: omp's composer trims the submitted text before both its `!`
    // bash-mode check and its slash-command dispatch, so the leading-space
    // defuse neutralizes neither trigger (live-verified: a defused ` /new`
    // still destroyed the session).
    notificationActions: {
      approve: ["Enter"],
      deny: ["Escape"],
      replyOnFinished: true,
      unsafeReplyPattern: /^\s*[/!]/,
    },
    // `omp -c` continues the most recent session in-pane (no session-id
    // extraction needed), same shape as `pi -c`.
    resumeCommand: "omp -c",
    // `omp --help` EXAMPLES spells both out: "# Interactive mode with initial
    // prompt / omp \"List all .ts files in src/\"" vs "# Non-interactive mode
    // (process and exit) / omp -p \"...\"".
    promptCommand: "{bin} '{prompt}'",
    // omp writes its JSONL transcript to
    // ~/.omp/agent/sessions/<encoded-cwd>/<ts>_<uuidv7>.jsonl, the same
    // filename shape as pi's, so the pattern is reused verbatim. ccmux does
    // not parse the transcript in v1; the pattern is recorded for when a
    // log-tail adapter lands.
    sessionFilePattern:
      /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
    invokeMode: {
      // omp reads the prompt from `-p` and prints the final assistant text
      // to stdout, then exits 0 (print mode). `{prompt}` rides in argv like
      // gemini and pi. Resume in print mode is unverified, so we do not
      // expose resumeArgs (sessionId is rejected at the daemon).
      args: ["omp", "-p", "{prompt}"],
      output: { kind: "stdout" },
    },
    hooks: { markerDir: MARKERS_DIR, type: "omp" },
  },
  {
    name: "pi",
    displayName: "Pi",
    shortCode: "pi",
    // pi sets `process.title = "pi"` at the top of its
    // CLI entrypoint, so `ps` reports both comm and command as exactly
    // `pi` (verified on macOS: `node .../pi-coding-agent/dist/cli.js`
    // rewrites to `pi`). `findAgentForProcess` matches against the argv[0]
    // basename, so `/^pi$/i` anchors exactly and avoids collisions a bare
    // `\bpi\b` would invite for such a short token (e.g. `pi.py`).
    processMatch: /^pi$/i,
    // Fallback for the sub-millisecond window before `process.title` is
    // set, and for any platform where title rewriting doesn't reach `ps`:
    // match the resolved launcher path.
    commandPatterns: [/pi-coding-agent[/\\]dist[/\\]cli\.js/i],
    versionCommand: "pi --version",
    // pi has no native tool-approval pause (it executes tools immediately),
    // so there is no reliable `waiting` string to match. Its idle footer
    // also contains the word "interrupt", so unlike codex/gemini we must
    // NOT key `working` on "interrupt". The streaming-only footer message
    // is the literal `Working...` (and `Thinking...` while thinking blocks
    // are hidden); both are pi's `defaultWorkingMessage`/`hiddenThinkingLabel`.
    // When the hooks extension is installed, the marker is the authoritative
    // working/idle source via the cascade; these rules are the no-hooks
    // fallback.
    terminalRules: [
      {
        matchAny: ["working...", "thinking..."],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
    ],
    errorRules: [
      {
        match:
          /(?:rate|usage|message|hourly|daily|weekly)\s*limit\s+(?:was\s+)?(?:reached|exceeded|exhausted)/i,
        kind: "rate_limit",
      },
    ],
    // No Approve/Deny keys ON PURPOSE (issue #26 decision, re-verified live
    // on pi 0.79.9: a bash curl ran in 0.1s with no prompt of any kind). pi
    // has no tool-approval pause — tools execute immediately — so a
    // `permission` wait can never exist and there is nothing for Approve/Deny
    // to drive. pi DOES ship an `ask_question` tool that can pause a session
    // on a model-initiated question, but ccmux has no pi waiting detection
    // (the extension marker only writes working/idle and the terminal rules
    // above only detect working), so no waiting notification ever fires and
    // no waiting-state Reply can attach. Revisit the Approve/Deny half only
    // if a pi release adds an approval gate (a user-installed
    // tool_call-gating extension is out of scope).
    //
    // `replyOnFinished` verified live on pi 0.79.9 (issue #35, the deferred
    // "decide during implementation" case): the extension marker tracks idle
    // correctly, plain text + Enter submits verbatim, and a leading space
    // defuses `/`. But pi strips leading whitespace before its `!`
    // bash-trigger detection and EXECUTES the text as a shell command with no
    // LLM turn. Hence the `!`-leading unsafeReplyPattern.
    notificationActions: {
      replyOnFinished: true,
      unsafeReplyPattern: /^\s*!/,
    },
    // `pi -c` continues the most recent session in-pane (no session-id
    // extraction needed, like opencode --continue).
    resumeCommand: "pi -c",
    // `pi --help` EXAMPLES spells both out: "# Interactive mode with initial
    // prompt / pi \"List all .ts files in src/\"" vs "# Non-interactive mode
    // (process and exit) / pi -p \"...\"". pi has NO --prompt flag at all.
    promptCommand: "{bin} '{prompt}'",
    // pi writes its JSONL transcript to
    // ~/.pi/agent/sessions/--<encoded-cwd>--/<ts>_<uuidv7>.jsonl. ccmux does
    // not parse it in v1 (pi closes the file after each append, so the lsof
    // discovery path never fires — same constraint as Claude); the pattern
    // is recorded for when a log-tail adapter lands.
    sessionFilePattern:
      /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
    invokeMode: {
      // pi reads the prompt from `-p` and prints the final assistant text
      // to stdout, then exits 0 (print mode). `{prompt}` rides in argv like
      // gemini. `--session <id>` resume in print mode is unverified, so we
      // do not expose resumeArgs (sessionId is rejected at the daemon).
      args: ["pi", "-p", "{prompt}"],
      output: { kind: "stdout" },
    },
    hooks: { markerDir: MARKERS_DIR, type: "pi" },
  },
  {
    name: "copilot",
    displayName: "Copilot",
    shortCode: "cp",
    // The real Copilot CLI is a native binary whose argv[0] basename is
    // `copilot` (e.g. .../@github/copilot-darwin-arm64/copilot). Anchored on
    // the basename so the legacy `gh copilot` extension (argv[0] `gh`, or the
    // `gh-copilot` shim) is NOT treated as this agent.
    processMatch: /^copilot$/i,
    // Deliberately NO commandPatterns: every wrapper form (`node .../bin/copilot`
    // from npm/mise shims, `npx @github/copilot`) SPAWNS the real binary as a
    // child that processMatch already catches, and both processes share the
    // pane's tty. Matching the wrapper too double-detects the pane, and the
    // per-scan pane-session upsert then flip-flops `pid` between wrapper and
    // binary, tripping the pane-reuse identity reset every cycle (clearing
    // nativeSessionId/logPath/lastPrompt as fast as enrichment writes them).
    // `copilot --version` prints `GitHub Copilot CLI 1.0.71.`; the default
    // version patterns extract `1.0.71` from that first line.
    versionCommand: "copilot --version",
    terminalRules: [
      {
        matchAny: ["do you want to run this command?"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Command",
      },
      {
        // URL-access approval ("Copilot is attempting to access the following
        // URL: ... Do you want to allow this access?"). Copilot raises this
        // BEFORE the shell dialog when a command touches the network, so a
        // URL-only wait is a real permission pause the pane path must see.
        // "Url" matches `permissionToolLabel("url")` on the log path.
        matchAny: ["do you want to allow this access?"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Url",
      },
      {
        // Folder-trust prompt shown on first launch in an untrusted dir.
        matchAny: ["do you trust the files in this folder?"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: null,
      },
      {
        // Copilot's working footer: "● Working · 162 B  esc interrupt".
        // Present only while a turn is in flight.
        matchAny: ["esc interrupt"],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
    ],
    errorRules: [
      {
        match:
          /(?:rate|usage|message|hourly|daily|weekly)\s*limit\s+(?:was\s+)?(?:reached|exceeded|exhausted)/i,
        kind: "rate_limit",
      },
    ],
    // Copilot's permission dialogs (verified e2e on Copilot CLI 1.0.71):
    //   Do you want to run this command?     → 1. Yes / 2. Yes, and don't ask
    //     again for `<cmd>` in this directory / 3. No, ... (Esc to stop)
    //   Do you want to allow this access?    → 1. Yes / 2.-3. "Yes, and
    //     approve all URLs from ..." variants / 4. No, ... (Esc to stop)
    //   Do you trust the files in this folder? → 1. Yes / 2. Yes, and
    //     remember / 3. No (Esc)
    // Digits are absolute select-and-submit: "1" alone approved and ran the
    // gated curl (no trailing Enter). Option "1. Yes" is position-stable
    // across all three dialogs, but the deny row is NOT (3 on shell/trust,
    // 4 on URL access), so deny must not be a digit. Escape uses the constant
    // "esc to cancel" affordance: verified the tool did NOT run ("✗ Shell ...
    // The user rejected this tool call") and the turn ended at the composer,
    // so it structurally cannot approve. A single tool call can chain two
    // dialogs (URL access, then shell); each is its own wait/notification and
    // one press answers exactly one dialog. No waiting-state Reply keys: no
    // question wait, and Escape ends the turn rather than cancelling to a
    // composer with the tool still pending.
    //
    // `replyOnFinished` verified live on Copilot CLI 1.0.71 (issue #35):
    // plain text + Enter submits verbatim. But Copilot TRIMS a leading space
    // on submit and re-parses the prefixes, so the space defuse neutralizes
    // NEITHER: ` /help ...` opened the help overlay, and ` !echo ...`
    // EXECUTED as a shell command with no permission prompt (Auto mode).
    // Hence the `[/!]`-leading unsafeReplyPattern.
    notificationActions: {
      approve: ["1"],
      deny: ["Escape"],
      replyOnFinished: true,
      unsafeReplyPattern: /^\s*[/!]/,
    },
    resumeCommand: "copilot --resume {id}",
    // "-i, --interactive <prompt>  Start interactive mode and automatically
    // execute this prompt". Copilot's `-p/--prompt` is explicitly the
    // non-interactive scripting mode.
    promptCommand: "{bin} -i '{prompt}'",
    // Copilot holds `session-state/<uuid>/session.db` open (lsof-discoverable),
    // so the no-hooks path can recover the native session id from it.
    sessionFilePattern: COPILOT_SESSION_FILE_PATTERN,
    invokeMode: {
      // `-p` is non-interactive print mode; `--allow-all-tools` lets the turn
      // run tools without pausing for approval (invoke has no interactive
      // approver). `{prompt}` rides in argv like gemini/pi. `--resume {id}`
      // continues an existing session.
      args: ["copilot", "-p", "{prompt}", "--allow-all-tools"],
      resumeArgs: [
        "copilot",
        "-p",
        "{prompt}",
        "--allow-all-tools",
        "--resume",
        "{id}",
      ],
      output: { kind: "stdout" },
    },
    hooks: { markerDir: MARKERS_DIR, type: "copilot" },
  },
];

/** Pre-resolved Claude agent definition for Claude-only code paths */
export const CLAUDE_AGENT_DEF =
  BUILTIN_AGENTS.find((agent) => agent.name === "claude") ?? BUILTIN_AGENTS[0];

export function getAgents(preferences?: Preferences): AgentDef[] {
  const byName = new Map<string, AgentDef>(
    BUILTIN_AGENTS.map((agent) => [
      agent.name,
      {
        ...agent,
        terminalRules: agent.terminalRules.map((rule) => ({ ...rule })),
      },
    ]),
  );
  const config = preferences?.agents ?? {};

  for (const [name, override] of Object.entries(config)) {
    const normalizedName = name.toLowerCase();
    const existing = byName.get(normalizedName);

    if (existing) {
      byName.set(normalizedName, mergeAgentConfig(existing, override));
      continue;
    }

    if (!override.processMatch) {
      throw new Error(
        `Invalid agent config for "${name}": processMatch is required for custom agents`,
      );
    }

    byName.set(normalizedName, {
      name: normalizedName,
      shortCode: normalizedName
        .slice(0, 2)
        .replace(/^./, (c) => c.toUpperCase()),
      processMatch: parseRegex(
        override.processMatch,
        `agents.${name}.processMatch`,
      ),
      commandPatterns: override.commandPatterns?.map((pattern, idx) =>
        parseRegex(pattern, `agents.${name}.commandPatterns[${idx}]`),
      ),
      versionCommand: override.versionCommand,
      versionPatterns: override.versionPatterns?.map((pattern, idx) =>
        parseRegex(pattern, `agents.${name}.versionPatterns[${idx}]`),
      ),
      terminalRules: normalizeTerminalRules(
        override.terminalRules,
        `agents.${name}.terminalRules`,
      ),
      errorRules: normalizeErrorRules(
        override.errorRules,
        `agents.${name}.errorRules`,
      ),
      resumeCommand: override.resumeCommand,
      promptCommand: override.promptCommand,
      forkCommand: override.forkCommand,
      sessionFilePattern: override.sessionFilePattern
        ? parseRegex(
            override.sessionFilePattern,
            `agents.${name}.sessionFilePattern`,
          )
        : undefined,
      executable: override.executable,
      invokeMode: override.invokeMode
        ? normalizeInvokeMode(override.invokeMode, `agents.${name}.invokeMode`)
        : undefined,
      readyPattern: override.readyPattern
        ? parseRegex(override.readyPattern, `agents.${name}.readyPattern`)
        : undefined,
      hooks: override.hooks,
      notificationActions: override.notificationActions
        ? parseNotificationActions(
            override.notificationActions,
            `agents.${name}.notificationActions`,
          )
        : undefined,
      ambiguousPermissionMarker: override.ambiguousPermissionMarker,
    });
  }

  return Array.from(byName.values());
}

/**
 * Whether a `forkCommand` is one the builder will actually accept.
 *
 * Shared with `buildAgentForkCommand` so the picker's gate and the route's
 * refusal cannot drift: a truthiness check offered Fork for a template that
 * was a number, an object, whitespace, or named neither the source's
 * transcript nor its id, and the action then failed on click — the exact
 * "reads as broken" outcome the hide-don't-disable choice exists to avoid.
 * Preferences are unvalidated JSON, so every one of those is reachable from
 * ccmux.json.
 *
 * Placeholder shape only. Whether a `{path}` template is quoted safely, and
 * whether the row actually has a readable transcript, are the builder's to
 * judge — the second is per session rather than per agent, so it could not be
 * a display gate even in principle.
 */
export function isUsableForkCommand(template: unknown): template is string {
  return (
    typeof template === "string" &&
    (template.includes("{path}") || template.includes("{id}"))
  );
}

/**
 * Names of the agents that declare how to fork a session — the built-ins
 * that ship a `forkCommand` plus any custom agent configured with one.
 *
 * The TUI takes this as a prop to decide whether to offer Fork on a row. It
 * is a display gate only: the daemon re-derives the same fact from its own
 * agent registry when the request arrives, so a picker running against a
 * daemon with different config gets a clear refusal rather than a wrong pane.
 *
 * NEVER THROWS, and that is load-bearing rather than defensive. `getAgents`
 * throws on a malformed `agents` block (a missing `processMatch`, an
 * unparseable regex), and this is called on the PICKER AND SIDEBAR STARTUP
 * PATH, which nothing above catches: Commander's async action has no handler
 * and there is no `unhandledRejection` hook. A single typo in ccmux.json
 * would otherwise take the picker from "renders, with the daemon logging the
 * config error" to a stack trace and exit — and in the tmux popup binding
 * that is a flash-and-close with no message at all, plus every sidebar in
 * the fleet dying on next launch. Fork not being offered is a far better
 * failure than no picker.
 */
export function forkableAgentNames(preferences?: Preferences): string[] {
  try {
    return getAgents(preferences)
      .filter((agent) => isUsableForkCommand(agent.forkCommand))
      .map((agent) => agent.name);
  } catch {
    return [];
  }
}

/** Map of agent name → short code for compact display */
const AGENT_SHORT_CODES: Record<string, string> = Object.fromEntries(
  BUILTIN_AGENTS.map((a) => [a.name, a.shortCode]),
);

/** Map of agent name → display name for UI labels */
const AGENT_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  BUILTIN_AGENTS.filter((a) => a.displayName).map((a) => [
    a.name,
    a.displayName!,
  ]),
);

export function getAgentDisplayName(agentType: string): string {
  return (
    AGENT_DISPLAY_NAMES[agentType] ??
    agentType.charAt(0).toUpperCase() + agentType.slice(1)
  );
}

export function getAgentShortCode(agentType: string): string {
  return (
    AGENT_SHORT_CODES[agentType] ??
    agentType.slice(0, 2).replace(/^./, (c) => c.toUpperCase())
  );
}

/** Map of agent name → interactive launcher binary, for agents where they differ */
const AGENT_EXECUTABLES: Record<string, string> = Object.fromEntries(
  BUILTIN_AGENTS.filter((a) => a.executable).map((a) => [
    a.name,
    a.executable!,
  ]),
);

/** The binary an agent launches (e.g. cursor → cursor-agent), for PATH detection */
export function getAgentExecutable(agentType: string): string {
  return AGENT_EXECUTABLES[agentType] ?? agentType;
}

export function findAgentForProcess(
  command: string,
  agents: AgentDef[],
): AgentDef | null {
  const normalizedCommand = command.trim();
  const firstToken = normalizedCommand.split(/\s+/)[0] ?? "";
  const executable =
    firstToken
      .replace(/^['"]|['"]$/g, "")
      .split("/")
      .filter(Boolean)
      .at(-1) ?? "";

  for (const agent of agents) {
    // Match against executable name to avoid false positives from args,
    // e.g. "npm exec gemini-grounding" should not be treated as Gemini CLI.
    if (agent.processMatch.test(executable)) {
      return agent;
    }
    if (
      agent.commandPatterns?.some((pattern) => pattern.test(normalizedCommand))
    ) {
      return agent;
    }
  }
  return null;
}
