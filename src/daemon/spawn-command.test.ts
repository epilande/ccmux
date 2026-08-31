import { describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_AGENTS, type AgentDef } from "../lib/agents";
import { getBuiltinAgent } from "../lib/agents-test-helpers";
import {
  buildAgentForkCommand,
  buildAgentSpawnCommand,
  buildSpawnFocusArgv,
  buildTmuxSpawnArgv,
  escapeSingleQuoted,
  MAX_SPAWN_COMMAND_BYTES,
  MAX_SPAWN_PROMPT_BYTES,
  normalizeBoolean,
  normalizeClientTty,
  normalizeModel,
  normalizePrompt,
  normalizeSplit,
  normalizeTarget,
  normalizeWorktreeRequest,
  quotedTemplateProblem,
  resolveSpawnFocusArgv,
  type ClientTtyProbe,
  spawnCommandTooLarge,
  substituteQuotedTemplate,
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

describe("normalizeClientTty", () => {
  // `callerTty` reaches tmux as a `switch-client -c` argument. Nothing here
  // touches a shell, so the risk is not injection but a nonsense value tmux
  // would resolve as some other client (or none), leaving the caller's view
  // wherever it was with a success reported.

  it("accepts the device paths tmux reports on macOS and Linux", () => {
    expect(normalizeClientTty("/dev/ttys004")).toEqual({
      ok: true,
      value: "/dev/ttys004",
    });
    expect(normalizeClientTty("/dev/pts/3")).toEqual({
      ok: true,
      value: "/dev/pts/3",
    });
  });

  it("treats absent, null and empty as no client", () => {
    for (const blank of [undefined, null, ""]) {
      expect(normalizeClientTty(blank)).toEqual({ ok: true, value: undefined });
    }
  });

  it("rejects anything that is not a device path", () => {
    for (const bad of ["ttys004", "/etc/passwd", "/dev/", 4, {}]) {
      const result = normalizeClientTty(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("callerTty");
    }
  });
});

describe("buildSpawnFocusArgv", () => {
  // The whole point of the split: `select-window` moves the active window
  // WITHIN a session, so against a target in another session it changes that
  // session and leaves the attached client exactly where it was. Verified by
  // hand on an isolated tmux server (issue #75).

  const base = { paneId: "%99", detach: false };

  it("selects the window for a same-session spawn, tty or not", () => {
    expect(
      buildSpawnFocusArgv({
        ...base,
        callerTty: "/dev/ttys004",
        placementSessionId: "$3",
        callerSessionId: "$3",
      }),
    ).toEqual(["select-window", "-t", "%99"]);
    expect(buildSpawnFocusArgv(base)).toEqual(["select-window", "-t", "%99"]);
  });

  it("switches the caller's own client for a verified cross-session spawn", () => {
    expect(
      buildSpawnFocusArgv({
        ...base,
        callerTty: "/dev/ttys004",
        placementSessionId: "$7",
        callerSessionId: "$3",
        ttyAttachedToCallerSession: true,
      }),
    ).toEqual(["switch-client", "-c", "/dev/ttys004", "-t", "%99"]);
  });

  it("runs nothing at all when detached, cross-session included", () => {
    expect(
      buildSpawnFocusArgv({
        ...base,
        detach: true,
        callerTty: "/dev/ttys004",
        placementSessionId: "$7",
        callerSessionId: "$3",
        ttyAttachedToCallerSession: true,
      }),
    ).toBeNull();
  });

  it("falls back to select-window when the switch cannot be proven needed", () => {
    // Each of these leaves a client that never asked to move: no tty to name
    // it with, a session pair we could not resolve both halves of, or a tty
    // nobody confirmed is even looking at the caller's session.
    const cases = [
      { placementSessionId: "$7", callerSessionId: "$3" }, // no tty
      { callerTty: "/dev/ttys004", callerSessionId: "$3" }, // no placement
      { callerTty: "/dev/ttys004", placementSessionId: "$7" }, // no caller
      {
        // Everything present, membership never established.
        callerTty: "/dev/ttys004",
        placementSessionId: "$7",
        callerSessionId: "$3",
      },
    ];
    for (const extra of cases) {
      expect(buildSpawnFocusArgv({ ...base, ...extra })).toEqual([
        "select-window",
        "-t",
        "%99",
      ]);
    }
  });
});

describe("resolveSpawnFocusArgv", () => {
  // The membership check. `#{client_tty}` is resolved by the CLI with tmux's
  // `cmd_find_best_client`, which prefers a client of the caller's session but
  // FALLS BACK to the most-recently-active client of any session when that
  // session has none attached. So spawning from a DETACHED session hands the
  // daemon a bystander's terminal, and switching it would drag a user with no
  // stake in this spawn into the new pane. Verified live on tmux 3.6a:
  // sessions A (attached), B and C detached, `--target <pane in C>` run from a
  // pane in B resolved A's tty.

  const crossSession = {
    paneId: "%99",
    detach: false,
    callerTty: "/dev/ttys004",
    placementSessionId: "$7",
    callerSessionId: "$3",
  };

  it("switches when the tty is a client of the caller's session", async () => {
    const asked: string[] = [];
    const argv = await resolveSpawnFocusArgv(crossSession, async (session) => {
      asked.push(session);
      return ["/dev/ttys004"];
    });

    expect(argv).toEqual(["switch-client", "-c", "/dev/ttys004", "-t", "%99"]);
    // The CALLER's session is what has to own the client, not the target's.
    expect(asked).toEqual(["$3"]);
  });

  it("refuses a tty attached to some other session", async () => {
    // The regression this guard exists for: without it the daemon yanks
    // whichever client tmux happened to name.
    const argv = await resolveSpawnFocusArgv(crossSession, async () => []);
    expect(argv).toEqual(["select-window", "-t", "%99"]);
  });

  it("refuses when the session has clients, none of them ours", async () => {
    const argv = await resolveSpawnFocusArgv(crossSession, async () => [
      "/dev/ttys009",
      "/dev/ttys012",
    ]);
    expect(argv).toEqual(["select-window", "-t", "%99"]);
  });

  it("falls back when the probe itself fails", async () => {
    // An unanswerable probe is the same unproven state as an empty list, and
    // the fallback is what this spawn would have done anyway.
    const argv = await resolveSpawnFocusArgv(crossSession, async () => null);
    expect(argv).toEqual(["select-window", "-t", "%99"]);
  });

  it("never probes for a same-session spawn or a detached one", async () => {
    // The paths that were already correct must not pay a tmux round-trip for
    // a question whose answer they would ignore.
    let probes = 0;
    const count: ClientTtyProbe = async () => {
      probes++;
      return null;
    };

    expect(
      await resolveSpawnFocusArgv(
        { ...crossSession, placementSessionId: "$3" },
        count,
      ),
    ).toEqual(["select-window", "-t", "%99"]);
    expect(
      await resolveSpawnFocusArgv({ ...crossSession, detach: true }, count),
    ).toBeNull();
    expect(
      await resolveSpawnFocusArgv(
        { paneId: "%99", detach: false, callerSessionId: "$3" },
        count,
      ),
    ).toEqual(["select-window", "-t", "%99"]);
    expect(probes).toBe(0);
  });
});

describe("normalizeBoolean", () => {
  // `detach` used to be an unchecked cast, so a truthy non-boolean like the
  // string "false" silently reached tmux as `true`.

  it("treats absent as absent, leaving the caller's default", () => {
    expect(normalizeBoolean(undefined, "detach")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("passes real booleans through", () => {
    expect(normalizeBoolean(true, "detach")).toEqual({ ok: true, value: true });
    expect(normalizeBoolean(false, "detach")).toEqual({
      ok: true,
      value: false,
    });
  });

  it("treats an explicit null as absent too", () => {
    // Matches `normalizePrompt`, `resume` and `fork`: a client that serializes
    // omitted fields as null must not be refused for saying nothing.
    expect(normalizeBoolean(null, "detach")).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("rejects a truthy non-boolean, naming the field", () => {
    for (const bad of ["false", "true", 0, 1, {}, []]) {
      const result = normalizeBoolean(bad, "detach");
      expect(result.ok).toBe(false);
      expect(result.ok || result.error).toContain("detach");
    }
  });
});

describe("normalizePrompt", () => {
  // Below this cap, `Bun.spawn` throws rather than exiting non-zero for an
  // oversized argv (E2BIG on macOS around 1MB, a single over-128KiB
  // argument on Linux), and that throw lands well after the pane already
  // exists. The cap turns it into a clean 400 before anything is created.

  it("accepts a prompt exactly at the byte cap", () => {
    const prompt = "a".repeat(MAX_SPAWN_PROMPT_BYTES);
    expect(normalizePrompt(prompt)).toEqual({ ok: true, value: prompt });
  });

  it("rejects a prompt one byte over the cap, naming the cap and the size", () => {
    const prompt = "a".repeat(MAX_SPAWN_PROMPT_BYTES + 1);
    const result = normalizePrompt(prompt);
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toContain(String(MAX_SPAWN_PROMPT_BYTES));
    expect(result.ok || result.error).toContain(
      String(MAX_SPAWN_PROMPT_BYTES + 1),
    );
  });

  it("measures bytes, not characters, for multi-byte prompts", () => {
    // Each of these is a 3-byte UTF-8 codepoint, so this string is over the
    // cap in bytes while under it in character count.
    const charCount = Math.floor(MAX_SPAWN_PROMPT_BYTES / 3) + 1;
    const prompt = "☃".repeat(charCount);
    expect(prompt.length).toBeLessThan(MAX_SPAWN_PROMPT_BYTES);
    const result = normalizePrompt(prompt);
    expect(result.ok).toBe(false);
  });
});

describe("spawnCommandTooLarge", () => {
  // The prompt cap alone cannot decide this: what the OS measures is the
  // built command, and it is always longer than the prompt inside it.

  it("accepts a command exactly at the argument budget", () => {
    expect(spawnCommandTooLarge("a".repeat(MAX_SPAWN_COMMAND_BYTES))).toBe(
      undefined,
    );
  });

  it("refuses one byte over, naming the size and the budget", () => {
    const problem = spawnCommandTooLarge(
      "a".repeat(MAX_SPAWN_COMMAND_BYTES + 1),
    );
    expect(problem).toContain(String(MAX_SPAWN_COMMAND_BYTES + 1));
    expect(problem).toContain(String(MAX_SPAWN_COMMAND_BYTES));
  });

  it("catches an escaped prompt that grew past the budget", () => {
    // A quote-only prompt inside the raw cap quadruples when escaped, so the
    // command it builds is over budget while the prompt never was.
    const prompt = "'".repeat(64 * 1024);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(
      MAX_SPAWN_PROMPT_BYTES,
    );
    const built = buildAgentSpawnCommand({
      agent: { ...claudeAgent, promptCommand: "{bin} '{prompt}'" },
      binary: "claude",
      prompt,
    });
    expect(built.ok).toBe(true);
    expect(built.ok && spawnCommandTooLarge(built.value)).toContain(
      "single command argument",
    );
  });

  it("stays under budget for a prompt at the raw cap", () => {
    // The headroom between the two constants is what keeps an ordinary
    // at-the-cap prompt from being refused by the second check instead.
    const built = buildAgentSpawnCommand({
      agent: { ...claudeAgent, promptCommand: "{bin} '{prompt}'" },
      binary: "claude",
      prompt: "a".repeat(MAX_SPAWN_PROMPT_BYTES),
    });
    expect(built.ok && spawnCommandTooLarge(built.value)).toBe(undefined);
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

  /** A real readable transcript, since the `{path}` form stats the file. */
  function transcript(name = "abc.jsonl"): {
    path: string;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "ccmux-fork-"));
    const path = join(dir, name);
    writeFileSync(path, "{}\n");
    return {
      path,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
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

  it("refuses a template that names neither the transcript nor the id", () => {
    // Without one of them the fork silently starts a FRESH session: a pane
    // appears, the agent runs, and the history the user asked to branch is
    // gone.
    const result = buildAgentForkCommand({
      agent: agentWith({ forkCommand: "{bin} --fork-session" }),
      binary: "claude",
      sessionId: "abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("{path}");
      expect(result.error).toContain("{id}");
    }
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

  describe("resuming by transcript path", () => {
    const PATH_TEMPLATE = "{bin} --resume '{path}' --fork-session";

    it("single-quote escapes the path, exactly as it does a prompt", () => {
      // A directory name can hold a space and a quote, and this is a shell
      // command typed into a pane: byte-exact, not "looks right".
      const { path, cleanup } = transcript("it's a.jsonl");
      try {
        const result = buildAgentForkCommand({
          agent: agentWith({ forkCommand: PATH_TEMPLATE }),
          binary: "claude",
          sessionId: "abc-123",
          logPath: path,
        });
        expect(result).toEqual({
          ok: true,
          value: `claude --resume '${dirname(path)}/it'\\''s a.jsonl' --fork-session`,
        });
      } finally {
        cleanup();
      }
    });

    it("refuses a missing, relative, or unreadable transcript", () => {
      // The whole point of the path form is that the agent opens the file
      // instead of deriving a directory, so a path that resolves to nothing
      // reproduces the failure it exists to prevent: a live pane that found
      // no conversation, which nothing downstream can detect.
      const { path, cleanup } = transcript();
      try {
        const bad: (string | null | undefined)[] = [
          undefined,
          null,
          "",
          "relative/abc.jsonl",
          // Absolute, but not a transcript at all: `Session.logPath` is
          // whatever the source recorded, and a background row records a
          // `state.json` scan path.
          join(dirname(path), "state.json"),
          // Absolute and .jsonl, but gone.
          join(dirname(path), "missing.jsonl"),
          // A directory, not a file.
          dirname(path),
        ];
        for (const logPath of bad) {
          const result = buildAgentForkCommand({
            agent: agentWith({ forkCommand: PATH_TEMPLATE }),
            binary: "claude",
            sessionId: "abc-123",
            logPath,
          });
          expect(result.ok).toBe(false);
          if (!result.ok) {
            // Actionable: names the escape hatch rather than just failing.
            expect(result.error).toContain("ccmux setup");
            expect(result.error).toContain("--resume {id}");
          }
        }
      } finally {
        cleanup();
      }
    });

    it("still builds an id-only template with no transcript at all", () => {
      // The compatibility fallback: the path interface is undocumented, so
      // reverting `forkCommand` to the id form in ccmux.json has to keep
      // working for a row ccmux never recorded a transcript for.
      expect(
        buildAgentForkCommand({
          agent: agentWith({
            forkCommand: "{bin} --resume {id} --fork-session",
          }),
          binary: "claude",
          sessionId: "abc-123",
          logPath: null,
        }),
      ).toEqual({ ok: true, value: "claude --resume abc-123 --fork-session" });
    });

    it("refuses a {path} that is not in a real single-quoted context", () => {
      // Same reasoning as `promptCommand`: the escaping is single-quote
      // escaping, and it is inert anywhere else.
      const { path, cleanup } = transcript();
      try {
        for (const template of [
          "{bin} --resume {path}",
          '{bin} --resume "{path}"',
          `sh -c "{bin} --resume '{path}'"`,
        ]) {
          const result = buildAgentForkCommand({
            agent: agentWith({ forkCommand: template }),
            binary: "claude",
            sessionId: "abc-123",
            logPath: path,
          });
          expect(result.ok).toBe(false);
        }
      } finally {
        cleanup();
      }
    });

    it("refuses a launcher that would break the quoting around the path", () => {
      // `{bin}` is skipped as inert by the template scan, which is only
      // sound while the binary itself is quote-neutral.
      const { path, cleanup } = transcript();
      try {
        const result = buildAgentForkCommand({
          agent: agentWith({ forkCommand: PATH_TEMPLATE }),
          binary: "/opt/it's/claude",
          sessionId: "abc-123",
          logPath: path,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("launcher");
      } finally {
        cleanup();
      }
    });
  });
});

describe("built-in fork invocations", () => {
  it("forks Claude by transcript path, leaving the source alone", () => {
    // `--fork-session` (not a bare `--resume`, which would APPEND to the
    // source's transcript and fight the live original for it), and by PATH
    // rather than id, which is what lets the fork start in any directory
    // (docs/agent-adapters.md#forking-a-session).
    const dir = mkdtempSync(join(tmpdir(), "ccmux-fork-"));
    const path = join(dir, "abc-123.jsonl");
    writeFileSync(path, "{}\n");
    try {
      expect(
        buildAgentForkCommand({
          agent: getBuiltinAgent("claude"),
          binary: "claude",
          sessionId: "abc-123",
          logPath: path,
        }),
      ).toEqual({
        ok: true,
        value: `claude --resume '${path}' --fork-session`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("substituteQuotedTemplate", () => {
  // `{path}` carries a filesystem path, which may legally contain quotes,
  // spaces, newlines and every shell metacharacter. It gets the same
  // single-quoted placement and escaping as `{prompt}`, through the same
  // one-pass substitution.

  it("escapes a path for the single-quoted word it lands in", () => {
    // Byte-exact: this string is typed into a shell, so "looks fine" is
    // not the contract.
    expect(
      substituteQuotedTemplate("{bin} --resume '{path}'", {
        bin: "claude",
        path: "/tmp/it's here/a b",
      }),
    ).toBe("claude --resume '/tmp/it'\\''s here/a b'");
  });

  it("leaves values that are inert by construction alone", () => {
    // `bin` and `id` are validated rather than escaped, so escaping them
    // would corrupt a legitimate `$HOME/bin/claude`.
    expect(
      substituteQuotedTemplate("{bin} --resume {id} --fork-session", {
        bin: "$HOME/bin/claude",
        id: "abc-123",
      }),
    ).toBe("$HOME/bin/claude --resume abc-123 --fork-session");
  });

  it("hands a real shell every hostile path as exactly one argument", () => {
    // The shell is the oracle. `printf` stands in for the agent binary, and
    // the canary proves nothing else ran, rather than just that stdout
    // looked right.
    const canary = join(mkdtempSync(join(tmpdir(), "spawn-path-")), "PWNED");
    try {
      for (const path of [
        "/tmp/it's here",
        '/tmp/say "hi"',
        "/tmp/a b\tc",
        "/tmp/$(touch " + canary + ")",
        "/tmp/`touch " + canary + "`",
        "/tmp/a;touch " + canary + ";:",
        "/tmp/line\nbreak",
        "/tmp/$HOME/${x}/$&/$`/$'",
        "/tmp/'; touch " + canary + "; #",
      ]) {
        const command = substituteQuotedTemplate("printf '[%s]' '{path}'", {
          bin: "printf",
          path,
        });
        // zsh ships on macOS but not on Linux CI runners.
        for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"].filter(
          existsSync,
        )) {
          const run = Bun.spawnSync([shell, "-c", command]);
          expect(run.exitCode).toBe(0);
          expect(run.stdout.toString()).toBe(`[${path}]`);
          expect(existsSync(canary)).toBe(false);
        }
      }
    } finally {
      rmSync(dirname(canary), { recursive: true, force: true });
    }
  });

  it("is not a raw substitution, which the same payload would execute", () => {
    // The red half of the test above: the naive `.replace` into the same
    // single-quoted slot closes the quote and runs the payload, and this
    // asserts it really does before asserting that ours does not.
    const canary = join(
      mkdtempSync(join(tmpdir(), "spawn-path-raw-")),
      "PWNED",
    );
    const template = "printf '[%s]' '{path}'";
    const path = `/tmp/x';touch ${canary};#`;
    try {
      const naive = template.replace("{path}", path);
      Bun.spawnSync(["/bin/sh", "-c", naive], { stderr: "ignore" });
      expect(existsSync(canary)).toBe(true);

      rmSync(canary, { force: true });
      const safe = substituteQuotedTemplate(template, {
        bin: "printf",
        path,
      });
      expect(safe).not.toBe(naive);
      const run = Bun.spawnSync(["/bin/sh", "-c", safe]);
      expect(run.stdout.toString()).toBe(`[${path}]`);
      expect(existsSync(canary)).toBe(false);
    } finally {
      rmSync(dirname(canary), { recursive: true, force: true });
    }
  });

  it("keeps a path containing {prompt} from relocating the prompt", () => {
    // The one-pass property, on the new placeholder: a path substituted
    // first must not be able to carry a later placeholder to a slot the
    // guard never checked.
    expect(
      substituteQuotedTemplate("{bin} '{path}' '{prompt}'", {
        bin: "x",
        path: "/tmp/{prompt}",
        prompt: "P",
      }),
    ).toBe("x '/tmp/{prompt}' 'P'");
  });
});

describe("quotedTemplateProblem", () => {
  it("accepts a single-quoted {path}", () => {
    expect(
      quotedTemplateProblem("{bin} --resume '{path}' --fork-session"),
    ).toBeUndefined();
  });

  it("refuses a {path} that is not in a genuine single-quoted context", () => {
    // Identical treatment to `{prompt}`: the escaping only holds inside
    // real single quotes, so anything else is refused rather than modelled.
    for (const template of [
      "{bin} {path}",
      `{bin} "{path}"`,
      `{bin} sh -c "{bin} '{path}'"`,
      "{bin} $'{path}'",
      "{bin} \\{path}",
      "{bin} '{path}",
      "{bin} $(echo '{path}')",
      "{bin} `echo '{path}'`",
    ]) {
      expect(quotedTemplateProblem(template)).toBeDefined();
    }
  });

  it("names the placeholder it could not prove safe", () => {
    // A hand-written template with several placeholders is unactionable
    // otherwise.
    expect(quotedTemplateProblem("{bin} '{prompt}' {path}")).toContain(
      "{path}",
    );
    expect(quotedTemplateProblem("{bin} {prompt} '{path}'")).toContain(
      "{prompt}",
    );
  });

  it("says nothing about which placeholders a template needs", () => {
    // Whether `{prompt}` or `{path}` is mandatory is the caller's contract
    // with its own config field, checked next to that field's error text.
    expect(quotedTemplateProblem("{bin} --continue")).toBeUndefined();
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

  it("carries a move request and its untracked mode through", () => {
    expect(
      normalizeWorktreeRequest({
        name: "fix-thing",
        withChanges: true,
        untracked: "copy",
      }),
    ).toEqual({
      ok: true,
      value: { name: "fix-thing", withChanges: true, untracked: "copy" },
    });
  });

  it("leaves the mode absent so the module's own default applies", () => {
    expect(normalizeWorktreeRequest({ withChanges: true })).toEqual({
      ok: true,
      value: { withChanges: true },
    });
  });

  it("keeps a plain worktree request free of move fields", () => {
    // `withChanges: false` is the same request as no field at all, and the
    // difference matters: a `false` left on the object would fail the
    // untracked pairing check below for callers that always send both.
    expect(normalizeWorktreeRequest({ withChanges: false })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("rejects an untracked mode with nothing to move", () => {
    const orphan = normalizeWorktreeRequest({ untracked: "leave" });
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) {
      expect(orphan.error).toContain("requires 'worktree.withChanges'");
    }

    const explicit = normalizeWorktreeRequest({
      withChanges: false,
      untracked: "move",
    });
    expect(explicit.ok).toBe(false);
  });

  it("rejects an untracked mode outside the three it knows", () => {
    for (const value of ["MOVE", "delete", "", 3, true]) {
      const bad = normalizeWorktreeRequest({
        withChanges: true,
        untracked: value,
      });
      expect([value, bad.ok]).toEqual([value, false]);
      if (!bad.ok) expect(bad.error).toContain("move, copy, leave");
    }
  });

  it("rejects a non-boolean withChanges", () => {
    const bad = normalizeWorktreeRequest({ withChanges: "yes" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("worktree.withChanges");
  });
});

describe("normalizeModel", () => {
  it("passes absent through and accepts every built-in's vocabulary", () => {
    expect(normalizeModel(undefined)).toEqual({ ok: true, value: undefined });
    expect(normalizeModel(null)).toEqual({ ok: true, value: undefined });
    for (const model of [
      "opus",
      "gpt-5",
      "anthropic/claude-sonnet-4",
      "sonnet:high",
      "gemini-2.5-pro",
      "claude-opus-4-1-20250805",
    ]) {
      expect(normalizeModel(model)).toEqual({ ok: true, value: model });
    }
  });

  it("rejects anything the shell or the agent could misread", () => {
    // The value is spliced UNQUOTED after the binary, so the pattern is the
    // whole of its safety: no leading `-` (a flag), no whitespace or quote.
    for (const bad of ["-x", "--model", "a b", "x'y", 'x"y', "x;y", "$(x)", ""]) {
      const result = normalizeModel(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid 'model' field");
    }
    expect(normalizeModel(42)).toEqual({
      ok: false,
      error: "Invalid 'model' field: expected a string",
    });
    expect(normalizeModel("a".repeat(129)).ok).toBe(false);
  });
});

describe("buildTmuxSpawnArgv window name", () => {
  it("names a new window with -n right after new-window", () => {
    expect(
      buildTmuxSpawnArgv({
        split: false,
        cwd: "/w",
        windowName: "issue-171",
        detach: true,
        placement: { kind: "session", id: "$3" },
      }),
    ).toEqual([
      "new-window",
      "-n",
      "issue-171",
      "-d",
      "-t",
      "$3:",
      "-c",
      "/w",
      "-P",
      "-F",
      "#{pane_id}",
    ]);
  });

  it("never names a split, whose window belongs to someone else", () => {
    expect(
      buildTmuxSpawnArgv({ split: "h", cwd: "/w", windowName: "issue-171" }),
    ).toEqual(["split-window", "-h", "-c", "/w", "-P", "-F", "#{pane_id}"]);
  });
});

describe("buildAgentSpawnCommand with a model", () => {
  function agentWith(overrides: Partial<AgentDef>): AgentDef {
    return { ...claudeAgent, ...overrides };
  }

  it("splices the flag after the binary on the bare path", () => {
    expect(
      buildAgentSpawnCommand({
        agent: claudeAgent,
        binary: "claude",
        model: "opus",
      }),
    ).toEqual({ ok: true, value: "claude --model opus" });
  });

  it("keeps the flag ahead of the prompt", () => {
    expect(
      buildAgentSpawnCommand({
        agent: claudeAgent,
        binary: "/my/wrapper",
        model: "opus",
        prompt: "go",
      }),
    ).toEqual({ ok: true, value: "/my/wrapper --model opus 'go'" });
  });

  it("appends the flag to a resume, whose template names its own binary", () => {
    expect(
      buildAgentSpawnCommand({
        agent: getBuiltinAgent("codex"),
        binary: "codex",
        resume: "abc-123",
        model: "gpt-5",
      }),
    ).toEqual({ ok: true, value: "codex resume abc-123 --model gpt-5" });
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ resumeCommand: undefined }),
        binary: "claude",
        resume: "abc-123",
        model: "opus",
      }),
    ).toEqual({ ok: true, value: "claude --resume abc-123 --model opus" });
  });

  it("refuses an agent without a verified model flag", () => {
    const result = buildAgentSpawnCommand({
      agent: agentWith({ name: "custom", modelFlag: undefined }),
      binary: "custom",
      model: "opus",
    });
    expect(result).toEqual({
      ok: false,
      error:
        "Agent 'custom' has no known model flag, so --model cannot be passed to it. " +
        'Set \'agents.custom.modelFlag\' in ccmux.json (e.g. "--model").',
    });
  });

  it("refuses a non-string modelFlag from config", () => {
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ modelFlag: 5 as unknown as string }),
        binary: "claude",
        model: "opus",
      }),
    ).toEqual({
      ok: false,
      error: "Invalid 'agents.claude.modelFlag': expected a string.",
    });
  });

  it("honors a custom flag spelling", () => {
    expect(
      buildAgentSpawnCommand({
        agent: agentWith({ modelFlag: "-m" }),
        binary: "codex",
        model: "gpt-5",
      }),
    ).toEqual({ ok: true, value: "codex -m gpt-5" });
  });

  it("uses --model on every built-in", () => {
    for (const agent of BUILTIN_AGENTS) {
      expect(agent.modelFlag).toBe("--model");
      const binary = agent.executable ?? agent.name;
      expect(
        buildAgentSpawnCommand({ agent, binary, model: "x" }),
      ).toEqual({ ok: true, value: `${binary} --model x` });
    }
  });
});

describe("buildAgentForkCommand with a model", () => {
  it("splices the flag into {bin} ahead of the resume", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccmux-fork-"));
    const path = join(dir, "abc.jsonl");
    writeFileSync(path, "{}\n");
    try {
      expect(
        buildAgentForkCommand({
          agent: claudeAgent,
          binary: "claude",
          sessionId: "abc-123",
          logPath: path,
          model: "opus",
        }),
      ).toEqual({
        ok: true,
        value: `claude --model opus --resume '${path}' --fork-session`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splices the flag into an id-form template, which has no transcript path", () => {
    // The id form is what the codebase itself recommends as the fallback
    // (see the {path}-resolution refusal), so it must carry the model too.
    expect(
      buildAgentForkCommand({
        agent: {
          ...claudeAgent,
          forkCommand: "{bin} --resume {id} --fork-session",
        },
        binary: "claude",
        sessionId: "abc-123",
        model: "opus",
      }),
    ).toEqual({
      ok: true,
      value: "claude --model opus --resume abc-123 --fork-session",
    });
  });

  it("refuses an agent without a verified model flag", () => {
    const result = buildAgentForkCommand({
      agent: { ...claudeAgent, modelFlag: undefined },
      binary: "claude",
      sessionId: "abc-123",
      model: "opus",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no known model flag");
  });
});
