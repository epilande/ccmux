import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { Footer, fitHints, footerHints, hintLine } from "./Footer";
import { ACTIONS } from "../actions";
import { RGBA } from "@opentui/core";
import { theme } from "../theme";
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

  it("draws its hints in subtext, which stays legible on light themes", async () => {
    await renderFooter({});
    const line = setup
      .captureSpans()
      .lines.flatMap((l) => l.spans)
      .find((span) => span.text.includes("q quit"));
    expect(line?.fg.toInts()).toEqual(RGBA.fromHex(theme.subtext).toInts());
  });

  it("glosses enter with the same verb as every other view", async () => {
    const frame = await renderFooter({});
    expect(frame).toContain("enter go");
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
    // Rank 1: it is on the line once every hint fits.
    const frame = await renderFooter({ reviewable: true, width: 200 });
    expect(frame).toContain("d/D review");
  });

  it("omits the review hint when not reviewable", async () => {
    const frame = await renderFooter({ reviewable: false });
    expect(frame).not.toContain("d/D review");
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
    expect(frame).toContain("enter continue");
    expect(frame).toContain("esc cancel");
  });

  it("handoff picking takes priority over search mode", async () => {
    // Reachable: right-clicking a row while searching offers the handoff, and
    // the pick then runs over the filtered list with search still on.
    const frame = await renderFooter({
      handoffPickMode: true,
      searchMode: true,
    });
    expect(frame).toContain("enter continue");
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

describe("footerHints", () => {
  const VIEWS = ["sessions", "worktrees", "start"] as const;
  const texts = (view: (typeof VIEWS)[number]) =>
    footerHints(view, { groupBy: "project", reviewable: true }).map(
      (segment) => segment.text,
    );
  const keyOf = (text: string) => text.split(" ")[0]!;

  it("lists every view's hints in the registry's order", () => {
    const order = ACTIONS.flatMap((action) =>
      "hint" in action ? [action.hint.key] : [],
    );
    for (const view of VIEWS) {
      const keys = texts(view).map(keyOf);
      const positions = keys.map((key) => (order as string[]).indexOf(key));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it("uses one verb per key everywhere, except where the key differs by view", () => {
    const verbs = new Map<string, Set<string>>();
    for (const view of VIEWS)
      for (const text of texts(view)) {
        const key = keyOf(text);
        verbs.set(key, (verbs.get(key) ?? new Set()).add(text));
      }
    for (const [key, seen] of verbs) {
      if (key === "x" || key === "q") continue;
      expect([key, seen.size]).toEqual([key, 1]);
    }
    expect(texts("sessions")).toContain("x kill");
    expect(texts("worktrees")).toContain("x remove");
    expect(texts("sessions")).toContain("q quit");
    expect(texts("start")).toContain("q back");
  });

  it("teaches each view the keys it handles", () => {
    expect(texts("sessions")).toEqual([
      "j/k nav",
      "h/l views",
      "enter go",
      "s scope",
      "/ search",
      "space mark",
      "x kill",
      "n new",
      "N start",
      "W worktrees",
      "r restart",
      "R refresh",
      "d/D review",
      "b group:project",
      "P preview",
      "? help",
      "q quit",
    ]);
    expect(texts("worktrees")).not.toContain("/ search");
    expect(texts("worktrees")).not.toContain("P preview");
    expect(texts("start")).toContain("/ search");
    expect(texts("start")).not.toContain("b group:project");
    expect(
      footerHints("sessions", { reviewable: false }).map((s) => s.text),
    ).not.toContain("d/D review");
  });

  it("keeps the sidebar's session list to the keys it has", () => {
    const sidebar = footerHints("sessions", { sidebar: true }).map(
      (s) => s.text,
    );
    expect(sidebar).not.toContain("h/l views");
    expect(sidebar).not.toContain("P preview");
  });
});

describe("fitHints", () => {
  const hints = (view: "sessions" | "worktrees" | "start" = "sessions") =>
    footerHints(view, { groupBy: "project", reviewable: true });
  const PINNED_TEXT = {
    sessions: ["h/l views", "s scope", "? help", "q quit"],
    worktrees: ["h/l views", "s scope", "? help", "q back"],
    start: ["h/l views", "s scope", "? help", "q back"],
  };

  it("returns every hint when they all fit", () => {
    const full = fitHints(hints(), 500);
    for (const segment of hints()) {
      expect(full).toContain(segment.text);
    }
  });

  it("never drops views, scope, help or quit, in any view, at any width", () => {
    for (const view of ["sessions", "worktrees", "start"] as const)
      for (let width = 40; width <= 200; width++) {
        const line = fitHints(hints(view), width);
        expect(line.length).toBeLessThanOrEqual(width);
        for (const text of PINNED_TEXT[view]) expect(line).toContain(text);
      }
  });

  it("shrinks the pinned four to their keys, left first, when they alone overflow", () => {
    // The sidebar overlay's 36 columns: one short of all four words.
    expect(fitHints(hints("worktrees"), 36)).toBe(
      "h/l · s scope · ? help · q back",
    );
    expect(fitHints(hints("worktrees"), 20)).toBe("h/l · s · ? · q back");
    expect(fitHints(hints("worktrees"), 10)).toBe("h/l · s · ? · q");
  });

  it("keeps preview, restart and kill on a 150-column session list", () => {
    const line = fitHints(hints(), 148);
    for (const text of ["P preview", "r restart", "x kill", "N start"])
      expect(line).toContain(text);
    // What a 150-column line gives up: the hints with other homes.
    expect(line).not.toContain("R refresh");
    expect(line).not.toContain("d/D review");
  });

  it("keeps j/k on the Worktrees line", () => {
    const line = fitHints(hints("worktrees"), 118);
    expect(line).toContain("j/k nav");
    expect(line).toContain("q back");
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
});

describe("hintLine", () => {
  it("fits droppable hints around a note that leaves the pinned four whole", () => {
    const { note, hints } = hintLine("worktrees", 120, {
      note: "scanning…",
    });
    expect(note).toBe("scanning…  ");
    expect(hints).toContain("j/k nav");
    expect(hints).toContain("q back");
    expect((note + hints).length).toBeLessThanOrEqual(120);
  });

  it("shrinks the pinned four to keys before cutting a long note", () => {
    const error = "daemon is out of date (restart it: ccmux daemon restart)";
    const { note, hints } = hintLine("start", 88, { note: error });
    expect(note).toBe(`${error}  `);
    expect(hints).toBe("h/l · s · ? help · q back");
  });

  it("truncates a note that does not fit even then, and keeps the keys", () => {
    const { note, hints } = hintLine("start", 50, {
      note: "gh pr list exited 1: no git remotes found in this repository at all",
    });
    expect(note.endsWith("…  ")).toBe(true);
    expect(hints).toBe("h/l · s · ? · q");
    expect((note + hints).length).toBeLessThanOrEqual(50);
  });
});
