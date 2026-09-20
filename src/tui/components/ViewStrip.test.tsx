import { afterEach, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { ViewStrip } from "./ViewStrip";
import type { RepoFacts } from "../../daemon/repo-facts";
import { RGBA } from "@opentui/core";
import { theme } from "../theme";

let setup: Awaited<ReturnType<typeof testRender>>;
afterEach(() => setup?.renderer.destroy());

const hex = (c: string) => RGBA.fromHex(c).toInts();

it("draws a titled rule, marks the active view with the accent stub, and fills counts only when facts arrive", async () => {
  const [facts, setFacts] = createSignal<RepoFacts[]>([
    { repoRoot: "/repo", repoName: "repo" },
  ]);
  setup = await testRender(
    () => (
      <ViewStrip
        view="worktrees"
        scope={null}
        sessions={2}
        facts={facts()}
        onView={() => {}}
      />
    ),
    { width: 96, height: 2 },
  );
  await setup.renderOnce();
  const line = setup.captureCharFrame().split("\n")[0]!;
  expect(line).toContain("── Sessions ·2 ━━ Worktrees ── Start ─");
  expect(line.trimEnd().endsWith(" scope: all repos ──")).toBe(true);
  // The rule runs edge to edge inside the one-column padding.
  expect(line.trimEnd().length).toBe(95);
  const spans = setup.captureSpans().lines[0]!.spans;
  const stub = spans.find((s) => s.text.startsWith("━━"));
  expect(stub?.fg.toInts()).toEqual(hex(theme.blue));
  const active = spans.find((s) => s.text.includes("Worktrees"));
  expect(active?.fg.toInts()).toEqual(hex(theme.text));
  const idle = spans.find((s) => s.text.includes("Sessions"));
  expect(idle?.fg.toInts()).toEqual(hex(theme.subtext));
  // No chip: nothing on the line carries a surface background.
  for (const s of spans) {
    expect(s.bg.toInts()).not.toEqual(hex(theme.surface));
  }
  setFacts([
    {
      repoRoot: "/repo",
      repoName: "repo",
      counts: { value: { prs: 80, issues: 2 }, updatedAt: 1, stale: false },
      worktrees: {
        value: { repoRoot: "/repo", repoName: "repo", worktrees: [] },
        updatedAt: 1,
        stale: false,
      },
    },
  ]);
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Worktrees ·0 ── Start ·82");
  expect(setup.captureCharFrame().split("\n")[1]?.trim()).toBe("");
});

it("scopes totals to the repo and names it, colored, at the right edge", async () => {
  setup = await testRender(
    () => (
      <ViewStrip
        view="start"
        scope="/repo"
        sessions={1}
        facts={[
          {
            repoRoot: "/repo",
            repoName: "repo",
            counts: {
              value: { prs: 1, issues: 2 },
              updatedAt: 1,
              stale: false,
            },
          },
          {
            repoRoot: "/other",
            repoName: "other",
            counts: {
              value: { prs: 10, issues: 20 },
              updatedAt: 1,
              stale: false,
            },
          },
        ]}
        onView={() => {}}
      />
    ),
    { width: 96, height: 1 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Start ·3");
  expect(frame.trimEnd().endsWith(" scope: repo ──")).toBe(true);
  const scope = setup
    .captureSpans()
    .lines[0]!.spans.find((s) => s.text === "repo");
  expect(scope?.fg.toInts()).toEqual(hex(theme.blue));
});

// Tabs cost 37 columns here (`── Sessions ·2 ── Worktrees ── Start `), the
// padding 2 and the scope dressing 11: the scope's name gets `width - 50`.
// Below the tabs' own width the strip CLIPS (line 2 must stay blank: OpenTUI
// wraps an overflowing row onto the next line, which here is the head line).
for (const [width, expected] of [
  [36, null],
  [39, null],
  [51, null],
  [52, "s…"],
  [56, "scope"],
] as const) {
  it(`fits the scope into a ${width - 50}-column budget`, async () => {
    setup = await testRender(
      () => (
        <ViewStrip
          view="sessions"
          scope="/scope"
          sessions={2}
          facts={[]}
          onView={() => {}}
        />
      ),
      { width, height: 2 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const line = frame.split("\n")[0]!.trimEnd();
    if (expected === null) {
      // A one-column budget would draw a lone `…`; the scope is dropped and
      // the rule runs to the edge instead (or the tabs are clipped).
      expect(line).not.toContain("scope:");
      expect(line.length).toBeLessThanOrEqual(width); // clipped, not wrapped
    } else {
      expect(line.endsWith(` scope: ${expected} ──`)).toBe(true);
      expect(line.length).toBe(width - 1);
    }
    expect(frame.split("\n")[1]?.trim()).toBe("");
  });
}
