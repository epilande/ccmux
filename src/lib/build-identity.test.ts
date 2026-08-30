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
  classifyDaemonBuild,
  computeBuildIdentity,
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
    const src = file(join(dir, "src", "index.ts"), "source code", 1_700_000_100);
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
    const idA = computeBuildIdentity({ execPath: "bun", argv1: a, version: "1" });
    const idB = computeBuildIdentity({ execPath: "bun", argv1: b, version: "1" });
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

  it("a different version is outdated, whatever the artifact", () => {
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

  it("same version, different artifact is foreign (left alone)", () => {
    expect(classifyDaemonBuild({ ...cli, artifact: "/elsewhere" }, cli)).toBe(
      "foreign",
    );
    // The stamp is not consulted across artifacts.
    expect(
      classifyDaemonBuild({ ...cli, artifact: "/elsewhere", stamp: "9:9" }, cli),
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
