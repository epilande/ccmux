---
name: dispatch
description: |
  Orchestrate other AI coding agents (claude, codex, cursor, opencode, pi, omp, gemini, or custom)
  by driving them through `ccmux invoke`: firing, polling, joining, cancelling, and reading
  worker output, plus when to hand a job to `ccmux spawn` (a live, human-driven pane) instead.
  Use when asked to coordinate, delegate, fan out, or pipeline work across agents ("plan with
  claude, implement with codex", "run these three agents in parallel", "delegate this to codex
  while I keep working"), or for any request to use `ccmux invoke`.
---

# Orchestrating agents with `ccmux invoke`

One uniform CLI launches and observes every harness the same way (claude, codex, cursor,
opencode, pi, omp, gemini, plus custom agents). This skill is the mechanics; the
agent-per-task policy comes from the user's prompt. ccmux never runs a model itself, so
digesting a worker's output is your job, and the discipline that keeps an orchestration
tractable is controlling how much each worker hands back.

## When (not) to use

- Use for a named multi-agent workflow, a fan-out, a long delegation without blocking your
  own work, or a second agent's independent take (review, verify, alternative take).
- Not for a single quick turn (just run `ccmux invoke <agent> "..."` once, no machinery),
  and not for work faster to do yourself: every invoke pays a 5-15s cold start.

## invoke vs spawn: which tool

The test is **who consumes the output**. `invoke` returns a discrete result you thread into
the next step (final turn on stdout, exit code, `list`/`result`/`cancel`); you consume it.
`spawn` opens a persistent interactive tmux pane (no 30-min ceiling) and returns a `paneId`,
not a result; its output is terminal scrollback consumed by a human at the pane. Reach for
spawn only when the deliverable _is_ a live session: a job that exceeds invoke's headless
envelope (too long, or wedges headless on interactive approval) and a human will supervise,
a task you judge wants human eyes (launch it, tell the user, stop), or workspace setup.

```bash
# Launch a live pane for the user, then stop. Do NOT poll or drive it.
ccmux spawn codex --cwd /path/to/repo --prompt "Long refactor: <brief>"
```

**Do not drive a spawned pane as a worker** (spawn -> `ccmux send` -> poll -> `ccmux screen`
-> parse scrollback). It is a brittle scrape loop: no completion signal, render races, and
an answer buried in terminal chrome. For multi-turn continuity use invoke's `--session`
(see the session-resume gotcha), or fold prior context into the next invoke.

## Mental model: two patterns, one fan-out trick

| Pattern            | Use it for                             | Shape                                                       |
| ------------------ | -------------------------------------- | ----------------------------------------------------------- |
| **Block-and-wait** | one quick task; small sequential steps | `out=$(ccmux invoke <agent> "...")`, blocks, returns inline |
| **Fire-and-poll**  | long tasks, or many at once            | `ccmux invoke <agent> "..." --id <id> > file &` then join   |

**Fan-out + join is your own parallel tool calls**; there is no batch primitive.

- **Small N, all quick:** N block-and-wait invokes as N _separate_ Bash tool calls in one
  assistant turn (not N `$(...)` lines in one script, which run serially). Their return is
  the join, but each call holds a slot for its whole runtime.
- **Large N, or long/uneven runtimes:** fire each with `--id`, then join. See
  "Fire-and-poll" for the three join shapes.

The daemon caps concurrency at **16 in-flight invokes**; beyond that, new invokes are
rejected (see "Handling failures").

## Prerequisites

- `ccmux` on PATH; `ccmux invoke` auto-starts the daemon (`ccmux daemon status` confirms).
- **Claude as a worker requires its hooks** (`ccmux setup --agent claude`); without them the
  invoke fails fast with exit 3 (`hooks_missing`). Subprocess agents
  (codex/cursor/opencode/pi/omp/gemini) need no hooks for invoke.
- **There is no `ccmux agents` command** to enumerate invokable agents. Built-ins:
  `claude`, `codex`, `cursor`, `opencode`, `pi`, `omp`, `gemini`; custom agents are whatever
  the user defined in `~/.config/ccmux/ccmux.json`.

## Generating invocation ids

`--id` must match `^inv_[A-Za-z0-9]{4,32}$` (the literal `inv_` then 4-32 letters/digits;
**no dashes, underscores, or dots**). Prefer readable task-scoped names (`inv_planauth`,
`inv_search1`) so you recognize them in `list`; for guaranteed uniqueness use
`id="inv_$(openssl rand -hex 6)"` (raw `uuidgen` output has dashes and fails the pattern).
Reusing an id whose invoke **already finished** is allowed (newest-wins); reusing one
**still in flight** is rejected (`agent_error`, message `invocationId already in flight`),
so mint a fresh id.

## Block-and-wait (quick tasks)

```bash
# Capture the worker's final turn directly. stdout has NO trailing newline.
plan=$(ccmux invoke claude "Plan, in 5 concise bullets, how to add a --dry-run flag to the importer.")
```

Exit 0 on success with the response on stdout; on failure, a message on stderr and a
non-zero exit (table below). Keep responses small by **telling the worker to be brief**
("answer in <=5 bullets", "just the code, no prose"); that is the cheapest output control.

## Fire-and-poll (long or many tasks)

Start each invoke without blocking your own progress, then **join** when it finishes.
Three join shapes; **pick the first your environment supports**:

1. **Push (best): background the _blocking_ invoke as a harness job** (e.g. Claude Code's
   Bash `run_in_background`). The harness wakes you on completion; you never poll.
2. **`wait` on the client PID**, when one shell stays alive for the whole run.
3. **Poll the store, race-safely**, when neither fits.

### Join, best (push): background the blocking invoke

```bash
# Background the BLOCKING invoke via your harness's background-job mechanism
# (e.g. Bash run_in_background), NOT a shell `&`, and no redirect-detach needed:
# a blocking invoke returns the worker's output inline when it finishes.
ccmux invoke codex "Implement the --dry-run flag end to end. Report a concise summary." \
  --id inv_implflag --cwd /path/to/repo --timeout 1800000
```

Then stop; the backgrounded job's captured stdout is the worker's result. Set `--id` anyway
so you can still `cancel`/`result` it by name. For a fan-out, background N such jobs; the
harness's per-job completion notification is the join, no polling at all. (The push comes
from **your harness**: the daemon's SSE events feed the ccmux TUI, and there is no CLI
wait/notify primitive.)

### The other two joins: `wait` and the race-safe poll

No background-job mechanism in your harness? The `wait` join and the race-safe store poll,
plus their traps (the store-admission race and the long-foreground-shell kill), are in
[references/joins.md](references/joins.md). Read it before writing any poll loop; the naive
loop breaks in ways that look like worker failures but aren't.

### Reading a worker's output: inline vs `result`

| Source                                                                      | What it is                                   | Works for                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| The invoke's **stdout** (your redirect file, or the block-and-wait capture) | the worker's final turn (summary-sized)      | **all agents**                                                        |
| `ccmux invoke result <id>`                                                  | the worker's **full** captured stdout/stderr | **subprocess agents only** (codex, cursor, opencode, pi, omp, gemini) |

- The inline final turn is usually all you need; keep it small with a brevity prompt.
- `result <id>` exits 0 with the full output, 2 if no longer available, 1 on transport
  error / malformed id. It includes the agent's own stderr chrome (banners, prompts), so
  scan for the relevant part.
- **Claude is the exception.** A Claude invoke drives an interactive tmux session with no
  stdout buffer and writes **no** result file (`result` on a claude id always exits 2).
  **A Claude worker's only output is the inline stdout**, so never skip the redirect when
  backgrounding a Claude invoke, and do not poll `result` for it.

### Controlling output size

You hold every worker's output in your own context; ccmux will not summarize for you.
Prompt for brevity first ("summarize your changes in <=5 bullets"), and when you must
capture a big result but only need the gist, pipe it through a cheap worker:

```bash
ccmux invoke result inv_bigjob | ccmux invoke claude "Summarize this in 3 bullets:"
```

## Handling failures

Read the outcome from the exit code (block-and-wait) or the `status` + `kind` fields
(`list --json`). Never regex the human-format rows.

| Exit | Meaning         | Typical orchestrator response                                                     |
| ---- | --------------- | --------------------------------------------------------------------------------- |
| 0    | success         | use the stdout                                                                    |
| 1    | generic/unknown | infra problem (tmux down, bad `--timeout`/`--format`); inspect, don't blind-retry |
| 2    | `rate_limit`    | back off, retry later, or route the task to a different agent                     |
| 3    | `hooks_missing` | Claude only; run `ccmux setup --agent claude`, then retry                         |
| 4    | `agent_error`   | agent-attributable; **see the cap/dup-id wrinkle below**                          |
| 124  | `timeout`       | the `--timeout` budget was exhausted; raise it (ceiling 30 min) or split the task |
| 130  | `cancelled`     | someone cancelled it (possibly you)                                               |

`status` in `list --json` is `running` | `succeeded` | `failed` | `cancelled`; on `failed`,
`kind` carries the same values as the exit table (a timeout reads `status: "failed",
kind: "timeout"`). **`cancelled` is first-class**, distinct from `failed`, so your own
cancels never read as failures.

### The concurrency-cap / dup-id wrinkle (exit 4)

Two rejections share `kind: "agent_error"` / exit 4; disambiguate on the **message**:

- Contains `too many concurrent invocations` (`max 16`): the in-flight cap. **Back off** a
  few seconds (or wait for a worker to finish via `list`), then retry the _same_ invoke.
- Contains `already in flight`: you reused a running id. **Mint a fresh id** and retry;
  do not back off.

## Gotchas (read before a long run)

- **Admission lag: a freshly-fired id is briefly ABSENT from `list`.** A naive poll loop
  reads that absence as done and aborts at 0s; this is the most common way to break a
  fan-out. Full detail and the race-safe pattern: [references/joins.md](references/joins.md).
- **A `running` record has no liveness guarantee.** A wedged worker sits at `running` until
  its `--timeout` fires or you `cancel`; there is no heartbeat. Track each id's age in
  `list`, cancel anything far past its expected runtime, and always set a deliberate
  `--timeout` so a wedge self-resolves.
- **Smoke-test an agent before you depend on it.** Some agent/version combinations wedge
  headless on tasks needing interactive approval (notably file writes) while answering
  trivial prompts fine. Fire one throwaway `ccmux invoke <agent> "reply with: ok"` with a
  short `--timeout` first; if it doesn't return cleanly, route the task elsewhere.
- **The store ages out 5 minutes after an invoke STARTS, not after it finishes** (running
  invokes never age out), so a long worker can finish and immediately be gone from `list`.
  If an id disappears and you have its redirect file, **trust the file**. Poll promptly
  after long invokes and pull `result` quickly for subprocess agents.
- **The store is in-memory per daemon.** `ccmux daemon restart` clears all records and
  result files; don't restart mid-orchestration.
- **`result` is ephemeral.** Per-daemon temp dir, ~5 MiB cap per invoke (truncated beyond),
  lost on restart/reboot/OS-reap. Read it soon; it is a backup, not a log.
- **Prompt cap: 256 KB** (arg + stdin combined). Gemini, pi, and omp carry a tighter
  **120 KiB** cap because their prompt rides in argv. Split or summarize bigger inputs.
- **Timeout: default 5 min, ceiling 30 min** (`--timeout <ms>`, e.g. `--timeout 1800000`).
  Set it deliberately for big jobs; a long implementation can hit the default.
- **`--cwd` matters.** A worker that edits files acts in `--cwd` (defaults to your cwd);
  point it at the intended repo, or a scratch dir you don't mind it touching.
- **Session resume is three tiers, not a boolean.** Claude and OpenCode hand a resumable id
  back through ccmux (`sessionId` on the `list --json` record) for `--session <id>`. Codex
  and Cursor _accept_ `--session` but never hand an id back through ccmux (scrape it from
  `result` chrome, or just fold prior context into the next prompt). Pi, omp, and Gemini
  reject `--session`. Every un-resumed invoke is a cold start.

## Cancelling

`ccmux invoke cancel <id>` is idempotent (exit 0 whether running, already finished, or
unknown) and prints which case it hit. A cancelled worker's record reads `cancelled`, so a
concurrent poll never misreads your cancel as a failure. Cancel workers that have run too
long or whose result you no longer need.

## Reading and relaying between existing sessions

Moving output between sessions that already exist (yours, the user's, another
orchestrator's) is its own skill: **relay**. The decision in one table:

| Motion              | Command                        | Payload goes                           |
| ------------------- | ------------------------------ | -------------------------------------- |
| **Read-and-reason** | `ccmux last <ref> [--turns N]` | to your stdout, i.e. into your context |
| **Relay**           | `ccmux handoff <from> <to>`    | daemon-side, straight into the target  |

When you are only a router, relay with `handoff` so the payload never enters your context.
Load the **relay** skill (via the Skill tool) whenever you relay between sessions or
receive a message beginning `[ccmux handoff]`.

## Worked example

A complete plan -> implement -> search pipeline (block-and-wait plan step, two-worker
fan-out, `wait` join, collect) is in [references/examples.md](references/examples.md);
adjust the agent names to whatever policy the user gave you.
