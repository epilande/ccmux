import { describe, it, expect } from "bun:test";
import { buildStatusLines } from "./daemon";
import type { BuildIdentity } from "../lib/build-identity";

const cli: BuildIdentity = {
  version: "1.4.8",
  artifact: "/opt/homebrew/Cellar/ccmux/1.4.8/bin/ccmux",
  stamp: "5:1690000000000",
};

const rc: BuildIdentity = {
  version: "1.5.0-rc.1",
  artifact: "/opt/homebrew/Cellar/ccmux-rc/1.5.0-rc.1/bin/ccmux",
  stamp: "7:1700000000000",
};

describe("buildStatusLines", () => {
  it("names a daemon whose binary is gone, and why it will be replaced", () => {
    const lines = buildStatusLines(null, rc, cli, false);
    expect(lines[0]).toBe(
      `Daemon build: ${rc.version} ${rc.artifact} (${rc.stamp}), binary removed`,
    );
    expect(lines[2]).toStartWith(
      `Build: OUTDATED (daemon ${rc.version}, cli ${cli.version}); `,
    );
  });

  it("still says `none` for a daemon that predates build identity", () => {
    const lines = buildStatusLines(undefined, undefined, cli, false);
    expect(lines[0]).toBe("Daemon build: none (predates build identity)");
    expect(lines[2]).toStartWith("Build: OUTDATED (daemon unknown, ");
  });

  it("a newer daemon with its binary in place stays foreign", () => {
    const lines = buildStatusLines(rc, undefined, cli, false);
    expect(lines[0]).toBe(
      `Daemon build: ${rc.version} ${rc.artifact} (${rc.stamp})`,
    );
    expect(lines[2]).toStartWith("Build: foreign (daemon 1.5.0-rc.1 is newer");
  });
});
