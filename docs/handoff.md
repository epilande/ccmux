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
  6fb3ae42-636f-4968-833e-8f3121472893  src:2.1  claude  idle  hs5-proj  /tmp/hs5-proj  [global]
  9ff6db28-4392-472e-80b9-2c0caa48f57a  src:1.1  claude  idle  hs5-proj  /tmp/hs5-proj  [global]
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
[ccmux handoff] from: <session-id> (<agent> · `<cwd>` · branch <branch>) at <YYYY-MM-DD HH:MM>
note: <note, if one was given>

<response text>
```

Live example, as it lands in the target's composer:

```
[ccmux handoff] from: 9ff6db28-4392-472e-80b9-2c0caa48f57a (claude · `/tmp/hs5-proj` · branch handoff-demo) at 2026-08-03 18:32

After tracing through the failure symptoms, my conclusion is that the retry loop
documented in README.md is the culprit...
```

Properties, all deliberate:

- **Greppable stable prefix** `[ccmux handoff]`. This shape is frozen; receiving agents are taught to recognize it.
- **The genuine header is the only line carrying that prefix at column 0.** A payload can contain its own `[ccmux handoff]` line, whether a peer quoting one back or an outright forgery, so any payload line that would pass for the real one is quoted with `> ` before the text is capped. A receiver identifies the header as the first line of the message and as the only unquoted one; everything below it is payload, including anything that imitates a header.
- **The cwd is backticked**, and that is load-bearing rather than decorative. Cursor's unsafe-reply guard is `/(^|\s)\/\S/`, which a bare absolute path after a space matches, so an unquoted cwd made ccmux's own header trip the delivery guard and refuse every handoff into a Cursor target. A branch name needs no such quoting, since git refuses a ref beginning with `/`.
- **The cwd is the pane's live directory** wherever the source has a pane, and the session's recorded cwd only when it does not. For a native Claude session that recorded cwd can be a `decodeProjectPath` guess, which cannot tell a `-` in a directory name from the `/` it encodes, and the receiving agent may `cd` into what the header quotes (issue #121). It is the same directory the branch segment is resolved against, so the two can never describe different places.
- **Short.** It is a tax paid on every handoff, so no YAML ceremony.
- **The branch segment is omitted cleanly** when the daemon does not already know one. It is never worth a `git` spawn.
- **Local time, minutes precision.**
- **A note is folded to one line.** The header's shape is one fact per line, and a multi-line note would make `note:` unparseable for anyone who learns it.
- **Because the header is prepended, the composed message can never lead with `/` or `!`**, which is what makes the header double as the slash/bang defuse for the whole paste.

The session id in the header is a **pointer**: the payload stays lean (one turn by default) because a receiving agent can pull more itself with `ccmux last <id> --turns N`. A handoff sends a business card, not the filing cabinet.

One measured caveat, and it is the reason the relay skill spends a paragraph on this: **an untaught receiver does not act on that pointer.** Measured 2026-08 against claude-code 2.1.x and codex 0.146.x: both a fresh Claude Code and a fresh Codex receiver recognized the handoff, noticed the missing context, and then reasoned about what they had rather than pulling more; Claude explicitly concluded the earlier turns "aren't available to me". The same receivers ran `ccmux last <id> --turns 5` immediately when the `--note` named the command. If you want the pointer used, put the command in the note. (A codex receiver additionally cannot reach the daemon from inside a turn under its default `workspace-write` sandbox, so send it the context rather than a pointer.)

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

| Target state | Behavior                                                       |
| :----------- | :------------------------------------------------------------- |
| `idle`       | deliver now                                                    |
| `working`    | queue, deliver when the target next reaches idle               |
| `waiting`    | **refuse**: a handoff is never used to answer a pending prompt |

There is deliberately no `--force`.

The queue holds **at most one pending handoff per target**. A second enqueue replaces the first and says so, because a queue of prompts would arrive as a burst of pastes the moment the target went idle, which is exactly the behavior the idle-only rule exists to avoid. Records expire after 30 minutes; expiry is logged, not reported back (the sender was already told it was queued).

**A guard that is already decidable refuses up front rather than queueing.** Both inputs to the unsafe-payload check are frozen the moment the text is composed (the composed text itself, and the target agent's own pattern), so a payload that agent can never receive is knowable at enqueue time and comes back as a 409 to a sender who is still listening. Queueing it instead would tell the sender "queued" and then drop the record half an hour later with nobody left to report it to.

**A failure at dequeue splits two ways**, because by then the sender has been told "queued" and is gone. A deterministic refusal (`unsafe-payload`, `not-at-agent`, `target-waiting`, `ambiguous-wait`, `no-pane`) drops the record and logs why: re-running a check that just said no would only say no again. A transient one (the tmux send failed, the target turned over between the readiness check and the paste, or `pane-not-ready`: a pane showing something other than an idle composer right now may well be showing one a second later) puts the record back with its attempt counted, for the next idle transition to retry, up to **3 attempts**. Retries never extend the TTL, so 30 minutes remains the outer bound either way.

**The queue is in memory.** A daemon restart drops every queued handoff, including ones whose senders were already told "queued". Nothing is persisted and nothing is reported when it happens, so a handoff that matters across a restart has to be re-sent.

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

| Reason           | Message                                                                                                                                                                                                  |
| :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambiguous-ref`  | the candidate listing above, naming which end was ambiguous                                                                                                                                              |
| `not-found`      | `Session not found for 'to': nope`                                                                                                                                                                       |
| `self-handoff`   | `A session cannot hand off to itself`                                                                                                                                                                    |
| `no-transcript`  | `Session <id> (<agent>) has no readable transcript. A handoff will not fall back to a pane capture: a screen scrape is not a prompt.`                                                                    |
| `empty-payload`  | `Session <id> has nothing to hand off (its last response is empty)`                                                                                                                                      |
| `target-waiting` | `Session <id> has a pending prompt. A handoff is never used to answer one: resolve it in the pane, then hand off again.`                                                                                 |
| `ambiguous-wait` | `Multiple sessions are waiting; press is ambiguous` (an aggregated OpenCode row: a paste could land on a sibling session's dialog)                                                                       |
| `no-pane`        | `Session <id> has no tmux pane to deliver into`                                                                                                                                                          |
| `not-at-agent`   | `Session <id> is no longer at the agent (pane foreground is "<cmd>")`                                                                                                                                    |
| `unsafe-payload` | `The composed handoff contains text <agent>'s composer cannot receive safely` (checked at enqueue as well as at delivery, so a busy target refuses instead of queueing something it could never receive) |
| `too-large`      | `The composed handoff exceeds the spawn prompt budget (<n> bytes > 120832); retry with fewer --turns` (`--spawn` only)                                                                                   |
| `target-busy`    | `Session <id> is <status>; a handoff is only ever delivered into an idle composer` (usually a dequeue; a direct request whose target changed status while the source was being read reaches it too)      |
| `pane-not-ready` | `Session <id> has something other than an empty composer on screen; a handoff is only ever delivered into an idle composer` (Claude targets only; transient, so a dequeue retries it)                    |

The `no-transcript` refusal is the one asymmetry worth calling out: `ccmux last` happily degrades to a pane capture, and a handoff will not. A screen scrape is fine to **read** and useless as a **prompt**: box drawing, spinners and half a composer are noise the receiving agent then has to reason about.

### The delivery guard stack

Everything runs server-side, and it runs in two places for two different reasons.

**At compose time**, before the request is routed by target status, the text is sanitized **twice**:

1. The transcript payload is control-char stripped as it is read.
2. The **final composed text** is stripped again, header included. A caller-supplied note is only whitespace-folded (`\x1b` is not `\s`) and a POSIX cwd may legally contain control bytes, so either can carry an ESC into the header. A literal ESC inside a bracketed paste can emit its `ESC[201~` terminator early and leak the remainder into the pane as live keystrokes, so nothing downstream of this point may be un-stripped.

That ordering is what makes the queue safe: a queued record holds the already-stripped text verbatim, so the delivery half never has to sanitize and never re-derives what gets pasted.

**At delivery time** the target checks run, in this order, and **every one of them runs again at dequeue** rather than being trusted from enqueue time (a queued handoff can wait half an hour, and every fact below can move in that window; the text cannot):

1. **Ambiguous wait** and **no pane** first: both disqualify the target outright, so queueing for one would only defer the same refusal.
2. **Status gate**: only `idle` delivers.
3. **Foreground liveness**, fail-closed. The reconciler keeps a dead agent's session idle with its pane still bound, so a handoff pasted after the agent exited would run a peer's prose as shell commands. A failed query counts as not-live.
4. **Per-agent `unsafeReplyPattern`**, then the leading `/`/`!` defuse. The header makes a leading trigger impossible, so the defuse is provably a no-op today and is run anyway; the per-agent unsafe shapes are not about the leading character (most composers trim before trigger detection, and Cursor fuzzy-matches a `/token` anywhere), so a payload containing one is a refusal rather than something a defuse can neutralize.

Check 4 is the one that _also_ runs at enqueue, for the reason the queue section gives: its two inputs are frozen at compose time, so a refusal it will certainly reach is better spent on a sender who is still listening. The other three depend on facts that move, and are therefore only ever asked at the moment of delivery.

**Cursor targets are the sharp edge.** Cursor's pattern is `/(^|\s)\/\S/`, which matches a slash after any whitespace and not just a leading one, so **a handoff whose payload mentions an absolute path is refused** (`unsafe-payload`, 409 at enqueue) when the target is Cursor. This is live-verified behavior of Cursor's composer, where a whitespace-preceded `/token` opens a fuzzy command popup that can swallow the submitting Enter, and not something ccmux can defuse on its behalf. Handoffs into Cursor work normally for path-free payloads; the header itself is safe because its cwd is backticked. Nothing else about Cursor is special here.

### Caps

| Cap                                 | Value         |
| :---------------------------------- | :------------ |
| Composed handoff (header + payload) | 65,536 chars  |
| Note                                | 500 chars     |
| Turns                               | 20            |
| Queue TTL                           | 30 minutes    |
| Delivery attempts (queued)          | 3             |
| Pending handoffs per target         | 1             |
| `--spawn` prompt budget             | 120,832 bytes |

The composed cap applies to the **final** text, header included, because it is a transport budget for what gets pasted, not a budget for the response that was read. Over-budget payloads are truncated tail-preserving with a leading `… ` marker, and the outcome line says `truncated`.

`--spawn` is budgeted a second time, and in **bytes** rather than chars. The composed text goes to the new agent in argv, so it is pre-checked against the spawn prompt budget before the spawn is attempted and refused with `too-large` if it overruns:

```
The composed handoff exceeds the spawn prompt budget (123456 bytes > 120832); retry with fewer --turns
```

The two budgets are close enough in size that only a multibyte-heavy payload separates them, which is exactly the case that reaches this: CJK or emoji text can sit comfortably under the 65,536-**char** cap and still overrun 120,832 **bytes**. It is caught in handoff's own terms rather than forwarded, which would return a 400 about an invalid `prompt` field the caller never sent.

## `ccmux send --stdin`

`ccmux send` takes its text from stdin instead of argv with `--stdin` (mutually exclusive with the positional text), which is what makes a large or multiline payload practical from a pipeline:

```bash
ccmux last codex | ccmux send %3 --stdin
printf 'line one\nline two\n' | ccmux send <id> --stdin --no-enter
```

`POST /sessions/:id/send` strips control characters up front, rejects a payload that strips to empty (a bare Enter would submit whatever already sits in the composer), and routes delivery by shape: single-line text under 10,000 chars goes argv-bound through `send-keys -l`, and anything multiline or longer goes through the stdin-fed `load-buffer` / `paste-buffer` path, capped at 65,536 chars.

`ccmux send` is **not** the gated path. It takes a session id or pane id (not the six-tier reference), and it applies none of the handoff guard stack: no status gate, no liveness check, no unsafe-pattern refusal. Use `ccmux handoff` when you want those.

That split is a decision, not a gap to be closed later. `ccmux send` stays the raw low-level escape hatch (an exact id or pane, no resolver, and none of the handoff guard stack beyond the control-char strip and the paste caps), precisely so there is one path that types exactly what you asked into exactly the pane you named, and `ccmux handoff` is where the guards live.

## TUI

### Hand off

The picker's row menu (right-click, or `m` on the selected row) has a **Hand off** item, offered on any row while another session is on the board. It starts a pick-a-target mode rather than opening a second list: the session list itself becomes the target picker, with a banner naming the source (`⇄ Hand off from <agent · project> · pick a target · enter continue · esc cancel`). While aiming, `j`/`k` and the arrows move, `Esc` or `q` cancels, and every other key is swallowed so `x` is never one keystroke from killing the row being pointed at.

The aim starts on the next row down from the source (wrapping past the end of the list if it has to), and the source row is hopped over by every move, in both directions, because it is the one row the pick can never settle on. A hop that runs out of list holds position rather than wrapping, the way an ordinary move stops at the edge. The mode closes itself with a toast if the gesture loses its meaning under it: `The session being handed off is gone` when an SSE update removes the source, `No other session left to hand off to` when the last row that was not the source leaves the board.

`Enter` (or a click on a row) settles WHO and opens the **handoff dialog**, which settles what they get. Nothing has been sent at that point. The dialog names both ends (the target in its title, the source under it) and asks two things:

- **Turns**, the same selector the Copy dialog uses and with the same keys (`j`/`k` and the arrows count between 1 and `MAX_TURNS`, a digit jumps straight to a count, a leading `1` or `2` waits for one more so `1` `2` is 12 and `2` `5` is 5). It opens on **Last response**, so the fast path is still pick, `Enter`, `Enter`.
- **Note**, an optional one-liner for the receiving agent, folded into the provenance header by the daemon. `Tab` moves between the two rows; the note row owns every printable key while it has focus, digits included, and the arrows move back to Turns there the way they do in the new-session dialog's text fields.

`Enter` from either row sends. `Esc` cancels the WHOLE handoff in one keystroke: the pick mode ended when the dialog opened, so there is no aiming mode left behind it.

Both ends go to `POST /handoff` as session ids, with the count the dialog was showing and the note if one was typed (a blank note is omitted rather than sent empty). No ambiguity refusal is possible here, since the pick is the disambiguation. The outcome lands in a toast: `Handed 532 chars to <target>`, `Queued for <target> (1,769 chars); it lands when the turn ends`, or `Handoff refused: <the daemon's reason, verbatim>`.

While a handoff is queued for a session, its row carries a **⇄** badge. It is driven straight off `pendingHandoff`, so it appears and clears with the SSE update that changed the fact, with no client-side timer, and it survives sidebar width.

### Copy

The row menu also has a **Copy** item, and `y` on the selected row is the same thing without the menu (one key into the same dialog, which is why the menu item advertises `y` as its hint). It opens a small centered dialog asking how much of the conversation to take, rather than copying at once. The dialog opens on **Last response** (one turn), so the fast path is `y`, `Enter`.

`y` is silent on a group header, as `r` and `x` are. On a row with neither a pane nor a transcript it says so in a toast rather than doing nothing: the menu can hide an item it cannot offer, but a key the help overlay lists unconditionally has to answer.

While it is open: `j`/`k` (and the arrows) count turns between 1 and `MAX_TURNS` (20), a digit jumps straight to a count (a leading `1` or `2` also waits for one more digit, so `1` `2` is 12 and `2` `5` is 5), `Enter` copies, `Esc` cancels, and any other key dismisses it without copying. Past one turn the dialog reads **Last N turns (with your prompts)**, which is what the payload becomes.

The copy reads the same transcript endpoint with `turns=N`. One turn is the response on its own; more than one is rendered by the same `renderTurns` that `ccmux last` prints, `user:` / `assistant:` prefixes and all, so the clipboard and the CLI produce identical text for the same turns. The result lands in a toast (`Copied 1,234 chars`, plus `(truncated)` or `(pane capture)` when either applies). The item is hidden for a row with neither a pane nor a transcript path, and every other refusal comes back from the daemon into the toast.

Two clipboard tiers, tried in an order that depends on where the picker is running (`src/tui/utils/clipboard.ts`):

- A local clipboard **command** (`pbcopy` on macOS; `wl-copy` then `xclip` on Linux, Wayland first because `xclip` under Wayland can succeed into a clipboard nothing reads). Its exit code is ground truth.
- **OSC 52**, an escape sequence the terminal itself acts on, and the only tier that reaches the machine the user is sitting at when the picker runs over SSH.

The command goes first **everywhere except an SSH session** (`SSH_TTY` / `SSH_CONNECTION`), where the order flips. The reason is that OSC 52 cannot be verified from this side: inside tmux the sequence is wrapped in tmux's DCS passthrough and the write reports success, which says nothing about whether anything received it (tmux forwards it only with `allow-passthrough` on, off by default since tmux 3.3, and the outer terminal then has to honour OSC 52 as well). A locally-running picker that led with OSC 52 could show "Copied" over an unchanged clipboard. Over SSH the local command would copy to the **remote** machine's clipboard, which is worse than unverifiable.

## HTTP API

```
GET  /sessions/:ref/transcript?turns=N&callerPane=%N
POST /handoff  {from, to?, turns?, note?, callerPane?, spawn?}
```

`GET /sessions/:ref/transcript` answers 200 with the contract above, 404 for an unknown ref, 409 with `candidates` for an ambiguous one, and 400 when there is neither a readable transcript nor a usable pane capture, or when `turns` is not a whole number.

`POST /handoff` answers 200 with `{status: "delivered" | "queued" | "spawned", from, to, chars, truncated, ...}`, 400 for a malformed request or a self-handoff, 404 for an unresolvable end, and 409 for every guard refusal (each carrying a `reason`). `spawn` is `true` for the bare form or an object with `agent` / `cwd` overrides, and is mutually exclusive with `to`.

`turns` defaults to 1 and is refused outside 1-`MAX_TURNS` (20), as is a value that is not a count at all: both endpoints validate it as an integer (or an all-digit string) rather than coercing, since `Number(true)` is 1 and would have sent one turn behind a 200 for a caller who sent nonsense. The transcript endpoint still CLAMPS an integer it cannot fully serve: a read gets the most it can have, where a paste refuses so the sender learns their count did not travel. A `note` of pure whitespace is refused for the same reason: the header drops it, and a 200 would say it was sent. One turn is the last response bare, exactly what every caller that omits the field has always received; more than one is rendered by the same `renderTurns` that `ccmux last --turns N` prints, so a receiver sees what the CLI would have shown for the same count. The payload is composed **before** the target's status is branched on, so a queued handoff holds the finished bytes rather than a request to be re-read when the turn ends, and the cap, the control-char strip and every delivery guard apply identically whatever the count.

## Where to look in the code

| Concern                                                  | Path                                              |
| :------------------------------------------------------- | :------------------------------------------------ |
| Session reference resolution (tiers, proximity, refusal) | `src/daemon/session-ref.ts`                       |
| Backwards line walk, JSONL turn fold, size guards        | `src/daemon/transcript-read.ts`                   |
| Shared turn rendering (`ccmux last`, Copy, handoff)      | `src/daemon/transcript-read.ts` (`renderTurns`)   |
| Per-agent readers + registry                             | `src/daemon/transcript-readers/`                  |
| Provenance header, compose, queue                        | `src/daemon/handoff.ts`                           |
| Endpoints, guard stack, delivery, `--spawn`              | `src/daemon/server.ts`                            |
| Shared delivery-safety guards                            | `src/daemon/send-guards.ts`                       |
| `ccmux last` / `ccmux handoff` CLIs                      | `src/commands/last.ts`, `src/commands/handoff.ts` |
| TUI clipboard tiers                                      | `src/tui/utils/clipboard.ts`                      |
| The Copy dialog (row budget)                             | `src/tui/components/CopyDialog.tsx`               |
| The handoff dialog (row budget, both fields)             | `src/tui/components/HandoffDialog.tsx`            |
| The shared turns selector (label, digit rules)           | `src/tui/turns-selection.ts`                      |
