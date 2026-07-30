import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_AGENTS, type AgentDef } from "../lib/agents";
import { getBuiltinAgent } from "../lib/agents-test-helpers";
import {
  buildAgentForkCommand,
  buildAgentSpawnCommand,
  buildTmuxSpawnArgv,
  escapeSingleQuoted,
  normalizeSplit,
  normalizeTarget,
  normalizeWorktreeRequest,
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

  it("appends at the end of a session, which renumbers nothing", () => {
    // The implicit case. `-a -t @window` was verified live to insert at
    // the next index and shift EVERY later window up, so a plain
    // `ccmux spawn` would silently renumber the caller's windows.
    expect(
      buildTmuxSpawnArgv({
        split: false,
        cwd: "/w",
        placement: { kind: "session", id: "$3" },
      }),
    ).toEqual([
      "new-window",
      "-t",
      "$3:",
      "-c",
      "/w",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
  });

  it("inserts after a window only when one was named explicitly", () => {
    expect(
      buildTmuxSpawnArgv({
        split: false,
        cwd: "/w",
        placement: { kind: "window", id: "@7" },
      }),
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
      buildTmuxSpawnArgv({
        split: "h",
        cwd: "/w",
        placement: { kind: "pane", id: "%12" },
      }),
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

  it("passes -d on both paths only when detaching", () => {
    // `-d` is the ONLY thing that keeps the caller's view put: both
    // new-window and split-window make what they create current by
    // default, so skipping the follow-up select-window was not enough
    // and `--detach` still yanked the caller to the new window.
    expect(
      buildTmuxSpawnArgv({ split: false, cwd: "/w", detach: true }),
    ).toContain("-d");
    expect(
      buildTmuxSpawnArgv({ split: "h", cwd: "/w", detach: true }),
    ).toContain("-d");
  });

  it("omits -d without detach, so the new pane still takes focus", () => {
    // The default users rely on. A stray `-d` here would silently stop
    // every plain spawn from focusing what it just created.
    expect(buildTmuxSpawnArgv({ split: false, cwd: "/w" })).not.toContain("-d");
    expect(buildTmuxSpawnArgv({ split: "h", cwd: "/w" })).not.toContain("-d");
    expect(
      buildTmuxSpawnArgv({ split: false, cwd: "/w", detach: false }),
    ).not.toContain("-d");
  });

  it("keeps -d compatible with placement on both paths", () => {
    expect(
      buildTmuxSpawnArgv({
        split: false,
        cwd: "/w",
        detach: true,
        placement: { kind: "session", id: "$3" },
      }),
    ).toEqual([
      "new-window",
      "-d",
      "-t",
      "$3:",
      "-c",
      "/w",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
    expect(
      buildTmuxSpawnArgv({
        split: "v",
        cwd: "/w",
        detach: true,
        placement: { kind: "pane", id: "%12" },
      }),
    ).toEqual([
      "split-window",
      "-v",
      "-d",
      "-t",
      "%12",
      "-c",
      "/w",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
  });

  it("ignores a non-pane placement on the split path", () => {
    // A split can only target a pane; a session/window placement must not
    // leak through as a `-t` tmux would resolve to something else.
    expect(
      buildTmuxSpawnArgv({
        split: "v",
        cwd: "/w",
        placement: { kind: "session", id: "$3" },
      }),
    ).not.toContain("-t");
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

  it("treats $ replacement patterns in the session id as literal", () => {
    // Same bug class on the {id} placeholder. Not remote input, but it
    // comes from a marker file rather than from ccmux, and the result is
    // typed into a shell. (The {bin} analogue is refused outright now —
    // see the launcher-quoting test.)
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ resumeCommand: "codex resume {id}" }),
        binary: "codex",
        resume: "$`x",
      }),
    ).toEqual({ ok: true, value: "codex resume $`x" });
  });

  it("keeps a binary containing {prompt} from relocating the prompt", () => {
    // Sequential substitution ({bin} then {prompt}) let a binary carrying
    // the literal text `{prompt}` move the prompt to wherever the binary
    // landed — outside the quotes the guard had just verified. One pass
    // over an alternation never revisits substituted text.
    const result = buildAgentSpawnCommand({
      agent: agentWith({ promptCommand: "{bin} '{prompt}'" }),
      binary: "evil{prompt}",
      prompt: "P",
    });
    expect(result).toEqual({ ok: true, value: "evil{prompt} 'P'" });
  });

  it("refuses a launcher that could break the prompt's quoting", () => {
    // The binary is substituted after the template's quoting is checked,
    // so it must not be able to change how the rest parses. The backtick
    // and `$(` cases would swallow the prompt into a command substitution.
    for (const binary of [
      "ev'il",
      'ev"il',
      "ev`il",
      "ev\\il",
      "ev$(id)il",
      "x$(",
    ]) {
      expect(
        buildAgentSpawnCommand({
          agent: agentWith({ promptCommand: "{bin} '{prompt}'" }),
          binary,
          prompt: "hi",
        }).ok,
      ).toBe(false);
    }
  });

  it("allows a launcher using ordinary parameter expansion", () => {
    // `$HOME/.local/bin/claude` is a plausible `command` preference. The
    // shell expands it when the line is typed into the pane, and the
    // result is not re-scanned for quotes, so it cannot reach the
    // prompt's quoting. Refusing it also made the SAME config work on a
    // bare spawn while erroring with --prompt.
    for (const binary of [
      "$HOME/.local/bin/claude",
      "${HOME}/bin/claude",
      "$CLAUDE_BIN",
    ]) {
      expect(
        buildAgentSpawnCommand({
          agent: agentWith({ promptCommand: "{bin} '{prompt}'" }),
          binary,
          prompt: "hi",
        }),
      ).toEqual({ ok: true, value: `${binary} 'hi'` });
    }
  });

  it("treats a launcher the same way with and without a prompt", () => {
    // The asymmetry is the real defect: one config, two paths, one of
    // which 400s. Whatever the guard decides must hold for both.
    const binary = "$HOME/.local/bin/claude";
    const agent = agentWith({ promptCommand: "{bin} '{prompt}'" });
    const bare = buildAgentSpawnCommand({ agent, binary });
    const withPrompt = buildAgentSpawnCommand({ agent, binary, prompt: "hi" });
    expect(bare.ok).toBe(true);
    expect(withPrompt.ok).toBe(true);
  });

  it("refuses a non-string promptCommand from config", () => {
    // ccmux.json can hold any JSON. This runs outside the route's try
    // block, so a TypeError here would surface as an opaque 500.
    const result = buildAgentSpawnCommand({
      agent: agentWith({ promptCommand: 123 as unknown as string }),
      binary: "x",
      prompt: "hi",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("promptCommand");
  });

  it("refuses an empty prompt instead of silently spawning bare", () => {
    // `if (prompt)` was falsy for "", so `--prompt ""` spawned a bare
    // agent AND slipped past the no-promptCommand refusal.
    const bare = buildAgentSpawnCommand({
      agent: agentWith({ promptCommand: undefined, name: "flagless" }),
      binary: "flagless",
      prompt: "",
    });
    expect(bare.ok).toBe(false);
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

  it("refuses templates whose quoting cannot be proven safe", () => {
    // Each of these was verified to pass the original one-character peek.
    // The odd-quote-count case leaves the placeholder unquoted (and the
    // shell at a PS2 continuation swallowing input); the command
    // substitution ones re-split the prompt after expansion.
    for (const template of [
      "{bin} ' '{prompt}'",
      "{bin} $(echo '{prompt}')",
      "{bin} `echo '{prompt}'`",
      `{bin} "pre'{prompt}'post"`,
    ]) {
      expect(
        buildAgentSpawnCommand({
          agent: agentWith({ promptCommand: template }),
          binary: "x",
          prompt: "hi",
        }).ok,
      ).toBe(false);
    }
  });

  it("refuses a template containing a backslash", () => {
    // A backslash desynchronizes any quote scan from the shell. The scan
    // used to consume the escaped character too, which swallowed the `{`
    // of a following `{prompt}`: the occurrence was never seen, but
    // `substitutePlaceholders` still replaced it, so the template below
    // passed and emitted a SECOND, unquoted copy of the prompt. With
    // prompt `x;touch <canary>;:` the emitted line was
    // `printf '...' \x;touch <canary>;:`, which created the canary in
    // /bin/sh, /bin/bash and /bin/zsh alike.
    for (const template of [
      "{bin} '{prompt}' \\{prompt}",
      "{bin} \\'{prompt}\\'",
      "{bin} '{prompt}' \\;",
    ]) {
      const result = buildAgentSpawnCommand({
        agent: agentWith({ promptCommand: template }),
        binary: "printf",
        prompt: "hi",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("backslash");
    }
  });

  it("refuses a template using $'...' ANSI-C quoting", () => {
    // The scan read the `'` after `$` as an ordinary opening single quote,
    // but bash and zsh INTERPRET backslashes inside `$'...'`, so
    // `escapeSingleQuoted`'s `'\''` idiom is inert there. With prompt
    // `a\';touch <canary>;#` the emitted `printf $'a\'\'';touch
    // <canary>;#'` terminated the ANSI-C string early and ran the touch in
    // /bin/sh, /bin/bash and /bin/zsh.
    for (const template of ["{bin} $'{prompt}'", "{bin} -m $'x' '{prompt}'"]) {
      const result = buildAgentSpawnCommand({
        agent: agentWith({ promptCommand: template }),
        binary: "printf",
        prompt: "hi",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("ANSI-C");
    }
  });

  it("still accepts every built-in promptCommand", () => {
    // The two refusals above widened the guard; a built-in template caught
    // by them would break prompt spawns for that agent outright.
    for (const agent of BUILTIN_AGENTS) {
      expect(
        buildAgentSpawnCommand({
          agent,
          binary: agent.executable ?? agent.name,
          prompt: "hi",
        }).ok,
      ).toBe(true);
    }
  });

  it("refuses a template with unbalanced quotes", () => {
    // Would leave the pane's shell waiting for a closing quote.
    for (const template of ["{bin} '{prompt}", "{bin} x '{prompt}''"]) {
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

describe("buildAgentForkCommand", () => {
  function agentWith(overrides: Partial<AgentDef>): AgentDef {
    return { ...claudeAgent, ...overrides };
  }

  it("substitutes the source id and the launcher in one pass", () => {
    expect(
      buildAgentForkCommand({
        agent: agentWith({ forkCommand: "{bin} --resume {id} --fork-session" }),
        binary: "/my/wrapper",
        sessionId: "abc-123",
      }),
    ).toEqual({
      ok: true,
      value: "/my/wrapper --resume abc-123 --fork-session",
    });
  });

  it("never revisits substituted text", () => {
    // The single-pass guarantee, phrased as the failure it prevents: a
    // wrapper binary that happens to contain `{id}` must stay a binary
    // name, not become a second copy of the session id.
    expect(
      buildAgentForkCommand({
        agent: agentWith({ forkCommand: "{bin} --resume {id}" }),
        binary: "wrap{id}",
        sessionId: "abc",
      }),
    ).toEqual({ ok: true, value: "wrap{id} --resume abc" });
  });

  it("refuses an agent that has not declared how it forks", () => {
    const result = buildAgentForkCommand({
      agent: agentWith({ name: "codex", forkCommand: undefined }),
      binary: "codex",
      sessionId: "abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("forkCommand");
  });

  it("treats an empty template as 'not supported', not as malformed", () => {
    // An empty string is the documented config-file way to turn fork off for
    // an agent, and `forkableAgentNames` reads it that way, so the picker
    // simply hides the item. `ccmux spawn --fork` bypasses that gate and must
    // land on the SAME answer rather than complaining about a missing {id}
    // in a template the user never wrote.
    const result = buildAgentForkCommand({
      agent: agentWith({ name: "codex", forkCommand: "" }),
      binary: "codex",
      sessionId: "abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does not support forking");
      expect(result.error).not.toContain("{id} placeholder");
    }
  });

  it("refuses a template with no {id}", () => {
    // Without it the fork silently starts a FRESH session: a pane appears,
    // the agent runs, and the history the user asked to branch is gone.
    const result = buildAgentForkCommand({
      agent: agentWith({ forkCommand: "{bin} --fork-session" }),
      binary: "claude",
      sessionId: "abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("{id}");
  });

  it("refuses a non-string template from config", () => {
    const result = buildAgentForkCommand({
      agent: agentWith({ forkCommand: 123 as unknown as string }),
      binary: "claude",
      sessionId: "abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("forkCommand");
  });

  it("refuses a session id that is not inert to the shell", () => {
    // The id lands in a command typed into a pane's shell. The route
    // constrains it too; this is the guard that travels with the builder,
    // so a future caller cannot lose it.
    for (const id of [
      "a b",
      "abc;rm -rf /",
      "$(id)",
      "'x'",
      "",
      "a".repeat(129),
    ]) {
      const result = buildAgentForkCommand({
        agent: agentWith({ forkCommand: "{bin} --resume {id}" }),
        binary: "claude",
        sessionId: id,
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe("built-in fork invocations", () => {
  it("forks Claude into a new session id, leaving the source alone", () => {
    // `--fork-session` (not a bare `--resume`, which would APPEND to the
    // source's transcript and fight the live original for it).
    expect(
      buildAgentForkCommand({
        agent: getBuiltinAgent("claude"),
        binary: "claude",
        sessionId: "abc-123",
      }),
    ).toEqual({
      ok: true,
      value: "claude --resume abc-123 --fork-session",
    });
  });

  it("is the only built-in that claims to fork", () => {
    // Every other agent's resume semantics against a LIVE original are
    // unverified, and a wrong guess corrupts the session being forked.
    // Adding a name here means someone checked it (see
    // docs/agent-adapters.md#forking-a-session).
    expect(
      BUILTIN_AGENTS.filter((a) => a.forkCommand).map((a) => a.name),
    ).toEqual(["claude"]);
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

describe("normalizeWorktreeRequest", () => {
  it("treats absent, null and false as no worktree", () => {
    for (const value of [undefined, null, false]) {
      expect(normalizeWorktreeRequest(value)).toEqual({
        ok: true,
        value: undefined,
      });
    }
  });

  it("accepts an empty object as opt-in with everything derived", () => {
    expect(normalizeWorktreeRequest({})).toEqual({ ok: true, value: {} });
  });

  it("carries name and base through", () => {
    expect(
      normalizeWorktreeRequest({ name: "fix-thing", base: "main" }),
    ).toEqual({ ok: true, value: { name: "fix-thing", base: "main" } });
  });

  it("drops empty members rather than passing blanks downstream", () => {
    expect(normalizeWorktreeRequest({ name: "", base: null })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("rejects a non-object and a non-string member", () => {
    const notObject = normalizeWorktreeRequest("please");
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.error).toContain("expected an object");

    const arrays = normalizeWorktreeRequest([{ name: "x" }]);
    expect(arrays.ok).toBe(false);

    const badName = normalizeWorktreeRequest({ name: 7 });
    expect(badName.ok).toBe(false);
    if (!badName.ok) expect(badName.error).toContain("worktree.name");
  });
});
