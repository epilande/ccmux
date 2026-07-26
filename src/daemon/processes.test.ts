import { describe, it, expect, afterEach } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  parseElapsedTime,
  parseLsofFdOutput,
  parsePsOutput,
  isCodexPluginHostCwd,
  discoverAgentProcesses,
  discoverAgentProcessesOrThrow,
  dropWrapperParents,
  resolveDiscoveredProcesses,
  ProcessDiscoveryError,
  FD_TTY_DISCOVERY,
  PS_TTY_DISCOVERY,
  type MatchedProcess,
  type ProcessFdInfo,
} from "./processes";
import { CODEX_DIR } from "../lib/config";
import { CLAUDE_AGENT_DEF, BUILTIN_AGENTS } from "../lib/agents";

const CODEX_AGENT_DEF = BUILTIN_AGENTS.find((a) => a.name === "codex")!;
const GEMINI_AGENT_DEF = BUILTIN_AGENTS.find((a) => a.name === "gemini")!;

describe("parseElapsedTime", () => {
  it("should parse MM:SS format", () => {
    expect(parseElapsedTime("00:05")).toBe(5);
    expect(parseElapsedTime("01:30")).toBe(90);
    expect(parseElapsedTime("59:59")).toBe(3599);
  });

  it("should parse HH:MM:SS format", () => {
    expect(parseElapsedTime("01:00:00")).toBe(3600);
    expect(parseElapsedTime("01:30:15")).toBe(5415);
    expect(parseElapsedTime("23:59:59")).toBe(86399);
  });

  it("should parse DD-HH:MM:SS format", () => {
    expect(parseElapsedTime("1-00:00:00")).toBe(86400);
    expect(parseElapsedTime("2-05:30:00")).toBe(192600);
    expect(parseElapsedTime("7-12:30:45")).toBe(649845);
  });

  it("should handle invalid input", () => {
    expect(parseElapsedTime("")).toBeNull();
    expect(parseElapsedTime("??")).toBeNull();
    expect(parseElapsedTime("-")).toBeNull();
    expect(parseElapsedTime("invalid")).toBeNull();
  });

  it("should handle whitespace", () => {
    expect(parseElapsedTime("  00:05  ")).toBe(5);
    expect(parseElapsedTime("\t01:30\n")).toBe(90);
  });
});

describe("isCodexPluginHostCwd", () => {
  it("matches a cwd under the codex plugins dir", () => {
    expect(
      isCodexPluginHostCwd(
        join(
          CODEX_DIR,
          "plugins",
          "cache",
          "openai-bundled",
          "computer-use",
          "1.0.793",
        ),
      ),
    ).toBe(true);
  });

  it("does not match a normal project cwd", () => {
    expect(isCodexPluginHostCwd(join(homedir(), "Code", "ccmux"))).toBe(false);
  });

  it("does not match a sibling dir sharing the plugins prefix", () => {
    expect(isCodexPluginHostCwd(join(CODEX_DIR, "plugins-backup", "x"))).toBe(
      false,
    );
  });

  it("does not match the plugins dir itself with no trailing path", () => {
    expect(isCodexPluginHostCwd(join(CODEX_DIR, "plugins"))).toBe(false);
  });

  it("handles a null cwd", () => {
    expect(isCodexPluginHostCwd(null)).toBe(false);
  });
});

describe("dropWrapperParents", () => {
  const entry = (
    pid: number,
    ppid: number | null,
    agentType = "gemini",
    tty = "ttys001",
  ) => ({ pid, ppid, agentType, tty });

  it("drops the wrapper when its child matches the same agent on the same tty", () => {
    // The gemini brew wrapper re-execs node: parent and child have identical
    // command lines, so only the parent/child link can tell them apart.
    const kept = dropWrapperParents([entry(100, 1), entry(101, 100)]);
    expect(kept).toEqual([entry(101, 100)]);
  });

  it("collapses a shim -> wrapper -> binary chain to the deepest process", () => {
    const kept = dropWrapperParents([
      entry(100, 1),
      entry(101, 100),
      entry(102, 101),
    ]);
    expect(kept).toEqual([entry(102, 101)]);
  });

  it("keeps both when the same agent runs on different ttys", () => {
    const a = entry(100, 1, "gemini", "ttys001");
    const b = entry(101, 100, "gemini", "ttys002");
    expect(dropWrapperParents([a, b])).toEqual([a, b]);
  });

  it("keeps both when different agents share a tty with a parent link", () => {
    const shell = entry(100, 1, "claude", "ttys001");
    const child = entry(101, 100, "gemini", "ttys001");
    expect(dropWrapperParents([shell, child])).toEqual([shell, child]);
  });

  it("keeps unrelated same-agent processes on the same tty (no parent link)", () => {
    const a = entry(100, 1);
    const b = entry(101, 2);
    expect(dropWrapperParents([a, b])).toEqual([a, b]);
  });

  it("keeps an entry with a null ppid", () => {
    const a = entry(100, null);
    expect(dropWrapperParents([a])).toEqual([a]);
  });
});

describe("parseLsofFdOutput", () => {
  it("reads cwd and the pane tty from the codex fd shape (fd2 on /dev/null)", () => {
    // Codex runs with fd2 redirected to /dev/null while fd0/fd1 hold the
    // pane tty, which is why all three fds have to be read.
    const output = [
      "p4242",
      "fcwd",
      "n/Users/dev/Code/myrepo",
      "f0",
      "n/dev/ttys012",
      "f1",
      "n/dev/ttys012",
      "f2",
      "n/dev/null",
    ].join("\n");

    expect(parseLsofFdOutput(output).get(4242)).toEqual({
      cwd: "/Users/dev/Code/myrepo",
      tty: "ttys012",
    });
  });

  it("reports no tty when every stdio fd is a pipe", () => {
    // Subprocess-mode invokes (`codex exec`, `cursor-agent --print`) and MCP
    // servers look like this; they must never become pane-tracked sessions.
    const output = [
      "p77",
      "fcwd",
      "n/Users/dev/Code/myrepo",
      "f0",
      "npipe",
      "f1",
      "npipe",
      "f2",
      "npipe",
    ].join("\n");

    expect(parseLsofFdOutput(output).get(77)).toEqual({
      cwd: "/Users/dev/Code/myrepo",
      tty: null,
    });
  });

  it("tolerates an f record whose n payload is empty", () => {
    // Observed live: lsof emits `f<n>` followed by an empty `n` line. The
    // empty payload must not be recorded, and must not shift the following
    // record's name onto the wrong fd.
    const output = [
      "p88",
      "fcwd",
      "n",
      "f0",
      "n/dev/ttys003",
      "f1",
      "n",
      "f2",
      "n/dev/ttys003",
    ].join("\n");

    expect(parseLsofFdOutput(output).get(88)).toEqual({
      cwd: null,
      tty: "ttys003",
    });
  });

  it("skips interleaved non-stdio records between cwd and the fd block", () => {
    const output = [
      "p99",
      "fcwd",
      "n/Users/dev/Code/myrepo",
      "ftxt",
      "n/opt/homebrew/bin/node",
      "ftxt",
      "n/usr/lib/dyld",
      "fmem",
      "n/usr/lib/libSystem.dylib",
      "f0",
      "n/dev/ttys055",
      "f1",
      "n/dev/ttys055",
      "f2",
      "n/dev/ttys055",
    ].join("\n");

    expect(parseLsofFdOutput(output).get(99)).toEqual({
      cwd: "/Users/dev/Code/myrepo",
      tty: "ttys055",
    });
  });

  it("ignores a tty held on a higher fd", () => {
    // ccmux's own OSC notification backend opens OTHER panes' ttys on high
    // fds (notify-osc.ts), so anything past fd2 would mis-attribute the
    // process to someone else's pane.
    const output = [
      "p101",
      "fcwd",
      "n/Users/dev/Code/myrepo",
      "f0",
      "npipe",
      "f1",
      "npipe",
      "f2",
      "npipe",
      "f5",
      "n/dev/ttys044",
      "f11",
      "n/dev/ttys061",
    ].join("\n");

    expect(parseLsofFdOutput(output).get(101)).toEqual({
      cwd: "/Users/dev/Code/myrepo",
      tty: null,
    });
  });

  it("rejects non-terminal device names on stdio fds", () => {
    // `/dev/tty` names no specific device (it is the controlling-terminal
    // alias), so it could never match a pane; `/dev/null` is not a terminal.
    const output = [
      "p102",
      "f0",
      "n/dev/null",
      "f1",
      "n/dev/tty",
      "f2",
      "n/dev/urandom",
    ].join("\n");

    // Nothing usable was recorded, so the pid gets no entry at all; callers
    // read that identically to "no cwd, no tty".
    expect(parseLsofFdOutput(output).get(102)).toBeUndefined();
  });

  it("accepts the Linux pts form", () => {
    const output = ["p103", "f0", "n/dev/pts/7"].join("\n");
    expect(parseLsofFdOutput(output).get(103)?.tty).toBe("pts/7");
  });

  it("keeps per-process state separate across multiple pids", () => {
    const output = [
      "p1",
      "fcwd",
      "n/one",
      "f0",
      "n/dev/ttys001",
      "p2",
      "fcwd",
      "n/two",
      "f0",
      "npipe",
      "p3",
      "f0",
      "n/dev/ttys003",
    ].join("\n");

    const parsed = parseLsofFdOutput(output);
    expect(parsed.get(1)).toEqual({ cwd: "/one", tty: "ttys001" });
    expect(parsed.get(2)).toEqual({ cwd: "/two", tty: null });
    expect(parsed.get(3)).toEqual({ cwd: null, tty: "ttys003" });
  });

  it("drops records under an unparsable process line", () => {
    const output = ["pnotanumber", "fcwd", "n/one", "f0", "n/dev/ttys001"].join(
      "\n",
    );
    expect(parseLsofFdOutput(output).size).toBe(0);
  });

  it("returns an empty map for empty output", () => {
    expect(parseLsofFdOutput("").size).toBe(0);
  });
});

describe("discovery platforms", () => {
  // Both records are exercised regardless of the host, so CI (ubuntu-only)
  // still covers the macOS ps layout and the lsof flags it depends on.
  it("pins the lsof invocation for each platform", () => {
    // `-a` is what confines lsof to the requested pids: without it lsof ORs
    // `-p` and `-d` and enumerates every process on the machine, silently.
    expect(FD_TTY_DISCOVERY.lsofArgv("10,11")).toEqual([
      "lsof",
      "-a",
      "-p",
      "10,11",
      "-d",
      "cwd,0,1,2",
      "-Ffn",
    ]);
    expect(PS_TTY_DISCOVERY.lsofArgv("10,11")).toEqual([
      "lsof",
      "-p",
      "10,11",
      "-Ffn",
    ]);
  });

  it("puts command last and asks for tty only where ps is the source", () => {
    expect(FD_TTY_DISCOVERY.psColumns).toBe("pid,ppid,etime,command");
    expect(PS_TTY_DISCOVERY.psColumns).toBe("pid,ppid,tty,etime,command");
    for (const platform of [FD_TTY_DISCOVERY, PS_TTY_DISCOVERY]) {
      const columns = platform.psColumns.split(",");
      expect(columns[columns.length - 1]).toBe("command");
    }
  });
});

describe("parsePsOutput", () => {
  const NOW = 1_700_000_000_000;

  it("reads every column off the platform's own layout", () => {
    // Same two processes, rendered in each platform's column order. The
    // tty-less macOS row is expected: lsof supplies that value there.
    const fdRows = parsePsOutput(
      [
        "  PID  PPID     ELAPSED COMMAND",
        "  100     1       00:05 claude --resume",
      ].join("\n"),
      [CLAUDE_AGENT_DEF],
      FD_TTY_DISCOVERY,
      NOW,
    );
    expect(fdRows).toEqual([
      {
        pid: 100,
        ppid: 1,
        tty: null,
        command: "claude --resume",
        agentType: "claude",
        startTime: NOW - 5000,
      },
    ]);

    const psRows = parsePsOutput(
      [
        "  PID  PPID TTY          ELAPSED COMMAND",
        "  100     1 ttys001        00:05 claude --resume",
      ].join("\n"),
      [CLAUDE_AGENT_DEF],
      PS_TTY_DISCOVERY,
      NOW,
    );
    expect(psRows).toEqual([{ ...fdRows[0], tty: "ttys001" }]);
  });

  it("normalizes both no-terminal spellings ps uses", () => {
    const rowFor = (tty: string) =>
      parsePsOutput(
        ["HEADER", `  100     1 ${tty}  00:05 claude`].join("\n"),
        [CLAUDE_AGENT_DEF],
        PS_TTY_DISCOVERY,
        NOW,
      )[0];

    expect(rowFor("??").tty).toBeNull(); // BSD
    expect(rowFor("?").tty).toBeNull(); // Linux
    expect(rowFor("ttys001").tty).toBe("ttys001");
  });

  it("skips the header, short rows, and non-agent commands", () => {
    const rows = parsePsOutput(
      [
        "  PID  PPID     ELAPSED COMMAND",
        "  100     1       00:05 claude",
        "  101     1       00:05 -zsh",
        "  102     1", // truncated row
        "  bad     1       00:05 claude",
      ].join("\n"),
      [CLAUDE_AGENT_DEF],
      FD_TTY_DISCOVERY,
      NOW,
    );
    expect(rows.map((r) => r.pid)).toEqual([100]);
  });

  it("keeps the whole command line and a null startTime for unparsable etime", () => {
    const [row] = parsePsOutput(
      ["HEADER", "  100     1          ?? claude -p 'do a thing'"].join("\n"),
      [CLAUDE_AGENT_DEF],
      FD_TTY_DISCOVERY,
      NOW,
    );
    expect(row.command).toBe("claude -p 'do a thing'");
    expect(row.startTime).toBeNull();
  });
});

describe("resolveDiscoveredProcesses (filter order)", () => {
  const realCwd = join(homedir(), "Code", "myrepo");
  const pluginCwd = join(
    CODEX_DIR,
    "plugins",
    "cache",
    "openai-bundled",
    "computer-use",
    "1.0.793",
  );

  const matched = (
    pid: number,
    ppid: number,
    agentType: string,
    tty: string | null,
  ): MatchedProcess => ({
    pid,
    ppid,
    tty,
    command: `${agentType} (pid ${pid})`,
    agentType,
    startTime: 1_700_000_000_000,
  });

  // pid 60: the real codex. pid 61: its computer-use plugin host (same tty,
  // child of 60). pid 62: a `codex exec` subprocess invoke with piped stdio.
  // pids 70/71: a gemini wrapper and the binary it re-execs.
  const rows = [
    matched(60, 50, "codex", "ttys077"),
    matched(61, 60, "codex", "ttys077"),
    matched(62, 1, "codex", null),
    matched(70, 51, "gemini", "ttys088"),
    matched(71, 70, "gemini", "ttys088"),
  ];

  const fds = new Map<number, ProcessFdInfo>([
    [60, { cwd: realCwd, tty: "ttys077" }],
    [61, { cwd: pluginCwd, tty: "ttys077" }],
    [62, { cwd: realCwd, tty: null }],
    [70, { cwd: realCwd, tty: "ttys088" }],
    [71, { cwd: realCwd, tty: "ttys088" }],
  ]);

  it("filters tty-less, then plugin hosts, then wrappers", () => {
    const resolved = resolveDiscoveredProcesses(rows, fds);

    // 60 survives only if the plugin-host filter ran before
    // dropWrapperParents; 62 is gone only if the tty filter ran at all; 70 is
    // gone only if dropWrapperParents ran last, on the post-filter set.
    expect(resolved.map((p) => p.pid)).toEqual([60, 71]);
    expect(resolved[0]).toEqual({
      pid: 60,
      command: "codex (pid 60)",
      agentType: "codex",
      tty: "ttys077",
      cwd: realCwd,
      startTime: 1_700_000_000_000,
    });
  });

  it("keeps a ps-tty row whose lsof entry is missing entirely, with a null cwd", () => {
    // Only reachable on the ps-tty platforms: the tty arrives in the ps row
    // and is already settled here, so a process lsof could not be read for
    // stays discoverable and merely loses its cwd. On the fd-tty platform a
    // missing lsof entry means a missing tty, and the row is dropped instead
    // — see "drops a row lsof omitted" in the fd-tty suite below.
    const [row] = resolveDiscoveredProcesses([rows[0]], new Map());
    expect(row).toMatchObject({ pid: 60, tty: "ttys077", cwd: null });
  });
});

describe("agent discovery failure semantics (fail-closed)", () => {
  const originalBunSpawn = Bun.spawn;

  afterEach(() => {
    Bun.spawn = originalBunSpawn;
  });

  // Simulate `ps` producing `stdout` and exiting with `exitCode`. Only the
  // `ps` call is intercepted; a throwing spawn simulates a spawn exception.
  function mockPs(opts: {
    stdout?: string;
    exitCode?: number;
    throwOnSpawn?: boolean;
  }) {
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === "ps") {
        if (opts.throwOnSpawn) throw new Error("EAGAIN: resource unavailable");
        return {
          stdout: new Blob([opts.stdout ?? ""]).stream(),
          stderr: new Blob([""]).stream(),
          exited: Promise.resolve(opts.exitCode ?? 0),
        };
      }
      // lsof (cwd batch) — return nothing; irrelevant to these cases.
      return {
        stdout: new Blob([""]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;
  }

  it("throws ProcessDiscoveryError when ps exits non-zero", async () => {
    mockPs({ stdout: "", exitCode: 1 });
    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).rejects.toBeInstanceOf(ProcessDiscoveryError);
  });

  it("throws ProcessDiscoveryError when ps produces no output", async () => {
    // ps always prints a header, so empty output means it did not run.
    mockPs({ stdout: "", exitCode: 0 });
    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).rejects.toBeInstanceOf(ProcessDiscoveryError);
  });

  it("throws ProcessDiscoveryError when the ps spawn itself throws", async () => {
    mockPs({ throwOnSpawn: true });
    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).rejects.toBeInstanceOf(ProcessDiscoveryError);
  });

  it("returns [] (does NOT throw) for a genuinely-empty agent list", async () => {
    // ps ran fine (header only) but no line matches an agent.
    mockPs({ stdout: "  PID TTY      TIME     COMMAND\n", exitCode: 0 });
    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).resolves.toEqual([]);
  });

  // Simulate `ps` producing `stdout` and `lsof -Ffn` producing `lsofStdout`,
  // so cwd- and fd-dependent behavior can be exercised. Returns the argv of
  // every spawn, so the exact invocations stay pinned.
  function mockPsAndLsof(stdout: string, lsofStdout: string) {
    const spawned: string[][] = [];
    Bun.spawn = ((cmd: string[]) => {
      spawned.push(cmd);
      const out = cmd[0] === "ps" ? stdout : lsofStdout;
      return {
        stdout: new Blob([out]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;
    return spawned;
  }

  // These tests run against whichever platform record the host resolves to,
  // so the fixture renders its ps columns from that record rather than
  // re-deriving the platform check. Both records are covered directly by the
  // parsePsOutput and "discovery platforms" suites above.
  const HOST_PLATFORM =
    process.platform === "darwin" ? FD_TTY_DISCOVERY : PS_TTY_DISCOVERY;
  const COLUMNS = HOST_PLATFORM.psColumns.split(",");

  function psOutput(
    rows: Array<{
      pid: number;
      ppid: number;
      tty: string;
      etime: string;
      command: string;
    }>,
  ): string {
    return [
      COLUMNS.join(" ").toUpperCase(),
      ...rows.map((r) =>
        COLUMNS.map((c) => String(r[c as keyof typeof r])).join(" "),
      ),
    ].join("\n");
  }

  /** Realistic `lsof -Ffn` output: cwd, then the pane tty on fds 0/1/2. */
  function lsofOutput(
    entries: Array<{ pid: number; cwd?: string; tty?: string }>,
  ): string {
    return entries
      .flatMap((e) => [
        `p${e.pid}`,
        ...(e.cwd ? ["fcwd", `n${e.cwd}`] : []),
        ...(e.tty
          ? [
              "f0",
              `n/dev/${e.tty}`,
              "f1",
              `n/dev/${e.tty}`,
              "f2",
              `n/dev/${e.tty}`,
            ]
          : []),
      ])
      .join("\n");
  }

  it("drops a wrapper parent during discovery", async () => {
    // The gemini brew wrapper and the binary it re-execs both match the
    // gemini def, so only the parent/child link separates them.
    const spawned = mockPsAndLsof(
      psOutput([
        {
          pid: 100,
          ppid: 1,
          tty: "ttys001",
          etime: "00:05",
          command: "node /opt/homebrew/bin/gemini",
        },
        {
          pid: 101,
          ppid: 100,
          tty: "ttys001",
          etime: "00:05",
          command: "node /opt/homebrew/bin/gemini",
        },
      ]),
      lsofOutput([
        { pid: 100, cwd: "/repo", tty: "ttys001" },
        { pid: 101, cwd: "/repo", tty: "ttys001" },
      ]),
    );

    const processes = await discoverAgentProcessesOrThrow([GEMINI_AGENT_DEF]);
    expect(processes.map((p) => p.pid)).toEqual([101]);
    expect(processes[0].tty).toBe("ttys001");

    // Discovery must run the host platform record's own invocations (the
    // flags themselves are pinned per record in "discovery platforms").
    expect(spawned[0]).toEqual(["ps", "-eo", HOST_PLATFORM.psColumns]);
    expect(spawned[1]).toEqual(HOST_PLATFORM.lsofArgv("100,101"));
  });

  it("drops an agent-matched process with no tty", async () => {
    // A subprocess-mode invoke (`codex exec` and friends) runs with piped
    // stdio and no controlling terminal; it must not become a session.
    mockPsAndLsof(
      psOutput([
        {
          pid: 200,
          ppid: 1,
          tty: "??",
          etime: "00:05",
          command: "claude -p 'do the thing'",
        },
      ]),
      lsofOutput([{ pid: 200, cwd: "/repo" }]),
    );

    await expect(
      discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]),
    ).resolves.toEqual([]);
  });

  it("keeps the real codex process when its computer-use plugin host shares its tty and is its ppid", async () => {
    // Regression: the computer-use plugin host is a same-tty child of the
    // real codex process and matches the codex agent def, so running
    // dropWrapperParents before the plugin-host cwd filter evicted the real
    // codex via the host's ppid link, leaving zero codex entries for the pane.
    const realCwd = join(homedir(), "Code", "myrepo");
    const pluginCwd = join(
      CODEX_DIR,
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "1.0.793",
    );

    mockPsAndLsof(
      psOutput([
        {
          pid: 50,
          ppid: 1,
          tty: "ttys077",
          etime: "05:00",
          command: "-zsh",
        },
        {
          pid: 60,
          ppid: 50,
          tty: "ttys077",
          etime: "04:50",
          command: "codex",
        },
        {
          pid: 61,
          ppid: 60,
          tty: "ttys077",
          etime: "00:10",
          command:
            "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient mcp",
        },
      ]),
      lsofOutput([
        { pid: 60, cwd: realCwd, tty: "ttys077" },
        { pid: 61, cwd: pluginCwd, tty: "ttys077" },
      ]),
    );

    const processes = await discoverAgentProcessesOrThrow([CODEX_AGENT_DEF]);
    expect(processes).toEqual([
      {
        pid: 60,
        command: "codex",
        agentType: "codex",
        tty: "ttys077",
        cwd: realCwd,
        startTime: expect.any(Number),
      },
    ]);
  });

  it("fail-soft discoverAgentProcesses swallows a hard ps failure as []", async () => {
    mockPs({ stdout: "", exitCode: 1 });
    await expect(discoverAgentProcesses([CLAUDE_AGENT_DEF])).resolves.toEqual(
      [],
    );
  });
});

/**
 * lsof failure semantics, run against BOTH platform records explicitly rather
 * than the host's, because the whole point is that they diverge: on the fd-tty
 * platform lsof is the only tty source, so losing it loses every row.
 */
describe("lsof failure semantics", () => {
  const originalBunSpawn = Bun.spawn;

  afterEach(() => {
    Bun.spawn = originalBunSpawn;
  });

  interface LsofBehavior {
    stdout?: string;
    exitCode?: number;
    throwOnSpawn?: boolean;
  }

  /** Renders ps rows in `platform`'s column order and scripts lsof's reply. */
  function mockPsAndLsof(
    platform: typeof FD_TTY_DISCOVERY,
    rows: Array<{
      pid: number;
      ppid: number;
      tty: string;
      etime: string;
      command: string;
    }>,
    lsof: LsofBehavior,
  ): string[][] {
    const columns = platform.psColumns.split(",");
    const psStdout = [
      columns.join(" ").toUpperCase(),
      ...rows.map((r) =>
        columns.map((c) => String(r[c as keyof typeof r])).join(" "),
      ),
    ].join("\n");

    const spawned: string[][] = [];
    Bun.spawn = ((cmd: string[]) => {
      spawned.push(cmd);
      if (cmd[0] === "ps") {
        return {
          stdout: new Blob([psStdout]).stream(),
          stderr: new Blob([""]).stream(),
          exited: Promise.resolve(0),
        };
      }
      if (lsof.throwOnSpawn) throw new Error("EAGAIN: resource unavailable");
      return {
        stdout: new Blob([lsof.stdout ?? ""]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(lsof.exitCode ?? 0),
      };
    }) as unknown as typeof Bun.spawn;
    return spawned;
  }

  const claudeRow = (pid: number, tty: string) => ({
    pid,
    ppid: 1,
    tty,
    etime: "00:05",
    command: "claude",
  });

  /** `lsof -Ffn` records: cwd, then the pane tty on fds 0/1/2. */
  const lsofRecords = (
    entries: Array<{ pid: number; cwd?: string; tty?: string }>,
  ): string =>
    entries
      .flatMap((e) => [
        `p${e.pid}`,
        ...(e.cwd ? ["fcwd", `n${e.cwd}`] : []),
        ...(e.tty ? ["f0", `n/dev/${e.tty}`] : []),
      ])
      .join("\n");

  describe("fd-tty platform (macOS)", () => {
    it("throws ProcessDiscoveryError when the lsof spawn throws", async () => {
      // Without this, every row takes tty:null, all are filtered out, and
      // discovery returns [] — which the scan loop reads as "every agent
      // exited" and acts on by wiping sessions and deleting every marker.
      mockPsAndLsof(FD_TTY_DISCOVERY, [claudeRow(100, "ttys001")], {
        throwOnSpawn: true,
      });

      await expect(
        discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF], FD_TTY_DISCOVERY),
      ).rejects.toBeInstanceOf(ProcessDiscoveryError);
    });

    it("throws ProcessDiscoveryError when lsof exits non-zero with no output", async () => {
      mockPsAndLsof(FD_TTY_DISCOVERY, [claudeRow(100, "ttys001")], {
        stdout: "",
        exitCode: 1,
      });

      await expect(
        discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF], FD_TTY_DISCOVERY),
      ).rejects.toBeInstanceOf(ProcessDiscoveryError);
    });

    it("keeps working when lsof exits non-zero but still reports records", async () => {
      // The routine case: lsof errors because a pid died between `ps` and the
      // lsof call, while printing every other process normally. This must
      // degrade to the rows it could resolve, NOT fail the whole scan.
      mockPsAndLsof(
        FD_TTY_DISCOVERY,
        [claudeRow(100, "ttys001"), claudeRow(101, "ttys002")],
        {
          stdout: lsofRecords([{ pid: 100, cwd: "/repo", tty: "ttys001" }]),
          exitCode: 1,
        },
      );

      const processes = await discoverAgentProcessesOrThrow(
        [CLAUDE_AGENT_DEF],
        FD_TTY_DISCOVERY,
      );
      expect(processes.map((p) => p.pid)).toEqual([100]);
      expect(processes[0]).toMatchObject({ tty: "ttys001", cwd: "/repo" });
    });

    it("drops a row lsof omitted while the call itself succeeded", async () => {
      // No tty for pid 101 means no pane can ever hold it, so it is not a
      // session. Cleanup hysteresis absorbs a one-scan omission of a live one.
      mockPsAndLsof(
        FD_TTY_DISCOVERY,
        [claudeRow(100, "ttys001"), claudeRow(101, "ttys002")],
        { stdout: lsofRecords([{ pid: 100, cwd: "/repo", tty: "ttys001" }]) },
      );

      const processes = await discoverAgentProcessesOrThrow(
        [CLAUDE_AGENT_DEF],
        FD_TTY_DISCOVERY,
      );
      expect(processes.map((p) => p.pid)).toEqual([100]);
    });

    it("returns [] without throwing when lsof legitimately reports nothing", async () => {
      // Exit 0 and no records: every requested pid raced away. A real answer,
      // not a failure.
      mockPsAndLsof(FD_TTY_DISCOVERY, [claudeRow(100, "ttys001")], {
        stdout: "",
        exitCode: 0,
      });

      await expect(
        discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF], FD_TTY_DISCOVERY),
      ).resolves.toEqual([]);
    });
  });

  describe("ps-tty platform (Linux and friends)", () => {
    it("survives a hard lsof failure, keeping every row with a null cwd", async () => {
      // `ps` already supplied the tty here, so lsof only ever contributed the
      // cwd. Losing it must not fail the scan.
      mockPsAndLsof(PS_TTY_DISCOVERY, [claudeRow(100, "ttys001")], {
        throwOnSpawn: true,
      });

      const processes = await discoverAgentProcessesOrThrow(
        [CLAUDE_AGENT_DEF],
        PS_TTY_DISCOVERY,
      );
      expect(processes).toMatchObject([
        { pid: 100, tty: "ttys001", cwd: null },
      ]);
    });

    it("asks lsof only about rows that survived the tty filter", async () => {
      // pid 101 has no controlling terminal, so it is dropped regardless;
      // widening the lsof call to cover it would be pure cost.
      const spawned = mockPsAndLsof(
        PS_TTY_DISCOVERY,
        [claudeRow(100, "ttys001"), claudeRow(101, "??")],
        { stdout: lsofRecords([{ pid: 100, cwd: "/repo" }]) },
      );

      const processes = await discoverAgentProcessesOrThrow(
        [CLAUDE_AGENT_DEF],
        PS_TTY_DISCOVERY,
      );
      expect(processes.map((p) => p.pid)).toEqual([100]);
      expect(spawned[1]).toEqual(PS_TTY_DISCOVERY.lsofArgv("100"));
    });
  });
});
