import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { createProgram } from "../program";
import * as preferences from "../lib/preferences";
import {
  COMPLETION_SHELLS,
  completeWords,
  completionScript,
  invocationRowsFromDaemon,
  liveCompletionDeps,
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
    expect(script).toContain(`printf '%s\\n' "$line"`);
  });

  // `--` only ends option parsing BEFORE the format string. After it, printf
  // takes it as data and reuses the format, so every candidate came back
  // preceded by a bare `--` line, which fish then offered as a completion.
  it("does not pass `--` to fish's printf, which would emit it as a candidate", () => {
    expect(completionScript("fish")).not.toContain(`printf '%s\\n' --`);
  });

  it("disables globbing while reading bash candidates", () => {
    const script = completionScript("bash");
    expect(script).toContain("set -f");
    expect(script).toContain("set +f");
  });
});

// ---------------------------------------------------------------------------
// The scripts, actually run.
//
// The assertions above pin the scripts' TEXT. Running them is what pins
// behavior. A stub `ccmux` is first on PATH so no daemon or real binary
// reaches the assertion.
// ---------------------------------------------------------------------------

// Prefer /bin/bash on macOS: it is 3.2, the version the script's index loop
// exists for. Fall back to whatever bash is on PATH elsewhere.
const BASH = existsSync("/bin/bash") ? "/bin/bash" : Bun.which("bash");
const FISH = Bun.which("fish");

// zsh is deliberately NOT executed. `compdef` registers into the completion
// system and `_describe` writes its results through ZLE, neither of which
// exists outside an interactive shell; driving it needs a pty harness. The zsh
// script keeps its text assertions only.

let shellRoot = "";
let bashScriptPath = "";
let fishConfigHome = "";
let workDir = "";
const stubs: Record<string, string> = {};

/** A directory holding an executable `ccmux` that answers with `body`. */
function makeStub(name: string, body: string): string {
  const dir = join(shellRoot, `bin-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ccmux"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

beforeAll(() => {
  shellRoot = mkdtempSync(join(tmpdir(), "ccmux-completion-"));

  stubs.values = makeStub("values", `printf 'alpha\\nbeta\\n'`);
  stubs.described = makeStub(
    "described",
    `printf 'alpha\\tfirst\\nbeta\\tsecond\\n'`,
  );
  stubs.directive = makeStub("directive", `printf ':dir\\n'`);
  stubs.glob = makeStub("glob", `printf '*\\n'`);
  // Echoes its own argv, so a test can assert what the wrapper passed along.
  stubs.argv = makeStub("argv", `for a in "$@"; do printf 'arg=[%s]\\n' "$a"; done`);

  bashScriptPath = join(shellRoot, "ccmux.bash");
  writeFileSync(bashScriptPath, completionScript("bash"));

  // fish loads completions from $XDG_CONFIG_HOME/fish/completions, which is
  // also how the override keeps the developer's own fish config out of the run.
  fishConfigHome = join(shellRoot, "fish-config");
  mkdirSync(join(fishConfigHome, "fish", "completions"), { recursive: true });
  writeFileSync(
    join(fishConfigHome, "fish", "completions", "ccmux.fish"),
    completionScript("fish"),
  );

  // A known working directory for the directory-directive branches to complete
  // against, and for the glob test to have something to wrongly expand into.
  workDir = join(shellRoot, "work");
  mkdirSync(join(workDir, "alpha-dir"), { recursive: true });
  mkdirSync(join(workDir, "beta-dir"), { recursive: true });
});

afterAll(() => {
  if (shellRoot) rmSync(shellRoot, { recursive: true, force: true });
});

function shQuote(word: string): string {
  return `'${word.split("'").join(`'\\''`)}'`;
}

/** Run a shell with `stub` shadowing the real ccmux; returns stdout's lines. */
function runShell(
  command: string,
  argv: string[],
  stub: string,
  env: Record<string, string> = {},
): string[] {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    cwd: workDir,
    env: { ...process.env, ...env, PATH: `${stub}:${process.env.PATH}` },
  });
  expect(result.error).toBeUndefined();
  const lines = result.stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Complete `words` (the last is the word under the cursor) through bash. */
function bashComplete(words: string[], stub: string): string[] {
  const body = [
    `source ${shQuote(bashScriptPath)}`,
    `COMP_WORDS=(ccmux ${words.map(shQuote).join(" ")})`,
    `COMP_CWORD=${words.length}`,
    `_ccmux`,
    `if (( \${#COMPREPLY[@]} )); then printf '%s\\n' "\${COMPREPLY[@]}"; fi`,
  ].join("\n");
  return runShell(BASH as string, ["-c", body], stub);
}

/** Ask fish's own completion engine what `line` completes to. */
function fishComplete(line: string, stub: string): string[] {
  return runShell(FISH as string, ["-c", `complete -C ${shQuote(line)}`], stub, {
    XDG_CONFIG_HOME: fishConfigHome,
  });
}

describe("completionScript: bash, executed", () => {
  it.skipIf(!BASH)("turns the endpoint's lines into COMPREPLY", () => {
    expect(bashComplete(["spawn", ""], stubs.values)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it.skipIf(!BASH)(
    "passes every typed word separately, the empty trailing one included",
    () => {
      // The argv contract the script's explicit index loop exists to keep:
      // `__complete bash --`, then one argument per typed word, the word under
      // the cursor last even when it is empty.
      //
      // Measured on this machine's bash 3.2.57: the quoted slice the comment
      // warns about, `"${COMP_WORDS[@]:1:COMP_CWORD}"`, collapses into ONE word
      // only while `IFS=$'\n'` is in effect. The script sets IFS after the
      // loop, so swapping the slice back in would not fail today; moving that
      // IFS assignment above it would, and this is what would catch it.
      expect(bashComplete(["spawn", "--cwd", ""], stubs.argv)).toEqual([
        "arg=[__complete]",
        "arg=[bash]",
        "arg=[--]",
        "arg=[spawn]",
        "arg=[--cwd]",
        "arg=[]",
      ]);
    },
  );

  it.skipIf(!BASH)(
    "hands a :dir directive to compgen instead of offering it",
    () => {
      const got = bashComplete(["spawn", "--cwd", ""], stubs.directive);
      expect(got).toContain("alpha-dir");
      expect(got).toContain("beta-dir");
      expect(got).not.toContain(":dir");
    },
  );

  it.skipIf(!BASH)("does not glob a candidate that looks like a pattern", () => {
    // What `set -f` around the read buys: the unquoted $(...) would otherwise
    // replace a `*` candidate with the working directory's filenames.
    expect(bashComplete([""], stubs.glob)).toEqual(["*"]);
  });
});

describe("completionScript: fish, executed", () => {
  it.skipIf(!FISH)(
    "offers exactly the endpoint's candidates and nothing else",
    () => {
      expect(fishComplete("ccmux ", stubs.described)).toEqual([
        "alpha\tfirst",
        "beta\tsecond",
      ]);
    },
  );

  it.skipIf(!FISH)("completes directories itself on a :dir directive", () => {
    const got = fishComplete("ccmux --cwd ", stubs.directive);
    expect(got.some((line) => line.startsWith("alpha-dir/"))).toBe(true);
    expect(got.some((line) => line.startsWith(":dir"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The live lookups and the hidden endpoint.
//
// Everything here fails silently in production: all three wrapper scripts send
// the endpoint's stderr to /dev/null, so a wrong route, a dropped timeout or a
// thrown lookup is indistinguishable from "nothing to complete".
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;
let prefsSpy: ReturnType<typeof spyOn> | undefined;
let stdoutSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  // `spyOn` + `mockRestore`, never `mock.module`, which leaks across files.
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  prefsSpy?.mockRestore();
  prefsSpy = undefined;
  stdoutSpy?.mockRestore();
  stdoutSpy = undefined;
});

/** Answer every request with `body`, recording what was asked for. */
function stubFetch(body: string | object, status = 200): FetchCall[] {
  const calls: FetchCall[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: unknown,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), init });
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch);
  return calls;
}

/** Answer every request the way an absent daemon does. */
function stubFetchRejecting(): void {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch);
}

const DAEMON_SESSION = {
  id: "sess_live",
  agentType: "claude",
  project: "ccmux",
  status: "idle",
  tmuxPane: "%7",
  nativeSessionId: "native_live",
};

describe("liveCompletionDeps", () => {
  it("reads sessions from the daemon's /sessions", async () => {
    const calls = stubFetch({ sessions: [DAEMON_SESSION] });

    expect(await liveCompletionDeps.sessions()).toEqual([DAEMON_SESSION]);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/sessions");
  });

  it("reads invocations from /invocations and renames invocationId", async () => {
    const calls = stubFetch({
      invocations: [
        { invocationId: "inv_live", status: "running", agent: "codex" },
      ],
    });

    expect(await liveCompletionDeps.invocations()).toEqual([
      { id: "inv_live", status: "running", agent: "codex" },
    ]);
    expect(new URL(calls[0].url).pathname).toBe("/invocations");
  });

  it("gives every request a timeout signal, so a Tab press cannot hang", async () => {
    const calls = stubFetch({ sessions: [] });
    await liveCompletionDeps.sessions();

    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("offers nothing when the daemon answers with an error status", async () => {
    stubFetch({ sessions: [DAEMON_SESSION] }, 500);
    expect(await liveCompletionDeps.sessions()).toEqual([]);

    fetchSpy?.mockRestore();
    stubFetch({ invocations: [{ invocationId: "x", status: "running" }] }, 404);
    expect(await liveCompletionDeps.invocations()).toEqual([]);
  });

  it("offers nothing when the body is not JSON", async () => {
    stubFetch("<html>not the daemon</html>");
    expect(await liveCompletionDeps.sessions()).toEqual([]);
  });

  it("offers nothing when the body omits the key it came for", async () => {
    stubFetch({ somethingElse: [] });
    expect(await liveCompletionDeps.sessions()).toEqual([]);

    fetchSpy?.mockRestore();
    stubFetch({ somethingElse: [] });
    expect(await liveCompletionDeps.invocations()).toEqual([]);
  });

  it("offers nothing when there is no daemon to answer at all", async () => {
    stubFetchRejecting();
    expect(await liveCompletionDeps.sessions()).toEqual([]);
    expect(await liveCompletionDeps.invocations()).toEqual([]);
  });

  it("lists the built-in agents, and nothing when the lookup throws", async () => {
    expect(await liveCompletionDeps.agentNames()).toContain("claude");

    prefsSpy = spyOn(preferences, "getPreferences").mockRejectedValue(
      new Error("unreadable config"),
    );
    expect(await liveCompletionDeps.agentNames()).toEqual([]);
  });
});

describe("__complete: the endpoint the scripts call", () => {
  /** Parse a fresh tree (Commander instances are single-use) and capture stdout. */
  async function runComplete(...words: string[]): Promise<string> {
    const written: string[] = [];
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
      chunk: string,
    ) => {
      written.push(String(chunk));
      return true;
    }) as unknown as typeof process.stdout.write);
    try {
      await createProgram().parseAsync(words, { from: "user" });
    } finally {
      stdoutSpy.mockRestore();
      stdoutSpy = undefined;
    }
    return written.join("");
  }

  it("completes an empty trailing word with the subcommands under it", async () => {
    stubFetch({ sessions: [] });

    expect(await runComplete("__complete", "zsh", "--", "worktree", "")).toBe(
      "list\tList every worktree of the repos ccmux knows about, plus this one\n" +
        "prune\tRemove worktrees whose work is finished\n" +
        "help\tdisplay help for command\n",
    );
  });

  it("lets a user-typed `--` through, so it still ends option parsing", async () => {
    stubFetch({ sessions: [] });

    // The first `--` is Commander's own separator; the second is one the user
    // typed. If it were swallowed, `--h` would read as a flag prefix and the
    // endpoint would answer `--help` instead of staying quiet.
    expect(
      await runComplete("__complete", "zsh", "--", "send", "%33", "--", "--h"),
    ).toBe("");
    expect(await runComplete("__complete", "zsh", "--", "send", "%33", "--h")).toBe(
      "--help\tdisplay help for command\n",
    );
  });

  it("carries the daemon's sessions all the way to stdout", async () => {
    stubFetch({ sessions: [DAEMON_SESSION] });

    expect(await runComplete("__complete", "zsh", "--", "switch", "")).toBe(
      "sess_live\tclaude ccmux idle\n%7\tclaude ccmux idle\n",
    );
  });

  it("drops the descriptions bash cannot show", async () => {
    stubFetch({ sessions: [DAEMON_SESSION] });

    expect(await runComplete("__complete", "bash", "--", "switch", "")).toBe(
      "sess_live\n%7\n",
    );
  });

  it("stays silent when the daemon is unreachable", async () => {
    stubFetchRejecting();

    expect(await runComplete("__complete", "fish", "--", "switch", "")).toBe("");
  });
});
