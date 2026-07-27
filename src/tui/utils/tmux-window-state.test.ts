import { describe, it, expect } from "bun:test";
import { UNKNOWN_WINDOW_STATE, parseWindowState } from "./tmux-window-state";
import { PANE_FIELD_SEP } from "../../lib/tmux-format";

describe("parseWindowState", () => {
  it("decodes width, active flag, and attached client count", () => {
    expect(parseWindowState(["200", "1", "2"].join(PANE_FIELD_SEP))).toEqual({
      windowWidth: 200,
      windowActive: true,
      sessionAttached: true,
    });
    expect(parseWindowState(["80", "0", "0"].join(PANE_FIELD_SEP))).toEqual({
      windowWidth: 80,
      windowActive: false,
      sessionAttached: false,
    });
  });

  it("returns unknown state for truncated or garbage output", () => {
    expect(parseWindowState("")).toEqual(UNKNOWN_WINDOW_STATE);
    expect(parseWindowState(["200", "1"].join(PANE_FIELD_SEP))).toEqual(
      UNKNOWN_WINDOW_STATE,
    );
    expect(parseWindowState(["x", "y", "z"].join(PANE_FIELD_SEP))).toEqual(
      UNKNOWN_WINDOW_STATE,
    );
  });
});
