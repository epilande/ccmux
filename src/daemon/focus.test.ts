import { describe, expect, it } from "bun:test";
import {
  getFrontmostBundleId,
  isTerminalFrontmost,
  resolveTerminalBundleId,
  type Spawn,
  type SpawnResult,
} from "./focus";

function fakeResult(stdout: string, exitCode = 0): SpawnResult {
  return {
    stdout: new Response(stdout).body,
    exited: Promise.resolve(exitCode),
  };
}

/**
 * Fake spawn dispatched by argv[0] (ps/lsappinfo/defaults), returning canned
 * output per call. Records every invocation so tests can assert call counts
 * (e.g. a cache hit skipping the ancestor walk entirely).
 */
function makeSpawn(handlers: {
  ps?: (argv: string[], callIndex: number) => SpawnResult;
  lsappinfo?: (argv: string[], callIndex: number) => SpawnResult;
  defaults?: (argv: string[], callIndex: number) => SpawnResult;
}): { spawn: Spawn; calls: string[][] } {
  const calls: string[][] = [];
  const callIndexByCmd: Record<string, number> = {};
  const spawn: Spawn = (argv) => {
    calls.push(argv);
    const [cmd] = argv;
    const handler = handlers[cmd as keyof typeof handlers];
    if (!handler) {
      throw new Error(`unexpected spawn call: ${argv.join(" ")}`);
    }
    const callIndex = callIndexByCmd[cmd] ?? 0;
    callIndexByCmd[cmd] = callIndex + 1;
    return handler(argv, callIndex);
  };
  return { spawn, calls };
}

/** Fresh cache per test so resolveTerminalBundleId calls never see stale state. */
function freshCache(): Map<number, string | null> {
  return new Map();
}

describe("resolveTerminalBundleId", () => {
  it("finds the .app on the first hop and returns its bundle id", async () => {
    const { spawn, calls } = makeSpawn({
      ps: () =>
        fakeResult("1  /Applications/Ghostty.app/Contents/MacOS/ghostty"),
      defaults: () => fakeResult("com.mitchellh.ghostty\n"),
    });

    const bundleId = await resolveTerminalBundleId(1234, spawn, freshCache());

    expect(bundleId).toBe("com.mitchellh.ghostty");
    expect(calls.filter((c) => c[0] === "ps")).toHaveLength(1);
    expect(calls.filter((c) => c[0] === "defaults")).toHaveLength(1);
  });

  it("returns null once the walk exhausts 20 hops without finding a .app", async () => {
    const { spawn, calls } = makeSpawn({
      // ppid climbs but never matches an .app binary and never reaches <=1,
      // so the walk should run out of hops rather than terminate early.
      ps: (_argv, callIndex) => fakeResult(`${1000 + callIndex} not-an-app`),
    });

    const bundleId = await resolveTerminalBundleId(1234, spawn, freshCache());

    expect(bundleId).toBeNull();
    expect(calls.filter((c) => c[0] === "ps")).toHaveLength(20);
  });

  it("skips the ancestor walk entirely on a cache hit for the same pid", async () => {
    const { spawn, calls } = makeSpawn({
      ps: () =>
        fakeResult("1  /Applications/Ghostty.app/Contents/MacOS/ghostty"),
      defaults: () => fakeResult("com.mitchellh.ghostty"),
    });
    const cache = freshCache();

    const first = await resolveTerminalBundleId(4242, spawn, cache);
    const second = await resolveTerminalBundleId(4242, spawn, cache);

    expect(first).toBe("com.mitchellh.ghostty");
    expect(second).toBe("com.mitchellh.ghostty");
    expect(calls.filter((c) => c[0] === "ps")).toHaveLength(1);
    expect(calls.filter((c) => c[0] === "defaults")).toHaveLength(1);
  });

  it("caches a null result too, so a dead-end walk isn't retried", async () => {
    const { spawn, calls } = makeSpawn({
      ps: () => fakeResult("1 not-an-app"),
    });
    const cache = freshCache();

    const first = await resolveTerminalBundleId(99, spawn, cache);
    const second = await resolveTerminalBundleId(99, spawn, cache);

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(calls.filter((c) => c[0] === "ps")).toHaveLength(1);
  });

  it("returns null when a ps call in the chain fails", async () => {
    const { spawn } = makeSpawn({
      ps: () => fakeResult("", 1),
    });

    const bundleId = await resolveTerminalBundleId(1, spawn, freshCache());

    expect(bundleId).toBeNull();
  });
});

describe("getFrontmostBundleId", () => {
  it("parses the bundle id out of lsappinfo's info output", async () => {
    const { spawn } = makeSpawn({
      lsappinfo: (argv) => {
        if (argv[1] === "front") return fakeResult("ASN:0x0-508e2:\n");
        return fakeResult(
          '"LSDisplayName"="Ghostty"\n"CFBundleIdentifier"="com.mitchellh.ghostty"\n',
        );
      },
    });

    const bundleId = await getFrontmostBundleId(spawn);

    expect(bundleId).toBe("com.mitchellh.ghostty");
  });

  it("returns null when the front ASN lookup fails", async () => {
    const { spawn } = makeSpawn({
      lsappinfo: () => fakeResult("", 1),
    });

    const bundleId = await getFrontmostBundleId(spawn);

    expect(bundleId).toBeNull();
  });
});

describe("isTerminalFrontmost", () => {
  it("returns false on non-darwin platforms without spawning anything", async () => {
    const { spawn, calls } = makeSpawn({});
    const getClientPid = () => {
      throw new Error("getClientPid should not be called on non-darwin");
    };

    const result = await isTerminalFrontmost(getClientPid, spawn, "linux");

    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false when any spawn call fails", async () => {
    const { spawn } = makeSpawn({
      ps: () => {
        throw new Error("ps unavailable");
      },
      lsappinfo: () => {
        throw new Error("lsappinfo unavailable");
      },
    });
    // Distinct pid per test: isTerminalFrontmost has no cache override, so it
    // always resolves through focus.ts's module-singleton bundle-id cache.
    // Reusing a pid across tests would silently serve a stale cached result.
    const getClientPid = async () => 90001;

    const result = await isTerminalFrontmost(getClientPid, spawn, "darwin");

    expect(result).toBe(false);
  });

  it("returns false when getClientPid resolves null (no attached client)", async () => {
    const { spawn, calls } = makeSpawn({});
    const getClientPid = async () => null;

    const result = await isTerminalFrontmost(getClientPid, spawn, "darwin");

    expect(result).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns true when the resolved terminal bundle id matches the frontmost app", async () => {
    const { spawn } = makeSpawn({
      ps: () =>
        fakeResult("1  /Applications/Ghostty.app/Contents/MacOS/ghostty"),
      defaults: () => fakeResult("com.mitchellh.ghostty"),
      lsappinfo: (argv) => {
        if (argv[1] === "front") return fakeResult("ASN:0x0-508e2:");
        return fakeResult('"CFBundleIdentifier"="com.mitchellh.ghostty"');
      },
    });
    const getClientPid = async () => 90002;

    const result = await isTerminalFrontmost(getClientPid, spawn, "darwin");

    expect(result).toBe(true);
  });

  it("returns false when the frontmost app differs from the terminal", async () => {
    const { spawn } = makeSpawn({
      ps: () =>
        fakeResult("1  /Applications/Ghostty.app/Contents/MacOS/ghostty"),
      defaults: () => fakeResult("com.mitchellh.ghostty"),
      lsappinfo: (argv) => {
        if (argv[1] === "front") return fakeResult("ASN:0x0-9999:");
        return fakeResult('"CFBundleIdentifier"="com.google.Chrome"');
      },
    });
    const getClientPid = async () => 90003;

    const result = await isTerminalFrontmost(getClientPid, spawn, "darwin");

    expect(result).toBe(false);
  });
});
