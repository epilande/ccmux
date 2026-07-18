import { describe, expect, it } from "bun:test";
import { BUILTIN_AGENTS, findAgentForProcess, getAgents } from "./agents";
import { extractVersionFromOutput } from "../daemon/version-resolver";

describe("findAgentForProcess", () => {
  it("matches Antigravity CLI commands without matching the IDE launcher", () => {
    for (const command of [
      "agy",
      "/Users/x/.local/bin/agy",
      "agy -c",
      "agy --conversation abc",
    ]) {
      expect(findAgentForProcess(command, BUILTIN_AGENTS)?.name).toBe(
        "antigravity",
      );
    }
    expect(
      findAgentForProcess(
        "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
        BUILTIN_AGENTS,
      ),
    ).toBeNull();
    expect(findAgentForProcess("antigravity", BUILTIN_AGENTS)).toBeNull();
  });

  it("matches agy via commandPatterns when argv[0] is a wrapper", () => {
    const agent = findAgentForProcess(
      "sh -c /Users/x/.local/bin/agy",
      BUILTIN_AGENTS,
    );
    expect(agent?.name).toBe("antigravity");
    expect(
      findAgentForProcess("claude --agy-flavored-flag", BUILTIN_AGENTS)?.name,
    ).toBe("claude");
  });
  it("matches claude executable", () => {
    const agent = findAgentForProcess("claude --resume abc", BUILTIN_AGENTS);
    expect(agent?.name).toBe("claude");
  });

  it("matches codex executable from absolute path", () => {
    const agent = findAgentForProcess(
      "/opt/tools/codex/codex --help",
      BUILTIN_AGENTS,
    );
    expect(agent?.name).toBe("codex");
  });

  it("matches opencode executable", () => {
    const agent = findAgentForProcess(
      "/usr/local/bin/opencode --continue",
      BUILTIN_AGENTS,
    );
    expect(agent?.name).toBe("opencode");
  });

  it("matches gemini via npx wrapper command", () => {
    const agent = findAgentForProcess(
      "npm exec @google/gemini-cli",
      BUILTIN_AGENTS,
    );
    expect(agent?.name).toBe("gemini");
  });

  it("matches gemini via node .bin shim command", () => {
    const agent = findAgentForProcess(
      "node /Users/test/.npm/_npx/abc/node_modules/.bin/gemini",
      BUILTIN_AGENTS,
    );
    expect(agent?.name).toBe("gemini");
  });

  it("matches gemini via Homebrew node wrapper command", () => {
    const agent = findAgentForProcess(
      "/opt/homebrew/opt/node/bin/node /opt/homebrew/bin/gemini",
      BUILTIN_AGENTS,
    );
    expect(agent?.name).toBe("gemini");
  });

  it("does not match gemini from npm wrapper command args", () => {
    const agent = findAgentForProcess(
      "npm exec gemini-grounding",
      BUILTIN_AGENTS,
    );
    expect(agent).toBeNull();
  });

  it("matches the Copilot native binary by basename and path", () => {
    for (const command of [
      "copilot",
      "/opt/homebrew/lib/node_modules/@github/copilot-darwin-arm64/copilot",
      "copilot --resume abc",
    ]) {
      expect(findAgentForProcess(command, BUILTIN_AGENTS)?.name).toBe(
        "copilot",
      );
    }
  });

  it("matches Copilot via npx / .bin wrapper commands", () => {
    expect(
      findAgentForProcess("npm exec @github/copilot", BUILTIN_AGENTS)?.name,
    ).toBe("copilot");
    expect(
      findAgentForProcess(
        "node /Users/test/.npm/_npx/abc/node_modules/.bin/copilot",
        BUILTIN_AGENTS,
      )?.name,
    ).toBe("copilot");
  });

  it("does not treat the legacy gh copilot extension as the Copilot CLI", () => {
    // `gh copilot ...` has argv[0] `gh`; the `gh-copilot` shim has a `-`
    // before `copilot`, so neither the basename nor the `/copilot` path
    // pattern matches.
    expect(
      findAgentForProcess("gh copilot suggest", BUILTIN_AGENTS),
    ).toBeNull();
    expect(
      findAgentForProcess(
        "/Users/x/.local/share/gh/extensions/gh-copilot/gh-copilot",
        BUILTIN_AGENTS,
      ),
    ).toBeNull();
  });
});

describe("Copilot version parsing", () => {
  it("extracts the version from `copilot --version` output using defaults", () => {
    // Copilot prints `GitHub Copilot CLI 1.0.71.` plus a second update-hint
    // line; the default patterns take the first version-shaped token.
    const copilot = BUILTIN_AGENTS.find((a) => a.name === "copilot");
    expect(copilot?.versionPatterns).toBeUndefined();
    expect(
      extractVersionFromOutput(
        "GitHub Copilot CLI 1.0.71.\nA newer version is available",
        copilot?.versionPatterns,
      ),
    ).toBe("1.0.71");
  });
});

describe("getAgents", () => {
  it("defines terminal rules for built-in agents", () => {
    const claude = BUILTIN_AGENTS.find((agent) => agent.name === "claude");
    expect(claude?.terminalRules).toEqual([
      {
        matchAny: ["requires approval", "permission rule"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: null,
      },
      {
        matchAll: ["type something.", "enter to select"],
        status: "waiting",
        attentionType: "question",
        pendingTool: null,
      },
      {
        matchAll: ["what would you like to work on", "enter to select"],
        status: "waiting",
        attentionType: "question",
        pendingTool: null,
      },
    ]);
  });

  it("replaces built-in terminal rules when overridden", () => {
    const agents = getAgents({
      agents: {
        codex: {
          terminalRules: [
            {
              matchAny: ["custom prompt"],
              status: "waiting",
              attentionType: "question",
            },
          ],
        },
      },
    });
    const codex = agents.find((agent) => agent.name === "codex");
    expect(codex?.terminalRules).toEqual([
      {
        matchAny: ["custom prompt"],
        status: "waiting",
        attentionType: "question",
        pendingTool: null,
      },
    ]);
  });

  it("replaces built-in errorRules when overridden", () => {
    const agents = getAgents({
      agents: {
        codex: {
          errorRules: [{ match: "custom-only-pattern", kind: "agent_error" }],
        },
      },
    });
    const codex = agents.find((agent) => agent.name === "codex");
    expect(codex?.errorRules).toHaveLength(1);
    expect(codex?.errorRules?.[0].kind).toBe("agent_error");
    // The built-in rate-limit rule must not bleed through after override.
    expect(
      codex?.errorRules?.some(
        (r) => r.match.test("rate limit reached") && r.kind === "rate_limit",
      ),
    ).toBe(false);
  });

  it("parses terminal rules for custom agents", () => {
    const agents = getAgents({
      agents: {
        myagent: {
          processMatch: "myagent",
          terminalRules: [
            {
              matchAny: ["thinking..."],
              status: "working",
            },
            {
              matchAll: ["approve?", "[y/n]"],
              status: "waiting",
              attentionType: "permission",
              pendingTool: "Command",
            },
          ],
        },
      },
    });
    const custom = agents.find((agent) => agent.name === "myagent");
    expect(custom?.terminalRules).toEqual([
      {
        matchAny: ["thinking..."],
        status: "working",
        attentionType: null,
        pendingTool: null,
      },
      {
        matchAll: ["approve?", "[y/n]"],
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Command",
      },
    ]);
  });

  it("rejects terminal rules with both matchAny and matchAll", () => {
    expect(() =>
      getAgents({
        agents: {
          myagent: {
            processMatch: "myagent",
            terminalRules: [
              {
                matchAny: ["foo"],
                matchAll: ["bar"],
                status: "working",
              },
            ],
          },
        },
      }),
    ).toThrow("exactly one of matchAny or matchAll is required");
  });

  it("rejects terminal rules with empty match arrays", () => {
    expect(() =>
      getAgents({
        agents: {
          myagent: {
            processMatch: "myagent",
            terminalRules: [{ matchAny: [], status: "working" }],
          },
        },
      }),
    ).toThrow("match patterns must not be empty");
  });

  it("rejects non-waiting terminal rules with attention metadata", () => {
    expect(() =>
      getAgents({
        agents: {
          myagent: {
            processMatch: "myagent",
            terminalRules: [
              {
                matchAny: ["thinking..."],
                status: "working",
                attentionType: "permission",
              },
            ],
          },
        },
      }),
    ).toThrow("attentionType and pendingTool are only valid for waiting rules");
  });

  it("declares cursor-agent as the cursor launch executable", () => {
    const cursor = BUILTIN_AGENTS.find((agent) => agent.name === "cursor");
    expect(cursor?.executable).toBe("cursor-agent");
  });

  it("merges executable override from preferences", () => {
    const agents = getAgents({
      agents: {
        cursor: { executable: "/opt/cursor/bin/cursor-agent" },
      },
    });
    const cursor = agents.find((agent) => agent.name === "cursor");
    expect(cursor?.executable).toBe("/opt/cursor/bin/cursor-agent");
  });

  it("accepts executable on custom agents", () => {
    const agents = getAgents({
      agents: {
        myagent: {
          processMatch: "myagent",
          executable: "myagent-cli",
          terminalRules: [],
        },
      },
    });
    const custom = agents.find((agent) => agent.name === "myagent");
    expect(custom?.executable).toBe("myagent-cli");
  });

  it("parses errorRules on custom agents", () => {
    const agents = getAgents({
      agents: {
        myagent: {
          processMatch: "myagent",
          terminalRules: [],
          errorRules: [
            {
              match: "myagent rate limit exceeded",
              kind: "rate_limit",
            },
          ],
        },
      },
    });
    const custom = agents.find((agent) => agent.name === "myagent");
    expect(custom?.errorRules).toHaveLength(1);
    expect(custom?.errorRules?.[0].kind).toBe("rate_limit");
    expect(
      custom?.errorRules?.[0].match.test("myagent rate limit exceeded"),
    ).toBe(true);
    expect(custom?.errorRules?.[0].match.test("nothing to see")).toBe(false);
  });

  it("rejects malformed errorRules regex on custom agents", () => {
    expect(() =>
      getAgents({
        agents: {
          myagent: {
            processMatch: "myagent",
            terminalRules: [],
            errorRules: [{ match: "/[unclosed/", kind: "rate_limit" }],
          },
        },
      }),
    ).toThrow(/Invalid regex/);
  });
});

describe("built-in errorRules", () => {
  // The previous /rate limit|usage limit/i caught the assistant's own
  // prose discussing rate limits. New rules require the limit noun to be
  // followed by a "reached/exceeded/exhausted" verb so the regex hits
  // chrome-style notices but not normal discussion.
  const rateLimitProse = [
    "Rate limits prevent abuse by throttling requests.",
    "When you hit your rate limit, wait an hour.",
    "Anthropic's rate limit is documented at /docs/limits.",
    "A typical usage limit is 50 messages per session.",
  ];

  // Notices every agent's regex should still catch.
  const universalNotices = [
    "Claude AI usage limit reached",
    "rate limit exceeded",
    "Daily limit exhausted",
  ];

  it("does not false-positive on assistant discussions of rate limits", () => {
    for (const agent of BUILTIN_AGENTS) {
      const rules = agent.errorRules ?? [];
      for (const text of rateLimitProse) {
        const match = rules.find((r) => r.match.test(text));
        expect(match, `${agent.name} matched prose: ${text}`).toBeUndefined();
      }
    }
  });

  it("still detects real limit notices", () => {
    for (const agent of BUILTIN_AGENTS) {
      const rules = agent.errorRules ?? [];
      if (rules.length === 0) continue;
      for (const text of universalNotices) {
        const match = rules.find((r) => r.match.test(text));
        expect(match, `${agent.name} missed notice: ${text}`).toBeDefined();
      }
    }
  });

  it("catches Claude's 5-hour subscription limit", () => {
    const claude = BUILTIN_AGENTS.find((a) => a.name === "claude");
    const rules = claude?.errorRules ?? [];
    const match = rules.find((r) =>
      r.match.test("5-hour limit reached • Resets at 11:30 PM"),
    );
    expect(match?.kind).toBe("rate_limit");
  });
});

describe("Claude readyPattern", () => {
  // The prompt-ready glyph has changed between Claude versions
  // (`> ` in early Claude Code → `❯ ` in 2.1.x). The default
  // character class accepts both so a glyph rename doesn't break
  // `ccmux invoke claude` outright; users can override the regex via
  // `agents.claude.readyPattern` in ccmux.json when it changes again.
  const claudePattern = BUILTIN_AGENTS.find(
    (a) => a.name === "claude",
  )?.readyPattern;

  it("matches the legacy `> ` prompt glyph", () => {
    expect(claudePattern?.test("> ")).toBe(true);
  });

  it("matches the current `❯` prompt glyph followed by NBSP", () => {
    // U+00A0 NO-BREAK SPACE; \s in JS regex matches it.
    expect(claudePattern?.test("❯ ")).toBe(true);
  });

  it("matches the `❯ ` prompt glyph followed by a regular space", () => {
    expect(claudePattern?.test("❯ ")).toBe(true);
  });

  it("rejects a bare shell prompt that doesn't use chevron glyphs", () => {
    expect(claudePattern?.test("$ ")).toBe(false);
    expect(claudePattern?.test("% ")).toBe(false);
    expect(claudePattern?.test("user@host:~/path$ ls")).toBe(false);
  });

  it("rejects a chevron-glyph shell prompt with a typed command", () => {
    // Critical for the launch sequence: between `tmux send-keys claude`
    // and the binary actually running, the pane shows `❯ claude` on
    // the prompt line. Without the `$` anchor in the default pattern,
    // this line would match and ccmux would send the user's prompt
    // before claude had launched.
    expect(claudePattern?.test("❯ claude")).toBe(false);
    expect(claudePattern?.test("> ls -la")).toBe(false);
  });
});

describe("agents.claude.readyPattern override", () => {
  it("accepts a slash-delimited regex override", () => {
    const agents = getAgents({
      agents: {
        claude: { readyPattern: "/^PROMPT>\\s/" },
      },
    });
    const claude = agents.find((a) => a.name === "claude");
    expect(claude?.readyPattern?.test("PROMPT> ")).toBe(true);
    expect(claude?.readyPattern?.test("❯ ")).toBe(false);
  });

  it("accepts a literal regex string (defaults to case-insensitive)", () => {
    const agents = getAgents({
      agents: {
        claude: { readyPattern: "^ready>" },
      },
    });
    const claude = agents.find((a) => a.name === "claude");
    expect(claude?.readyPattern?.test("READY> ")).toBe(true);
  });

  it("preserves the default when override is absent", () => {
    const agents = getAgents({
      agents: {
        claude: { resumeCommand: "claude --resume {id}" },
      },
    });
    const claude = agents.find((a) => a.name === "claude");
    expect(claude?.readyPattern?.test("❯ ")).toBe(true);
  });

  it("throws on an invalid regex override", () => {
    expect(() =>
      getAgents({
        agents: {
          claude: { readyPattern: "/[unclosed/" },
        },
      }),
    ).toThrow(/Invalid regex/);
  });
});

describe("agents.claude.notificationActions", () => {
  it("carries the built-in reply gates on the default Claude def", () => {
    const claude = BUILTIN_AGENTS.find((a) => a.name === "claude");
    expect(claude?.notificationActions?.replyOnQuestion).toBe(true);
    expect(claude?.notificationActions?.replyOnFinished).toBe(true);
  });

  it("carries the plan keys on the default Claude def (approve = 2, never 1)", () => {
    const claude = BUILTIN_AGENTS.find((a) => a.name === "claude");
    expect(claude?.notificationActions?.planApprove).toEqual(["2"]);
    expect(claude?.notificationActions?.planDeny).toEqual(["Escape"]);
    expect(claude?.notificationActions?.planReplyPrelude).toEqual(["Escape"]);
  });

  it("copies plan keys through a custom notificationActions override", () => {
    const agents = getAgents({
      agents: {
        claude: {
          notificationActions: {
            planApprove: ["9"],
            planDeny: ["q"],
            planReplyPrelude: ["Escape"],
          },
        },
      },
    });
    const claude = agents.find((a) => a.name === "claude");
    expect(claude?.notificationActions?.planApprove).toEqual(["9"]);
    expect(claude?.notificationActions?.planDeny).toEqual(["q"]);
    expect(claude?.notificationActions?.planReplyPrelude).toEqual(["Escape"]);
  });

  it("whole-object replaces the map (omitted keys become undefined)", () => {
    const agents = getAgents({
      agents: {
        claude: {
          notificationActions: { approve: ["y"], deny: ["n"] },
        },
      },
    });
    const claude = agents.find((a) => a.name === "claude");
    expect(claude?.notificationActions?.approve).toEqual(["y"]);
    expect(claude?.notificationActions?.deny).toEqual(["n"]);
    // A partial override drops the builtin reply gates rather than merging them.
    expect(claude?.notificationActions?.answerPrelude).toBeUndefined();
    expect(claude?.notificationActions?.permissionReplyPrelude).toBeUndefined();
    expect(claude?.notificationActions?.replyOnQuestion).toBeUndefined();
    expect(claude?.notificationActions?.replyOnFinished).toBeUndefined();
  });

  it("preserves the built-in map when there is no override", () => {
    const agents = getAgents({
      agents: {
        claude: { resumeCommand: "claude --resume {id}" },
      },
    });
    const claude = agents.find((a) => a.name === "claude");
    expect(claude?.notificationActions?.replyOnQuestion).toBe(true);
    expect(claude?.notificationActions?.replyOnFinished).toBe(true);
  });
});

describe("agents.<custom>.readyPattern (custom-agent path)", () => {
  // The merge path (override of a built-in) and the custom-agent path
  // (a brand-new agent with no built-in to merge into) are separate
  // branches in getAgents. The built-in override tests above cover the
  // merge path; these pin the custom-agent path so a typo there
  // wouldn't go unnoticed.
  it("parses readyPattern for a fully custom agent", () => {
    const agents = getAgents({
      agents: {
        myagent: {
          processMatch: "myagent",
          terminalRules: [],
          readyPattern: "/^READY>\\s*$/",
        },
      },
    });
    const custom = agents.find((a) => a.name === "myagent");
    expect(custom?.readyPattern?.test("READY> ")).toBe(true);
    expect(custom?.readyPattern?.test("READY> typed cmd")).toBe(false);
  });

  it("leaves readyPattern undefined when a custom agent omits it", () => {
    const agents = getAgents({
      agents: {
        myagent: {
          processMatch: "myagent",
          terminalRules: [],
        },
      },
    });
    const custom = agents.find((a) => a.name === "myagent");
    expect(custom?.readyPattern).toBeUndefined();
  });

  it("throws on an invalid readyPattern for a custom agent", () => {
    expect(() =>
      getAgents({
        agents: {
          myagent: {
            processMatch: "myagent",
            terminalRules: [],
            readyPattern: "/[unclosed/",
          },
        },
      }),
    ).toThrow(/Invalid regex/);
  });
});

describe("normalizeInvokeMode validation", () => {
  // normalizeInvokeMode is called via mergeAgentConfig (built-in override)
  // and the custom-agent path. These tests pin its three throw branches
  // so a user-supplied agents.<name>.invokeMode in ccmux.json fails fast
  // with an actionable message instead of surfacing as a runtime crash at
  // first invoke.

  it("throws when args is missing or empty", () => {
    expect(() =>
      getAgents({
        agents: {
          myagent: {
            processMatch: "myagent",
            terminalRules: [],
            invokeMode: {
              args: [],
              output: { kind: "stdout" },
            },
          },
        },
      }),
    ).toThrow(/args must be a non-empty argv array/);
  });

  it("throws on an invalid output.kind", () => {
    expect(() =>
      getAgents({
        agents: {
          myagent: {
            processMatch: "myagent",
            terminalRules: [],
            invokeMode: {
              args: ["myagent", "exec"],
              output: { kind: "bogus" as never },
            },
          },
        },
      }),
    ).toThrow(/output\.kind: must be one of/);
  });

  it("throws when output.kind=tmpfile is missing the {tmpfile} placeholder", () => {
    expect(() =>
      getAgents({
        agents: {
          myagent: {
            processMatch: "myagent",
            terminalRules: [],
            invokeMode: {
              args: ["myagent", "exec", "--no-tmpfile-placeholder"],
              output: { kind: "tmpfile" },
            },
          },
        },
      }),
    ).toThrow(/requires a \{tmpfile\} placeholder/);
  });
});
