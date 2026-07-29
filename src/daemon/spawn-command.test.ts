import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_AGENTS, type AgentDef } from "../lib/agents";
import { getBuiltinAgent } from "../lib/agents-test-helpers";
import {
  buildAgentSpawnCommand,
  buildTmuxSpawnArgv,
  escapeSingleQuoted,
  normalizeSplit,
  normalizeTarget,
} from "./spawn-command";

const claudeAgent: AgentDef = getBuiltinAgent("claude");

describe("normalizeSplit", () => {
  // The wire field is a union of the historical boolean and the new
  // direction. Getting `true` wrong would silently flip every existing
  // `--split` caller to the other axis.

  it("treats absent and false as a new window", () => {
    expect(normalizeSplit(undefined)).toEqual({ ok: true, value: false });
    expect(normalizeSplit(false)).toEqual({ ok: true, value: false });
  });

  it("maps the legacy boolean true to tmux's default stacked split", () => {
    expect(normalizeSplit(true)).toEqual({ ok: true, value: "v" });
  });

  it("passes explicit directions through", () => {
    expect(normalizeSplit("h")).toEqual({ ok: true, value: "h" });
    expect(normalizeSplit("v")).toEqual({ ok: true, value: "v" });
  });

  it("rejects anything else", () => {
    for (const bad of ["horizontal", "H", "", 1, null, {}]) {
      const result = normalizeSplit(bad);
      expect(result.ok).toBe(false);
    }
  });
});

describe("normalizeTarget", () => {
  // `target` reaches tmux as an argv element, so the risk is not shell
  // injection but tmux resolving a non-pane string as some OTHER target
  // type (a session or window name) and spawning somewhere unexpected.

  it("accepts a tmux pane id", () => {
    expect(normalizeTarget("%12")).toEqual({ ok: true, value: "%12" });
  });

  it("treats absent as no target", () => {
    expect(normalizeTarget(undefined)).toEqual({ ok: true, value: undefined });
    expect(normalizeTarget(null)).toEqual({ ok: true, value: undefined });
  });

  it("rejects window ids, session names, and other target forms", () => {
    for (const bad of ["@3", "mysession:1.0", "0", "%", "%1a", 12]) {
      expect(normalizeTarget(bad).ok).toBe(false);
    }
  });
});

describe("buildTmuxSpawnArgv", () => {
  // These argv are executed verbatim. `new-window -t %pane` fails with
  // "can't specify pane here" and `new-window -t @win` without `-a`
  // fails with "index in use", so both shapes are pinned.

  it("creates a new window when split is false", () => {
    expect(buildTmuxSpawnArgv({ split: false, cwd: "/w" })).toEqual([
      "new-window",
      "-c",
      "/w",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
  });

  it("inserts the new window after the target window", () => {
    expect(
      buildTmuxSpawnArgv({ split: false, cwd: "/w", target: "@7" }),
    ).toEqual([
      "new-window",
      "-a",
      "-t",
      "@7",
      "-c",
      "/w",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
  });

  it("splits left/right for 'h' and stacked for 'v'", () => {
    expect(buildTmuxSpawnArgv({ split: "h", cwd: "/w" })[1]).toBe("-h");
    expect(buildTmuxSpawnArgv({ split: "v", cwd: "/w" })[1]).toBe("-v");
  });

  it("splits the target pane when one is given", () => {
    expect(
      buildTmuxSpawnArgv({ split: "h", cwd: "/w", target: "%12" }),
    ).toEqual([
      "split-window",
      "-h",
      "-t",
      "%12",
      "-c",
      "/w",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
  });
});

describe("buildAgentSpawnCommand", () => {
  // This string is typed into the new pane's shell and submitted with
  // Enter, so a wrong flag launches the wrong MODE (print/one-shot
  // rather than an interactive session) and a wrong quote is shell
  // syntax the user never typed.

  function agentWith(overrides: Partial<AgentDef>): AgentDef {
    return { ...claudeAgent, ...overrides };
  }

  it("returns the binary alone with no resume or prompt", () => {
    expect(
      buildAgentSpawnCommand({ agent: claudeAgent, binary: "claude" }),
    ).toEqual({ ok: true, value: "claude" });
  });

  it("honors a wrapper binary on the bare path", () => {
    expect(
      buildAgentSpawnCommand({ agent: claudeAgent, binary: "/my/wrapper" }),
    ).toEqual({ ok: true, value: "/my/wrapper" });
  });

  it("substitutes {id} into resumeCommand, else appends --resume", () => {
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ resumeCommand: "codex resume {id}" }),
        binary: "codex",
        resume: "abc-123",
      }),
    ).toEqual({ ok: true, value: "codex resume abc-123" });

    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ resumeCommand: undefined }),
        binary: "claude",
        resume: "abc-123",
      }),
    ).toEqual({ ok: true, value: "claude --resume abc-123" });
  });

  it("prefers resume over prompt when both are given", () => {
    // A resumed session already carries its history; the prompt would
    // otherwise be appended to a command that cannot take it.
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({
          resumeCommand: "codex resume {id}",
          promptCommand: "{bin} '{prompt}'",
        }),
        binary: "codex",
        resume: "abc-123",
        prompt: "hello",
      }),
    ).toEqual({ ok: true, value: "codex resume abc-123" });
  });

  it("substitutes the prompt into promptCommand", () => {
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ promptCommand: "{bin} '{prompt}'" }),
        binary: "claude",
        prompt: "fix the tests",
      }),
    ).toEqual({ ok: true, value: "claude 'fix the tests'" });
  });

  it("resolves {bin} to the wrapper binary, not the agent name", () => {
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ promptCommand: "{bin} '{prompt}'" }),
        binary: "/my/wrapper",
        prompt: "hi",
      }),
    ).toEqual({ ok: true, value: "/my/wrapper 'hi'" });
  });

  it("escapes single quotes so prompt text cannot break out of the word", () => {
    const result = buildAgentSpawnCommand({
      agent: agentWith({ promptCommand: "{bin} '{prompt}'" }),
      binary: "claude",
      prompt: "don't; rm -rf /",
    });
    expect(result).toEqual({
      ok: true,
      value: "claude 'don'\\''t; rm -rf /'",
    });
  });

  it("survives a real shell as exactly one argument", () => {
    // The built command is typed into a pane and submitted with Enter,
    // so the contract is what /bin/sh does with it, not what the string
    // looks like. `printf` stands in for the agent binary.
    const prompt = 'don\'t `id` $(id); rm -rf / && echo "x"';
    const result = buildAgentSpawnCommand({
      agent: agentWith({ promptCommand: "printf '[%s]' '{prompt}'" }),
      binary: "printf",
      prompt,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = Bun.spawnSync(["sh", "-c", result.value]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(`[${prompt}]`);
  });

  it("treats $ replacement patterns in the prompt as literal text", () => {
    // `String.replace` with a STRING replacement expands `$&`, "$`", "$'",
    // and `$$` inside the replacement, so a prompt containing them used to
    // splice parts of the template back into the command. "$`" is the
    // dangerous one: it inserts everything before the match, which reopens
    // the quoted word and turns the rest of the prompt into shell syntax.
    // The payload targets a scratch path and the test asserts it was
    // never created, so the proof is "no command ran", not just "stdout
    // looked right". Kept out of the repo so a regression cannot litter
    // the working tree.
    const canary = join(mkdtempSync(join(tmpdir(), "spawn-inj-")), "PWNED");
    try {
      for (const prompt of [
        `$\`; touch ${canary}; #`,
        "$& $& $&",
        "$'; id; #",
        "$$",
        "$`$&$'$$",
      ]) {
        const result = buildAgentSpawnCommand({
          agent: agentWith({ promptCommand: "printf '[%s]' '{prompt}'" }),
          binary: "printf",
          prompt,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        // The shell is the real oracle: the agent must receive the prompt
        // byte for byte, and nothing else may run.
        const run = Bun.spawnSync(["sh", "-c", result.value]);
        expect(run.exitCode).toBe(0);
        expect(run.stdout.toString()).toBe(`[${prompt}]`);
        expect(existsSync(canary)).toBe(false);
      }
    } finally {
      rmSync(dirname(canary), { recursive: true, force: true });
    }
  });

  it("treats $ replacement patterns in the binary and session id as literal", () => {
    // Same bug class on the other two placeholders. Neither is remote
    // input, but both come from a config file rather than from ccmux.
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ promptCommand: "{bin} '{prompt}'" }),
        binary: "$&bin",
        prompt: "hi",
      }),
    ).toEqual({ ok: true, value: "$&bin 'hi'" });

    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ resumeCommand: "codex resume {id}" }),
        binary: "codex",
        resume: "$`x",
      }),
    ).toEqual({ ok: true, value: "codex resume $`x" });
  });

  it("refuses a template whose single quotes are nested in double quotes", () => {
    // The placeholder is immediately wrapped in single quotes, but the
    // whole word is double-quoted, where `'` is an ordinary character.
    // Single-quote escaping does nothing there, and `$(...)`/backticks in
    // the prompt would be expanded by the shell.
    for (const template of [
      `sh -c "{bin} '{prompt}'"`,
      `{bin} --wrap "outer '{prompt}' outer"`,
    ]) {
      const result = buildAgentSpawnCommand({
        agent: agentWith({ promptCommand: template }),
        binary: "printf",
        prompt: "$(touch ./should-never-run)",
      });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a template with unbalanced quotes", () => {
    // Would leave the pane's shell waiting for a closing quote.
    for (const template of ["{bin} '{prompt}", `{bin} "x '{prompt}'`]) {
      expect(
        buildAgentSpawnCommand({
          agent: agentWith({ promptCommand: template }),
          binary: "x",
          prompt: "hi",
        }).ok,
      ).toBe(false);
    }
  });

  it("substitutes every occurrence of a placeholder", () => {
    // A half-substituted template would reach the shell with a literal
    // `{prompt}` in it.
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({
          promptCommand: "{bin} --a '{prompt}' --b '{prompt}'",
        }),
        binary: "x",
        prompt: "p",
      }),
    ).toEqual({ ok: true, value: "x --a 'p' --b 'p'" });
  });

  it("refuses a prompt spawn for an agent with no promptCommand", () => {
    // Better a clear refusal than emitting `--prompt`, which is one-shot
    // print mode for Copilot and not a flag at all for pi.
    const result = buildAgentSpawnCommand({
      agent: agentWith({ name: "someagent", promptCommand: undefined }),
      binary: "someagent",
      prompt: "hi",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("someagent");
      expect(result.error).toContain("promptCommand");
    }
  });

  it("refuses a promptCommand whose placeholder is not single-quoted", () => {
    // The escaping is single-quote escaping; a bare or double-quoted
    // placeholder would let prompt text reach the shell as syntax.
    for (const template of ['{bin} "{prompt}"', "{bin} {prompt}", "{bin} -p"]) {
      const result = buildAgentSpawnCommand({
        agent: agentWith({ promptCommand: template }),
        binary: "x",
        prompt: "hi",
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe("built-in prompt invocations", () => {
  // Each of these was read off the agent's own `--help` on a machine with
  // all nine installed. The failure mode they guard against is silent: a
  // one-shot/print flag still "works", it just exits after one turn
  // instead of leaving an interactive session behind. Re-verify against
  // `--help` before changing a row, not just against the test.
  const expected: Record<string, string> = {
    claude: "claude 'go'",
    codex: "codex 'go'",
    cursor: "cursor-agent 'go'",
    opencode: "opencode --prompt 'go'",
    pi: "pi 'go'",
    omp: "omp 'go'",
    antigravity: "agy -i 'go'",
    copilot: "copilot -i 'go'",
    gemini: "gemini -i 'go'",
  };

  for (const [name, want] of Object.entries(expected)) {
    it(`spawns ${name} interactively with the prompt`, () => {
      const agent = getBuiltinAgent(name);
      expect(
        buildAgentSpawnCommand({
          agent,
          binary: agent.executable ?? agent.name,
          prompt: "go",
        }),
      ).toEqual({ ok: true, value: want });
    });
  }

  it("covers every built-in agent", () => {
    // A new built-in with no promptCommand would silently refuse prompt
    // spawns; adding it here forces the --help check to happen.
    expect(Object.keys(expected).sort()).toEqual(
      BUILTIN_AGENTS.map((a) => a.name).sort(),
    );
  });
});

describe("escapeSingleQuoted", () => {
  it("closes, escapes, and reopens the quoted word", () => {
    expect(escapeSingleQuoted("a'b")).toBe("a'\\''b");
  });

  it("leaves shell metacharacters alone (the quotes contain them)", () => {
    expect(escapeSingleQuoted("$(id); `id` && x")).toBe("$(id); `id` && x");
  });
});
