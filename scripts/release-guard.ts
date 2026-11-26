/**
 * Decides whether a ref may release a version, and how that version ranks
 * against the existing tags. Every release job gates on these outputs, and
 * ci.yml runs the same check against a PR's base branch.
 *
 * Policy lives in `release-lines.json`, not here: `branches` maps each branch
 * allowed to release to its line (`major.minor`), and `rcLine` is the line
 * still in release candidates, which may publish only `X.Y.0-rc.N`. Set
 * `rcLine` to null in the PR that bumps to the stable.
 *
 * Run it with `bun --no-install --config=/dev/null`: it needs no
 * node_modules, and without that flag bunfig.toml's dev preload would.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareSemver } from "../src/lib/build-identity";

const ROOT = join(import.meta.dir, "..");
const LINE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION =
  /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\.(0|[1-9]\d*)(-rc\.(?:0|[1-9]\d*))?$/;

export interface ReleaseLines {
  /** Branch name -> the `major.minor` line it may release. */
  branches: Record<string, string>;
  /** The line still in release candidates, or null when none is. */
  rcLine: string | null;
}

export interface GuardInput {
  lines: ReleaseLines;
  /** Full ref, so a tag or PR ref that shares a branch's short name never matches. */
  ref: string;
  /** package.json version. */
  version: string;
  /** Every tag in the repository. */
  tags: string[];
  /** Raw workflow input; empty on push events. */
  dryRun: string;
  versionOverride: string;
  branchOverride: string;
}

export type GuardVerdict = "release" | "skip" | "deny";

export interface GuardResult {
  verdict: GuardVerdict;
  reason: string;
  outputs: {
    version: string;
    dry_run: boolean;
    /** Build, smoke-test and package. True for real AND dry runs. */
    build: boolean;
    /** Anything outward facing. Never true on a dry run. */
    publish: boolean;
    prerelease: boolean;
    highest_stable: boolean;
    highest_overall: boolean;
  };
}

/** Throws on malformed policy: a typo in `rcLine` must not unlock a stable release. */
export function parseReleaseLines(value: unknown): ReleaseLines {
  const { branches, rcLine } = (value ?? {}) as Partial<ReleaseLines>;
  if (
    typeof branches !== "object" ||
    branches === null ||
    Array.isArray(branches) ||
    Object.keys(branches).length === 0 ||
    !Object.values(branches).every(
      (line) => typeof line === "string" && LINE.test(line),
    )
  ) {
    throw new Error(
      "release-lines.json: branches must map branch names to X.Y",
    );
  }
  if (
    rcLine !== null &&
    (typeof rcLine !== "string" || !Object.values(branches).includes(rcLine))
  ) {
    throw new Error(
      "release-lines.json: rcLine must be null or a line some branch releases",
    );
  }
  return { branches, rcLine };
}

export function evaluateRelease(input: GuardInput): GuardResult {
  const dryRun = input.dryRun === "true";
  const overridden =
    input.versionOverride !== "" || input.branchOverride !== "";
  const version = (dryRun && input.versionOverride) || input.version;
  const ref =
    dryRun && input.branchOverride
      ? `refs/heads/${input.branchOverride}`
      : input.ref;
  const releaseTags = input.tags.filter(
    (tag) => tag.startsWith("v") && compareSemver(tag, tag) !== null,
  );

  const result = (verdict: GuardVerdict, reason: string): GuardResult => {
    const valid = VERSION.test(version);
    const prerelease = version.includes("-");
    const outranksAll = (tags: string[]) =>
      valid && tags.every((tag) => (compareSemver(version, tag) ?? -1) >= 0);
    return {
      verdict,
      reason,
      outputs: {
        version,
        dry_run: dryRun,
        build: verdict === "release",
        publish: verdict === "release" && !dryRun,
        prerelease,
        // Independent of the verdict: the publishing jobs rank again once
        // the version's own tag exists, when the verdict is "skip".
        highest_stable:
          !prerelease &&
          outranksAll(releaseTags.filter((tag) => !tag.includes("-"))),
        highest_overall: outranksAll(releaseTags),
      },
    };
  };

  if (!["", "true", "false"].includes(input.dryRun)) {
    return result("deny", `dry_run must be true or false: ${input.dryRun}`);
  }
  if (!dryRun && overridden) {
    return result("deny", "version and branch overrides require dry_run=true");
  }
  // A checkout without tags would make every version look new and highest.
  if (releaseTags.length === 0) {
    return result("deny", "no release tags found; was the tag fetch complete?");
  }
  // Ahead of all validation, so a push that only bumps a dependency in
  // package.json stays green whatever the branch's line has become.
  if (input.tags.includes(`v${version}`)) {
    return result("skip", `tag v${version} already exists`);
  }

  const branch = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : "";
  if (!Object.hasOwn(input.lines.branches, branch)) {
    return result("deny", `${ref} may not release`);
  }
  const match = version.match(VERSION);
  if (!match) {
    return result("deny", `${version} is not X.Y.Z or X.Y.Z-rc.N`);
  }
  const [, line, patch, rc] = match;
  const allowedLine = input.lines.branches[branch];
  if (line !== allowedLine) {
    return result(
      "deny",
      `${branch} releases ${allowedLine}.x, not ${version}`,
    );
  }
  if (line === input.lines.rcLine) {
    if (patch !== "0" || rc === undefined) {
      return result(
        "deny",
        `${line} is in rc, so only ${line}.0-rc.N may release, not ${version}`,
      );
    }
  } else if (rc !== undefined) {
    return result(
      "deny",
      `${line} is stable only, so ${version} may not release`,
    );
  }
  const blocker = input.tags.find((tag) => {
    if (!tag.startsWith(`v${line}.`)) return false;
    const cmp = compareSemver(version, tag);
    return cmp === null || cmp <= 0;
  });
  if (blocker) {
    return result("deny", `${version} is not higher than ${blocker}`);
  }
  return result("release", `${branch} may release ${version}`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

function listTags(): string[] {
  const { exitCode, stdout, stderr } = Bun.spawnSync(["git", "tag", "--list"], {
    cwd: ROOT,
  });
  if (exitCode !== 0) throw new Error(`git tag failed: ${stderr}`);
  return stdout.toString().split("\n").filter(Boolean);
}

if (import.meta.main) {
  const ref = process.env.RELEASE_REF;
  if (!ref) throw new Error("RELEASE_REF is required");
  const { verdict, reason, outputs } = evaluateRelease({
    lines: parseReleaseLines(readJson("scripts/release-lines.json")),
    ref,
    version: (readJson("package.json") as { version: string }).version,
    tags: listTags(),
    dryRun: process.env.DRY_RUN ?? "",
    versionOverride: process.env.VERSION_OVERRIDE ?? "",
    branchOverride: process.env.BRANCH_OVERRIDE ?? "",
  });
  console.log(`${verdict}: ${reason}`);
  console.log(outputs);
  if (verdict === "deny") process.exit(1);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
}
