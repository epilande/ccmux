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
   * `replyOnQuestion` opts `question` waits into inline Reply; `replyOnFinished`
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
    merged.notificationActions = { ...override.notificationActions };
  }
  if (override.ambiguousPermissionMarker !== undefined) {
    merged.ambiguousPermissionMarker = override.ambiguousPermissionMarker;
  }

  return merged;
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

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: "claude",
    shortCode: "cc",
    processMatch: /\bclaude\b/i,
    versionCommand: "claude --version",
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
    // Claude's numbered permission prompt: "1" quick-selects the first option
    // (approve) and submits immediately, so no trailing Enter is needed; Escape
    // cancels/denies. The lone-"1" choice is unverified against every prompt
    // variant — the notification-action e2e pass MUST confirm it approves (and
    // switch to ["1", "Enter"] if the prompt turns out to need submission).
    // `answerPrelude: ["Escape"]` cancels the AskUserQuestion picker before the
    // reply text (the picker ignores typed literals; Escape returns to the
    // composer where the reply sends as a user message).
    // `replyOnFinished` idle Reply sends with NO prelude: Escape at Claude's
    // idle composer clears a draft and double-Escape opens history rewind, so a
    // prelude there is destructive (see `resolveActionPlan`). `replyOnQuestion`
    // reuses `answerPrelude`'s Escape-to-composer path for question waits.
    // `permissionReplyPrelude: ["Escape"]` is deny-with-feedback: Escape cancels
    // the prompt, then the reply sends as the next user message. Verified on
    // Claude Code 2.1.211 across the Bash, Edit/Write diff, and MCP-tool variants.
    // Plan (ExitPlanMode) picker, verified on Claude Code 2.1.211: option 1 is
    // "Yes, and use auto mode" (bypass), option 2 is "manually approve edits", so
    // `planApprove` MUST be ["2"], never ["1"] (["1"] silently enables auto mode).
    // The digit submits immediately, no Enter. `planDeny`/`planReplyPrelude` are
    // ["Escape"]: cancels ExitPlanMode to an empty composer with plan mode still
    // on, where text + Enter sends as a user message.
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
    terminalRules: [
      {
        matchAny: [
          "press enter to confirm or esc to cancel",
          "allow command?",
          "[y/n]",
          "(y/n)",
        ],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Command",
      },
      {
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
    sessionFilePattern: CODEX_SESSION_FILE_PATTERN,
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
    // `--resume <chatId>` restores the chat transcript only when invoked
    // from the original workspace; cursor scopes chats per workspace_roots.
    // ccmux resumes inside the pane's shell which preserves cwd, so this
    // is fine in practice.
    resumeCommand: "cursor-agent --resume {id}",
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
    resumeCommand: "agy --conversation {id}",
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
    // `pi -c` continues the most recent session in-pane (no session-id
    // extraction needed, like opencode --continue).
    resumeCommand: "pi -c",
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
    });
  }

  return Array.from(byName.values());
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
