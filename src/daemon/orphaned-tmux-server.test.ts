import { describe, expect, it } from "bun:test";
import {
  findOrphanedTmuxServer,
  missingSocketPath,
  parseSocketHolders,
} from "./orphaned-tmux-server";

const MISSING =
  "error connecting to /private/tmp/tmux-501/default (No such file or directory)";

/** Real `lsof -U -a -c tmux -F pn` output from an orphaned server (pid 19086)
 *  and one of its attached clients (16634), whose socket is a bare peer. */
const LSOF_ORPHANED = [
  "p16634",
  "f5",
  "n->0xf5541e12ae127ab6",
  "p19086",
  "f5",
  "n/private/tmp/tmux-501/default",
  "f6",
  "n/private/tmp/tmux-501/default",
  "",
].join("\n");

describe("missingSocketPath", () => {
  it("reads the path out of tmux's missing-socket error", () => {
    expect(missingSocketPath(MISSING)).toBe("/private/tmp/tmux-501/default");
  });

  it("ignores a refused connection, which is a dead server, not an orphan", () => {
    expect(missingSocketPath("no server running on /tmp/tmux-501/work")).toBe(
      null,
    );
  });

  it("ignores other connect errors", () => {
    expect(
      missingSocketPath(
        "error connecting to /tmp/tmux-501/work (Permission denied)",
      ),
    ).toBe(null);
  });
});

describe("parseSocketHolders", () => {
  it("returns the server once, not once per fd, and never the client", () => {
    expect(
      parseSocketHolders(LSOF_ORPHANED, "/private/tmp/tmux-501/default"),
    ).toEqual([19086]);
  });

  it("matches across macOS's /private spelling in either direction", () => {
    expect(parseSocketHolders(LSOF_ORPHANED, "/tmp/tmux-501/default")).toEqual(
      [19086],
    );
    expect(
      parseSocketHolders(
        "p7\nf3\nn/tmp/tmux-501/work\n",
        "/private/tmp/tmux-501/work",
      ),
    ).toEqual([7]);
  });

  it("does not match a different socket in the same directory", () => {
    expect(parseSocketHolders(LSOF_ORPHANED, "/tmp/tmux-501/work")).toEqual(
      [],
    );
  });

  it("does not strip /private from paths outside tmp and var", () => {
    expect(
      parseSocketHolders("p7\nf3\nn/private/etc/sock\n", "/etc/sock"),
    ).toEqual([]);
  });
});

describe("findOrphanedTmuxServer", () => {
  it("names the one tmux process still holding the deleted socket", async () => {
    const calls: string[][] = [];
    const pid = await findOrphanedTmuxServer(MISSING, async (args) => {
      calls.push(args);
      return LSOF_ORPHANED;
    });
    expect(pid).toBe(19086);
    expect(calls).toEqual([["-U", "-a", "-c", "tmux", "-F", "pn"]]);
  });

  it("does not run lsof for any other error", async () => {
    let ran = false;
    const pid = await findOrphanedTmuxServer(
      "no server running on /tmp/tmux-501/default",
      async () => {
        ran = true;
        return LSOF_ORPHANED;
      },
    );
    expect(pid).toBe(null);
    expect(ran).toBe(false);
  });

  it("returns null when nothing holds the socket (tmux is simply not running)", async () => {
    expect(await findOrphanedTmuxServer(MISSING, async () => "")).toBe(null);
  });

  it("returns null when lsof is unavailable", async () => {
    expect(await findOrphanedTmuxServer(MISSING, async () => null)).toBe(null);
  });

  it("refuses to guess between two holders", async () => {
    const two =
      "p1\nf5\nn/private/tmp/tmux-501/default\np2\nf5\nn/private/tmp/tmux-501/default\n";
    expect(await findOrphanedTmuxServer(MISSING, async () => two)).toBe(null);
  });
});
