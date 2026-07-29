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
    expect(frame).toContain("tab next field");
    expect(frame).toContain("esc cancel");
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
    // The view toggles are the first to go.
    const tight = fitHints(hints(), 60);
    expect(tight).not.toContain("P preview");
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
