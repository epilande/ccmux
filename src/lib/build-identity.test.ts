import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BUILD_IDENTITY,
  IS_TRANSIENT_SOURCE_RUN,
  classifyDaemonBuild,
  compareSemver,
  computeBuildIdentity,
  isTransientSourceRun,
  parseBuildIdentity,
  type BuildIdentity,
} from "./build-identity";

let dir: string;

beforeEach(() => {
  // realpath: on macOS the temp dir lives under a /var -> /private/var symlink.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-build-identity-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A file with a fixed size and mtime, so its stamp is predictable. */
function file(path: string, content: string, mtimeSec: number): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

describe("computeBuildIdentity", () => {
  it("compiled binary: artifact is the binary's realpath, stamp its size:mtime", () => {
    const bin = file(join(dir, "bin", "ccmux"), "binary!", 1_700_000_000);
    const id = computeBuildIdentity({
      execPath: bin,
      argv1: "/$bunfs/root/ccmux",
      version: "1.2.3",
    });
    expect(id.version).toBe("1.2.3");
    expect(id.artifact).toBe(bin);
    expect(id.stamp).toBe(`7:${1_700_000_000 * 1000}`);
  });

  it("bun <script>: dist/index.js and src/index.ts of one checkout share an artifact but not a stamp", () => {
    const dist = file(join(dir, "dist", "index.js"), "bundled", 1_700_000_000);
    const src = file(
      join(dir, "src", "index.ts"),
      "source code",
      1_700_000_100,
    );
    const fromDist = computeBuildIdentity({
      execPath: "/usr/local/bin/bun",
      argv1: dist,
      version: "1.2.3",
    });
    const fromSrc = computeBuildIdentity({
      execPath: "/usr/local/bin/bun",
      argv1: src,
      version: "1.2.3",
    });
    expect(fromDist.artifact).toBe(fromSrc.artifact);
    expect(fromDist.stamp).not.toBe(fromSrc.stamp);
    expect(classifyDaemonBuild(fromDist, fromSrc)).toBe("outdated");
  });

  it("bun <script>: a sibling checkout is a different artifact", () => {
    const a = file(join(dir, "a", "dist", "index.js"), "x", 1_700_000_000);
    const b = file(join(dir, "b", "dist", "index.js"), "x", 1_700_000_000);
    const idA = computeBuildIdentity({
      execPath: "bun",
      argv1: a,
      version: "1",
    });
    const idB = computeBuildIdentity({
      execPath: "bun",
      argv1: b,
      version: "1",
    });
    expect(idA.artifact).not.toBe(idB.artifact);
    // Same size and mtime, so only the artifact separates them.
    expect(idA.stamp).toBe(idB.stamp);
    expect(classifyDaemonBuild(idA, idB)).toBe("foreign");
  });

  it("resolves a RELATIVE argv1 against the given cwd (bin/ccmux execs `bun dist/index.js` from the package root)", () => {
    const dist = file(join(dir, "dist", "index.js"), "bundled", 1_700_000_000);
    const id = computeBuildIdentity({
      execPath: "/usr/local/bin/bun",
      argv1: "dist/index.js",
      cwd: dir,
      version: "1",
    });
    expect(id.stamp).toBe(`7:${1_700_000_000 * 1000}`);
    // The artifact follows the resolved script, so it is the checkout root
    // whatever spelling of the path got there (realpath applied to both).
    expect(id.artifact).toBe(
      computeBuildIdentity({ execPath: "bun", argv1: dist, version: "1" })
        .artifact,
    );
  });

  it("degrades to an empty stamp when the executed file cannot be stat'ed, without throwing", () => {
    const id = computeBuildIdentity({
      execPath: "bun",
      argv1: join(dir, "missing", "index.js"),
      version: "1",
    });
    expect(id.stamp).toBe("");
    expect(id.artifact).toBe(dir);
  });

  it("BUILD_IDENTITY is computed at import and well-formed", () => {
    expect(parseBuildIdentity(BUILD_IDENTITY)).toEqual(BUILD_IDENTITY);
    expect(BUILD_IDENTITY.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("classifyDaemonBuild", () => {
  const cli: BuildIdentity = {
    version: "1.3.2",
    artifact: "/opt/ccmux",
    stamp: "100:1000",
  };

  it("missing identity (a daemon predating the field) is outdated", () => {
    expect(classifyDaemonBuild(undefined, cli)).toBe("outdated");
    expect(classifyDaemonBuild(null, cli)).toBe("outdated");
  });

  it("malformed identity is outdated", () => {
    expect(classifyDaemonBuild("1.3.2", cli)).toBe("outdated");
    expect(classifyDaemonBuild({ version: "1.3.2" }, cli)).toBe("outdated");
    expect(
      classifyDaemonBuild(
        { version: 132, artifact: "/opt/ccmux", stamp: "100:1000" },
        cli,
      ),
    ).toBe("outdated");
  });

  it("a strictly older daemon version is outdated, whatever the artifact", () => {
    expect(classifyDaemonBuild({ ...cli, version: "1.3.1" }, cli)).toBe(
      "outdated",
    );
    expect(
      classifyDaemonBuild(
        { version: "1.3.1", artifact: "/elsewhere", stamp: "1:1" },
        cli,
      ),
    ).toBe("outdated");
  });

  it("a newer daemon than this CLI is foreign (kept; do not flip-flop)", () => {
    expect(classifyDaemonBuild({ ...cli, version: "1.3.3" }, cli)).toBe(
      "foreign",
    );
    expect(
      classifyDaemonBuild(
        { version: "2.0.0", artifact: "/elsewhere", stamp: "1:1" },
        cli,
      ),
    ).toBe("foreign");
  });

  it("a release candidate is replaced by a newer rc and by the stable, never the reverse", () => {
    const verdict = (daemon: string, ours: string) =>
      classifyDaemonBuild(
        { version: daemon, artifact: "/elsewhere", stamp: "1:1" },
        { ...cli, version: ours },
      );
    expect(verdict("1.5.0-rc.1", "1.5.0-rc.2")).toBe("outdated");
    expect(verdict("1.5.0-rc.9", "1.5.0-rc.10")).toBe("outdated");
    expect(verdict("1.5.0-rc.2", "1.5.0")).toBe("outdated");
    expect(verdict("1.4.8", "1.5.0-rc.1")).toBe("outdated");
    expect(verdict("1.5.0-rc.2", "1.5.0-rc.1")).toBe("foreign");
    expect(verdict("1.5.0", "1.5.0-rc.2")).toBe("foreign");
    expect(verdict("1.5.0-rc.1", "1.4.8")).toBe("foreign");
  });

  it("same version, different artifact is foreign (left alone)", () => {
    expect(classifyDaemonBuild({ ...cli, artifact: "/elsewhere" }, cli)).toBe(
      "foreign",
    );
    // The stamp is not consulted across artifacts.
    expect(
      classifyDaemonBuild(
        { ...cli, artifact: "/elsewhere", stamp: "9:9" },
        cli,
      ),
    ).toBe("foreign");
  });

  it("same artifact, different stamp is outdated (rebuilt in place)", () => {
    expect(classifyDaemonBuild({ ...cli, stamp: "100:2000" }, cli)).toBe(
      "outdated",
    );
  });

  it("identical identity is current", () => {
    expect(classifyDaemonBuild({ ...cli }, cli)).toBe("current");
  });
});

describe("compareSemver", () => {
  it("orders releases and prereleases by semver precedence", () => {
    const ascending = [
      "1.4.7",
      "1.4.10",
      "1.5.0-alpha",
      "1.5.0-alpha.1",
      "1.5.0-alpha.beta",
      "1.5.0-rc",
      "1.5.0-rc.1",
      "1.5.0-rc.2",
      "1.5.0-rc.9",
      "1.5.0-rc.10",
      "1.5.0",
      "1.5.1-rc.1",
      "2.0.0",
    ];
    // Every pair, so a comparator that is only right for neighbours fails.
    for (const [i, a] of ascending.entries()) {
      for (const [j, b] of ascending.entries()) {
        const cmp = compareSemver(a, b);
        expect([a, b, cmp === null ? null : Math.sign(cmp)]).toEqual([
          a,
          b,
          Math.sign(i - j),
        ]);
      }
    }
  });

  it("accepts a leading v and ignores build metadata", () => {
    expect(compareSemver("v1.5.0-rc.1", "1.5.0-rc.1")).toBe(0);
    expect(compareSemver("1.5.0+001", "1.5.0")).toBe(0);
    expect(compareSemver("1.5.0-01a", "1.5.0")).toBeLessThan(0);
  });

  it("is null when either side is not a semver", () => {
    for (const bad of [
      "",
      "1.5",
      "1.5.0.1",
      "1.5.0-",
      "1.5.0-rc.",
      "1.5.0rc1",
      "latest",
      "01.5.0",
      "1.5.0-01",
      "1.5.0-rc.01",
      "1.5.0+build..id",
    ]) {
      expect(compareSemver(bad, "1.5.0")).toBeNull();
      expect(compareSemver("1.5.0", bad)).toBeNull();
    }
  });
});

describe("isTransientSourceRun", () => {
  // `exists` is injected, so these paths need not be on disk.
  const bundleAt = (root: string) => (path: string) =>
    path === join(root, "dist", "index.js");

  it("source run of a checkout that holds a bundle is transient", () => {
    expect(
      isTransientSourceRun({
        execPath: "/usr/local/bin/bun",
        argv1: "/repo/src/index.ts",
        version: "1",
        exists: bundleAt("/repo"),
      }),
    ).toBe(true);
  });

  it("resolves a relative argv1 against cwd, the way bin/ccmux execs it", () => {
    expect(
      isTransientSourceRun({
        execPath: "/usr/local/bin/bun",
        argv1: "src/index.ts",
        cwd: "/repo",
        version: "1",
        exists: bundleAt("/repo"),
      }),
    ).toBe(true);
  });

  it("running the bundle itself is not transient", () => {
    expect(
      isTransientSourceRun({
        execPath: "/usr/local/bin/bun",
        argv1: "/repo/dist/index.js",
        version: "1",
        exists: bundleAt("/repo"),
      }),
    ).toBe(false);
  });

  it("source run with NO bundle (a fresh clone) is not transient", () => {
    expect(
      isTransientSourceRun({
        execPath: "/usr/local/bin/bun",
        argv1: "/repo/src/index.ts",
        version: "1",
        exists: () => false,
      }),
    ).toBe(false);
  });

  it("a compiled standalone binary is never transient", () => {
    expect(
      isTransientSourceRun({
        execPath: "/usr/local/bin/ccmux",
        argv1: "/$bunfs/root/ccmux",
        version: "1",
        exists: () => true,
      }),
    ).toBe(false);
  });

  it("a sibling checkout's bundle does not make this one transient", () => {
    expect(
      isTransientSourceRun({
        execPath: "/usr/local/bin/bun",
        argv1: "/repo-a/src/index.ts",
        version: "1",
        exists: bundleAt("/repo-b"),
      }),
    ).toBe(false);
  });

  it("IS_TRANSIENT_SOURCE_RUN is a boolean computed at import", () => {
    expect(typeof IS_TRANSIENT_SOURCE_RUN).toBe("boolean");
  });
});
