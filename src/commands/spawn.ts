import { Command, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import { getDaemonUrl } from "../lib/config";
import { readString } from "../lib/daemon-json";
import { ensureDaemon } from "./shared";
import { PANE_ID_PATTERN, type SpawnSplit } from "../daemon/spawn-command";
import {
  isUntrackedMode,
  UNTRACKED_MODES,
  type UntrackedMode,
} from "../daemon/worktree-move-changes";
import {
  moveReportLines,
  stashRecoveryLines,
  type MoveReport,
} from "../lib/move-report";
import { isSameTmuxServer } from "../lib/tmux-server";
import { resolveCurrentTmuxClientTty } from "../lib/tmux-client";
import { BUILTIN_AGENTS } from "../lib/agents";

interface SpawnResponse {
  success: boolean;
  paneId: string;
  command: string;
  /** Present only when `--worktree` asked for one. */
  worktree?: {
    name: string;
    path: string;
    branch: string;
    created: boolean;
    branchCreated: boolean;
    /** Absent when no branch was cut, so there is nothing to report it from. */
    base?: string;
  };
  /** Present only when `--with-changes` relocated uncommitted work. */
  move?: MoveReport;
}

/**
 * A failed spawn.
 *
 * `stashSha`/`sourceRestored` describe a move that was REFUSED, `move` a move
 * that completed before something later went wrong. They never both appear:
 * the first pair says the work is still recoverable from a stash, the second
 * that it is already in the new worktree.
 */
interface SpawnErrorResponse {
  error: string;
  /** The stash entry holding the user's work, when one was left in place. */
  stashSha?: string;
  sourceRestored?: boolean;
  /** A move that had already completed when the spawn failed. */
  move?: SpawnResponse["move"];
}

/**
 * `--split` with no value keeps tmux's default (stacked) direction; an
 * explicit `h`/`v` is tmux's own vocabulary, so `h` is a left/right split.
 */
function parseSplit(value: string): SpawnSplit {
  if (value === "h" || value === "v") return value;
  // `ccmux spawn --split codex` is an easy slip, and the generic message
  // reads like the direction is wrong rather than the argument order.
  const hint = BUILTIN_AGENTS.some((a) => a.name === value)
    ? ` To spawn ${value} in a split, put the agent first: ccmux spawn ${value} --split.`
    : "";
  throw new InvalidArgumentError(
    `Expected 'h' (left/right) or 'v' (stacked).${hint}`,
  );
}

/**
 * A `--pr`/`--issue` number. `#123` is accepted because that is how GitHub
 * writes one everywhere a user might copy it from, and the `#` is stripped
 * rather than tolerated further in: the value ends up in a `gh` argv and in a
 * branch name, so only digits may survive.
 */
function parseNumber(flag: string): (value: string) => number {
  return (value: string) => {
    const digits = value.startsWith("#") ? value.slice(1) : value;
    if (!/^\d+$/.test(digits) || Number(digits) < 1) {
      throw new InvalidArgumentError(
        `Expected a ${flag} number, such as 123 or #123.`,
      );
    }
    return Number(digits);
  };
}

/** `--untracked`'s value, rejected at parse time so a typo never reaches the
 *  daemon (or starts one). */
function parseUntracked(value: string): UntrackedMode {
  if (isUntrackedMode(value)) return value;
  // Quoted, like parseSplit's: the values are literals to type, and an
  // unquoted list reads as prose the moment one of them is a real word.
  throw new InvalidArgumentError(
    `Expected ${UNTRACKED_MODES.map((mode) => `'${mode}'`).join(", ")}.`,
  );
}

/**
 * The pane the CLI was run from. Sent as `callerPane` rather than
 * `target`: it means "my session/pane", not "put the window here", and
 * the daemon treats the two differently (an explicit target inserts a
 * window next to it and renumbers later windows; the caller's pane only
 * pins the session).
 *
 * Dropped when the daemon is watching a DIFFERENT tmux server, because
 * `%N` ids are unique only within one server and collide across them
 * (see lib/tmux-server.ts and the invariant in pane-discovery.ts); a
 * stale-looking id would otherwise resolve to an unrelated pane.
 */
function callerPane(daemonSocket: string | null): string | undefined {
  const pane = process.env.TMUX_PANE;
  if (!pane || !PANE_ID_PATTERN.test(pane)) return undefined;
  return isSameTmuxServer(daemonSocket) ? pane : undefined;
}

/**
 * The tty of the tmux client the caller is attached with, so the daemon can
 * move it to a pane in ANOTHER session: `select-window` only changes which
 * window is current within the target's session, and the daemon has no client
 * of its own to `switch-client` with. `src/commands/switch.ts` solves the same
 * problem the same way.
 *
 * Resolved only when an explicit `--target` was given, because that is the
 * only way a spawn can land outside the caller's session: without one the new
 * pane goes wherever `callerPane` is, which IS the caller's session. Skipping
 * it otherwise keeps an ordinary `ccmux spawn` at exactly the tmux round-trips
 * it always made.
 *
 * Same cross-server gate as {@link callerPane}, and pointless when nothing
 * will be switched (`--detach`, or running outside tmux with no client to
 * name).
 */
async function callerClientTty(
  daemonSocket: string | null,
): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined;
  if (!isSameTmuxServer(daemonSocket)) return undefined;
  return (await resolveCurrentTmuxClientTty()) ?? undefined;
}

/**
 * The directory the new agent should start in.
 *
 * `bin/ccmux` cds into the package root for module resolution and carries
 * the real invocation directory in `CCMUX_CALLER_PWD`, so `process.cwd()`
 * alone would start every agent inside the ccmux install (see
 * `src/commands/review.ts` and `src/commands/sidebar.ts` for the same
 * restoration). An explicit `--cwd` is resolved against the caller's
 * directory too, so a relative one means what the user typed rather than
 * something relative to the install.
 */
function resolveSpawnCwd(explicit?: string): string {
  const callerPwd = process.env.CCMUX_CALLER_PWD ?? process.cwd();
  return explicit ? resolve(callerPwd, explicit) : callerPwd;
}

/** The daemon's tmux socket, or null when it can't be determined. */
async function daemonTmuxSocket(): Promise<string | null> {
  const res = await fetch(`${getDaemonUrl()}/server-info`).catch(() => null);
  if (!res || !res.ok) return null;
  const body: unknown = await res.json().catch(() => null);
  return readString(body, "socketPath");
}

export function createSpawnCommand(): Command {
  return new Command("spawn")
    .description("Spawn a new agent session in a tmux pane")
    .argument(
      "[agent]",
      "Agent to spawn (claude, codex, copilot, opencode, gemini)",
      "claude",
    )
    .option("--cwd <dir>", "Working directory")
    .option("--resume <session-id>", "Resume an existing session")
    .option(
      "--fork <session-id>",
      "Continue an existing session's history in a new one, leaving the original untouched " +
        "(the agent and, unless --cwd says otherwise, the directory come from that session)",
    )
    .option("--prompt <text>", "Initial prompt to send")
    .option(
      "--split [direction]",
      "Split current pane instead of new window ('h' left/right, 'v' stacked)",
      parseSplit,
    )
    .option(
      "--target <pane-id>",
      "tmux pane to split or place next to ('none' to ignore the current pane)",
    )
    .option("--detach", "Don't switch to the new pane after spawning")
    .option(
      "--worktree [name]",
      "Spawn into a git worktree at <repo>/.claude/worktrees/<name>, creating it if needed (name derived from --prompt, or from the forked session's branch, when omitted)",
    )
    .option(
      "--base <ref>",
      "Branch the new worktree from this ref (default: the repository's current branch, or the forked session's)",
    )
    .option(
      "--with-changes",
      "Move the checkout's uncommitted changes into the new worktree, leaving it clean",
    )
    .option(
      "--untracked <mode>",
      `What --with-changes does with untracked files (${UNTRACKED_MODES.join(", ")}; default ${UNTRACKED_MODES[0]})`,
      parseUntracked,
    )
    .option(
      "--pr <number>",
      "Spawn into a worktree checked out on this pull request's branch (resolved with gh)",
      parseNumber("PR"),
    )
    .option(
      "--issue <number>",
      "Spawn into a new worktree named after this issue, with its title and URL as the prompt",
      parseNumber("issue"),
    )
    .action(
      async (
        agent: string,
        options: {
          cwd?: string;
          resume?: string;
          fork?: string;
          prompt?: string;
          split?: SpawnSplit;
          target?: string;
          detach?: boolean;
          worktree?: string | boolean;
          base?: string;
          withChanges?: boolean;
          untracked?: UntrackedMode;
          pr?: number;
          issue?: number;
        },
      ) => {
        // Every check in this block is pure argument validation, and every
        // one of them runs before `ensureDaemon` for the reason spelled out
        // below: rejecting a typo must not leave a daemon behind.
        //
        // `--pr` and `--issue` each bring their own worktree, their own name
        // and (for a PR) their own branch and start point, so each flag that
        // would decide one of those is a contradiction rather than a
        // refinement. Refused pairwise so the message names the actual pair.
        if (options.pr !== undefined && options.issue !== undefined) {
          console.error(
            "--pr and --issue cannot be used together: each brings its own worktree",
          );
          process.exit(1);
        }
        const source =
          options.pr !== undefined
            ? "--pr"
            : options.issue !== undefined
              ? "--issue"
              : undefined;
        if (source) {
          const conflict =
            options.worktree !== undefined
              ? "--worktree"
              : options.withChanges
                ? "--with-changes"
                : options.fork
                  ? "--fork"
                  : options.resume
                    ? "--resume"
                    : undefined;
          if (conflict) {
            console.error(
              `${source} cannot be used with ${conflict}: ${source} decides the worktree, its name and where it starts from`,
            );
            process.exit(1);
          }
          // Allowed with `--issue`, which branches from a base like any other
          // spawn, and refused with `--pr`, whose start point IS the PR head.
          if (options.base !== undefined && options.pr !== undefined) {
            console.error(
              "--base cannot be used with --pr: the pull request's own head is what gets checked out",
            );
            process.exit(1);
          }
        }

        // `--base` alone is inert, and silently ignoring a flag someone typed
        // costs a confused debugging session. Unlike `--split` without a
        // target, which still does something sensible, this expresses an
        // intent the command cannot honor at all.
        //
        // Checked before `ensureDaemon`, because pure argument validation
        // must not start a background process: rejecting a typo used to leave
        // a daemon behind on the shared port, which the CLI's own test then
        // did to whoever ran it.
        if (
          options.base !== undefined &&
          options.worktree === undefined &&
          options.issue === undefined
        ) {
          console.error("--base requires --worktree or --issue");
          process.exit(1);
        }
        // Same rule, same reason, and the same "before ensureDaemon" placement:
        // there is nowhere for the changes to move without a destination, and
        // moving work is the last operation that should start on a guess.
        if (options.withChanges && options.worktree === undefined) {
          console.error("--with-changes requires --worktree");
          process.exit(1);
        }
        if (options.untracked !== undefined && !options.withChanges) {
          console.error("--untracked requires --with-changes");
          process.exit(1);
        }
        // A move empties the checkout it takes the changes from, and a fork
        // leaves the original session running in that same checkout. The
        // daemon refuses this too (the picker can express it), but the same
        // placement rule applies: nothing should start on a command line that
        // cannot be honored.
        if (options.withChanges && options.fork) {
          console.error(
            "--with-changes cannot be used with --fork: the session being forked keeps " +
              "running in that checkout, so moving its changes would empty it out from under it",
          );
          process.exit(1);
        }

        await ensureDaemon();

        // `--target none` (or an empty value) opts out of placement
        // entirely, letting tmux pick as it did before targeting existed.
        const explicitTarget =
          options.target === "none" || options.target === ""
            ? undefined
            : options.target;
        const optedOut = options.target !== undefined && !explicitTarget;

        // `--worktree` bare is `true` from commander, `--worktree x` is the
        // string. Both become an object, since the daemon accepts one shape.
        //
        // `--issue --base` rides the same object rather than a second
        // top-level field: an issue spawn creates an ordinary worktree, so
        // its start point is the one the daemon already validates here.
        const worktree =
          options.worktree === undefined
            ? options.issue !== undefined && options.base !== undefined
              ? { base: options.base }
              : undefined
            : {
                name:
                  typeof options.worktree === "string"
                    ? options.worktree
                    : undefined,
                base: options.base,
                // Omitted rather than sent as `false`: the daemon reads
                // `untracked` without `withChanges` as a contradiction, and a
                // plain `--worktree` should send the shape it always did.
                ...(options.withChanges
                  ? { withChanges: true, untracked: options.untracked }
                  : {}),
              };

        // One `/server-info` round-trip for both placement fields, which have
        // the same cross-server gate. Still skipped entirely when placement is
        // opted out of, since neither field is sent then.
        const daemonSocket = optedOut ? null : await daemonTmuxSocket();
        const detach = options.detach ?? false;

        // The try covers the round trip ONLY. Everything after it prints and
        // exits, and wrapping those in a catch meant a `process.exit` walked
        // straight back into it and was reported as a spawn failure.
        let response: Response;
        try {
          response = await fetch(`${getDaemonUrl()}/spawn`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              // Both are the source session's on a fork: the daemon reads
              // them off the session it resolves, so sending the positional
              // agent (which defaults to "claude") would only look like it
              // had a say. An explicit `--cwd` still wins.
              agent: options.fork ? undefined : agent,
              cwd:
                options.fork && !options.cwd
                  ? undefined
                  : resolveSpawnCwd(options.cwd),
              resume: options.resume,
              fork: options.fork,
              prompt: options.prompt,
              split: options.split ?? false,
              target: explicitTarget,
              callerPane: optedOut ? undefined : callerPane(daemonSocket),
              // What the daemon switches to the new pane with when that pane
              // lands in another session; see `callerClientTty`.
              callerTty:
                explicitTarget && !detach
                  ? await callerClientTty(daemonSocket)
                  : undefined,
              detach,
              worktree,
              pr: options.pr,
              issue: options.issue,
            }),
          });
        } catch (error) {
          console.error("Failed to spawn session:", error);
          process.exit(1);
        }

        // EVERY non-ok status, not only 400. A failure after a successful
        // move is a 500, and its body is the only place that says the user's
        // uncommitted work has already left their checkout; collapsing that
        // to "HTTP 500" throws away the one sentence they need.
        if (!response.ok) {
          const data = (await response
            .json()
            .catch(() => null)) as SpawnErrorResponse | null;
          console.error(data?.error ?? `Spawn failed: HTTP ${response.status}`);
          // A daemon predating fork-into-a-worktree still carries the refusal
          // that said the combination was unverified, and printed on its own
          // it reads as "this feature does not exist" rather than "the
          // process answering you is old". Matched on the sentence unique to
          // that refusal, so an ordinary fork failure is left to speak for
          // itself. Same treatment `--with-changes` gets below, for the same
          // class of mismatch between a new CLI and an old daemon.
          if (
            options.fork &&
            options.worktree !== undefined &&
            data?.error?.includes("into a new worktree yet")
          ) {
            console.error(
              `The running ccmux daemon is an older build that could not fork into a new ` +
                `worktree; the feature is in this CLI. Restart it with 'ccmux daemon restart' ` +
                `and try again.`,
            );
          }
          // A refused move can leave a stash entry behind, and the sha is
          // the handle for getting the work back by hand. Same lines the
          // picker raises for the same body; see `src/lib/move-report.ts`.
          if (data) {
            for (const line of stashRecoveryLines(data)) console.error(line);
          }
          // A move that DID complete before the spawn failed. The same
          // accounting the success path prints, because the work has left
          // the checkout either way.
          if (data?.move) {
            for (const line of moveReportLines(
              data.move,
              resolveSpawnCwd(options.cwd),
            )) {
              console.error(line);
            }
          }
          process.exit(1);
        }

        {
          // Guarded the same way the error path is: a 200 whose body will not
          // parse (a proxy in the way, a daemon killed mid-write) says nothing
          // about what the daemon did, and throwing here surfaces as an
          // unhandled rejection rather than as the failure it is.
          const data = (await response
            .json()
            .catch(() => null)) as SpawnResponse | null;
          if (!data) {
            console.error("Failed to spawn session: unreadable response body");
            process.exit(1);
          }
          if (data.worktree) {
            const { name, path, branch, created, branchCreated, base } =
              data.worktree;
            // Three honest lines rather than one hedged one. A reused branch
            // can already carry twenty commits, so calling it new would
            // misdescribe where the agent is starting from, and the base is
            // only worth naming when a branch was actually cut from it.
            // A reused worktree already sits on its branch, so there was
            // nothing for `--base` to cut. Saying so beats a line that reads
            // as if the flag had been honored.
            const staleBase =
              !created && options.base
                ? " (--base ignored: the worktree already existed)"
                : "";
            // A move resolves its own base to the SOURCE checkout's HEAD, so
            // this is routinely 40 characters of hex where a `--base` is a
            // ref name. Abbreviated the way git prints one; the ref the
            // worktree was actually cut from is unchanged.
            const from = base
              ? ` from ${/^[0-9a-f]{40}$/.test(base) ? base.slice(0, 12) : base}`
              : "";
            const what = !created
              ? `Reusing worktree ${name} on branch ${branch}${staleBase}`
              : branchCreated
                ? `Created worktree ${name} on new branch ${branch}${from}`
                : `Created worktree ${name} on existing branch ${branch}`;
            console.log(`${what}: ${path}`);
          }
          if (data.move) {
            for (const line of moveReportLines(
              data.move,
              resolveSpawnCwd(options.cwd),
            )) {
              console.log(line);
            }
          }
          console.log(
            options.fork
              ? `Forked ${options.fork} into pane ${data.paneId}: ${data.command}`
              : `Spawned ${agent} in pane ${data.paneId}: ${data.command}`,
          );

          // Reported last, after everything that DID happen, and as a
          // failure. A daemon predating `--with-changes` drops the keys it
          // does not know and answers a perfectly ordinary 200, so the agent
          // starts in an empty worktree while the work sits untouched in the
          // original checkout. The absent `move` is the only evidence there
          // is, and exiting 0 on it would make a silent no-op look like a
          // completed move.
          // Same class of mismatch as `--with-changes` below: a daemon
          // predating these flags drops the fields it does not know and
          // answers an ordinary 200, so the agent comes up in the current
          // checkout with no worktree and nothing says why. The absent
          // `worktree` is the only evidence there is.
          if (
            (options.pr !== undefined || options.issue !== undefined) &&
            !data.worktree
          ) {
            console.error(
              `The running ccmux daemon is an older build that does not support ` +
                `${options.pr !== undefined ? "--pr" : "--issue"}, so the agent started in ` +
                `${resolveSpawnCwd(options.cwd)} instead of a worktree. Restart it with ` +
                `'ccmux daemon restart' and try again.`,
            );
            process.exit(1);
          }
          if (options.withChanges && !data.move) {
            console.error(
              `The running ccmux daemon is an older build that does not support --with-changes, ` +
                `so your changes were not moved: they are still in ${resolveSpawnCwd(options.cwd)}. ` +
                `Restart it with 'ccmux daemon restart' and move them again.`,
            );
            process.exit(1);
          }
        }
      },
    );
}
