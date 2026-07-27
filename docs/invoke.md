# `ccmux invoke`: programmatic agent invocation

`ccmux invoke <agent> "prompt"` runs a single agent turn and writes the final response to stdout. It drives an interactive agent in a dedicated tmux session, waits for the turn to complete, captures the response, and tears the session down.

The motivating use case: Anthropic Pro/Max subscribers wanting to script Claude (and other built-in agents) from shell pipelines and local CLIs, without falling onto API billing.

## Quickstart

```bash
# One-shot Claude turn
ccmux invoke claude "say hi in one word"

# Stdin as the prompt
echo "what is 2 + 2" | ccmux invoke claude

# Mix: arg + stdin (concatenated with a newline)
git diff main | ccmux invoke claude "Review this diff"

# Default agent is claude, so this also works
ccmux invoke "explain what this repo does"
```

## CLI reference

```
ccmux invoke [agent] [prompt] [options]

Arguments:
  agent     Agent to invoke (claude, codex, cursor, opencode, pi, omp,
            gemini).
            Default: claude. If the first positional doesn't match a known
            agent, it's treated as the prompt and agent defaults to claude.
  prompt    Prompt text. Optional if stdin is piped.

Options:
  --cwd <dir>          Working directory (default: process.cwd())
  --timeout <ms>       Timeout in milliseconds (default: 300000 = 5 minutes;
                       max 1800000 = 30 minutes, enforced by the daemon)
  --session <id>       Continue an existing session by native agent id
  --id <id>            Caller-set invocation id (must match
                       inv_<4-32 alphanumerics>); generated when omitted.
                       See "Fire-and-poll" below.
  --format <fmt>       Output format. v1: only "text" (default). Any other
                       value exits 1 immediately.

Exit codes:
  0    success (response written to stdout)
  1    generic / unknown error. Includes ccmux infrastructure failures
       (tmux unavailable, daemon could not spawn the agent), invalid
       `--format`, and invalid `--timeout`.
  2    rate_limit
  3    hooks_missing (Claude only; Claude requires `ccmux setup --agent
       claude` for the interactive tmux path. Subprocess agents do not
       need hooks installed.)
  4    agent_error. Agent-attributable failures: login expired,
       `--session` rejected (Gemini/Pi/omp), agent did not produce a session
       within 30s, subprocess produced empty output with stderr.
  124  timeout (the invocation's `--timeout` budget was exhausted)
  130  user cancelled (SIGINT)
```

Output is written to stdout without a trailing newline so command substitutions and pipelines preserve the exact response text. Add one in shell if you need it (`echo "$(ccmux invoke claude ...)"`).

## Stdin behavior

| Stdin | Prompt arg | Result                               |
| ----- | ---------- | ------------------------------------ |
| Empty | Set        | `prompt` is the arg.                 |
| Set   | Set        | `prompt` is `arg + "\n" + stdin`.    |
| Set   | Empty      | `prompt` is stdin.                   |
| Empty | Empty      | Error: "No prompt provided". Exit 1. |

The daemon caps the combined prompt at **256 KB** to keep a misbehaving caller from streaming gigabytes of stdin into daemon memory. Exceeding the cap returns exit 1 with `Prompt exceeds maximum size of 262144 bytes`. The cap accommodates realistic piped inputs (git diffs, test logs); if you genuinely need more, splice the input into smaller follow-up turns via `--session`. Gemini, Pi, and omp carry a tighter **120 KiB** cap: their prompt rides in argv rather than stdin (`-p {prompt}`), so an over-cap prompt to those two returns exit 4 (`agent_error`) before the process spawns.

## Multi-turn with `--session`

`ccmux invoke <agent> --session <native_id> "follow up"` resumes an existing native agent session. Resume semantics differ per agent:

| Agent    | `--session <id>` behavior                                                        |
| -------- | -------------------------------------------------------------------------------- |
| Claude   | `claude --resume <id>`, fully native, by id.                                     |
| Codex    | `codex resume <id>`, by rollout id.                                              |
| Cursor   | `cursor-agent --resume <conversation_id>`, workspace-scoped; `--cwd` must match. |
| OpenCode | `opencode run --session <id>`, by id.                                            |
| Pi       | Not supported. Returns exit 4 (`agent_error`).                                   |
| omp      | Not supported. Returns exit 4 (`agent_error`).                                   |
| Gemini   | Not supported. Returns exit 4 (`agent_error`).                                   |

The returned `sessionId` (visible via the daemon `POST /invoke` response, not the text output) is the native agent id you can pass back as `--session <id>` for follow-ups, or to the agent directly outside ccmux for `--resume`.

## Fire-and-poll (`--id`, `list`, `cancel`, `result`)

Beyond the blocking one-shot form, `ccmux invoke` exposes a small set of verbs for orchestrators that want to name an invocation, watch it, cancel it, or read its full output by id. The id is the handle for all three management verbs.

### Naming an invocation: `--id`

```bash
ccmux invoke codex "run the migration" --id inv_step1
```

`--id <id>` sets the invocation id instead of letting ccmux generate one. It must match `inv_<4-32 alphanumerics>` (`^inv_[A-Za-z0-9]{4,32}$`); the CLI validates it locally and exits 1 with `Invalid --id: ... (must match inv_<4-32 alphanumerics>)` before contacting the daemon. A caller-set id lets you `list` / `cancel` / `result` that invocation by a name you already know.

Reusing an id that is **still in flight** is rejected: the daemon returns `kind: "agent_error"` (message `invocationId already in flight`, exit 4) on an HTTP 200 response, so retry with a fresh id rather than reusing one that may not have finished. Reusing an id whose previous invocation has **already finished** is allowed and starts a fresh run (newest-wins).

### Listing: `ccmux invoke list`

```bash
ccmux invoke list          # human-readable rows
ccmux invoke list --json   # raw JSON array (also -j)
```

Prints active and recently-finished invocations from the daemon's in-memory store, newest first. Each row is `id - agent - outcome - age`, where outcome is the status (with the failure `kind` in parentheses on a failed run):

```
inv_step1 - codex - succeeded - 4s
inv_ab12cd - claude - running - 12s running
inv_x9 - gemini - failed (rate_limit) - 2s
```

Finished records linger for up to 5 minutes measured **from when the invocation started** (not from when it finished), then age out; running invocations are never aged out. The window to observe a terminal state after the invoke returns is therefore 5 minutes minus the runtime: a quick invoke leaves nearly the full 5 minutes, but a long run (a multi-minute agent task, or one that hits its timeout) can age out within a minute of finishing, so poll promptly after a long invoke. The store is per-daemon-process and in-memory, so a daemon restart clears it. `--json` emits the raw `InvocationRecord[]` (fields: `invocationId`, `agent`, `cwd`, `startedAt`, `status`, `durationMs?`, `sessionId?`, `paneId?`, `kind?`).

### Statuses

| Status      | Meaning                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `running`   | In flight.                                                                                                                            |
| `succeeded` | Completed; the response was returned on the original `POST /invoke`.                                                                  |
| `failed`    | Terminal failure. `kind` carries the detail (a timeout is `failed` with `kind: "timeout"`).                                           |
| `cancelled` | Cancelled by the user/orchestrator. A first-class state, distinct from `failed`, so a poller never reads its own cancel as a failure. |

### Cancelling: `ccmux invoke cancel <id>`

```bash
ccmux invoke cancel inv_step1
```

Idempotent: a successful cancel exits 0 regardless of whether the invocation was running, already finished, or unknown (a malformed id or a transport error exits 1). The daemon classifies the id and the CLI prints which case it hit:

- `Cancelling inv_step1` — the invocation was running and is being torn down.
- `inv_step1 already finished (nothing to cancel)` — already terminal.
- `inv_step1 not found (cancel recorded in case it starts)` — unknown id; the cancel is stashed so a racing `invoke()` for that id short-circuits as `cancelled`.

Cancel is best-effort and returns as soon as the abort lands; the original `ccmux invoke` (or `POST /invoke`) request is what returns once teardown completes. `Ctrl-C` on a blocking `ccmux invoke` issues the same cancel automatically (see [Cancellation](#cancellation)).

### Reading full output: `ccmux invoke result <id>`

```bash
ccmux invoke result inv_step1
```

Prints the invocation's full captured output from the daemon's ephemeral result store, without a trailing newline (same as the one-shot form). Exit codes are scoped to this verb and do **not** match the one-shot table above:

| Exit | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | Output printed.                                                                                 |
| 2    | No longer available (reaped, never written, or the daemon restarted).                           |
| 1    | Transport error (daemon unreachable), or a malformed id (exits 1 before contacting the daemon). |

> **Only subprocess invokes write a result file.** Codex, Cursor, OpenCode, Gemini, Pi, and omp buffer their full stdout/stderr and persist it at finish. Claude invokes drive an interactive tmux session with no stdout buffer, so their full output **is** the text returned inline on the original invoke. `ccmux invoke result <claude-id>` therefore always reports "no longer available" (exit 2).

The result store is deliberately ephemeral: a per-daemon-process `0700` directory under the OS temp dir (random path), capped at ~5 MiB per invocation (output beyond that is truncated with a marker). It is lost on daemon restart, reboot, or the OS `/tmp` reaper. Treat `result` as "read it soon after it finishes," not a durable log.

### HTTP endpoints

The fire-and-poll verbs are thin wrappers over the daemon's loopback HTTP API. As with the rest of the API these are **internal**: the CLI is the only supported consumer in v1, and the shapes may change (see [Stability commitments](#stability-commitments)).

- `GET /invocations` → `{ "invocations": InvocationRecord[] }`, newest-first by `startedAt`. Backs `ccmux invoke list`.
- `GET /invocations/:id/result` → `{ "available": boolean, "output"?: string }`. `available: false` on HTTP 200 is the reap-tolerant miss; an invalid id returns `{ "available": false, "message": "Invalid 'invocationId'" }` with HTTP 400. Backs `ccmux invoke result <id>`.
- `POST /invoke/:id/cancel` → `{ "success": boolean, "state": "cancelling" | "already_finished" | "not_found" }`. Backs `ccmux invoke cancel <id>` and the `Ctrl-C` path.

## Execution model and text extraction

Each agent runs in one of two paths, chosen by whether the agent has an `invokeMode` configured in `src/lib/agents.ts`:

| Path        | Agents   | How it runs                                                                  | How text is returned                                                  |
| ----------- | -------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Interactive | Claude   | Launched in a dedicated `ccmux-invoke-<id>` tmux session.                    | Native transcript JSONL: assistant TextBlock content. Clean.          |
| Subprocess  | OpenCode | `opencode run --format json`, no tmux pane.                                  | Aggregated `type === "text"` parts from the JSON event stream. Clean. |
| Subprocess  | Codex    | `codex exec --skip-git-repo-check -o <tmpfile> [resume <id>]`, no tmux pane. | Final assistant message from the tmpfile. Clean.                      |
| Subprocess  | Cursor   | `cursor-agent --print [--resume <id>]`, no tmux pane.                        | Raw stdout from the subprocess.                                       |
| Subprocess  | Pi       | `pi -p {prompt}`, prompt in argv, no tmux pane.                              | Raw stdout from the subprocess. `--session` is rejected.              |
| Subprocess  | omp      | `omp -p {prompt}`, prompt in argv, no tmux pane.                             | Raw stdout from the subprocess. `--session` is rejected.              |
| Subprocess  | Gemini   | `gemini -p {prompt}`, prompt in argv, no tmux pane.                          | Raw stdout from the subprocess. `--session` is rejected.              |

Output **semantics** are committed (the response is in there); subprocess-path exit codes and message wording are not (see Stability commitments).

### Error classification (`errorRules`)

Subprocess invokers classify failures by running each `AgentDef.errorRules` regex against the tail of the combined stdout+stderr. The first matching rule wins, **even if the process exited zero**, so the rate-limit banner that some agents print right before exiting non-zero (Codex, OpenCode) still maps to the right exit code. `kind: "rate_limit"` → exit 2, `kind: "agent_error"` → exit 4; a non-zero exit with no rule match falls through to exit 4 (`agent_error`). Each built-in agent except Gemini ships one rate-limit rule in `src/lib/agents.ts`. Other agent-attributable failures don't need rules: `--session` on an agent that can't resume is rejected by a capability pre-flight before the process spawns, and login expiry surfaces as exit 4 through the non-zero-exit fallthrough.

Custom agents declared under `agents.*` in `~/.config/ccmux/ccmux.json` can ship their own `errorRules`:

```jsonc
{
  "agents": {
    "myagent": {
      "errorRules": [
        { "match": "/rate.?limit/i", "kind": "rate_limit" },
        {
          "match": "/please log in/i",
          "kind": "agent_error",
          "message": "auth expired",
        },
      ],
    },
  },
}
```

`match` accepts the slash-delimited form (`/regex/flags`) or a bare string (defaults to case-insensitive). `message` is optional; when set, it replaces the agent's stderr in the failure message surfaced to the CLI.

## Pre-flight requirements

- The ccmux daemon must be running. `ccmux invoke` starts it automatically via `ensureDaemon()` if needed.
- For Claude only, hooks must be installed (`ccmux setup --agent claude`). Without them the daemon cannot derive an authoritative session id for the interactive tmux path, and invoke fails fast with exit code 3 (`hooks_missing`).
- Subprocess agents (Codex / Cursor / OpenCode / Gemini / Pi / omp) do not need hooks installed for `ccmux invoke`. They are still useful to install for normal `ccmux picker` / `sidebar` session tracking.
- Custom agents declared under `agents.*` in `~/.config/ccmux/ccmux.json` are invokable too. With an `invokeMode` they take the subprocess path; without one they take the interactive tmux path and skip the hooks precheck (no built-in hook adapter to gate against).

## Observability

Claude invocations run in a dedicated `ccmux-invoke-<short-id>` tmux session and show up in `ccmux picker` / `sidebar` like any other ccmux session while in flight. The session is killed automatically when the turn completes (or on timeout / cancel).

Subprocess-path agents (Codex / Cursor / OpenCode / Gemini / Pi / omp) do not create a tmux session, but they still appear on the board as paneless worker rows: a running spinner while in flight, then their terminal outcome (`✓` done / `✗` failed / `⊘` cancelled) lingering for a few seconds before the row clears. The header shows an `N invoking` count of every in-flight invoke (Claude and subprocess alike), and under session / window grouping the paneless rows collect under a dedicated `(invoke)` group rather than `(no tmux)`. Killing or restarting one of these rows from the board cancels the invocation (`POST /invoke/<id>/cancel`); a one-shot worker has no real session to kill or restart. The board's kill-all reaps in-flight invokes too: the daemon cancels every running invocation it knows about (the authoritative set), so kill-all unwinds Claude and subprocess workers cleanly rather than stranding them.

> Settling a Claude invoke by killing its `ccmux-invoke-<id>` tmux session directly (rather than via `ccmux invoke cancel`, `Ctrl-C`, or the board's kill binding) does not clear it immediately: the daemon keeps polling for the turn end until the per-invocation timeout (`--timeout`, default 300s), so the `N invoking` count can linger until then. Cancel through the CLI or the board for a clean, immediate unwind.

## Cancellation

`Ctrl-C` on a running `ccmux invoke` sends `POST /invoke/<id>/cancel` to the daemon. For Claude, the daemon sends `C-c` to the agent's pane, waits 1.5s for graceful interrupt, then kills the tmux session. For subprocess agents, the daemon aborts the spawned process directly. Either way the CLI exits 130.

The `invocationId` is generated client-side (or set via `--id`) and included in the request body, so cancellation works even before the daemon has responded to the initial `POST /invoke`. The daemon rejects a duplicate `invocationId` that is **still in flight** with `kind: "agent_error"` (message `invocationId already in flight`, exit 4) on an HTTP 200 response: if you retry a `POST /invoke` after a network hiccup, generate a fresh id rather than reusing the previous one (the original may still be in flight). Reusing an id whose prior invocation already finished is allowed and starts a fresh run.

> On shared / multi-user hosts: the daemon binds `127.0.0.1` only, but any local process can call `POST /invoke/<id>/cancel`. The cancel endpoint does not authenticate the caller against the invocation owner, and ccmux uses a single fixed port (`2269`), so co-tenant users on the same loopback can cancel each other's invocations. Not a concern on single-user machines.

> The daemon rejects any `POST /invoke` carrying an `Origin` header (browser-issued cross-origin requests). Only loopback CLI clients without an `Origin` are accepted. This prevents a malicious page on `localhost` from triggering invocations via the user's browser.

## Cold-start latency

Each invocation pays roughly 5-15s for tmux session creation, agent boot, prompt-readiness detection, and the LLM round-trip. There's no warm-pool reuse in v1. Running `ccmux invoke` 50 times in a loop will feel slow (by design).

A warm pool is the planned latency win in v1.3.

## Overriding Claude prompt-ready detection

The Claude invoke path drives Claude Code's interactive TUI inside a detached tmux session, and needs to wait for the input box to render before sending the user prompt. ccmux detects this by matching a regex against captured pane content. The default tracks Claude's current prompt glyph and accepts both the legacy `> ` and the current `❯ ` forms.

If a future Claude release rebrands the prompt and ccmux hasn't shipped a matching update yet, every `ccmux invoke claude` call will fail after ~15s with `Claude prompt did not appear within 15s`. You can patch this locally without waiting for a ccmux release:

```jsonc
// ~/.config/ccmux/ccmux.json
{
  "agents": {
    "claude": {
      // Slash-delimited form supports flags; bare strings default to /i.
      "readyPattern": "/^[>❯▶]\\s/",
    },
  },
}
```

Restart the daemon (`ccmux daemon restart`) to pick up the change. The regex runs against each line of the stripped pane capture; any line that matches counts as "ready."

## Stability commitments

What v1 commits to keeping stable:

- CLI flags (`--cwd`, `--timeout`, `--session`, `--format`).
- Exit codes per the table above.
- `--format text` semantics: stdout contains the agent's response text.

What v1 explicitly reserves the right to change:

- Error message wording.
- Subprocess-agent invocation flags (e.g., switching Cursor away from `--print`, or adding chrome-stripping over `cursor-agent` / `gemini` stdout).
- Internal HTTP API (`POST /invoke`, `POST /invoke/:id/cancel`, `GET /invocations`, `GET /invocations/:id/result`). The CLI is the only supported consumer in v1.

## Out of scope for v1 (deferred to later additive releases)

- Warm pane pool.
- `--format json` / `--format raw-transcript` / `--format events`.
- `--background` jobs with `ccmux invoke status/logs/cancel <id>`.
- An `@ccmux/sdk` npm package for TypeScript/Bun import.
- Daemon-side concurrency queue / rate-limit awareness.

## Examples

```bash
# Generate a commit message from staged diff
~/bin/claude-commit-msg () {
  git diff --staged | ccmux invoke claude \
    "Write a concise conventional commits message for this diff. Just the message, no preamble."
}

# Quick code explanation
ccmux invoke claude "explain what $(cat src/daemon/server.ts | head -50) does"

# Multi-turn (use the sessionId from the previous response)
SID="<claude session uuid from prior /invoke response>"
ccmux invoke claude --session "$SID" "and what about error handling?"

# Pipe pipeline output through review
make test 2>&1 | ccmux invoke claude "Are any of these failures actionable?"
```
