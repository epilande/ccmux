import { describe, it, expect, afterEach } from "bun:test";
import { applyTheme, resetTheme } from "../theme";
import { catppuccinLatte } from "../themes/catppuccin-latte";
import { catppuccinMocha } from "../themes/catppuccin-mocha";
import { dotColor } from "./Header";
import { invokeColor } from "./InvokeStatusBadge";
import { agentColorFor, prStateColor } from "./SessionItem";

/**
 * Guard against the import-time freeze bug: these four resolvers used to be
 * module-scope const objects that captured `theme.*` by value at import, so they
 * ignored `applyTheme` and rendered the default palette under every theme.
 * Asserting the function output follows the live theme (the same precedent as
 * getStatusColor in StatusBadge.test) catches any regression back to a frozen
 * capture. captureCharFrame is text-only, so a rendered frame can't assert the
 * color directly; the resolver is the meaningful seam.
 */
afterEach(() => resetTheme());

describe("module-scope color resolvers follow the active theme", () => {
  it("Header dot color", () => {
    applyTheme("catppuccin-latte");
    expect(dotColor("connected")).toBe(catppuccinLatte.semantic.green);
    resetTheme();
    expect(dotColor("connected")).toBe(catppuccinMocha.semantic.green);
  });

  it("InvokeStatusBadge color", () => {
    applyTheme("catppuccin-latte");
    expect(invokeColor("running")).toBe(catppuccinLatte.semantic.peach);
    expect(invokeColor("succeeded")).toBe(catppuccinLatte.semantic.green);
  });

  it("SessionItem agent + PR colors", () => {
    applyTheme("catppuccin-latte");
    expect(agentColorFor("claude")).toBe(catppuccinLatte.semantic.peach);
    expect(agentColorFor("unknown-agent")).toBe(
      catppuccinLatte.semantic.overlay,
    );
    expect(agentColorFor("copilot")).toBe(catppuccinLatte.semantic.mauve);
    expect(agentColorFor("antigravity")).toBe(catppuccinLatte.semantic.blue);
    expect(agentColorFor("cursor")).toBe(catppuccinLatte.semantic.rosewater);
    expect(prStateColor("red")).toBe(catppuccinLatte.semantic.red);
    expect(prStateColor("none")).toBe(catppuccinLatte.semantic.mauve);
  });
});
