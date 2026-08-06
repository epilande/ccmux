# Fire-and-poll joins without a background-job mechanism

The push join in SKILL.md is the best join there is: if your harness can background a job
and notify you on completion (e.g. Claude Code's Bash `run_in_background`), use it and skip
this file. The two shapes below are for harnesses without one; they get progressively more
manual, so prefer `wait` over the store poll.

## Join (`wait` on the client PIDs)

When one shell stays alive for the whole run, **`wait` is the join.** Background each
invoke with a shell `&`, redirect its output to a file keyed by the id, capture the PID:

```bash
mkdir -p /tmp/ccmux-orch
id="inv_implflag"

# Fire: shell-background it, redirect BOTH streams to a file keyed by the id, capture the PID.
ccmux invoke codex "Implement the --dry-run flag end to end. Report a concise summary." \
  --id "$id" --cwd /path/to/repo \
  > "/tmp/ccmux-orch/$id.out" 2> "/tmp/ccmux-orch/$id.err" &
pid=$!
```

The backgrounded client blocks until the invoke finishes daemon-side, then exits with the
agent's exit code, so `wait` joins cleanly (and no store means no admission race):

```bash
wait "$pid"; rc=$?    # rc is the agent's exit code (0 ok; see the exit table in SKILL.md)
cat "/tmp/ccmux-orch/$id.out"
```

For a fan-out, capture every PID and `wait` on each (`list` is still useful for live
status + age while they run). **Caveat: all the `&`'d jobs must share one shell that stays
alive.** If your harness runs each Bash call in a fresh subshell, the PIDs aren't yours to
`wait` on later (`wait` returns 127); fall through to the race-safe poll below.

## Join, fallback (poll the store, race-safely)

When no single shell stays alive across the run either, poll `ccmux invoke list --json`
for the id's `status`. **The store has an admission lag**: for a second or three after the
fire, the id is **not yet in the store**, and a naive `break unless running` join reads
that brief absence as "done", aborting at 0s while the worker runs fine daemon-side. This
is the most common way to break a fan-out. Treat "absent" as **keep waiting** until you
have seen the id at least once; only an absence _after_ a sighting means
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

Poll every few seconds, not in a tight loop (each invoke pays a ~5-15s cold start). A final
status of `aged out` is **not** a failure (see "The store ages out" in SKILL.md's gotchas);
read your redirect file.

> **Do not run the fire + poll-loop as one long foreground shell command.** A worker can
> run for up to 30 minutes; if your shell tool's wall-clock limit (often ~10 min) kills the
> loop mid-run, that is harmless under the push join but **fatal if you shell-`&`'d a
> blocking invoke for the `wait` path**: the kill SIGHUPs the client and its redirect file
> ends up empty (for Claude, the only copy of the result). So fire in one call, then poll
> in **separate, short calls** that each check `list --json` a bounded number of times and
> return. Cap the loop (the `deadline` guard above) rather than `while true`; the invoke
> itself runs **daemon-side** and keeps going across your turns regardless.
