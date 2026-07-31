import { Command, InvalidArgumentError } from "commander";
import { resolve } from "node:path";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import { PANE_ID_PATTERN, type SpawnSplit } from "../daemon/spawn-command";
import {
  isUntrackedMode,
  UNTRACKED_MODES,
  type UntrackedMode,
} from "../daemon/worktree-move-changes";
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
  move?: {
    moved: number;
    untracked: { mode: UntrackedMode; files: string[] };
    /**
     * The checkout the work came OUT of, absolute. Reported rather than
     * assumed to be the caller's cwd: under `--fork` the daemon resolves it
     * from the forked session, so the two differ. Optional only for a daemon
     * older than this field.
     */
    source?: string;
    leftoverStash?: string;
    /** The staged/unstaged split could not be preserved. */
    flattenedIndex?: boolean;
  };
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
  reason?: string;
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

/** `--untracked`'s value, rejected at parse time so a typo never reaches the
 *  daemon (or starts one). */
function parseUntracked(value: string): UntrackedMode {
  if (isUntrackedMode(value)) return value;
  throw new InvalidArgumentError(`Expected ${UNTRACKED_MODES.join(", ")}.`);
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

/**
 * What a completed move did, as lines.
 *
 * Shared by the success path and by a failure that happened AFTER the move,
 * because both owe the user the same accounting: the work has left their
 * checkout either way, and a spawn that failed later is exactly when they
 * most need to be told where it went.
 */
function moveLines(
  move: NonNullable<SpawnResponse["move"]>,
  fallbackSource: string,
): string[] {
  const { moved, untracked, source, leftoverStash, flattenedIndex } = move;
  // Both halves are named even at zero, because "0 untracked files" is the
  // answer to "did it take my new files too" — the question `--untracked`
  // exists for.
  const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  const verb = untracked.mode === "copy" ? "copied" : "moved";
  const untrackedNote =
    untracked.mode === "leave"
      ? "untracked files left behind"
      : `${files(untracked.files.length)} untracked ${verb}`;
  const lines = [
    // The daemon's source, not the caller's cwd: `--fork` resolves it from
    // the forked session, so naming the local directory there would point at
    // one nothing happened in.
    `Moved ${files(moved)} changed, ${untrackedNote}, out of ${source ?? fallbackSource}`,
  ];
  // A note, not an error: every edit is in the new worktree, but the staged
  // half arrived unstaged, and finding that out at commit time is worse than
  // reading one line here.
  if (flattenedIndex) {
    lines.push(
      "Everything moved, but not the staged/unstaged split: re-run 'git add' in the worktree for what you had staged.",
    );
  }
  // A successful move that could not drop its own backup. Harmless, but
  // silence would leave it to be found later as a stash entry nobody
  // remembers making.
  if (leftoverStash) {
    lines.push(
      `Left a redundant stash entry behind (${leftoverStash}); drop it with 'git stash drop'.`,
    );
  }
  return lines;
}

/** The daemon's tmux socket, or null when it can't be determined. */
async function daemonTmuxSocket(): Promise<string | null> {
  const res = await fetch(`${getDaemonUrl()}/server-info`).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { socketPath: string | null };
  return data.socketPath;
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
      "Spawn into a git worktree at <repo>/.claude/worktrees/<name>, creating it if needed (name derived from --prompt when omitted)",
    )
    .option(
      "--base <ref>",
      "Branch the new worktree from this ref (default: the repository's current branch)",
    )
    .option(
      "--with-changes",
      "Move the checkout's uncommitted changes into the new worktree, leaving it clean",
    )
    .option(
      "--untracked <mode>",
      `What --with-changes does with untracked files (${UNTRACKED_MODES.join(", ")})`,
      parseUntracked,
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
        },
      ) => {
        // `--base` alone is inert, and silently ignoring a flag someone typed
        // costs a confused debugging session. Unlike `--split` without a
        // target, which still does something sensible, this expresses an
        // intent the command cannot honor at all.
        //
        // Checked before `ensureDaemon`, because pure argument validation
        // must not start a background process: rejecting a typo used to leave
        // a daemon behind on the shared port, which the CLI's own test then
        // did to whoever ran it.
        if (options.base !== undefined && options.worktree === undefined) {
          console.error("--base requires --worktree");
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
        const worktree =
          options.worktree === undefined
            ? undefined
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
          // A refused move can leave a stash entry behind, and the sha is
          // the handle for getting the work back by hand. Which sentence
          // applies turns on whether the source was restored: with the
          // changes back in the checkout the entry is a redundant copy,
          // without them it is the only one.
          if (data?.stashSha) {
            console.error(
              data.sourceRestored
                ? `Your changes are back in the checkout; stash entry ${data.stashSha} still holds a copy ('git stash list').`
                : `Your changes are in stash entry ${data.stashSha}; recover them with 'git stash apply ${data.stashSha}'.`,
            );
          }
          // A move that DID complete before the spawn failed. The same
          // accounting the success path prints, because the work has left
          // the checkout either way.
          if (data?.move) {
            for (const line of moveLines(
              data.move,
              resolveSpawnCwd(options.cwd),
            )) {
              console.error(line);
            }
          }
          process.exit(1);
        }

        {
          const data = (await response.json()) as SpawnResponse;
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
            const what = !created
              ? `Reusing worktree ${name} on branch ${branch}${staleBase}`
              : branchCreated
                ? `Created worktree ${name} on new branch ${branch}${base ? ` from ${base}` : ""}`
                : `Created worktree ${name} on existing branch ${branch}`;
            console.log(`${what}: ${path}`);
          }
          if (data.move) {
            for (const line of moveLines(
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
