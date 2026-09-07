import { describe, it, expect } from "bun:test";
import { isCodexHooksEnabled, ensureCodexHooksEnabled } from "./toml";

describe("isCodexHooksEnabled", () => {
  it("returns false for empty content", () => {
    expect(isCodexHooksEnabled("")).toBe(false);
  });

  it("returns false when there is no [features] section", () => {
    expect(isCodexHooksEnabled(`model = "o3"\n`)).toBe(false);
  });

  it("returns false when [features] has no codex_hooks key", () => {
    expect(isCodexHooksEnabled(`[features]\nother = true\n`)).toBe(false);
  });

  it("returns false when codex_hooks = false", () => {
    expect(isCodexHooksEnabled(`[features]\ncodex_hooks = false\n`)).toBe(
      false,
    );
  });

  it("returns true when codex_hooks = true", () => {
    expect(isCodexHooksEnabled(`[features]\ncodex_hooks = true\n`)).toBe(true);
  });

  it("tolerates whitespace around the section name", () => {
    expect(isCodexHooksEnabled(`[ features ]\ncodex_hooks = true\n`)).toBe(
      true,
    );
  });

  it("tolerates comments next to the key", () => {
    expect(
      isCodexHooksEnabled(`[features]\ncodex_hooks = true # on for testing\n`),
    ).toBe(true);
  });

  it("tolerates leading whitespace and trailing comment on the header", () => {
    expect(
      isCodexHooksEnabled(`  [features]  # enable hooks\ncodex_hooks = true\n`),
    ).toBe(true);
  });

  it("is not confused by [features.something] nested sections", () => {
    expect(
      isCodexHooksEnabled(`[features.experimental]\ncodex_hooks = true\n`),
    ).toBe(false);
  });

  it("is not confused by [[features]] array-of-tables", () => {
    expect(isCodexHooksEnabled(`[[features]]\ncodex_hooks = true\n`)).toBe(
      false,
    );
  });

  it("stops scanning the section at the next header", () => {
    const content = `[features]\n[other]\ncodex_hooks = true\n`;
    expect(isCodexHooksEnabled(content)).toBe(false);
  });

  it("ignores a commented-out key inside the section", () => {
    expect(isCodexHooksEnabled(`[features]\n# codex_hooks = true\n`)).toBe(
      false,
    );
  });

  it("recognizes the renamed `hooks` flag (Codex 0.124+)", () => {
    expect(isCodexHooksEnabled(`[features]\nhooks = true\n`)).toBe(true);
  });

  it("returns false when the renamed `hooks` flag is false", () => {
    expect(isCodexHooksEnabled(`[features]\nhooks = false\n`)).toBe(false);
  });

  it("treats `hooks = true` alongside other keys as enabled", () => {
    const input = `[features]\nhooks = true\nmulti_agent = true\n`;
    expect(isCodexHooksEnabled(input)).toBe(true);
  });

  it("ORs across both key names: stale `codex_hooks = false` + `hooks = true`", () => {
    const input = `[features]\ncodex_hooks = false\nhooks = true\n`;
    expect(isCodexHooksEnabled(input)).toBe(true);
  });

  it("ORs across both key names: `hooks = false` + `codex_hooks = true`", () => {
    const input = `[features]\nhooks = false\ncodex_hooks = true\n`;
    expect(isCodexHooksEnabled(input)).toBe(true);
  });

  it("returns false when both keys are false", () => {
    const input = `[features]\ncodex_hooks = false\nhooks = false\n`;
    expect(isCodexHooksEnabled(input)).toBe(false);
  });
});

describe("ensureCodexHooksEnabled", () => {
  it("creates a minimal file when content is empty", () => {
    expect(ensureCodexHooksEnabled("")).toBe("[features]\nhooks = true\n");
  });

  it("appends a [features] section when none exists", () => {
    const input = `model = "o3"\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(`model = "o3"\n\n[features]\nhooks = true\n`);
  });

  it("appends correctly even when the original content has no trailing newline", () => {
    const input = `model = "o3"`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(`model = "o3"\n\n[features]\nhooks = true\n`);
  });

  it("does not double up blank lines when content already ends with a blank line", () => {
    const input = `model = "o3"\n\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(`model = "o3"\n\n[features]\nhooks = true\n`);
  });

  it("inserts the key after the header when [features] exists without it", () => {
    const input = `[features]\nother = true\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(`[features]\nhooks = true\nother = true\n`);
  });

  it("flips codex_hooks = false to true in place", () => {
    const input = `[features]\ncodex_hooks = false\nother = true\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(`[features]\ncodex_hooks = true\nother = true\n`);
  });

  it("preserves trailing comments when flipping false to true", () => {
    const input = `[features]\ncodex_hooks = false # leave off for now\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(`[features]\ncodex_hooks = true # leave off for now\n`);
  });

  it("returns content unchanged when codex_hooks is already true", () => {
    const input = `# top comment\n[features]\ncodex_hooks = true\n`;
    expect(ensureCodexHooksEnabled(input)).toBe(input);
  });

  it("preserves comments above the [features] header when inserting", () => {
    const input = `# user notes\nmodel = "o3"\n\n[features]\nother = true\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(
      `# user notes\nmodel = "o3"\n\n[features]\nhooks = true\nother = true\n`,
    );
  });

  it("does not touch unrelated sections when inserting into [features]", () => {
    const input = `[providers.openai]\nmodel = "o3"\n\n[features]\nother = true\n\n[logging]\nlevel = "debug"\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(
      `[providers.openai]\nmodel = "o3"\n\n[features]\nhooks = true\nother = true\n\n[logging]\nlevel = "debug"\n`,
    );
  });

  it("inserts in the real [features] block and not a nested [features.experimental]", () => {
    const input = `[features.experimental]\nfoo = true\n\n[features]\nbar = true\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(
      `[features.experimental]\nfoo = true\n\n[features]\nhooks = true\nbar = true\n`,
    );
  });

  it("produces a no-section-yet file when content is only blank lines", () => {
    const input = "\n\n";
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe("[features]\nhooks = true\n");
  });

  it("is idempotent across repeat calls", () => {
    let out = ensureCodexHooksEnabled("");
    out = ensureCodexHooksEnabled(out);
    out = ensureCodexHooksEnabled(out);
    expect(out).toBe("[features]\nhooks = true\n");
  });

  it("leaves existing `hooks = true` (Codex 0.124+) untouched", () => {
    const input = `[features]\nhooks = true\n`;
    expect(ensureCodexHooksEnabled(input)).toBe(input);
  });

  it("flips `hooks = false` to `hooks = true` in place", () => {
    const input = `[features]\nhooks = false\nmulti_agent = true\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(`[features]\nhooks = true\nmulti_agent = true\n`);
  });

  it("leaves dual keys untouched when at least one is already true", () => {
    const input = `[features]\ncodex_hooks = false\nhooks = true\n`;
    expect(ensureCodexHooksEnabled(input)).toBe(input);
  });

  it("leaves dual keys untouched when the legacy key is true", () => {
    const input = `[features]\nhooks = false\ncodex_hooks = true\n`;
    expect(ensureCodexHooksEnabled(input)).toBe(input);
  });

  it("flips only the first false key when both keys are false", () => {
    const input = `[features]\ncodex_hooks = false\nhooks = false\n`;
    const output = ensureCodexHooksEnabled(input);
    expect(output).toBe(`[features]\ncodex_hooks = true\nhooks = false\n`);
  });

  it("writes the modern `hooks` name, never the deprecated `codex_hooks`", () => {
    // Current Codex warns on `codex_hooks`, so a fresh install must not
    // author it. Applies to every insertion path, not just the empty file.
    const inputs = ["", "\n\n", `model = "o3"`, `[features]\nother = true\n`];
    for (const input of inputs) {
      const output = ensureCodexHooksEnabled(input);
      expect(output).toContain("hooks = true");
      expect(output).not.toContain("codex_hooks");
    }
  });
});
