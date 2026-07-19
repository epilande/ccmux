import { describe, it, expect, afterEach } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import {
  parseElapsedTime,
  isCodexPluginHostCwd,
  discoverAgentProcesses,
  discoverAgentProcessesOrThrow,
  dropWrapperParents,
  ProcessDiscoveryError,
} from "./processes";
import { CODEX_DIR } from "../lib/config";
import { CLAUDE_AGENT_DEF, BUILTIN_AGENTS } from "../lib/agents";

const CODEX_AGENT_DEF = BUILTIN_AGENTS.find((a) => a.name === "codex")!;

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

  it("drops a wrapper parent during discovery (5-column ps output)", async () => {
    mockPs({
      stdout: [
        "  PID  PPID TTY      ELAPSED  COMMAND",
        "  100     1 ttys001  00:05    node /opt/homebrew/bin/claude",
        "  101   100 ttys001  00:05    claude",
      ].join("\n"),
      exitCode: 0,
    });
    const processes = await discoverAgentProcessesOrThrow([CLAUDE_AGENT_DEF]);
    expect(processes.map((p) => p.pid)).toEqual([101]);
  });

  // Simulate `ps` producing `stdout` and `lsof -Ffn` producing `lsofStdout`,
  // so cwd-dependent behavior (the plugin-host filter) can be exercised.
  function mockPsAndLsof(stdout: string, lsofStdout: string) {
    Bun.spawn = ((cmd: string[]) => {
      if (cmd[0] === "ps") {
        return {
          stdout: new Blob([stdout]).stream(),
          stderr: new Blob([""]).stream(),
          exited: Promise.resolve(0),
        };
      }
      return {
        stdout: new Blob([lsofStdout]).stream(),
        stderr: new Blob([""]).stream(),
        exited: Promise.resolve(0),
      };
    }) as unknown as typeof Bun.spawn;
  }

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
      [
        "  PID  PPID TTY      ELAPSED  COMMAND",
        "   50     1 ttys077  05:00    -zsh",
        "   60    50 ttys077  04:50    codex",
        "   61    60 ttys077  00:10    ./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient mcp",
      ].join("\n"),
      ["p60", "fcwd", `n${realCwd}`, "p61", "fcwd", `n${pluginCwd}`].join("\n"),
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
