import { describe, expect, it } from "bun:test";
import { summaryFromPaneTitle } from "./pane-summary";
import { BUILTIN_AGENTS } from "./agents";

/**
 * The per-agent rule table from issue #183's survey. Every case below is a
 * real pane title one of the built-ins wrote on an isolated tmux server.
 *
 * Every helper pins the hostname rather than taking the machine's own, so
 * the guard that reads tmux's seed as no summary is tested against a known
 * value instead of whatever laptop runs the suite.
 */
const HOST = "probe-host.local";

describe("summaryFromPaneTitle", () => {
  describe("claude", () => {
    const claude = (title: string | null) =>
      summaryFromPaneTitle("claude", title, "/tmp/probe-claude", HOST);

    it("takes the summary after the idle glyph", () => {
      expect(claude("✳ Add dark mode toggle to settings")).toBe(
        "Add dark mode toggle to settings",
      );
    });

    it("takes the summary after the braille spinner shown while working", () => {
      expect(claude("⠂ cache-invalidation-fix")).toBe("cache-invalidation-fix");
      expect(claude("⣾ Fix pagination off-by-one")).toBe(
        "Fix pagination off-by-one",
      );
    });

    it("keeps a summary that itself starts with a digit", () => {
      expect(claude("✳ 3 failing tests in parser/")).toBe(
        "3 failing tests in parser/",
      );
    });

    it("keeps a summary that itself starts with punctuation", () => {
      // The glyph class is greedy, so a leading `-` or `#` has to survive it.
      expect(claude("✳ -- dry-run the migration")).toBe(
        "-- dry-run the migration",
      );
      expect(claude("⠂ #183 summary column")).toBe("#183 summary column");
    });

    it("reads the placeholder title as no summary", () => {
      expect(claude("✳ Claude Code")).toBeNull();
    });

    it("reads tmux's hostname seed as no summary", () => {
      // The leak this column exists to avoid: tmux seeds `pane_title` to the
      // hostname, so a title with none of Claude's glyphs is not Claude's.
      expect(claude("Mac")).toBeNull();
      expect(claude("some-laptop.local")).toBeNull();
    });
  });

  describe("codex", () => {
    // Live captures on codex-cli 0.159.x, plus the shapes its title code
    // writes in states hard to hold still (the blink, the mic, a pending
    // `/rename`), read from the 0.160.0 source.
    const codex = (title: string | null) =>
      summaryFromPaneTitle("codex", title, "/tmp/probe-codex-x7", HOST);
    // Codex's own spinner, in its order.
    const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const UUID = "019a3c2e-7b41-7d10-9f3e-2c5b8a6d4e1f";

    it("takes the thread name before the project", () => {
      expect(codex("lab-tests | probe-codex-x7")).toBe("lab-tests");
      expect(codex("Resolve Git conflicts, suggest Ops | probe-codex-x7")).toBe(
        "Resolve Git conflicts, suggest Ops",
      );
    });

    it("takes the thread name after the spinner shown while working", () => {
      expect(codex("⠋ lab-tests | probe-codex-x7")).toBe("lab-tests");
    });

    it("takes the thread name behind the approval prefix, in both blink states", () => {
      // The prefix blinks every second; a summary that followed it would
      // change between scans and re-send the row each time.
      expect(codex("[ ! ] Action Required | lab-tests | probe-codex-x7")).toBe(
        "lab-tests",
      );
      expect(codex("[ . ] Action Required | lab-tests | probe-codex-x7")).toBe(
        "lab-tests",
      );
    });

    it("drops the frame trailing a name while a /rename suggestion is pending", () => {
      expect(codex("lab-tests ⠋ | probe-codex-x7")).toBe("lab-tests");
    });

    it("drops the dot shown while the mic is listening", () => {
      expect(codex("● lab-tests | probe-codex-x7")).toBe("lab-tests");
      expect(codex("● ⠋ lab-tests | probe-codex-x7")).toBe("lab-tests");
    });

    it("gives the same summary on every spinner frame in each animated slot", () => {
      for (const f of FRAMES) {
        expect([f, codex(`${f} lab-tests | probe-codex-x7`)]).toEqual([
          f,
          "lab-tests",
        ]);
        expect([f, codex(`lab-tests ${f} | probe-codex-x7`)]).toEqual([
          f,
          "lab-tests",
        ]);
        expect([f, codex(`${f} lab-tests ${f} | probe-codex-x7`)]).toEqual([
          f,
          "lab-tests",
        ]);
      }
    });

    it("reads an unnamed thread, idle or working, as no summary", () => {
      expect(codex("probe-codex-x7")).toBeNull();
      expect(codex("⠏ probe-codex-x7")).toBeNull();
    });

    it("reads a title still being generated as no summary", () => {
      for (const f of FRAMES) {
        expect([f, codex(`${f} | probe-codex-x7`)]).toEqual([f, null]);
        expect([f, codex(`⠋ ${f} | probe-codex-x7`)]).toEqual([f, null]);
      }
    });

    it("reads the bare approval prefix as no summary", () => {
      expect(codex("[ ! ] Action Required")).toBeNull();
      expect(codex("[ . ] Action Required")).toBeNull();
      // An unnamed thread waiting on approval.
      expect(codex("[ ! ] Action Required | probe-codex-x7")).toBeNull();
    });

    it("reads a title with an extra separator as no summary", () => {
      // An unfamiliar layout falls back to the prompt rather than showing
      // part of it; a thread name holding `|` falls back the same way.
      expect(codex("a | b | probe-codex-x7")).toBeNull();
    });

    it("reads the app-name and thread-title items as no summary", () => {
      expect(codex("codex | probe-codex-x7")).toBeNull();
      expect(codex(`${UUID} | probe-codex-x7`)).toBeNull();
      expect(codex(`${UUID.toUpperCase()} | probe-codex-x7`)).toBeNull();
    });

    it("reads tmux's hostname seed as no summary", () => {
      expect(codex("probe-host.local")).toBeNull();
      expect(codex("probe-host")).toBeNull();
    });
  });

  describe("copilot", () => {
    const copilot = (title: string | null) =>
      summaryFromPaneTitle("copilot", title, "/tmp/probe-copilot", HOST);

    it("takes the summary before the app-name suffix", () => {
      expect(copilot("Implement Hello Function - GitHub Copilot")).toBe(
        "Implement Hello Function",
      );
    });

    it("keeps a dash inside the summary itself", () => {
      expect(
        copilot("Fix the off-by-one - and its test - GitHub Copilot"),
      ).toBe("Fix the off-by-one - and its test");
    });

    it("reads the bare app name as no summary", () => {
      expect(copilot("GitHub Copilot")).toBeNull();
    });

    it("reads a title without the suffix as no summary", () => {
      expect(copilot("Mac")).toBeNull();
    });
  });

  describe("cursor", () => {
    const cursor = (title: string | null, host = HOST) =>
      summaryFromPaneTitle("cursor", title, "/tmp/probe-cursor", host);

    it("takes the bare summary, which cursor writes unadorned", () => {
      expect(cursor("Hello Bot")).toBe("Hello Bot");
    });

    it("reads the app name it shows before the first turn as no summary", () => {
      expect(cursor("Cursor Agent")).toBeNull();
    });

    it("reads tmux's hostname seed as no summary", () => {
      // Nothing in cursor's title proves cursor wrote it, so a pane whose
      // agent never sets one (`allow-set-title off`) keeps tmux's seed
      // forever. Both spellings of the machine name, and either case.
      expect(cursor("probe-host.local")).toBeNull();
      expect(cursor("probe-host")).toBeNull();
      expect(cursor("Probe-Host")).toBeNull();
      expect(cursor("probe-host", "probe-host")).toBeNull();
    });

    it("keeps a summary that merely contains the hostname", () => {
      expect(cursor("fix probe-host boot order")).toBe(
        "fix probe-host boot order",
      );
    });

    it("reads a shell-written cwd title as no summary", () => {
      // The shell writes the cwd into pane_title on every prompt, and cursor
      // only overwrites it once it has a summary of its own. Colon-prefixed
      // (zsh's default `print -Pn`), tilde-abbreviated, and bare, all of it.
      expect(cursor(":/Users/x/y")).toBeNull();
      expect(cursor("/tmp/x")).toBeNull();
      expect(cursor(":~/Code/ccmux")).toBeNull();
      expect(cursor("~/x")).toBeNull();
      expect(cursor("~")).toBeNull();
      expect(cursor(":~")).toBeNull();
      // bash's default PROMPT_COMMAND shape.
      expect(cursor("me@erp-mac-mini:~/Code/ccmux")).toBeNull();
      expect(cursor("me@host.local:/tmp")).toBeNull();
    });

    it("keeps a real summary that carries a slash or a tilde", () => {
      // The path guards are anchored, so a slash mid-string and a leading
      // tilde that is not a path both survive.
      expect(cursor("Fix src/foo.ts import")).toBe("Fix src/foo.ts import");
      expect(cursor("~50 lines of drift")).toBe("~50 lines of drift");
    });
  });

  describe("omp", () => {
    const omp = (title: string | null, cwd = "/tmp/probe-omp-w5") =>
      summaryFromPaneTitle("omp", title, cwd, HOST);

    it("takes the summary after the prompt prefix", () => {
      expect(omp("π > Say hello and nothing else")).toBe(
        "Say hello and nothing else",
      );
    });

    it("takes the summary after the spinner frame shown while working", () => {
      expect(omp("π ⠧ Say hello and nothing else")).toBe(
        "Say hello and nothing else",
      );
    });

    it("reads the pre-first-turn cwd title as no summary", () => {
      // omp keeps the prefix either way, so only the cwd comparison separates
      // a session title from the directory name `project` already carries.
      expect(omp("π > probe-omp-w5")).toBeNull();
    });

    it("keeps a summary that merely resembles a different directory", () => {
      expect(omp("π > probe-omp-w5", "/tmp/other")).toBe("probe-omp-w5");
    });
  });

  describe("opencode", () => {
    const opencode = (title: string | null) =>
      summaryFromPaneTitle("opencode", title, "/tmp/probe-opencode", HOST);

    it("takes the summary after the session-title prefix", () => {
      expect(opencode("OC | Banana request")).toBe("Banana request");
    });

    it("reads the app name it shows before the first turn as no summary", () => {
      expect(opencode("OpenCode")).toBeNull();
    });

    it("reads tmux's hostname seed as no summary", () => {
      expect(opencode("erp-mac-mini.local")).toBeNull();
    });

    it("reads the prefix with no title after it as no summary", () => {
      expect(opencode("OC | ")).toBeNull();
    });
  });

  describe("normalization", () => {
    it("strips an ANSI escape the agent left in the title", () => {
      // The title is free text on the same footing as the prompt, and it
      // reaches us through a `#{pane_title}` read that carries whatever the
      // agent wrote. Stripped from the WHOLE title, since every rule anchors
      // on `^` and an escape ahead of the glyph would defeat the match.
      expect(
        summaryFromPaneTitle(
          "claude",
          "\x1b[32m✳ Wire up the summary column\x1b[0m",
          "/tmp/p",
          HOST,
        ),
      ).toBe("Wire up the summary column");
    });

    it("collapses tabs and runs of whitespace", () => {
      expect(
        summaryFromPaneTitle(
          "cursor",
          "  Fix\tthe   scroll   math  ",
          "/tmp/p",
          HOST,
        ),
      ).toBe("Fix the scroll math");
    });

    it("strips the controls stripAnsi leaves behind", () => {
      // `stripAnsi` handles well-formed sequences. A BEL, a lone ESC and a
      // C1 byte (here
      // U+0085 NEL, which JS `\s` does not match) would otherwise ride into a
      // rendered cell. Each becomes a space, so the words stay apart.
      expect(
        summaryFromPaneTitle(
          "cursor",
          "Fix\x07the\x85scroll\x1bmath",
          "/tmp/p",
          HOST,
        ),
      ).toBe("Fix the scroll math");
    });

    it("caps a long title before any rule runs", () => {
      // A title is free text another process wrote, so no rule gets to see
      // more than 512 characters of it, however it is written.
      expect(
        summaryFromPaneTitle(
          "claude",
          `✳ ${"a".repeat(10_000)}`,
          "/tmp/p",
          HOST,
        ),
      ).toBe("a".repeat(510));
      const started = Date.now();
      for (const agent of BUILTIN_AGENTS) {
        summaryFromPaneTitle(agent.name, "⠋ ".repeat(5_000), "/tmp/p", HOST);
      }
      expect(
        summaryFromPaneTitle("codex", "⠋ ".repeat(5_000), "/tmp/p", HOST),
      ).toBeNull();
      expect(Date.now() - started).toBeLessThan(100);
    });

    it("normalizes before the cwd comparison", () => {
      expect(
        summaryFromPaneTitle(
          "omp",
          "π >  probe-omp-w5 ",
          "/tmp/probe-omp-w5",
          HOST,
        ),
      ).toBeNull();
    });
  });

  describe("agents with no rule", () => {
    it("has no summary for pi or gemini", () => {
      expect(
        summaryFromPaneTitle("pi", "π - probe-pi-z3", "/tmp/p", HOST),
      ).toBeNull();
      expect(
        summaryFromPaneTitle(
          "gemini",
          "◇  Ready (probe-gemini-t6)",
          "/tmp/p",
          HOST,
        ),
      ).toBeNull();
    });

    it("has no summary for a custom agent", () => {
      expect(
        summaryFromPaneTitle("my-agent", "Doing a thing", "/tmp/p", HOST),
      ).toBeNull();
    });
  });

  describe("absent input", () => {
    it("reads null, empty and whitespace-only titles as no summary", () => {
      // gemini emits "" during boot.
      expect(summaryFromPaneTitle("claude", null, "/tmp/p", HOST)).toBeNull();
      expect(summaryFromPaneTitle("claude", "", "/tmp/p", HOST)).toBeNull();
      expect(summaryFromPaneTitle("claude", "   ", "/tmp/p", HOST)).toBeNull();
      expect(summaryFromPaneTitle("claude", "✳ ", "/tmp/p", HOST)).toBeNull();
    });

    it("reads an unknown agent type as no summary", () => {
      expect(
        summaryFromPaneTitle(null, "✳ Anything", "/tmp/p", HOST),
      ).toBeNull();
    });
  });

  describe("rule hygiene", () => {
    it("never uses a global regex, whose lastIndex would leak between calls", () => {
      // Every rule, not just the one below: `exec` on a `/g` regex advances
      // `lastIndex`, so such a rule answers correctly once and then
      // intermittently null. The `empty` patterns run through `test`, which
      // has the same hazard.
      for (const agent of BUILTIN_AGENTS) {
        const rule = agent.summaryTitle;
        if (!rule) continue;
        expect([agent.name, rule.match.global]).toEqual([agent.name, false]);
        for (const re of rule.empty ?? []) {
          expect([agent.name, re.source, re.global]).toEqual([
            agent.name,
            re.source,
            false,
          ]);
        }
      }
      // And the behavior the guard protects, on a repeat call.
      const claude = (title: string) =>
        summaryFromPaneTitle("claude", title, "/tmp/p", HOST);
      for (let i = 0; i < 5; i++) {
        expect(claude("✳ Wire up the summary column")).toBe(
          "Wire up the summary column",
        );
      }
    });
  });
});
