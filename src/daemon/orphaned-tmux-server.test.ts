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

/** Real Linux lsof 4.99.7 output for the same case: an orphaned server (pid
 *  1524666) holding the path on two fds and an attached client (1526376).
 *  Linux follows the path with the socket type, and a client names no path. */
const LSOF_ORPHANED_LINUX = [
  "p1524666",
  "n/tmp/ccv.RKcNR9/tt/tmux-1000/ccv type=STREAM",
  "n/tmp/ccv.RKcNR9/tt/tmux-1000/ccv type=STREAM",
  "p1526376",
  "ntype=STREAM",
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
      parseSocketHolders(
        LSOF_ORPHANED,
        "/private/tmp/tmux-501/default",
        "darwin",
      ),
    ).toEqual([19086]);
  });

  it("matches across macOS's /private spelling in either direction", () => {
    expect(
      parseSocketHolders(LSOF_ORPHANED, "/tmp/tmux-501/default", "darwin"),
    ).toEqual([19086]);
    expect(
      parseSocketHolders(
        "p7\nf3\nn/tmp/tmux-501/work\n",
        "/private/tmp/tmux-501/work",
        "darwin",
      ),
    ).toEqual([7]);
  });

  it("keeps /private on Linux, where it is a different directory", () => {
    expect(
      parseSocketHolders(
        "p7\nn/private/tmp/tmux-1000/default type=STREAM\n",
        "/tmp/tmux-1000/default",
        "linux",
      ),
    ).toEqual([]);
    expect(
      parseSocketHolders(
        "p7\nn/tmp/tmux-1000/default type=STREAM\n",
        "/private/tmp/tmux-1000/default",
        "linux",
      ),
    ).toEqual([]);
  });

  it("reads the path out of Linux's `<path> type=STREAM` name", () => {
    expect(
      parseSocketHolders(
        LSOF_ORPHANED_LINUX,
        "/tmp/ccv.RKcNR9/tt/tmux-1000/ccv",
        "linux",
      ),
    ).toEqual([1524666]);
  });

  it("strips only the type Linux lsof appends, not a ` type=` in the path", () => {
    const lsof = "p7\nn/tmp/review.sock type=backup type=STREAM\n";
    expect(parseSocketHolders(lsof, "/tmp/review.sock", "linux")).toEqual([]);
    expect(
      parseSocketHolders(lsof, "/tmp/review.sock type=backup", "linux"),
    ).toEqual([7]);
  });

  it("keeps a macOS name exactly as printed, ` type=` and all", () => {
    const lsof = "p7\nf3\nn/tmp/review.sock type=backup\n";
    expect(parseSocketHolders(lsof, "/tmp/review.sock", "darwin")).toEqual([]);
    expect(
      parseSocketHolders(lsof, "/tmp/review.sock type=backup", "darwin"),
    ).toEqual([7]);
  });

  it("does not match a Linux socket that only shares a prefix", () => {
    expect(
      parseSocketHolders(
        LSOF_ORPHANED_LINUX,
        "/tmp/ccv.RKcNR9/tt/tmux-1000/cc",
        "linux",
      ),
    ).toEqual([]);
  });

  it("does not match a different socket in the same directory", () => {
    expect(
      parseSocketHolders(LSOF_ORPHANED, "/tmp/tmux-501/work", "darwin"),
    ).toEqual([]);
  });

  it("does not strip /private from paths outside tmp and var", () => {
    expect(
      parseSocketHolders("p7\nf3\nn/private/etc/sock\n", "/etc/sock", "darwin"),
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
