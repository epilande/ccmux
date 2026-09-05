import { describe, expect, it } from "bun:test";
import { join } from "path";
import {
  findLegacyPopupBindings,
  RECOMMENDED_POPUP_BINDING,
} from "./popup-binding-check";

/**
 * Every fixture below is a verbatim `tmux list-keys` line, captured from tmux
 * 3.6a on a scratch server after binding the shape it names. tmux re-quotes what
 * the user typed (a bare `"ccmux"` loses its quotes, a `run-shell -C` wrapper
 * escapes the inner ones, `-n` becomes `-T root`), so a hand-written fixture
 * would test a shape that never reaches the checker.
 */
const OLD_README_FORM = String.raw`bind-key    -T prefix       C-p                       run-shell -C "display-popup -E -w 80% -h 75% \"ccmux\""`;
const OLD_BARE_FORM = String.raw`bind-key    -T prefix       C-o                       display-popup -E -h "75%" -w "80%" ccmux`;
const OLD_ROOT_TABLE_FORM = String.raw`bind-key    -T root         M-p                       run-shell -C "display-popup -E -w 80% -h 75% \"ccmux\""`;
const OLD_ABSOLUTE_PATH_FORM = String.raw`bind-key    -T prefix       C-g                       run-shell -C "display-popup -E \"/opt/homebrew/bin/ccmux\""`;
const OLD_REPEAT_FLAG_FORM = String.raw`bind-key -r -T prefix       C-q                       run-shell -C "display-popup -E \"ccmux\""`;
const ENV_FORM = String.raw`bind-key    -T prefix       C-e                       run-shell -C "display-popup -c \"#{client_tty}\" -e \"CCMUX_CLIENT_TTY=#{client_tty}\" -E -w 80% -h 75% \"ccmux\""`;
const ARGUMENT_FORM = String.raw`bind-key    -T prefix       C-y                       run-shell -C "display-popup -E -w 80% -h 75% \"ccmux --client-tty #{client_tty}\""`;
const SIDEBAR_POPUP = String.raw`bind-key    -T prefix       C-s                       display-popup -E -h "75%" -w "80%" "ccmux sidebar"`;
const OTHER_POPUP = String.raw`bind-key    -T prefix       C-h                       display-popup -E htop`;
const UNRELATED = String.raw`bind-key    -T prefix       c                         new-window`;

function keys(output: string): string[] {
  return findLegacyPopupBindings(output).map((binding) => binding.key ?? "?");
}

describe("findLegacyPopupBindings", () => {
  it("flags the old README run-shell form", () => {
    const found = findLegacyPopupBindings(OLD_README_FORM);
    expect(found).toHaveLength(1);
    expect(found[0].table).toBe("prefix");
    expect(found[0].key).toBe("C-p");
    expect(found[0].line).toBe(OLD_README_FORM);
    expect(found[0].command).toBe(
      String.raw`run-shell -C "display-popup -E -w 80% -h 75% \"ccmux\""`,
    );
  });

  it("flags the bare display-popup form", () => {
    expect(keys(OLD_BARE_FORM)).toEqual(["C-o"]);
  });

  it("flags a root-table (-n) binding, which tmux prints as -T root", () => {
    const found = findLegacyPopupBindings(OLD_ROOT_TABLE_FORM);
    expect(found).toHaveLength(1);
    expect(found[0].table).toBe("root");
    expect(found[0].key).toBe("M-p");
  });

  it("flags a binding that names ccmux by absolute path", () => {
    expect(keys(OLD_ABSOLUTE_PATH_FORM)).toEqual(["C-g"]);
  });

  it("reads the key past a -r flag", () => {
    const found = findLegacyPopupBindings(OLD_REPEAT_FLAG_FORM);
    expect(found).toHaveLength(1);
    expect(found[0].table).toBe("prefix");
    expect(found[0].key).toBe("C-q");
  });

  it("accepts the CCMUX_CLIENT_TTY env form from #180", () => {
    expect(findLegacyPopupBindings(ENV_FORM)).toEqual([]);
  });

  it("accepts the --client-tty argument form", () => {
    expect(findLegacyPopupBindings(ARGUMENT_FORM)).toEqual([]);
  });

  it("ignores a sidebar popup, which switches no client", () => {
    expect(findLegacyPopupBindings(SIDEBAR_POPUP)).toEqual([]);
  });

  it("ignores popups that do not run ccmux", () => {
    expect(findLegacyPopupBindings(OTHER_POPUP)).toEqual([]);
  });

  it("ignores bindings that open no popup", () => {
    expect(findLegacyPopupBindings(UNRELATED)).toEqual([]);
  });

  it("returns nothing for empty output", () => {
    expect(findLegacyPopupBindings("")).toEqual([]);
  });

  it("picks the offenders out of a full listing", () => {
    const listing = [
      UNRELATED,
      ENV_FORM,
      OLD_ABSOLUTE_PATH_FORM,
      OTHER_POPUP,
      OLD_BARE_FORM,
      OLD_README_FORM,
      SIDEBAR_POPUP,
      ARGUMENT_FORM,
      OLD_ROOT_TABLE_FORM,
      "",
    ].join("\n");
    expect(keys(listing)).toEqual(["C-g", "C-o", "C-p", "M-p"]);
  });
});

/** `RECOMMENDED_POPUP_BINDING` after tmux has parsed and reprinted it, i.e.
 *  what `list-keys` shows for the binding README tells people to write. */
const RECOMMENDED_AS_LIST_KEYS = String.raw`bind-key    -T prefix       C-p                       run-shell -C "display-popup -E -w 80% -h 75% \"ccmux --client-tty #{client_tty}\""`;

describe("RECOMMENDED_POPUP_BINDING", () => {
  it("matches the binding README documents", async () => {
    const readme = await Bun.file(
      join(import.meta.dir, "..", "..", "README.md"),
    ).text();
    expect(readme).toContain(RECOMMENDED_POPUP_BINDING);
  });

  it("is a binding the checker itself accepts", () => {
    // Fed in the shape `list-keys` prints it back, since that is the only text
    // the checker ever sees: the config-file form has no `-T <table>` and would
    // pass through the unparsed-line fallback instead of the real path.
    expect(findLegacyPopupBindings(RECOMMENDED_AS_LIST_KEYS)).toEqual([]);
  });
});
