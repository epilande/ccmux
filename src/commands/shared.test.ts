import { describe, it, expect } from "bun:test";
import {
  defaultReconcileDeps,
  probeDaemon,
  reconcileDaemon,
  settleDaemon,
  type ReconcileDeps,
} from "./shared";
import type { BuildIdentity } from "../lib/build-identity";

/**
 * The reconcile decision matrix, driven entirely through injected deps: no
 * fetch, no lsof, no kill. `routes` answers `getJson` by path; a route that
 * throws stands in for a timeout or an unreadable body.
 */

const cli: BuildIdentity = {
  version: "1.3.2",
  artifact: "/opt/ccmux",
  stamp: "100:1000",
};

type Route =
  | { status: number; body: unknown }
  | (() => { status: number; body: unknown });

function harness(
  options: {
    alive?: boolean;
    routes?: Record<string, Route | Route[]>;
  } = {},
) {
  const launches: number[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const calls: string[] = [];
  const routes = { ...(options.routes ?? {}) };
  const deps: ReconcileDeps = defaultReconcileDeps({
    isAlive: async () => options.alive ?? true,
    getJson: async (path) => {
      calls.push(path);
      const entry = routes[path];
      if (entry === undefined) throw new Error(`no route for ${path}`);
      // A queue answers in order and repeats its last element.
      const route = Array.isArray(entry)
        ? (entry.length > 1 ? entry.shift() : entry[0])
        : entry;
      if (route === undefined) throw new Error(`no route for ${path}`);
      return typeof route === "function" ? route() : route;
    },
    launch: async () => {
      launches.push(Date.now());
    },
    cli,
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
  });
  return { deps, launches, logs, warns, calls };
}

const info = (
  build: unknown,
  busy?: { invocations: number; handoffs: number },
) => ({
  status: 200,
  body: { socketPath: "/tmp/sock", socketError: null, health: { degraded: false }, build, ...(busy ? { busy } : {}) },
});

const outdatedBuild = { ...cli, version: "1.3.1" };

describe("reconcileDaemon", () => {
  it("unreachable daemon: starts one, never reads /server-info", async () => {
    const h = harness({ alive: false });
    expect(await reconcileDaemon(h.deps)).toBe("started");
    expect(h.launches).toHaveLength(1);
    expect(h.logs).toEqual(["Starting daemon..."]);
    expect(h.calls).toEqual([]);
  });

  it("current build: nothing happens", async () => {
    const h = harness({
      routes: { "/server-info": info(cli, { invocations: 3, handoffs: 1 }) },
    });
    expect(await reconcileDaemon(h.deps)).toBe("kept");
    expect(h.launches).toHaveLength(0);
    expect(h.logs).toEqual([]);
    expect(h.warns).toEqual([]);
  });

  it("foreign build (another checkout, same version): left alone", async () => {
    const h = harness({
      routes: {
        "/server-info": info(
          { ...cli, artifact: "/elsewhere" },
          { invocations: 0, handoffs: 0 },
        ),
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("kept");
    expect(h.launches).toHaveLength(0);
  });

  it("outdated and idle: announces, re-probes once, then launches", async () => {
    const h = harness({
      routes: {
        "/server-info": info(outdatedBuild, { invocations: 0, handoffs: 0 }),
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("restarted");
    expect(h.launches).toHaveLength(1);
    expect(h.logs).toEqual(["Daemon is outdated; restarting..."]);
    expect(h.warns).toEqual([]);
    // One read for the probe, one re-read right before the kill.
    expect(h.calls).toEqual(["/server-info", "/server-info"]);
  });

  it("outdated but busy: warns with the counts and keeps the old daemon", async () => {
    const h = harness({
      routes: {
        "/server-info": info(outdatedBuild, { invocations: 2, handoffs: 1 }),
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("busy");
    expect(h.launches).toHaveLength(0);
    expect(h.logs).toEqual([]);
    expect(h.warns).toEqual([
      "Daemon is outdated but busy (2 running invocations, 1 queued handoffs); run `ccmux daemon restart` when it is free.",
    ]);
  });

  it("a queued handoff alone counts as busy", async () => {
    const h = harness({
      routes: {
        "/server-info": info(outdatedBuild, { invocations: 0, handoffs: 1 }),
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("busy");
    expect(h.launches).toHaveLength(0);
  });

  it("legacy daemon (no build, no busy) whose /invocations 404s: launches", async () => {
    const h = harness({
      routes: {
        "/server-info": info(undefined),
        "/invocations": { status: 404, body: { error: "not found" } },
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("restarted");
    expect(h.launches).toHaveLength(1);
    expect(h.calls).toEqual(["/server-info", "/invocations", "/server-info"]);
  });

  it("legacy daemon with a running invocation: no launch, invocations-only warning", async () => {
    const h = harness({
      routes: {
        "/server-info": info(undefined),
        "/invocations": {
          status: 200,
          body: {
            invocations: [
              { invocationId: "a", status: "running" },
              { invocationId: "b", status: "succeeded" },
            ],
          },
        },
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("busy");
    expect(h.launches).toHaveLength(0);
    expect(h.warns).toEqual([
      "Daemon is outdated but busy (1 running invocations); run `ccmux daemon restart` when it is free.",
    ]);
  });

  it("legacy daemon with only finished invocations: launches", async () => {
    const h = harness({
      routes: {
        "/server-info": info(undefined),
        "/invocations": {
          status: 200,
          body: { invocations: [{ invocationId: "b", status: "succeeded" }] },
        },
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("restarted");
  });

  it("legacy daemon whose /invocations is unreadable: fail safe, no launch", async () => {
    const h = harness({
      routes: {
        "/server-info": info(undefined),
        "/invocations": () => {
          throw new Error("timeout");
        },
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("busy");
    expect(h.launches).toHaveLength(0);
    expect(h.warns[0]).toContain("could not read its invocations");
  });

  it("legacy daemon whose /invocations body is malformed: fail safe, no launch", async () => {
    const h = harness({
      routes: {
        "/server-info": info(undefined),
        "/invocations": { status: 200, body: { invocations: "nope" } },
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("busy");
    expect(h.launches).toHaveLength(0);
  });

  it("/server-info timeout: fail open, the live daemon is kept", async () => {
    const h = harness({
      routes: {
        "/server-info": () => {
          throw new DOMException("timed out", "TimeoutError");
        },
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("kept");
    expect(h.launches).toHaveLength(0);
    expect(h.warns).toEqual([]);
  });

  it("race: the re-probe finds a current daemon, so nothing is killed", async () => {
    const h = harness({
      routes: {
        "/server-info": [
          info(outdatedBuild, { invocations: 0, handoffs: 0 }),
          info(cli, { invocations: 0, handoffs: 0 }),
        ],
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("raced");
    expect(h.launches).toHaveLength(0);
    expect(h.logs).toEqual(["Daemon is outdated; restarting..."]);
  });

  it("race: the re-probe cannot read the daemon, so it is kept (fail open)", async () => {
    const h = harness({
      routes: {
        "/server-info": [
          info(outdatedBuild, { invocations: 0, handoffs: 0 }),
          () => {
            throw new Error("timeout");
          },
        ],
      },
    });
    expect(await reconcileDaemon(h.deps)).toBe("raced");
    expect(h.launches).toHaveLength(0);
  });
});

describe("probeDaemon / settleDaemon split", () => {
  it("the probe has no side effects; settling is where the launch happens", async () => {
    const h = harness({
      routes: {
        "/server-info": info(outdatedBuild, { invocations: 0, handoffs: 0 }),
      },
    });
    const probe = await probeDaemon(h.deps);
    expect(probe).toEqual({
      alive: true,
      verdict: "outdated",
      daemonBuild: outdatedBuild,
      busy: { invocations: 0, handoffs: 0 },
    });
    expect(h.launches).toHaveLength(0);
    expect(h.logs).toEqual([]);
    expect(await settleDaemon(probe, h.deps)).toBe("restarted");
    expect(h.launches).toHaveLength(1);
  });

  it("busy is not measured for a current daemon", async () => {
    const h = harness({ routes: { "/server-info": info(cli) } });
    const probe = await probeDaemon(h.deps);
    expect(probe.verdict).toBe("current");
    expect(probe.busy).toBe(null);
    expect(h.calls).toEqual(["/server-info"]);
  });
});
