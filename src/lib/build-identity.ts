/**
 * Build identity: which ccmux CODE a process is running.
 *
 * The daemon is a long-lived background process, so after an upgrade (a new
 * package version, a `bun run build`, a reinstall) it keeps running the old
 * code while every CLI command connects to it (issue #163). Each process
 * computes its own identity at module load, the daemon publishes it on
 * `GET /server-info`, and the CLI's auto-start path (`reconcileDaemon` in
 * `commands/shared.ts`) compares the two and replaces an outdated daemon when
 * it is idle.
 *
 * Three fields, compared in this order by `classifyDaemonBuild`:
 *
 * 1. `version` (package.json). A *strictly older* daemon version -> `outdated`.
 *    Checked FIRST because a version bump is the one signal that is true
 *    across checkouts: a daemon from an older release should be replaced by
 *    any newer CLI, wherever the newer CLI lives. A *newer* daemon than this
 *    CLI is `foreign` (kept): an older CLI must not evict a newer daemon, or
 *    two versions flip-flop the shared process on every command.
 * 2. `artifact`: what was installed. For a compiled binary its realpath; for
 *    `bun <script>` the CHECKOUT ROOT (two levels above the script, so
 *    `dist/index.js` and `src/index.ts` of one checkout share an artifact
 *    while a sibling worktree does not). Same version but a different
 *    artifact -> `foreign`, and foreign is deliberately left alone: two
 *    worktrees on the same version each running the CLI would otherwise
 *    flip-flop the single shared daemon on every command. The user chooses a
 *    build explicitly with `ccmux daemon restart`.
 * 3. `stamp`: size and mtime of the file actually executed. Same artifact,
 *    different stamp -> `outdated` (a rebuild or reinstall in place).
 *
 * A daemon that reports no identity at all (it predates this module) or a
 * malformed one is `outdated`: the issue's rule is that a missing identity is
 * a mismatch, so such a daemon is replaced once, even from another checkout.
 *
 * One verdict is not acted on: `isTransientSourceRun` marks a CLI that is
 * running a checkout's SOURCE while that checkout also holds a built bundle.
 * There, `bin/ccmux` is already rebuilding and the next launch runs the
 * bundle, so an outdated daemon is left alone rather than replaced twice for
 * one edit. See that function for the full reason.
 *
 * `BUILD_IDENTITY` is computed at MODULE LOAD, not on demand. `bin/ccmux`
 * cds into the package root and execs `bun dist/index.js`, so `argv[1]` is
 * RELATIVE; the daemon later does `process.chdir("/")` and the sidebar and
 * spawn commands chdir to `CCMUX_CALLER_PWD`. Resolving lazily after any of
 * those would stat the wrong file (or nothing). Import phase runs before any
 * command action, so the value is right for both the CLI and the daemon.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isStandaloneBinary } from "../daemon/lifecycle";
import pkg from "../../package.json" with { type: "json" };

export interface BuildIdentity {
  /** package.json version. */
  version: string;
  /** Compiled binary: its realpath. `bun <script>`: the checkout root. */
  artifact: string;
  /** `${size}:${mtimeMs}` of the executed file; "" when it cannot be stat'ed. */
  stamp: string;
}

export interface BuildIdentityInputs {
  execPath: string;
  argv1: string | undefined;
  /** Base for a relative `argv1`. Defaults to `process.cwd()`. */
  cwd?: string;
  version: string;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function stampOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return "";
  }
}

/**
 * The identity computation with its inputs supplied, so tests can drive it.
 * A file that cannot be resolved or stat'ed degrades to its unresolved path
 * and an empty stamp rather than failing the import of every module that
 * needs this one.
 */
export function computeBuildIdentity(
  inputs: BuildIdentityInputs,
): BuildIdentity {
  const { execPath, argv1, version } = inputs;
  const cwd = inputs.cwd ?? process.cwd();
  if (isStandaloneBinary(argv1, execPath)) {
    const binary = realpathOr(execPath);
    return { version, artifact: binary, stamp: stampOf(binary) };
  }
  const script = realpathOr(resolve(cwd, argv1 ?? ""));
  return {
    version,
    artifact: dirname(dirname(script)),
    stamp: stampOf(script),
  };
}

function computeOwnIdentity(): BuildIdentity {
  try {
    return computeBuildIdentity({
      execPath: process.execPath,
      argv1: process.argv[1],
      version: pkg.version,
    });
  } catch {
    return { version: pkg.version, artifact: "", stamp: "" };
  }
}

/** This process's identity, frozen at import (see the header). */
export const BUILD_IDENTITY: BuildIdentity = computeOwnIdentity();

/**
 * A "transient source run": this CLI is executing a source file of a checkout
 * that ALSO holds a built `dist/index.js`.
 *
 * `bin/ccmux` runs the bundle when it is current and otherwise runs
 * `src/index.ts` while kicking off a background `bun run build`. So a single
 * edit under `src/` produces two CLI runs with two different stamps: this
 * source one, then a dist one once the rebuild lands. Letting the source run
 * evict the daemon costs a restart that the very next launch immediately
 * undoes, which is two daemon restarts (and two dropped SSE fleets) per edit
 * instead of one. The source run therefore DEFERS: the rebuild is already in
 * flight, and the dist run that follows does the single correct replacement.
 *
 * The predicate is deliberately about the executed file, not about the build
 * lock: `bin/ccmux`'s one-minute stamp guard means the lock is usually gone
 * while the source run is still the thing executing.
 *
 * Computed at MODULE LOAD for the same reason as `BUILD_IDENTITY` (see the
 * header): `argv[1]` is relative and the process chdirs later.
 */
export function isTransientSourceRun(
  inputs: BuildIdentityInputs & { exists?: (path: string) => boolean },
): boolean {
  const exists = inputs.exists ?? existsSync;
  if (isStandaloneBinary(inputs.argv1, inputs.execPath)) return false;
  const cwd = inputs.cwd ?? process.cwd();
  const script = realpathOr(resolve(cwd, inputs.argv1 ?? ""));
  // Same derivation as the identity's `artifact` for a `bun <script>` run.
  const artifact = dirname(dirname(script));
  const bundle = join(artifact, "dist", "index.js");
  // Running the bundle itself is the settled state, not a transient one.
  if (script === bundle) return false;
  // No bundle at all (a fresh clone before its first build): there is nothing
  // for a rebuild to land in, so no second run is coming and this one must
  // not defer.
  return exists(bundle);
}

function computeOwnTransientSourceRun(): boolean {
  try {
    return isTransientSourceRun({
      execPath: process.execPath,
      argv1: process.argv[1],
      version: pkg.version,
    });
  } catch {
    return false;
  }
}

/** Whether THIS process is a transient source run, frozen at import. */
export const IS_TRANSIENT_SOURCE_RUN: boolean = computeOwnTransientSourceRun();

export type BuildVerdict = "current" | "outdated" | "foreign";

/** A `BuildIdentity` if `value` is a well-formed one, else null. */
export function parseBuildIdentity(value: unknown): BuildIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const { version, artifact, stamp } = value as Record<string, unknown>;
  if (
    typeof version !== "string" ||
    typeof artifact !== "string" ||
    typeof stamp !== "string"
  ) {
    return null;
  }
  return { version, artifact, stamp };
}

/**
 * How the running daemon's build relates to the CLI's. Rules and their
 * reasons are in the header comment.
 */
export function classifyDaemonBuild(
  daemon: unknown,
  cli: BuildIdentity,
): BuildVerdict {
  const identity = parseBuildIdentity(daemon);
  if (!identity) return "outdated";
  if (identity.version !== cli.version) {
    const cmp = compareSemver(identity.version, cli.version);
    // Only a strictly older daemon is replaced. Newer, or unorderable, is
    // kept so an older CLI cannot evict a newer daemon (and flip-flop).
    return cmp !== null && cmp < 0 ? "outdated" : "foreign";
  }
  if (identity.artifact !== cli.artifact) return "foreign";
  if (identity.stamp !== cli.stamp) return "outdated";
  return "current";
}

/** `a - b` for `major.minor.patch` (optional leading `v`). Null if either side will not parse. */
function compareSemver(a: string, b: string): number | null {
  const parse = (value: string): [number, number, number] | null => {
    const match = value
      .trim()
      .replace(/^v/i, "")
      .match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}
