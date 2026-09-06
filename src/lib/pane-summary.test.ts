import { describe, expect, it } from "bun:test";
import { summaryFromPaneTitle } from "./pane-summary";

/**
 * The per-agent rule table from issue #183's survey. Every case below is a
 * real pane title one of the built-ins wrote on an isolated tmux server.
 */
describe("summaryFromPaneTitle", () => {
  describe("claude", () => {
    const claude = (title: string | null) =>
      summaryFromPaneTitle("claude", title, "/tmp/probe-claude");

    it("strips the idle glyph from the generated summary", () => {
      expect(claude("✳ Add dark mode toggle to settings")).toBe(
        "Add dark mode toggle to settings",
      );
    });

    it("strips the braille spinner shown while working", () => {
      expect(claude("⠂ cache-invalidation-fix")).toBe("cache-invalidation-fix");
      expect(claude("⣾ Fix pagination off-by-one")).toBe(
        "Fix pagination off-by-one",
      );
    });

    it("keeps digits and punctuation inside the summary", () => {
      expect(claude("✳ 3 failing tests in parser/")).toBe(
        "3 failing tests in parser/",
      );
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

  describe("copilot", () => {
    const copilot = (title: string | null) =>
      summaryFromPaneTitle("copilot", title, "/tmp/probe-copilot");

    it("strips the app-name suffix", () => {
      expect(copilot("Implement Hello Function - GitHub Copilot")).toBe(
        "Implement Hello Function",
      );
    });

    it("reads the bare app name as no summary", () => {
      expect(copilot("GitHub Copilot")).toBeNull();
    });

    it("reads a title without the suffix as no summary", () => {
      expect(copilot("Mac")).toBeNull();
    });
  });

  describe("cursor", () => {
    const cursor = (title: string | null) =>
      summaryFromPaneTitle("cursor", title, "/tmp/probe-cursor");

    it("takes the bare summary, which cursor writes unadorned", () => {
      expect(cursor("Hello Bot")).toBe("Hello Bot");
    });

    it("reads the app name it shows before the first turn as no summary", () => {
      expect(cursor("Cursor Agent")).toBeNull();
    });
  });

  describe("omp", () => {
    const omp = (title: string | null, cwd = "/tmp/probe-omp-w5") =>
      summaryFromPaneTitle("omp", title, cwd);

    it("strips the prompt prefix", () => {
      expect(omp("π > Say hello and nothing else")).toBe(
        "Say hello and nothing else",
      );
    });

    it("strips the spinner frame shown while working", () => {
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

  describe("agents with no rule", () => {
    it("has no summary for codex, pi, gemini or opencode", () => {
      expect(summaryFromPaneTitle("codex", "probe-codex-x7", "/tmp/p")).toBeNull();
      expect(summaryFromPaneTitle("codex", "⠏ probe-codex-x7", "/tmp/p")).toBeNull();
      expect(summaryFromPaneTitle("pi", "π - probe-pi-z3", "/tmp/p")).toBeNull();
      expect(
        summaryFromPaneTitle("gemini", "◇  Ready (probe-gemini-t6)", "/tmp/p"),
      ).toBeNull();
      expect(summaryFromPaneTitle("opencode", "OpenCode", "/tmp/p")).toBeNull();
    });

    it("has no summary for a custom agent", () => {
      expect(summaryFromPaneTitle("my-agent", "Doing a thing", "/tmp/p")).toBeNull();
    });
  });

  describe("absent input", () => {
    it("reads null, empty and whitespace-only titles as no summary", () => {
      // gemini emits "" during boot.
      expect(summaryFromPaneTitle("claude", null, "/tmp/p")).toBeNull();
      expect(summaryFromPaneTitle("claude", "", "/tmp/p")).toBeNull();
      expect(summaryFromPaneTitle("claude", "   ", "/tmp/p")).toBeNull();
      expect(summaryFromPaneTitle("claude", "✳ ", "/tmp/p")).toBeNull();
    });

    it("reads an unknown agent type as no summary", () => {
      expect(summaryFromPaneTitle(null, "✳ Anything", "/tmp/p")).toBeNull();
    });
  });
});
