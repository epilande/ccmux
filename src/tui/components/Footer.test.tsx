import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { Footer, fitHints, defaultHints } from "./Footer";
import { DEFAULT_GROUP_BY, type GroupBy } from "../../lib/preferences";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderFooter(props: {
  searchMode?: boolean;
  confirmMode?: boolean;
  helpMode?: boolean;
  previewFocused?: boolean;
  persistent?: boolean;
  groupBy?: GroupBy;
  newSessionMode?: boolean;
  newSessionOption?: "focused" | "dropdown";
  handoffPickMode?: boolean;
  reviewable?: boolean;
  width?: number;
}) {
  setup = await testRender(
    () => (
      <Footer
        searchMode={props.searchMode ?? false}
        confirmMode={props.confirmMode}
        helpMode={props.helpMode}
        previewFocused={props.previewFocused}
        persistent={props.persistent}
        groupBy={props.groupBy}
        newSessionMode={props.newSessionMode}
        newSessionOption={props.newSessionOption}
        handoffPickMode={props.handoffPickMode}
        reviewable={props.reviewable}
      />
    ),
    { width: props.width ?? 120, height: 4 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("Footer", () => {
  it("renders default mode help text", async () => {
    const frame = await renderFooter({});
    expect(frame).toContain("j/k");
    expect(frame).toContain("enter");
    expect(frame).toContain("/ search");
    expect(frame).toContain("? help");
    expect(frame).toContain("q quit");
  });

  it("renders search mode help text", async () => {
    const frame = await renderFooter({ searchMode: true });
    expect(frame).toContain("type to search");
    expect(frame).toContain("esc cancel");
  });

  it("renders confirm mode help text", async () => {
    const frame = await renderFooter({ confirmMode: true });
    expect(frame).toContain("y confirm");
    expect(frame).toContain("cancel");
  });

  it("renders help mode dismiss text", async () => {
    const frame = await renderFooter({ helpMode: true });
    expect(frame).toContain("? or Esc close");
  });

  it("renders preview focused help text", async () => {
    const frame = await renderFooter({ previewFocused: true });
    expect(frame).toContain("exit focus");
    expect(frame).toContain("keys sent to pane");
  });

  it("shows switch label when persistent", async () => {
    const frame = await renderFooter({ persistent: true });
    expect(frame).toContain("switch");
  });

  it("shows select label when not persistent", async () => {
    const frame = await renderFooter({ persistent: false });
    expect(frame).toContain("select");
  });

  it("shows current groupBy mode", async () => {
    const frame = await renderFooter({ groupBy: "cwd" });
    expect(frame).toContain("group:cwd");
  });

  it("shows default groupBy when none specified", async () => {
    const frame = await renderFooter({});
    expect(frame).toContain(`group:${DEFAULT_GROUP_BY}`);
  });

  it("help mode takes priority over search mode", async () => {
    const frame = await renderFooter({ helpMode: true, searchMode: true });
    expect(frame).toContain("? or Esc close");
    expect(frame).not.toContain("type to search");
  });

  it("confirm mode takes priority over search mode", async () => {
    const frame = await renderFooter({ confirmMode: true, searchMode: true });
    expect(frame).toContain("y confirm");
    expect(frame).not.toContain("type to search");
  });

  it("shows the review hint when reviewable", async () => {
    const frame = await renderFooter({ reviewable: true });
    expect(frame).toContain("d review");
  });

  it("omits the review hint when not reviewable", async () => {
    const frame = await renderFooter({ reviewable: false });
    expect(frame).not.toContain("d review");
  });

  it("shows the new-session hints in newSessionMode", async () => {
    const frame = await renderFooter({ newSessionMode: true });
    expect(frame).toContain("enter spawn");
    expect(frame).toContain("tab field");
    expect(frame).toContain("esc cancel");
  });

  it("teaches the dropdown opener while an option field is focused", async () => {
    const frame = await renderFooter({
      newSessionMode: true,
      newSessionOption: "focused",
    });
    expect(frame).toContain("space open");
    expect(frame).toContain("enter spawn");
  });

  it("swaps to the dropdown's own keys while it is open", async () => {
    const frame = await renderFooter({
      newSessionMode: true,
      newSessionOption: "dropdown",
    });
    expect(frame).toContain("j/k move");
    expect(frame).toContain("enter/space select");
    expect(frame).toContain("esc cancel");
    // The dialog's keys are not in effect, so their hints are gone.
    expect(frame).not.toContain("spawn");
    expect(frame).not.toContain("tab next field");
  });

  it("new-session mode takes priority over search mode", async () => {
    // Reachable: right-clicking a row while searching offers "New session
    // here", which opens the dialog with search mode still on.
    const frame = await renderFooter({
      newSessionMode: true,
      searchMode: true,
    });
    expect(frame).toContain("enter spawn");
    expect(frame).not.toContain("type to search");
  });

  it("shows what the keys do while a handoff is being aimed", async () => {
    const frame = await renderFooter({ handoffPickMode: true });
    expect(frame).toContain("j/k pick target");
    expect(frame).toContain("enter hand off");
    expect(frame).toContain("esc cancel");
  });

  it("handoff picking takes priority over search mode", async () => {
    // Reachable: right-clicking a row while searching offers the handoff, and
    // the pick then runs over the filtered list with search still on.
    const frame = await renderFooter({
      handoffPickMode: true,
      searchMode: true,
    });
    expect(frame).toContain("enter hand off");
    expect(frame).not.toContain("type to search");
  });

  it("confirm mode takes priority over new-session mode", async () => {
    const frame = await renderFooter({
      confirmMode: true,
      newSessionMode: true,
    });
    expect(frame).toContain("y confirm");
    expect(frame).not.toContain("enter spawn");
  });

  it("keeps the whole default line inside a 120-column terminal", async () => {
    // The line grew past 120 when `n new` was added (121 characters at
    // group:project with the review hint), which clipped `quit`.
    const frame = await renderFooter({
      width: 120,
      groupBy: "project",
      reviewable: true,
    });
    expect(frame).toContain("? help");
    expect(frame).toContain("q quit");
    const widest = Math.max(
      ...frame.split("\n").map((line) => line.trimEnd().length),
    );
    expect(widest).toBeLessThanOrEqual(120);
  });

  it("keeps the exits when a narrow terminal drops the rest", async () => {
    const frame = await renderFooter({ width: 40, reviewable: true });
    expect(frame).toContain("? help");
    expect(frame).toContain("q quit");
    expect(frame).not.toContain("r restart");
  });
});

describe("fitHints", () => {
  const hints = () =>
    defaultHints({ groupBy: "project", reviewable: true, persistent: false });

  it("returns every hint when they all fit", () => {
    const full = fitHints(hints(), 500);
    for (const segment of hints()) {
      expect(full).toContain(segment.text);
    }
  });

  it("never exceeds the width it is given", () => {
    for (let width = 8; width <= 130; width++) {
      expect(fitHints(hints(), width).length).toBeLessThanOrEqual(
        Math.max(width, "q quit".length),
      );
    }
  });

  it("drops the lowest-ranked hints first and keeps the exits longest", () => {
    // `? help` and `q quit` are how a stuck user gets out, so they outlive
    // every view toggle no matter how narrow the terminal gets.
    for (let width = 20; width <= 118; width++) {
      const line = fitHints(hints(), width);
      expect(line).toContain("? help");
      expect(line).toContain("q quit");
    }
    // The view toggles are among the first to go.
    const tight = fitHints(hints(), 60);
    expect(tight).not.toContain("P preview");
  });

  it("gives up the hints the row menu also teaches first", () => {
    // `r` and `x` are named on the row itself by the `m` menu, so the footer
    // stops teaching them before it gives up a mode with no other home
    // (`/ search`) or the only advertisement the review integration has
    // (`d review`). Widths, not ranks, because the rank scale is an
    // implementation detail and the drop ORDER is the behaviour.
    const dropped = (width: number) =>
      hints()
        .map((segment) => segment.text)
        .filter((text) => !fitHints(hints(), width).includes(text));

    // The first column the line has to give up takes the Worktrees pointer
    // (the panel it opens teaches its own keys), the next takes Kill, and the
    // one after that Restart. (Listed in display order, which is what the
    // helper reads them off in — Restart sits left of Kill on the line, and
    // both sit left of Worktrees.)
    expect(dropped(132)).toEqual(["W worktrees"]);
    expect(dropped(118)).toEqual(["x kill", "W worktrees"]);
    expect(dropped(106)).toEqual(["r restart", "x kill", "W worktrees"]);
    // Both gone while everything they were ranked against is still there.
    const line = fitHints(hints(), 106);
    expect(line).toContain("/ search");
    expect(line).toContain("d review");
    expect(line).toContain("P preview");
    expect(line).toContain("b group:project");
  });

  it("keeps the two view toggles longer than the two menu-backed actions", () => {
    // The tie-break inside rank 1 is positional, so this is the assertion
    // that would catch a reshuffle of `defaultHints` silently reversing it.
    const line = fitHints(hints(), 100);
    expect(line).not.toContain("x kill");
    expect(line).not.toContain("r restart");
    expect(line).toContain("P preview");
    expect(line).toContain("b group:project");
  });

  it("drops whole hints rather than truncating mid-word", () => {
    const line = fitHints(hints(), 60);
    for (const part of line.split(" · ")) {
      expect(hints().some((segment) => segment.text === part)).toBe(true);
    }
  });

  it("keeps display order regardless of what was dropped", () => {
    const line = fitHints(hints(), 70);
    const order = hints().map((segment) => segment.text);
    const shown = line.split(" · ");
    const positions = shown.map((text) => order.indexOf(text));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps at least one hint even at an absurd width", () => {
    expect(fitHints(hints(), 1)).toBe("q quit");
  });
});
