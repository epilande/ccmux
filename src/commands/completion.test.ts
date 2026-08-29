import { describe, expect, it } from "bun:test";
import type { Command } from "commander";
import { createProgram } from "../program";
import {
  COMPLETION_SHELLS,
  completeWords,
  completionScript,
  invocationRowsFromDaemon,
  renderCompletion,
  type Completion,
  type CompletionDeps,
} from "./completion";

const SESSION_A = "0ccdd4f6-5c06-429f-abb3-4c324e281e52";
const SESSION_B = "cursor_pane35";

const deps: CompletionDeps = {
  async sessions() {
    return [
      {
        id: SESSION_A,
        agentType: "claude",
        project: "ccmux",
        status: "working",
        tmuxPane: "%33",
        nativeSessionId: SESSION_A,
      },
      {
        id: SESSION_B,
        agentType: "cursor",
        project: "ccmux",
        status: "idle",
        tmuxPane: "%35",
        nativeSessionId: null,
      },
    ];
  },
  async invocations() {
    return [{ id: "inv_abcd", status: "running", agent: "codex" }];
  },
  async agentNames() {
    return ["claude", "codex"];
  },
};

const program = createProgram();

function complete(...words: string[]): Promise<Completion> {
  return completeWords(program, words, deps);
}

function values(completion: Completion): string[] {
  return completion.candidates.map((c) => c.value);
}

describe("completeWords: commands", () => {
  it("offers every visible subcommand at the root, never the hidden endpoint", async () => {
    const got = values(await complete(""));
    expect(got).toContain("spawn");
    expect(got).toContain("worktree");
    expect(got).toContain("completion");
    expect(got).toContain("help");
    expect(got).not.toContain("__complete");
  });

  it("filters by the typed prefix and carries descriptions", async () => {
    const got = await complete("sp");
    expect(values(got)).toEqual(["spawn"]);
    expect(got.candidates[0].description).toMatch(/Spawn a new agent/);
  });

  it("descends into nested command groups", async () => {
    expect(values(await complete("worktree", ""))).toEqual([
      "list",
      "prune",
      "help",
    ]);
    expect(values(await complete("daemon", "st"))).toEqual([
      "start",
      "stop",
      "status",
    ]);
  });

  it("completes `help <command>` from the root's commands", async () => {
    const got = values(await complete("help", "s"));
    expect(got).toContain("spawn");
    expect(got).toContain("switch");
    expect(got.every((v) => v.startsWith("s"))).toBe(true);
  });

  it("stops offering subcommands once a positional has been consumed", async () => {
    expect(values(await complete("invoke", "claude", ""))).toEqual([]);
  });
});

describe("completeWords: options", () => {
  it("lists a command's flags when the current word starts with a dash", async () => {
    const got = await complete("spawn", "--un");
    expect(values(got)).toEqual(["--untracked"]);
    expect(got.candidates[0].description).toMatch(/untracked files/);
  });

  it("includes the implicit --help", async () => {
    expect(values(await complete("show", "--h"))).toEqual(["--help"]);
  });

  it("completes a required option's fixed values", async () => {
    expect(values(await complete("spawn", "--untracked", ""))).toEqual([
      "move",
      "copy",
      "leave",
    ]);
    expect(values(await complete("sidebar", "--position", "l"))).toEqual([
      "left",
    ]);
    expect(values(await complete("picker", "--icons", ""))).toContain(
      "nerdfont",
    );
  });

  it("walks the default command's options at the root", async () => {
    expect(values(await complete("--i"))).toEqual(["--icons"]);
    expect(values(await complete("--icons", ""))).toContain("nerdfont");
  });

  it("hands directory options to the shell with a directive", async () => {
    const got = await complete("spawn", "--cwd", "");
    expect(got.directive).toBe("dir");
    expect(got.candidates).toEqual([]);
    expect((await complete("worktree", "prune", "--repo", "")).directive).toBe(
      "dir",
    );
  });

  it("treats the word after a required-value option as its value, even a dashed one", async () => {
    // `--prompt -x` binds -x to --prompt, so the current word is spawn's
    // agent positional, not a flag position.
    const got = values(await complete("spawn", "--prompt", "-x", ""));
    expect(got).toEqual(["claude", "codex"]);
  });

  it("completes an optional-value option's values, but yields to a following flag", async () => {
    expect(values(await complete("spawn", "--split", ""))).toEqual(["h", "v"]);
    expect(values(await complete("spawn", "--split", "--d"))).toEqual([
      "--detach",
    ]);
  });

  it("stops treating dashes as flags after `--`", async () => {
    expect(values(await complete("send", "%33", "--", "-x"))).toEqual([]);
  });
});

describe("completeWords: dynamic values", () => {
  it("offers session ids and pane ids for a session-id argument, without self", async () => {
    const got = await complete("switch", "");
    expect(values(got)).toEqual([SESSION_A, SESSION_B, "%33", "%35"]);
    expect(got.candidates[0].description).toBe("claude ccmux working");
  });

  it("adds `self` for full session refs", async () => {
    expect(values(await complete("last", ""))).toContain("self");
    expect(values(await complete("handoff", "self", ""))).toContain("self");
  });

  it("filters session refs by prefix", async () => {
    expect(values(await complete("kill", "%3"))).toEqual(["%33", "%35"]);
  });

  it("offers native ids for --resume/--session and ccmux ids for --fork", async () => {
    expect(values(await complete("spawn", "--resume", ""))).toEqual([
      SESSION_A,
    ]);
    expect(values(await complete("invoke", "--session", ""))).toEqual([
      SESSION_A,
    ]);
    expect(values(await complete("spawn", "--fork", ""))).toEqual([
      SESSION_A,
      SESSION_B,
    ]);
    expect(values(await complete("spawn", "--fork", ""))).not.toContain("%33");
  });

  it("offers panes plus `none` for spawn --target", async () => {
    expect(values(await complete("spawn", "--target", ""))).toEqual([
      "%33",
      "%35",
      "none",
    ]);
  });

  it("offers agent names where an agent is named", async () => {
    expect(values(await complete("spawn", ""))).toEqual(["claude", "codex"]);
    expect(values(await complete("setup", "--agent", "c"))).toEqual([
      "claude",
      "codex",
    ]);
    expect(values(await complete("handoff", "--agent", ""))).toEqual([
      "claude",
      "codex",
    ]);
  });

  it("offers agents alongside subcommands for invoke's first word", async () => {
    const got = values(await complete("invoke", ""));
    expect(got).toContain("cancel");
    expect(got).toContain("claude");
  });

  it("offers invocation ids to invoke cancel/result", async () => {
    const got = await complete("invoke", "cancel", "");
    expect(values(got)).toEqual(["inv_abcd"]);
    expect(got.candidates[0].description).toBe("codex running");
    expect(values(await complete("invoke", "result", "inv"))).toEqual([
      "inv_abcd",
    ]);
  });

  it("maps the daemon's invocationId onto cancel/result candidates", async () => {
    const fixture = [
      {
        invocationId: "inv_real",
        agent: "claude",
        cwd: "/tmp/ccmux",
        startedAt: 1_700_000_000_000,
        status: "running",
      },
    ];
    expect(invocationRowsFromDaemon(fixture)).toEqual([
      { id: "inv_real", status: "running", agent: "claude" },
    ]);
    const daemonDeps: CompletionDeps = {
      ...deps,
      invocations: async () => invocationRowsFromDaemon(fixture),
    };
    const got = await completeWords(
      program,
      ["invoke", "cancel", ""],
      daemonDeps,
    );
    expect(values(got)).toEqual(["inv_real"]);
    expect(got.candidates[0].description).toBe("claude running");
  });

  it("completes config keys, then the key's values when they are enumerable", async () => {
    const keys = values(await complete("config", "set", ""));
    expect(keys).toContain("theme");
    expect(keys).toContain("notifications.backend");
    expect(values(await complete("config", "get", "side"))).toEqual([
      "sidebar.width",
      "sidebar.position",
    ]);
    expect(values(await complete("config", "set", "theme", ""))).toContain(
      "dracula",
    );
    expect(values(await complete("config", "set", "persistent", ""))).toEqual([
      "true",
      "false",
    ]);
    expect(
      values(await complete("config", "set", "sidebar.position", "")),
    ).toEqual(["left", "right"]);
    expect(values(await complete("config", "set", "command", ""))).toEqual([]);
    expect(
      values(await complete("config", "set", "notifications.events", "")),
    ).toEqual(["waiting", "finished"]);
  });

  it("completes the completion command's own shell argument", async () => {
    expect(values(await complete("completion", ""))).toEqual([
      ...COMPLETION_SHELLS,
    ]);
  });
});

describe("completeWords: every session argument in the tree has a source", () => {
  const SESSION_ARGS = new Set(["session-id", "session-ref", "from", "to"]);

  function walk(cmd: Command, path: string[], out: string[][]): void {
    cmd.registeredArguments.forEach((arg, index) => {
      if (!SESSION_ARGS.has(arg.name())) return;
      // Fill the earlier positionals with placeholders, then complete this one.
      const fillers = cmd.registeredArguments.slice(0, index).map(() => "x");
      out.push([...path, ...fillers, ""]);
    });
    for (const sub of cmd.commands) walk(sub, [...path, sub.name()], out);
  }

  const cases: string[][] = [];
  walk(program, [], cases);

  it("finds the arguments it is guarding", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const words of cases) {
    it(`ccmux ${words.join(" ").trim()} <TAB> offers sessions`, async () => {
      expect(values(await completeWords(program, words, deps))).toContain(
        SESSION_A,
      );
    });
  }
});

describe("renderCompletion", () => {
  const completion: Completion = {
    candidates: [
      { value: "%33", description: "claude  ccmux\nworking" },
      { value: "self" },
    ],
  };

  it("emits value<TAB>description lines with whitespace collapsed", () => {
    expect(renderCompletion(completion, "zsh")).toBe(
      "%33\tclaude ccmux working\nself\n",
    );
  });

  it("drops descriptions for bash", () => {
    expect(renderCompletion(completion, "bash")).toBe("%33\nself\n");
  });

  it("puts a directive on its own leading line", () => {
    expect(renderCompletion({ candidates: [], directive: "dir" }, "fish")).toBe(
      ":dir\n",
    );
  });

  it("prints nothing at all when there is nothing to offer", () => {
    expect(renderCompletion({ candidates: [] }, "zsh")).toBe("");
  });

  it("drops values that would forge candidates or directives", () => {
    expect(
      renderCompletion(
        {
          candidates: [
            { value: "ok", description: "fine" },
            { value: "bad\n:dir" },
            { value: "bad\rname" },
            { value: "bad\tname" },
            { value: ":dir" },
            { value: ":sneaky" },
          ],
        },
        "zsh",
      ),
    ).toBe("ok\tfine\n");
  });
});

describe("completionScript", () => {
  it("calls the hidden endpoint with the shell's own name", () => {
    for (const shell of COMPLETION_SHELLS) {
      expect(completionScript(shell)).toContain(`ccmux __complete ${shell} --`);
    }
  });

  it("marks the zsh script for fpath autoloading", () => {
    expect(completionScript("zsh").startsWith("#compdef ccmux\n")).toBe(true);
  });

  it("registers the completer in each shell", () => {
    expect(completionScript("zsh")).toContain("compdef _ccmux ccmux");
    expect(completionScript("bash")).toContain("complete -F _ccmux ccmux");
    expect(completionScript("fish")).toContain("complete -c ccmux");
  });

  it("quotes fish candidate lines so tabs survive", () => {
    const script = completionScript("fish");
    expect(script).toContain(`switch "$line"`);
    expect(script).toContain(`printf '%s\\n' -- "$line"`);
  });

  it("disables globbing while reading bash candidates", () => {
    const script = completionScript("bash");
    expect(script).toContain("set -f");
    expect(script).toContain("set +f");
  });
});
