# Fire-and-poll joins without a background-job mechanism

The push join in SKILL.md (background the blocking invoke as a harness job and let the
harness wake you) is the best join there is. If your harness has a background-job/notify
mechanism (e.g. Claude Code's Bash `run_in_background`), use that and skip this file
entirely. The two join shapes below exist for harnesses without one; they get
progressively more manual, so prefer `wait` over the store poll.

## Join (`wait` on the client PIDs)

When one shell stays alive for the whole run (but your harness has no background-job/notify
mechanism), **`wait` is the join.** Background each invoke with a shell `&`, redirect its
output to a file keyed by the id, and capture the PID:

```bash
mkdir -p /tmp/ccmux-orch
id="inv_implflag"

# Fire: shell-background it, redirect BOTH streams to a file keyed by the id, capture the PID.
ccmux invoke codex "Implement the --dry-run flag end to end. Report a concise summary." \
  --id "$id" --cwd /path/to/repo \
  > "/tmp/ccmux-orch/$id.out" 2> "/tmp/ccmux-orch/$id.err" &
pid=$!
```

The backgrounded `ccmux invoke` client blocks until the invoke finishes daemon-side, then
exits with the agent's exit code, so `wait` joins on it cleanly (and sidesteps the
store-admission race below):

```bash
wait "$pid"; rc=$?    # rc is the agent's exit code (0 ok; see the exit table in SKILL.md)
echo "$id finished, exit=$rc"
cat "/tmp/ccmux-orch/$id.out"
```

For a fan-out, capture every PID and `wait` on each. `list` is still useful here for live
observability (status + age while they run), but `wait` is what you join on. **Caveat: this
only works if all the `&`'d jobs share one shell that stays alive.** If your harness runs each
Bash call in a fresh subshell, the PIDs aren't yours to `wait` on in a later call (`wait`
returns 127), fall through to the race-safe poll below.

## Join, fallback (poll the store, race-safely)

When neither push nor `wait` fits (no harness background jobs, and no single shell stays alive
across the run), poll `ccmux invoke list --json` for the id's `status`. This is the most manual
shape; reach for it only when the two above don't apply. **The store has an admission lag:**
for a second or three right after the fire, a freshly-started id is **not yet in the store**.
A naive `break unless running` join reads that brief absence as "done" and aborts at 0s,
which is the easiest way to get this wrong. Treat "absent" as **keep
waiting** until you've seen the id at least once; only an absence _after_ you've seen it means
finished-and-aged-out.

```bash
id="inv_implflag"; seen=0; start=$(date +%s)
deadline=1900   # overall cap in seconds; set a bit above the worker's --timeout budget
while true; do
  elapsed=$(( $(date +%s) - start ))
  # Never poll a worker forever: a wedged invoke sits at `running` until its --timeout.
  [ "$elapsed" -gt "$deadline" ] && { status="gave up watching"; break; }
  status=$(ccmux invoke list --json | jq -r --arg id "$id" \
    '.[] | select(.invocationId==$id) | .status')
  case "$status" in
    running)                     seen=1; sleep 5 ;;          # in flight
    succeeded|failed|cancelled)  break ;;                    # terminal
    "")  # absent from the store
      if [ "$seen" = 1 ]; then status="aged out"; break; fi  # was running, so finished: trust the file
      # not admitted yet (admission race). Wait, but not forever:
      [ "$elapsed" -gt 60 ] && { status="never appeared"; break; }
      sleep 2 ;;
  esac
done
echo "final status: $status"
```

Poll every few seconds, not in a tight loop. Each invoke pays ~5-15s cold start before the
worker even begins, so sub-second polling just burns cycles. If `status` ends `aged out`,
that is **not** a failure (see "The store ages out" in SKILL.md's gotchas); read your
redirect file.

> **Do not run the fire + poll-loop as one long foreground shell command.** A worker can run
> for minutes (the timeout ceiling is 30). If your shell tool has a wall-clock limit (most
> do, e.g. ~10 min) and your poll loop blows past it, the shell is killed mid-loop, which is
> harmless if you used the push join (the invoke runs daemon-side and the harness still wakes
> you), but **fatal if you shell-`&`'d a blocking invoke for the `wait` path**: the kill
> SIGHUPs that client and you lose its stdout redirect (the file ends up empty, and for Claude
> that redirect is the only copy of the result). So keep each poll call short: fire in one
> call, then poll in **separate, short calls** that each check `list --json` a bounded number
> of times and return, so control comes back to you between polls and no single call runs long
> enough to be killed. Always cap the loop (the `deadline` guard above) rather than
> `while true`. The invoke itself runs **daemon-side** and keeps going across your turns
> regardless; you are only ever polling a record, never holding the worker open.

## The admission race in full

A freshly-fired id is briefly **absent** from `list`. For a second or three after the fire,
the id is not yet in the store; a join that "breaks unless status==running" reads that
absence as done and aborts at 0s while the worker is fine and running daemon-side. **This is
the most common way to break a fan-out.** Either `wait` on the client PID (no store
involved, so no race), or poll race-safely (treat absent-before-first-sighting as
keep-waiting, per the fallback join above).
