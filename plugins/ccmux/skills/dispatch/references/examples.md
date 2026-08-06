# Worked example: plan, implement, search

User policy: _"Plan with claude, implement with codex, then have codex search for edge
cases."_

> **This example uses the `wait` join in one foreground shell, which assumes that shell
> outlives the longest worker.** That holds for short and medium steps. But the implement step
> below uses `--timeout 1800000` (30 min), and most shell tools have a wall-clock limit
> (~10 min) that would kill the `wait` block mid-run and destroy the redirect (see the
> redirect-loss warning in references/joins.md). So for a genuinely long step, prefer
> the **push join**: background the _blocking_ invoke as a harness job and let the harness
> wake you (join shape #1). The `wait` shape shown here is the right shape only when your
> harness has no background-job/notify mechanism _and_ every worker comfortably finishes
> inside your shell's lifetime.

```bash
mkdir -p /tmp/ccmux-orch
REPO=/path/to/repo

# 1) PLAN: quick, block-and-wait, brief prompt. (Claude: inline output only.)
plan=$(ccmux invoke claude \
  "In <=6 bullets, plan adding a --dry-run flag to the importer in $REPO. No code yet.")

# 2) IMPLEMENT: long, fire-and-poll. Background + redirect + generous timeout. Capture PID.
impl=inv_impldryrun
ccmux invoke codex "Using this plan, implement the --dry-run flag and a test. Summarize
concisely.\n\n$plan" \
  --id "$impl" --cwd "$REPO" --timeout 1800000 \
  > "/tmp/ccmux-orch/$impl.out" 2> "/tmp/ccmux-orch/$impl.err" &
pimpl=$!

# 3) SEARCH: fire alongside the implement so they overlap; this is the fan-out.
srch=inv_searchedge
ccmux invoke codex "List 5 edge cases a --dry-run importer flag commonly misses. Terse." \
  --id "$srch" --cwd "$REPO" \
  > "/tmp/ccmux-orch/$srch.out" 2> "/tmp/ccmux-orch/$srch.err" &
psrch=$!

# 4) JOIN via `wait` on the client PIDs, NOT by polling the store for "running"
#    (admission race: the ids are briefly absent right after the fire, and a naive poll
#    aborts at 0s; `wait` has no such race because each client exits when its invoke
#    finishes daemon-side). Optional: tail `ccmux invoke list` between turns to watch ages.
wait "$pimpl"; rc_impl=$?
wait "$psrch"; rc_srch=$?
echo "implement exit=$rc_impl, search exit=$rc_srch"

# 5) COLLECT: codex is a subprocess agent, so `result` has the full output; the redirect
#    file has the inline summary. Pull `result` promptly (it can age out). Fall back to the
#    redirect file on exit 2.
ccmux invoke result "$impl" || cat "/tmp/ccmux-orch/$impl.out"
cat "/tmp/ccmux-orch/$srch.out"
```

Adjust the agent names to whatever policy the user gave you; the mechanics are identical. If
you must drive this across turns (no single shell stays alive for the whole `wait`), fire
with a harness-native background job and join with the race-safe store poll instead.
