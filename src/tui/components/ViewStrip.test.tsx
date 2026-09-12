import { afterEach, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { ViewStrip } from "./ViewStrip";
import type { RepoFacts } from "../../daemon/repo-facts";
import { RGBA } from "@opentui/core";
import { theme } from "../theme";

let setup: Awaited<ReturnType<typeof testRender>>;
afterEach(() => setup?.renderer.destroy());
it("paints one chip and fills unknown counts only when facts arrive", async () => {
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
  expect(setup.captureCharFrame()).toContain("Sessions 2   Worktrees   Start");
  expect(
    setup.captureCharFrame().split("\n")[0]?.trimEnd().endsWith("all repos"),
  ).toBe(true);
  const spans = setup.captureSpans().lines[0]!.spans;
  const chip = spans.find((s) => s.text.includes("Worktrees"));
  expect(chip?.bg.toInts()).toEqual(RGBA.fromHex(theme.surface).toInts());
  expect(
    spans.find((s) => s.text.includes("Sessions"))?.bg.toInts(),
  ).not.toEqual(chip?.bg.toInts());
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
  expect(setup.captureCharFrame()).toContain("Worktrees 0   Start 82");
  expect(setup.captureCharFrame().split("\n")[1]?.trim()).toBe("");
});
it("scopes totals to the repo and shows its name at the right edge", async () => {
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
  expect(setup.captureCharFrame()).toContain("Start 3");
  expect(setup.captureCharFrame().trimEnd().endsWith("repo")).toBe(true);
});

for (const width of [35, 36, 37]) {
  it(`fits the scope into a ${width - 36}-column budget`, async () => {
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
    expect(frame).not.toContain("s…");
    expect(frame.split("\n")[1]?.trim()).toBe("");
    expect(frame.includes("…")).toBe(width === 37);
  });
}
