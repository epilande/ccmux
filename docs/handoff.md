# Reading and handing off between sessions

Two commands, one capability. `ccmux last` **reads** a session's last response and prints it. `ccmux handoff` **relays** it into another session without the text ever passing through the caller.

The difference is where the payload ends up. `ccmux last` puts it on your stdout, which for an agent means "into my own context". `ccmux handoff` composes it inside the daemon and pastes it into the target's composer, so an orchestrating agent can move a peer's 8 KB answer to another peer for the price of one command line.

Underneath both sits one daemon capability: reading a session's own transcript, for every built-in agent, with tool inputs and outputs never inlined.

## Quickstart

```bash
# Read a peer's last response (stdout is pure payload, so it pipes)
ccmux last 9ff6db28-4392-472e-80b9-2c0caa48f57a
ccmux last codex | pbcopy
ccmux last work:1.0 --turns 3

# Relay it, daemon-side, into another session
ccmux handoff codex claude --note "this is the failing test, take it from here"

# An agent handing off its own conclusion
ccmux handoff self codex --note "..."

# Or into a session that does not exist yet
ccmux handoff self --spawn --agent codex
```

## Session references

Both commands take a **session reference** rather than only an id. Six tiers, tried in order, stopping at the first tier with any match (`src/daemon/session-ref.ts`):

| Tier | Form                           | Example                                | Exact |
| :--- | :----------------------------- | :------------------------------------- | :---- |
| 1    | ccmux session id               | `9ff6db28-4392-472e-80b9-2c0caa48f57a` | yes   |
| 2    | tmux pane id                   | `%0`                                   | yes   |
| 3    | tmux coordinate                | `src:1.1`                              | yes   |
| 4    | `self` (the caller's own pane) | `self`                                 | yes   |
| 5    | agent type                     | `codex`                                | no    |
| 6    | project / directory name       | `ccmux`                                | no    |

The exact tiers **claim their syntax**. A ref shaped like a pane (`%99`), a coordinate, or the literal `self` that matches nothing answers `Session not found` and deliberately does not fall through to the fuzzy tiers, so a mistyped pane id can never quietly become a project search that lands somewhere unrelated.

The fuzzy tiers are scoped by where the caller is sitting: **same window > same tmux session > global**. The nearest scope that holds any match decides, and a unique match there wins even when farther matches exist. Proximity comes from `$TMUX_PANE`, which both CLIs forward as `callerPane`; outside tmux every fuzzy search simply runs at global scope.

`self` is the reference an agent uses about itself. It resolves through the same `$TMUX_PANE`, so it works from inside an agent's own shell tool and nowhere else.

### Ambiguity refuses, never guesses

More than one match in the deciding scope is a **refusal carrying the full candidate list**, sorted nearest-first. There is no tie-break on recency or status and deliberately no `--first`-style override: the listing is the recovery path.

```
$ ccmux last claude
Ambiguous session reference "claude" (2 matches):
  6fb3ae42-636f-4968-833e-8f3121472893  src:2.1  claude  idle  /tmp/hs5-proj  [global]
  9ff6db28-4392-472e-80b9-2c0caa48f57a  src:1.1  claude  idle  /tmp/hs5-proj  [global]
Re-run with one of the ids or coordinates above.
```

Each row carries an id and a coordinate precisely so the next command can be typed straight off it. `ccmux handoff` refuses the same way at either end and names which end was ambiguous. An ambiguous `to` matters most: delivering a prompt into the wrong session is the worst thing this feature can do, so it is the one thing it will not risk.

### Non-exact resolutions echo to stderr

stdout stays pure payload so `ccmux last codex | pbcopy` is clean. A fuzzy pick is reported on stderr instead:

```
$ ccmux last claude > out.txt
claude -> 9ff6db28-4392-472e-80b9-2c0caa48f57a (global)
```

Exact refs print nothing: there is nothing to explain about a ref that named its session outright.

## `ccmux last`

```
ccmux last <session-ref> [options]

Arguments:
  session-ref      Session id, %pane, session:window.pane, self, agent type,
                   or project name

Options:
  -t, --turns <n>  How many turns back to include (default: 1, max 20)
  --json           Print the raw transcript response
```

A **turn** is one user to assistant exchange, counted backwards from the end of the transcript, and only completed turns count. `--turns N` yields N assistant entries plus only the prompts **between** them, never a leading prompt: `--turns 1` is exactly one assistant entry, `--turns 2` is `[assistant, user, assistant]`, i.e. 2N-1 entries. A transcript that runs out early produces the same shape with fewer entries, so asking for more than exists is harmless.

A single entry prints bare (it **is** the last response). Several print with `user:` / `assistant:` labels, oldest first, so the exchange reads in order.

`--turns` outside 1-20 is rejected client-side before any request goes out:

```
$ ccmux last <id> --turns 50
Invalid --turns value (expected 1-20)
```

`--json` prints the raw daemon response, which is also what `GET /sessions/:ref/transcript` answers:

```jsonc
{
  "sessionId": "9ff6db28-4392-472e-80b9-2c0caa48f57a",
  "agentType": "claude",
  "source": "transcript", // "pane" = degraded fallback
  "turns": [
    {
      "role": "assistant",
      "text": "...",
      "timestamp": "2026-08-04T01:28:37.192Z",
    },
  ],
  "truncated": false, // true if any size guard dropped content
  "resolution": {
    // how the :ref was read
    "ref": "claude",
    "tier": "agent-type", // id | pane | coordinate | self | agent-type | project
    "exact": false,
    "proximity": "global", // same-window | same-session | global | null
  },
}
```

`resolution` is additive and optional; a consumer that does not care about it can ignore it. `timestamp` is absent for agents whose format carries none (Cursor).

### What can be read

Every built-in agent has a transcript reader (`src/daemon/transcript-readers/`): claude, codex, copilot, cursor, pi, omp, antigravity, opencode, gemini. Tool inputs and outputs are never inlined, in any format.

What a reader needs is the session's transcript location, and that comes from different places per agent:

- **Most agents** read `session.logPath`, which the daemon learns from the agent's ccmux marker (`transcript_path`) or from log discovery. A session whose transcript ccmux has not located yet reads as "nothing to read" rather than an error.
- **OpenCode** queries its SQLite database by native session id.
- **Gemini** locates its chat file from the session's cwd, because Gemini has no hooks and therefore no marker.

When there is nothing to read, `ccmux last` falls back to a **pane capture** and says so with `source: "pane"`: role is nominal there, since a screen scrape is not a parsed turn. A session with neither a readable transcript nor a pane is a 400 naming which.

### Size guards

| Guard                | Value        | Behavior                                                         |
| :------------------- | :----------- | :--------------------------------------------------------------- |
| Turns per request    | 20           | clamped daemon-side, rejected client-side                        |
| Text per turn        | 20,000 chars | truncated **tail-preserving** (a response's point is at its end) |
| Transcript line size | 256 KiB      | the line is skipped unparsed (in practice always a tool result)  |

Any guard that dropped content sets `truncated: true`.

## `ccmux handoff`

```
ccmux handoff <from> [to] [options]

Arguments:
  from               Source ref (any of the six forms above)
  to                 Target ref, same forms (omit with --spawn)

Options:
  -t, --turns <n>    How many turns of context to include (default: 1, max 20)
  -n, --note <text>  One-line note for the receiving agent (max 500 chars)
  --spawn            Open a new session for the handoff instead of naming one
  --agent <name>     Agent for --spawn (default: the source's agent)
  --cwd <path>       Directory for --spawn (default: the source's cwd)
  --json             Print the raw handoff response
```

The payload is read and composed **inside the daemon**. It never transits the caller's context, and the provenance header can therefore be trusted to describe the session it names.

### The provenance header (frozen)

Every handoff arrives with this prepended:

```
[ccmux handoff] from: <session-id> (<agent> · <cwd> · branch <branch>) at <YYYY-MM-DD HH:MM>
note: <note, if one was given>

<response text>
```

Live example, as it lands in the target's composer:

```
[ccmux handoff] from: 9ff6db28-4392-472e-80b9-2c0caa48f57a (claude · /tmp/hs5-proj · branch handoff-demo) at 2026-08-03 18:32

After tracing through the failure symptoms, my conclusion is that the retry loop
documented in README.md is the culprit...
```

Properties, all deliberate:

- **Greppable stable prefix** `[ccmux handoff]`. This shape is frozen; receiving agents are taught to recognize it.
- **Short.** It is a tax paid on every handoff, so no YAML ceremony.
- **The branch segment is omitted cleanly** when the daemon does not already know one. It is never worth a `git` spawn.
- **Local time, minutes precision.**
- **A note is folded to one line.** The header's shape is one fact per line, and a multi-line note would make `note:` unparseable for anyone who learns it.
- **Because the header is prepended, the composed message can never lead with `/` or `!`**, which is what makes the header double as the slash/bang defuse for the whole paste.

The session id in the header is a **pointer**: the payload stays lean (one turn by default) because a receiving agent can pull more itself with `ccmux last <id> --turns N`. A handoff sends a business card, not the filing cabinet.

One measured caveat, and it is the reason the dispatch skill spends a paragraph on this: **an untaught receiver does not act on that pointer.** In live tests, both a fresh Claude Code and a fresh Codex receiver recognized the handoff, noticed the missing context, and then reasoned about what they had rather than pulling more; Claude explicitly concluded the earlier turns "aren't available to me". The same receivers ran `ccmux last <id> --turns 5` immediately when the `--note` named the command. If you want the pointer used, put the command in the note.

### Outcomes

`ccmux handoff` prints exactly one line per outcome to stdout, with refusals and resolution echoes on stderr.

**Delivered** (target was idle):

```
Delivered 9ff6db28-4392-472e-80b9-2c0caa48f57a -> 6fb3ae42-636f-4968-833e-8f3121472893 (claude): 532 chars.
```

**Queued** (target was mid-turn):

```
Queued for 6fb3ae42-636f-4968-833e-8f3121472893 (claude is working): 1,769 chars. It will be delivered when the turn ends.
Replaced a pending handoff from 9ff6db28-4392-472e-80b9-2c0caa48f57a.
```

**Spawned** (`--spawn`):

```
Spawned claude in /tmp/hs5-proj (pane %3) with the handoff as its opening prompt: 1,752 chars.
```

A codex spawn adds a note on stderr, because codex asks to trust a directory the first time it runs there and holds the initial prompt behind that question. The new pane looks stalled until someone answers it; ccmux surfaces that rather than answering a trust prompt on the user's behalf.

Every outcome line reports the composed size, and appends `, truncated` when a size guard dropped content.

### Why a handoff is only ever typed into an idle composer

The whole safety case rests on one rule. Typing text and Enter into an **idle** composer is verified for all nine built-in agents (it is the same path a notification reply takes). What **mid-turn** typed input does is verified for none of them, Claude included. So:

| Target state | Behavior                                                        |
| :----------- | :-------------------------------------------------------------- |
| `idle`       | deliver now                                                     |
| `working`    | queue, deliver when the target next reaches idle                |
| `waiting`    | **refuse** — a handoff is never used to answer a pending prompt |

There is deliberately no `--force`.

The queue holds **at most one pending handoff per target**. A second enqueue replaces the first and says so, because a queue of prompts would arrive as a burst of pastes the moment the target went idle, which is exactly the behavior the idle-only rule exists to avoid. Records expire after 30 minutes; expiry is logged, not reported back (the sender was already told it was queued).

A queued handoff is visible on the wire as an optional `pendingHandoff` field on the session, so a TUI can render it:

```jsonc
"pendingHandoff": {
  "fromSessionId": "9ff6db28-4392-472e-80b9-2c0caa48f57a",
  "queuedAt": "2026-08-04T01:38:07.335Z"
}
```

The payload itself is deliberately not on the wire: it is a prompt for the target agent, not content for a session list. Delivery waits for **any** transition into idle, not `working -> idle` specifically, because a target can pass through `waiting` on its way out of a turn and the handoff is still owed a delivery.

### Refusals

Each one is a refusal on purpose. All are printed verbatim by the CLI.

| Reason           | Message                                                                                                                               |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| `ambiguous-ref`  | the candidate listing above, naming which end was ambiguous                                                                           |
| `not-found`      | `Session not found for 'to': nope`                                                                                                    |
| `self-handoff`   | `A session cannot hand off to itself`                                                                                                 |
| `no-transcript`  | `Session <id> (<agent>) has no readable transcript. A handoff will not fall back to a pane capture: a screen scrape is not a prompt.` |
| `empty-payload`  | `Session <id> has nothing to hand off (its last response is empty)`                                                                   |
| `target-waiting` | `Session <id> has a pending prompt. A handoff is never used to answer one: resolve it in the pane, then hand off again.`              |
| `ambiguous-wait` | `Multiple sessions are waiting; press is ambiguous` (an aggregated OpenCode row: a paste could land on a sibling session's dialog)    |
| `no-pane`        | `Session <id> has no tmux pane to deliver into`                                                                                       |
| `not-at-agent`   | `Session <id> is no longer at the agent (pane foreground is "<cmd>")`                                                                 |
| `unsafe-payload` | `The composed handoff contains text <agent>'s composer cannot receive safely`                                                         |
| `target-busy`    | `Session <id> is <status>; a handoff is only ever delivered into an idle composer` (dequeue-time only)                                |

The `no-transcript` refusal is the one asymmetry worth calling out: `ccmux last` happily degrades to a pane capture, and a handoff will not. A screen scrape is fine to **read** and useless as a **prompt** — box drawing, spinners and half a composer are noise the receiving agent then has to reason about.

### The delivery guard stack

Everything below runs server-side, in this order, and **re-runs at dequeue time** rather than trusting what passed at enqueue time (a queued handoff can wait half an hour, and every fact it checked can have moved):

1. **Ambiguous wait** and **no pane** first: both disqualify the target outright, so queueing for one would only defer the same refusal.
2. **Status gate**: idle delivers, working queues, waiting refuses.
3. **Foreground liveness**, fail-closed. The reconciler keeps a dead agent's session idle with its pane still bound, so a handoff pasted after the agent exited would run a peer's prose as shell commands. A failed query counts as not-live.
4. **Control-char strip** on the final composed text. A literal ESC inside a bracketed paste can emit its `ESC[201~` terminator early and leak the remainder into the pane as live keystrokes. The transcript payload is stripped when it is read, and the composed text is stripped again: a caller-supplied note is only whitespace-folded (`\x1b` is not `\s`), and a POSIX cwd may legally contain control bytes, so either can carry an ESC into the header.
5. **Per-agent `unsafeReplyPattern`**, then the leading `/`/`!` defuse. The header makes a leading trigger impossible, so the defuse is provably a no-op today and is run anyway; the per-agent unsafe shapes are not about the leading character (most composers trim before trigger detection, and Cursor fuzzy-matches a `/token` anywhere), so a payload containing one is a refusal rather than something a defuse can neutralize.

### Caps

| Cap                                 | Value        |
| :---------------------------------- | :----------- |
| Composed handoff (header + payload) | 65,536 chars |
| Note                                | 500 chars    |
| Turns                               | 20           |
| Queue TTL                           | 30 minutes   |
| Pending handoffs per target         | 1            |

The composed cap applies to the **final** text, header included, because it is a transport budget for what gets pasted, not a budget for the response that was read. Over-budget payloads are truncated tail-preserving with a leading `… ` marker, and the outcome line says `truncated`. The same cap governs `--spawn`, which sits well under `POST /spawn`'s own prompt budget, so a handoff behaves identically whichever way it lands.

## `ccmux send --stdin`

`ccmux send` takes its text from stdin instead of argv with `--stdin` (mutually exclusive with the positional text), which is what makes a large or multiline payload practical from a pipeline:

```bash
ccmux last codex | ccmux send %3 --stdin
printf 'line one\nline two\n' | ccmux send <id> --stdin --no-enter
```

`POST /sessions/:id/send` strips control characters up front, rejects a payload that strips to empty (a bare Enter would submit whatever already sits in the composer), and routes delivery by shape: single-line text under 10,000 chars goes argv-bound through `send-keys -l`, and anything multiline or longer goes through the stdin-fed `load-buffer` / `paste-buffer` path, capped at 65,536 chars.

`ccmux send` is **not** the gated path. It takes a session id or pane id (not the six-tier reference), and it applies none of the handoff guard stack: no status gate, no liveness check, no unsafe-pattern refusal. Use `ccmux handoff` when you want those.

## TUI: Copy last response

The picker's row menu (right-click, or `m` on the selected row) has a **Copy last response** item. It reads the same transcript endpoint with `turns=1` and puts the text on the clipboard, reporting the result in a toast (`Copied 1,234 chars`, plus `(truncated)` or `(pane capture)` when either applies). It is hidden for a row with neither a pane nor a transcript path, and every other refusal comes back from the daemon into the toast.

Two clipboard tiers, tried in an order that depends on where the picker is running (`src/tui/utils/clipboard.ts`):

- A local clipboard **command** (`pbcopy` on macOS; `wl-copy` then `xclip` on Linux, Wayland first because `xclip` under Wayland can succeed into a clipboard nothing reads). Its exit code is ground truth.
- **OSC 52**, an escape sequence the terminal itself acts on, and the only tier that reaches the machine the user is sitting at when the picker runs over SSH.

The command goes first **everywhere except an SSH session** (`SSH_TTY` / `SSH_CONNECTION`), where the order flips. The reason is that OSC 52 cannot be verified from this side: inside tmux the sequence is wrapped in tmux's DCS passthrough and the write reports success, which says nothing about whether anything received it (tmux forwards it only with `allow-passthrough` on, off by default since tmux 3.3, and the outer terminal then has to honour OSC 52 as well). A locally-running picker that led with OSC 52 could show "Copied" over an unchanged clipboard. Over SSH the local command would copy to the **remote** machine's clipboard, which is worse than unverifiable.

## HTTP API

```
GET  /sessions/:ref/transcript?turns=N&callerPane=%N
POST /handoff  {from, to?, turns?, note?, callerPane?, spawn?}
```

`GET /sessions/:ref/transcript` answers 200 with the contract above, 404 for an unknown ref, 409 with `candidates` for an ambiguous one, and 400 when there is neither a readable transcript nor a usable pane capture.

`POST /handoff` answers 200 with `{status: "delivered" | "queued" | "spawned", from, to, chars, truncated, ...}`, 400 for a malformed request or a self-handoff, 404 for an unresolvable end, and 409 for every guard refusal (each carrying a `reason`). `spawn` is `true` for the bare form or an object with `agent` / `cwd` overrides, and is mutually exclusive with `to`.

## Where to look in the code

| Concern                                                  | Path                                              |
| :------------------------------------------------------- | :------------------------------------------------ |
| Session reference resolution (tiers, proximity, refusal) | `src/daemon/session-ref.ts`                       |
| Backwards line walk, JSONL turn fold, size guards        | `src/daemon/transcript-read.ts`                   |
| Per-agent readers + registry                             | `src/daemon/transcript-readers/`                  |
| Provenance header, compose, queue                        | `src/daemon/handoff.ts`                           |
| Endpoints, guard stack, delivery, `--spawn`              | `src/daemon/server.ts`                            |
| Shared delivery-safety guards                            | `src/daemon/send-guards.ts`                       |
| `ccmux last` / `ccmux handoff` CLIs                      | `src/commands/last.ts`, `src/commands/handoff.ts` |
| TUI clipboard tiers                                      | `src/tui/utils/clipboard.ts`                      |
