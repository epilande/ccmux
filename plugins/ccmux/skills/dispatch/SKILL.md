---
name: dispatch
description: |
  Orchestrate other AI coding agents (Claude Code, Codex, Cursor, OpenCode, Pi, Gemini, or any
  custom agent) by driving them through `ccmux invoke`. ccmux is the cross-harness substrate;
  YOU are the router. Use this skill when a prompt asks you to coordinate, delegate, fan out,
  or pipeline work across multiple agents, e.g. "plan with claude, implement with codex,
  search with gemini", "run these three agents in parallel and combine the results",
  "delegate this long implementation to codex while I keep working", "have another agent do
  X and summarize it back", or any request to use `ccmux invoke` to launch and watch worker
  agents. The user supplies the agent-per-task policy in their prompt; this skill teaches the
  mechanics of firing, polling, joining, cancelling, and reading worker output, plus when to
  hand a job off to `ccmux spawn` (a live, human-driven pane) instead of invoking it.
---

# Orchestrating agents with `ccmux invoke`

You are the orchestrator. ccmux gives you one uniform CLI that launches and observes every
harness the same way (claude, codex, cursor, opencode, pi, gemini, plus custom agents). This
skill teaches the **mechanics** of driving those workers. It is deliberately generic: the
**agent-per-task policy comes from the user's prompt** ("plan with claude, implement with
codex, search with gemini"), not from this file. Your job is to apply judgment to that
policy and thread results between steps.

ccmux never runs a model itself, not even to summarize a worker's output. Digesting a large
result is your job (prompt the worker for brevity, or spawn a cheap summarizer over its full
output). Keep that in mind throughout: the discipline that keeps an orchestration tractable
is controlling how much each worker hands back.

## When to use

- The user names a multi-agent workflow ("plan with X, implement with Y, search with Z").
- You need to fan a task out across several agents and combine their answers.
- You want to delegate a long task to another agent without blocking your own work.
- You want a second agent's independent take (review, verify, alternative implementation).

## When NOT to use

- A single quick turn you can run inline: just `ccmux invoke <agent> "..."` once; you don't
  need the fire-and-poll machinery below.
- Work you should do yourself. Delegation costs a cold start (5-15s) plus the worker's own
  round-trip; don't farm out what's faster to do directly.

## invoke vs spawn: which tool

`ccmux invoke` is the orchestration primitive in this skill. `ccmux spawn` is a different
tool with a different job; an orchestrator should reach for it rarely and deliberately. The
test is the **shape of what you need back**:

- **A discrete result you thread into the next step -> `invoke`.** Final turn on stdout, exit
  code, `list`/`result`/`cancel`. Everything this skill teaches, and almost always what an
  orchestrator wants.
- **A persistent live session a human attaches to and drives -> `spawn`.** It opens the agent
  in a real tmux pane (interactive, attachable, no 30-min ceiling) and returns a `paneId`,
  not a result. Its output is terminal scrollback, not a clean value.

The line underneath is **who consumes the output**: invoke's is consumed by you, the LLM;
spawn's is consumed by a human at the pane. So reach for spawn only when the deliverable
_is_ a live session, not a value you process:

- A job that **exceeds invoke's headless envelope** (longer than the 30-min ceiling, or one
  that wedges headless because it needs interactive approval) **and that a human will
  supervise.**
- A **handoff**: you judge that a task wants human eyes, spawn it into a pane, tell the user,
  and stop. You are a launcher here, not a router.
- **Workspace setup**: open agents in panes for the user to work with. Not orchestration at all.

```bash
# Handoff: launch a live pane for the user, then stop. Do NOT poll or drive it.
ccmux spawn codex --cwd /path/to/repo --prompt "Long refactor: <brief>"
```

**Do not drive a spawned pane as a worker** (spawn -> `ccmux send` -> poll -> `ccmux screen`
-> parse scrollback). It looks like a path to autonomous multi-turn or to answering a
worker's approval prompts, but it is a brittle scrape loop: no completion signal, render
races, and a final answer you still have to dig out of terminal chrome. The agent's own
harness already does interactive driving; ccmux is for insight and oversight, not for
reimplementing that channel by scraping. When you genuinely need multi-turn continuity, use
invoke's `--session` (claude and opencode hand a resumable id back; see the session-resume
gotcha for the full per-agent matrix), or fold prior context into the next invoke.

## Mental model: two patterns, one fan-out trick

| Pattern            | Use it for                             | Shape                                                       |
| ------------------ | -------------------------------------- | ----------------------------------------------------------- |
| **Block-and-wait** | one quick task; small sequential steps | `out=$(ccmux invoke <agent> "...")`, blocks, returns inline |
| **Fire-and-poll**  | long tasks, or many at once            | `ccmux invoke <agent> "..." --id <id> > file &` then join   |

**Fan-out + join is your own parallel tool calls.** You do not need a batch primitive. To
run N agents concurrently, issue N `ccmux invoke` calls and collect their results. Two ways:

- **Small N, all quick:** issue N block-and-wait `ccmux invoke` calls in a single turn (as
  parallel tool calls). This means N _separate_ Bash tool calls in the same assistant turn,
  not three `out=$(...)` in one shell script (those run serially). They run concurrently
  daemon-side and return together, and that is the join. Simple, but each call holds a slot
  for its whole runtime, and if your harness serializes tool calls they won't actually overlap.
- **Large N, or long/uneven runtimes:** fire each with `--id`, then join. There are three
  join shapes (push via a harness background job, `wait` on a PID, or a race-safe store poll);
  pick the first your environment supports. This is the robust mechanism to reach for whenever
  runtimes are long or you have more than a couple of workers. See "Fire-and-poll" for all three.

The daemon caps concurrency at **16 in-flight invokes**. Beyond that, new invokes are
rejected (see "Handling failures").

## Prerequisites

- `ccmux` on PATH and the daemon running. `ccmux invoke` auto-starts the daemon, but you can
  start it explicitly with `ccmux daemon start`. Confirm with `ccmux daemon status`.
- **Claude as a worker requires its hooks installed** (`ccmux setup --agent claude`); without
  them a `ccmux invoke claude` fails fast with exit 3 (`hooks_missing`). Subprocess agents
  (codex/cursor/opencode/pi/gemini) need no hooks for invoke.
- **There is no `ccmux agents` command.** You cannot enumerate invokable agents
  programmatically. Use the agent names the user gave you; the built-ins are `claude`,
  `codex`, `cursor`, `opencode`, `pi`, `gemini`. Custom agents are whatever the user defined in
  `~/.config/ccmux/ccmux.json`.

## Generating invocation ids

Every fire-and-poll invoke needs an id you choose with `--id`. It must match
`^inv_[A-Za-z0-9]{4,32}$` (the literal `inv_` then 4-32 letters/digits, with **no dashes,
underscores, or dots** after the prefix).

- **Prefer readable, task-scoped names** so you recognize them in `list`: `inv_planauth`,
  `inv_implmigration`, `inv_search1`. You own the namespace, so just don't reuse a name
  while its invoke is still in flight.
- **Need guaranteed uniqueness?** `id="inv_$(openssl rand -hex 6)"` gives `inv_` + 12 hex
  chars, always valid. Avoid `uuidgen` raw output, whose dashes break the pattern.
- Reusing an id whose previous invoke **already finished** is allowed (newest-wins). Reusing
  one that is **still in flight** is rejected (`agent_error`, message `invocationId already in
flight`), so mint a fresh id.

## Block-and-wait (quick tasks)

```bash
# Capture the worker's final turn directly. stdout has NO trailing newline.
plan=$(ccmux invoke claude "Plan, in 5 concise bullets, how to add a --dry-run flag to the importer.")
echo "$plan"
```

`ccmux invoke` writes the worker's final response to stdout and exits 0 on success. On
failure it writes a message to stderr and exits non-zero (see the exit-code table below).
Keep the response small by **telling the worker to be brief** ("answer in <=5 bullets", "just
the code, no prose"). That is the cheapest output control you have.

## Fire-and-poll (long or many tasks)

This is the core pattern for long or many workers: start each invoke without blocking your
own progress, then **join** when it finishes. There are three join shapes. **Pick the first
one your environment supports** (they get progressively more manual), and choosing well is
the single most important thing in this skill:

1. **Push (best): background the _blocking_ invoke as a harness job.** Your harness wakes you
   on completion, so you never poll. Use this whenever your harness can run a background job
   and notify you (e.g. Claude Code's Bash `run_in_background`).
2. **`wait` on the client PID.** When one shell stays alive for the whole run, `wait` is the
   join. No store involved, so no admission race.
3. **Poll the store, race-safely.** When neither fits (no background jobs, and the firing
   shell is gone across turns), poll `ccmux invoke list`.

### Join, best (push): background the blocking invoke

If your harness can run a shell command in the background and notify you when it exits, this
is the cleanest fire-and-poll there is. You background the **blocking** `ccmux invoke` (the
plain form, which stays open until the worker finishes and returns its result inline), and
the harness's completion notification _is_ your push. You learn of completion, with the
result already in hand, **without ever calling `ccmux invoke list`**.

```bash
# Background the BLOCKING invoke via your harness's background-job mechanism
# (e.g. Bash run_in_background), NOT a shell `&`, and no redirect-detach needed:
# a blocking invoke returns the worker's output inline when it finishes.
ccmux invoke codex "Implement the --dry-run flag end to end. Report a concise summary." \
  --id inv_implflag --cwd /path/to/repo --timeout 1800000
```

Then stop and wait for the harness to wake you; the backgrounded job's captured stdout is the
worker's result. Set `--id` anyway so you can still `cancel`/`result` it by name. For a
fan-out, background N such jobs and let the harness notify you as each finishes; that is your
join, and it needs no polling at all. (Note: the push here comes from **your harness**, not
ccmux. The daemon does emit `invocation_started`/`invocation_finished` SSE events, but those
feed the ccmux TUI; there is no CLI wait/notify primitive, so your harness's background-job
notification is the only push an orchestrator can consume.)

### The other two joins: `wait` and the race-safe poll

No background-job/notify mechanism in your harness? The other two join shapes (`wait` on
the client PIDs, and the race-safe store poll), plus their traps (the store-admission race
and the long-foreground-shell kill), live in [references/joins.md](references/joins.md) in
this skill's directory. Read it before writing any poll loop; the naive loop breaks in ways
that look like worker failures but aren't.

### Reading a worker's output: inline vs `result`

There are two sources for a worker's output, and which one you use depends on the agent:

| Source                                                                      | What it is                                   | Works for                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| The invoke's **stdout** (your redirect file, or the block-and-wait capture) | the worker's final turn (summary-sized)      | **all agents**                                                   |
| `ccmux invoke result <id>`                                                  | the worker's **full** captured stdout/stderr | **subprocess agents only** (codex, cursor, opencode, pi, gemini) |

- For a quick fan-out, the inline final turn is usually all you need; keep it small with a
  brevity prompt.
- When you need more than the summary (full diff, full reasoning, error detail), pull
  `ccmux invoke result <id>` for a **subprocess** agent. It exits 0 with the output, exit 2 if
  the result is no longer available, exit 1 on transport error / malformed id. The captured
  output includes the agent's own stderr chrome (banners, "Reading prompt from stdin..."),
  not just the final answer, so scan for the relevant part.
- **Claude is the exception.** A Claude invoke drives an interactive tmux session with no
  stdout buffer, so it writes **no** result file: `ccmux invoke result <claude-id>` always
  reports "no longer available" (exit 2). **A Claude worker's only output is the inline
  stdout**, so when you fire a Claude invoke in the background, the redirect file is the
  _only_ copy. Do not skip the redirect for Claude, and do not poll `result` for it.

### Controlling output size

You hold every worker's output in your own context, so a large fan-out can overflow it.
Two levers, both yours (ccmux will not summarize for you):

1. **Prompt for brevity.** "Summarize your changes in <=5 bullets and list changed files."
   This is the first and cheapest control.
2. **Summarize the full output with a cheap worker.** When you must capture a big result but
   only need the gist, pipe the full output through a small/cheap agent:
   ```bash
   ccmux invoke result inv_bigjob | ccmux invoke claude "Summarize this in 3 bullets:"
   ```

## Handling failures

Read the outcome from the exit code (block-and-wait) or the `status` + `kind` fields
(`list --json`). Never regex the human-format rows.

**Exit codes (block-and-wait `ccmux invoke`):**

| Exit | Meaning         | Typical orchestrator response                                                     |
| ---- | --------------- | --------------------------------------------------------------------------------- |
| 0    | success         | use the stdout                                                                    |
| 1    | generic/unknown | infra problem (tmux down, bad `--timeout`/`--format`); inspect, don't blind-retry |
| 2    | `rate_limit`    | back off, retry later, or route the task to a different agent                     |
| 3    | `hooks_missing` | Claude only; run `ccmux setup --agent claude`, then retry                         |
| 4    | `agent_error`   | agent-attributable; **see the cap/dup-id wrinkle below**                          |
| 124  | `timeout`       | the `--timeout` budget was exhausted; raise it (ceiling 30 min) or split the task |
| 130  | `cancelled`     | someone cancelled it (possibly you)                                               |

**`status` in `list --json`:** `running` | `succeeded` | `failed` | `cancelled`. On `failed`,
the `kind` field carries the same `InvokeErrorKind` as the exit table (`rate_limit`,
`timeout`, `agent_error`, `hooks_missing`, `unknown`). A timeout reads as
`status: "failed", kind: "timeout"` (there is no separate `timed_out` status).

**`cancelled` is first-class**, distinct from `failed`. So you can always tell _your own_
cancels apart from real failures: a worker you cancelled reads `cancelled`, never
`failed (cancelled)`.

### The concurrency-cap / dup-id wrinkle (exit 4)

Two different rejections both come back as `kind: "agent_error"` / exit 4, so the `kind`
alone is not enough to decide what to do. Disambiguate on the **message**:

- Message contains **`too many concurrent invocations`** (the daemon returns `too many
concurrent invocations (max 16)`): you hit the 16-in-flight cap. **Back off** (sleep a few
  seconds, or wait for an in-flight worker to finish via `list`), then retry the _same_ invoke.
- Message contains **`already in flight`** (`invocationId already in flight`): you reused an
  id that is still running. **Mint a fresh id** and retry; do not back off.

```bash
out=$(ccmux invoke codex "..." --id "$id" 2>&1); code=$?
if [ "$code" -eq 4 ] && printf '%s' "$out" | grep -q 'too many concurrent'; then
  sleep 5            # cap hit: back off and retry the same call
elif [ "$code" -eq 4 ] && printf '%s' "$out" | grep -q 'already in flight'; then
  id="inv_$(openssl rand -hex 6)"   # id collision: new id, retry
fi
```

This message-matching is a workaround: the error `kind` cannot by itself distinguish
"retry after backoff" from "collision, new id." Worth flagging if you find yourself doing it
a lot.

## Gotchas (read before a long run)

- **Admission lag: a freshly-fired id is briefly ABSENT from `list`.** A naive poll loop
  reads that absence as done and aborts at 0s; this is the most common way to break a
  fan-out. Full detail and the race-safe pattern: [references/joins.md](references/joins.md).
- **A `running` record has no liveness guarantee.** The store flips to a terminal status only
  when the invoke's own promise resolves. If a worker wedges (the underlying agent hangs in
  non-interactive mode, or exits without the invoker noticing), the record can sit at
  `running` until its `--timeout` fires or you `cancel` it; there is no heartbeat that notices
  the process died. So **do not poll a worker forever.** Track how long each id has been
  running (the `list` row shows a live age); if it has run far past what the task should take,
  `cancel` it and treat it as failed rather than waiting. Always set a deliberate `--timeout`
  so a wedge self-resolves even if you stop watching.
- **Smoke-test an agent before you depend on it.** Agents run non-interactively under invoke,
  and some agent/version combinations stall or fail on tasks that need interactive approval
  (notably file-_writing_ tasks) while the same agent answers a trivial prompt in seconds.
  Before building a long pipeline on an agent, fire one throwaway `ccmux invoke <agent>
"reply with: ok"` with a short `--timeout`. If it doesn't return cleanly, that agent isn't
  usable for invoke on this machine right now; route the task elsewhere. Prefer prompts that
  don't require the worker to get interactive approval mid-turn.
- **The store ages out 5 minutes after an invoke STARTS, not after it finishes.** Finished
  records linger only until `startedAt + 5min`, then vanish; running invokes are never aged
  out. So a long worker (the 30-min ceiling allows up to 30) can **finish and immediately be
  gone from `list`**, because the 5-minute clock started when it began. Consequence: if an id
  disappears from `list --json` and you have its stdout redirect file, **trust the file**; the
  absence is the TTL expiring, not a failure. Poll promptly after a long invoke, and rely on
  your redirect file (and, for subprocess agents, pull `result` quickly) rather than on the
  store sticking around.
- **The store is in-memory per daemon.** A `ccmux daemon restart` clears all invocation
  records and result files. Don't restart the daemon mid-orchestration.
- **`result` is ephemeral.** Per-daemon temp dir, ~5 MiB cap per invoke (truncated beyond),
  lost on restart/reboot/OS-reap. Read it soon after the worker finishes; it is a backup, not
  a log.
- **Prompt cap is 256 KB** (arg + stdin combined). Bigger inputs must be split or summarized
  before sending.
- **Timeout: default 5 min, ceiling 30 min** (`--timeout <ms>`, e.g. `--timeout 1800000`).
  A long implementation can hit the default; set `--timeout` deliberately for big jobs.
- **`--cwd` matters.** A worker that edits files acts in `--cwd` (defaults to your cwd). For
  anything that writes, point `--cwd` at the intended repo, or a scratch dir if you don't
  want it touching your tree.
- **Session resume is three tiers, not a boolean.** Claude and OpenCode hand a resumable id
  back through ccmux (the `sessionId` field on their `list --json` record); pass it to
  `--session <id>` to continue the same worker. Codex and Cursor _accept_ `--session <id>`
  but never hand an id back through ccmux, so resuming them means scraping the id out of
  `invoke result` output chrome; usually folding prior context into the next prompt is
  simpler. Pi and Gemini reject `--session` at the daemon. Every un-resumed invoke is a cold
  start.

## Cancelling

```bash
ccmux invoke cancel inv_implflag
```

Idempotent (exits 0 whether running, already finished, or unknown). It prints which case it
hit: `Cancelling <id>`, `<id> already finished (nothing to cancel)`, or `<id> not found
(cancel recorded in case it starts)`. The cancelled worker's record reads `status:
"cancelled"`, so a concurrent poll won't misread your cancel as a failure. Use cancel to
abort a worker that has run too long or whose result you no longer need (e.g. you got a good
answer from a faster sibling in a fan-out).

## Reading and relaying between existing sessions

Everything above launches _new_ workers. Moving output between sessions that already exist
(yours, the user's, another orchestrator's) is its own skill: **relay**. The
decision in one table:

| Motion              | Command                        | Payload goes                           |
| ------------------- | ------------------------------ | -------------------------------------- |
| **Read-and-reason** | `ccmux last <ref> [--turns N]` | to your stdout, i.e. into your context |
| **Relay**           | `ccmux handoff <from> <to>`    | daemon-side, straight into the target  |

When you are only a router, relay with `handoff` so the payload never enters your context.
The mechanics (session references, delivery outcomes, the receive-side protocol, and the
per-agent gotchas) live in the **relay** skill; load it via the Skill tool whenever
you relay between sessions or receive a message beginning `[ccmux handoff]`.

## Worked example

For a complete plan -> implement -> search pipeline (block-and-wait plan step, two-worker
fan-out, `wait` join, and collect, with the join-shape caveats applied end to end), read
[references/examples.md](references/examples.md) in this skill's directory. Adjust the agent
names to whatever policy the user gave you; the mechanics are identical.
