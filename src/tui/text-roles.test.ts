import { afterEach, describe, expect, it } from "bun:test";
import { applyTheme, resetTheme, theme } from "./theme";
import { BUILTIN_THEME_NAMES } from "./themes";
import { MIN_TEXT_CONTRAST, TEXT_ROLES, contrastRatio } from "./text-roles";

afterEach(() => resetTheme());

const ROLES = Object.entries(TEXT_ROLES);

/** The roles that are secondary text: dimmed wherever the theme allows. */
const QUIET = [
  "groupMarker",
  "groupMarkerSelected",
  "groupSources",
  "renameTitle",
  "renameHint",
  "renameCount",
  "toast",
] as const;

describe("text roles", () => {
  // The user's two reference themes: every role must read at WCAG AA.
  describe.each(["catppuccin-latte", "catppuccin-mocha"])("%s", (name) => {
    it.each(ROLES)("%s reads at 4.5:1 on its background", (_role, role) => {
      applyTheme(name);
      expect(contrastRatio(role.fg(), role.bg())).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
    });
  });

  it("keeps the quiet roles dimmer than body text in mocha", () => {
    applyTheme("catppuccin-mocha");
    for (const key of QUIET) expect(TEXT_ROLES[key].fg()).not.toBe(theme.text);
  });

  it("keeps the accent roles' color where it already reads (mocha)", () => {
    applyTheme("catppuccin-mocha");
    expect(TEXT_ROLES.renameCut.fg()).toBe(theme.peach);
    expect(TEXT_ROLES.renameMerge.fg()).toBe(theme.blue);
  });

  // Every other built-in: AA where the palette can reach it at all. A theme
  // whose own body text is under 4.5:1 on a background (tokyo-night-day's
  // surface) gets body text, the most legible token it has.
  describe.each(BUILTIN_THEME_NAMES)("%s", (name) => {
    it("reads at 4.5:1, or as well as the theme's own text can", () => {
      applyTheme(name);
      for (const [, role] of ROLES) {
        const ratio = contrastRatio(role.fg(), role.bg());
        if (ratio < MIN_TEXT_CONTRAST) expect(role.fg()).toBe(theme.text);
      }
    });
  });
});
