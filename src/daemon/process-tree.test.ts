import { describe, expect, test } from "bun:test";
import { ProcessTree, shellCommKey } from "./process-tree";
import { PS_HEADER, psLine } from "./process-tree-test-helpers";

describe("ProcessTree", () => {
  test("build() creates a tree from ps output", async () => {
    const tree = await ProcessTree.build();

    // Some restricted environments may return an empty process list.
    expect(tree.size).toBeGreaterThanOrEqual(0);
    expect(tree.builtAt).toBeLessThanOrEqual(Date.now());
  });

  test("getChildPids() returns empty array for non-existent parent", async () => {
    const tree = await ProcessTree.build();

    // PID 999999999 should not exist
    const children = tree.getChildPids(999999999);
    expect(children).toEqual([]);
  });

  test("getChildPids() returns children for init process (pid 1)", async () => {
    const tree = await ProcessTree.build();

    // PID 1 may not be visible in sandboxed test environments.
    const children = tree.getChildPids(1);
    expect(Array.isArray(children)).toBe(true);
  });

  test("getProcess() returns process info", async () => {
    const tree = await ProcessTree.build();

    // Current process may be absent in restricted process listings.
    const currentPid = process.pid;
    const proc = tree.getProcess(currentPid);

    if (proc) {
      expect(proc.pid).toBe(currentPid);
      expect(proc.ppid).toBeGreaterThan(0);
    } else {
      expect(proc).toBeUndefined();
    }
  });

  test("getProcess() returns undefined for non-existent pid", async () => {
    const tree = await ProcessTree.build();

    const proc = tree.getProcess(999999999);
    expect(proc).toBeUndefined();
  });

  test("findAgentDescendant() returns null when no match", async () => {
    const tree = await ProcessTree.build();
    const agentPids = new Set([999999999]); // Non-existent PID

    const result = tree.findAgentDescendant(1, agentPids);
    expect(result).toBeNull();
  });

  test("findAgentDescendant() finds direct match", async () => {
    const tree = await ProcessTree.build();
    const currentPid = process.pid;
    const agentPids = new Set([currentPid]);

    // Starting from current pid, should find itself
    const result = tree.findAgentDescendant(currentPid, agentPids);
    expect(result).toBe(currentPid);
  });

  test("findShellDescendants() returns empty array for non-existent pid", async () => {
    const tree = await ProcessTree.build();
    const shells = tree.findShellDescendants(999999999);
    expect(shells).toEqual([]);
  });

  test("SHELL_NAMES includes common shells", () => {
    expect(ProcessTree.SHELL_NAMES).toContain("bash");
    expect(ProcessTree.SHELL_NAMES).toContain("sh");
    expect(ProcessTree.SHELL_NAMES).toContain("zsh");
    expect(ProcessTree.SHELL_NAMES).toContain("fish");
    expect(ProcessTree.SHELL_NAMES).toContain("dash");
    expect(ProcessTree.SHELL_NAMES).toContain("ksh");
    expect(ProcessTree.SHELL_NAMES).toContain("csh");
    expect(ProcessTree.SHELL_NAMES).toContain("tcsh");
    expect(ProcessTree.SHELL_NAMES).toContain("ash");
  });

  describe("shellCommKey()", () => {
    // Positive fixtures: real shells, in the forms macOS/Linux `comm` actually
    // reports them (login-dash, bare path, path with embedded spaces from an
    // app-bundle-style directory). `comm` is argv[0]/task name, never a
    // space-separated argv list, so there is no "path+args" form to cover.
    test.each([
      ["-zsh", "zsh"],
      ["-/bin/zsh", "zsh"],
      ["/bin/zsh", "zsh"],
      ["/bin/bash", "bash"],
      ["/opt/homebrew/bin/fish", "fish"],
      // A real space-containing macOS comm path (a user directory with a
      // space in it). The old first-whitespace-token split would have cut
      // this at "a", missing the shell entirely; basename-only derivation
      // resolves it correctly since it splits on "/", not spaces.
      ["/Users/a b/bin/bash", "bash"],
    ])("derives %j -> %j", (comm, expected) => {
      expect(shellCommKey(comm)).toBe(expected);
    });

    // Negative fixtures: processes the old substring rule misclassified as
    // shells purely because their path or name contains a shell name as a
    // substring (e.g. ".local/share" contains "sh"). Paths use /Users/...
    // rather than `~`, since `ps` always emits absolute paths.
    test.each([
      "/Users/dev/.local/share/mise/installs/node/26.3.0/bin/node",
      "sshd-session: user [priv]",
      "/usr/libexec/sharingd",
      "/System/Library/CoreServices/ReportCrash",
      // A real space-containing macOS comm path for a non-shell binary
      // inside an app bundle's Helpers directory.
      "/Applications/Elgato Stream Deck.app/Contents/Helpers/crashpad_handler",
    ])("derives %j -> a key not in SHELL_NAMES", (comm) => {
      expect(ProcessTree.SHELL_NAMES).not.toContain(shellCommKey(comm));
    });

    // Defensive-tolerance fixtures: `comm` is never actually argv-shaped
    // (see the JSDoc on shellCommKey), but the function must not throw on
    // command-style input if it's ever handed some by a caller. These are
    // NOT representative of real ps output, and the derived key is
    // incidental rather than a guarantee — in particular, the login-wrapper
    // case below happens to end in "/bin/zsh" and so is (mis)classified as
    // a real zsh shell, which is why every other fixture in this file is
    // careful to stay comm-shaped rather than argv-shaped.
    test.each([
      ["/bin/bash --noprofile --norc", "bash --noprofile --norc"],
      ["sh -c echo hi", "sh -c echo hi"],
      ["/usr/bin/login -flp user /bin/bash -c exec -l /bin/zsh", "zsh"],
    ])("tolerates command-style input %j -> %j", (comm, expected) => {
      expect(shellCommKey(comm)).toBe(expected);
    });
  });

  describe("findShellDescendants() against fixture ps output", () => {
    test("finds a real shell descendant, exact match only", () => {
      const output = [
        PS_HEADER,
        psLine(100, 1, "/usr/bin/claude"),
        psLine(101, 100, "-zsh"),
        psLine(
          102,
          100,
          "/Users/dev/.local/share/mise/installs/node/26.3.0/bin/node",
        ),
      ].join("\n");

      const tree = ProcessTree.fromPsOutput(output);
      const shells = tree.findShellDescendants(100);

      expect(shells).toEqual([101]);
    });

    test("returns empty when the only descendant is a language server under a path containing 'sh'", () => {
      const output = [
        PS_HEADER,
        psLine(200, 1, "/usr/bin/claude"),
        psLine(
          201,
          200,
          "/Users/dev/.local/share/mise/installs/node/26.3.0/bin/node",
        ),
        psLine(202, 200, "/usr/libexec/sharingd"),
      ].join("\n");

      const tree = ProcessTree.fromPsOutput(output);
      const shells = tree.findShellDescendants(200);

      expect(shells).toEqual([]);
    });

    test("tolerates a login-wrapper argv string fed in as comm (not representative of real ps output)", () => {
      // Real `ps` comm is never argv-shaped (see shellCommKey's JSDoc), so
      // this input can't occur in practice. It's kept here only to document
      // the known trade-off: because the derivation no longer strips argv,
      // a synthetic comm string that happens to end in "/bin/zsh" derives
      // to "zsh" and is (mis)classified as a real shell descendant.
      const output = [
        PS_HEADER,
        psLine(300, 1, "/usr/bin/claude"),
        psLine(
          301,
          300,
          "/usr/bin/login -flp user /bin/bash -c exec -l /bin/zsh",
        ),
      ].join("\n");

      const tree = ProcessTree.fromPsOutput(output);
      const shells = tree.findShellDescendants(300);

      expect(shells).toEqual([301]);
    });

    test("finds shells across the expanded name set (dash, ksh, csh, tcsh, ash)", () => {
      const output = [
        PS_HEADER,
        psLine(400, 1, "/usr/bin/claude"),
        psLine(401, 400, "/bin/dash"),
        psLine(402, 400, "/bin/ksh"),
        psLine(403, 400, "/bin/csh"),
        psLine(404, 400, "/bin/tcsh"),
        psLine(405, 400, "/bin/ash"),
      ].join("\n");

      const tree = ProcessTree.fromPsOutput(output);
      const shells = tree.findShellDescendants(400);

      expect(shells.sort((a, b) => a - b)).toEqual([401, 402, 403, 404, 405]);
    });
  });
});
