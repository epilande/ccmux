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
 * 1. `version` (package.json). Differs -> `outdated`. Checked FIRST because a
 *    version bump is the one signal that is true across checkouts: a daemon
 *    from an older release should be replaced by any newer CLI, wherever the
 *    newer CLI lives.
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
 * `BUILD_IDENTITY` is computed at MODULE LOAD, not on demand. `bin/ccmux`
 * cds into the package root and execs `bun dist/index.js`, so `argv[1]` is
 * RELATIVE; the daemon later does `process.chdir("/")` and the sidebar and
 * spawn commands chdir to `CCMUX_CALLER_PWD`. Resolving lazily after any of
 * those would stat the wrong file (or nothing). Import phase runs before any
 * command action, so the value is right for both the CLI and the daemon.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
  if (identity.version !== cli.version) return "outdated";
  if (identity.artifact !== cli.artifact) return "foreign";
  if (identity.stamp !== cli.stamp) return "outdated";
  return "current";
}
