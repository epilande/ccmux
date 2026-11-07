import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import {
  rightSegments,
  ViewStrip,
  type StripStatus,
} from "./ViewStrip";
import type { RepoFacts } from "../../daemon/repo-facts";
import { RGBA } from "@opentui/core";
import { theme } from "../theme";

type StripProps = Parameters<typeof ViewStrip>[0];
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

it("sums the repos that answered and marks the total partial when one never did", async () => {
  const facts: RepoFacts[] = [
    {
      repoRoot: "/github",
      repoName: "github",
      counts: { value: { prs: 4, issues: 7 }, updatedAt: 1, stale: false },
      worktrees: {
        value: { repoRoot: "/github", repoName: "github", worktrees: [] },
        updatedAt: 1,
        stale: false,
      },
    },
    // No GitHub remote: counts never succeed, so the fact stays absent.
    { repoRoot: "/local", repoName: "local" },
  ];
  setup = await testRender(
    () => (
      <ViewStrip
        view="start"
        scope={null}
        sessions={2}
        facts={facts}
        onView={() => {}}
      />
    ),
    { width: 96, height: 1 },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Worktrees 0 ~   Start 11 ~");
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

const strip = async (width: number, extra: Partial<StripProps> = {}) => {
  setup = await testRender(
    () => (
      <ViewStrip
        view="sessions"
        scope={null}
        sessions={3}
        facts={[]}
        onView={() => {}}
        {...extra}
      />
    ),
    { width, height: 1 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n")[0]!.trimEnd();
};
const fgOf = (text: string) =>
  setup
    .captureSpans()
    .lines[0]!.spans.find((s) => s.text.includes(text))
    ?.fg.toInts();
const hex = (color: string) => RGBA.fromHex(color).toInts();

it("renders the healthy board exactly as it did without status", async () => {
  const bare = await strip(96);
  setup.renderer.destroy();
  const healthy = await strip(96, {
    connectionState: "connected",
    daemonDegraded: false,
    invokeInFlight: 0,
    hideIdle: false,
  });
  expect(healthy).toBe(bare);
  expect(healthy).toBe(
    `  Sessions 3   Worktrees   Start  ${" ".repeat(95 - 34 - 9)}all repos`,
  );
});

it("marks a lost connection with its state color, never when connected", async () => {
  expect(await strip(96, { connectionState: "reconnecting" })).toEndWith(
    "● reconnecting · all repos",
  );
  expect(fgOf("reconnecting")).toEqual(hex(theme.yellow));
  setup.renderer.destroy();
  expect(await strip(96, { connectionState: "disconnected" })).toEndWith(
    "● disconnected · all repos",
  );
  expect(fgOf("disconnected")).toEqual(hex(theme.red));
  setup.renderer.destroy();
  expect(await strip(96, { connectionState: "connected" })).not.toContain(
    "●",
  );
});

it("shows degraded and in-flight invokes only while they hold", async () => {
  expect(await strip(96, { daemonDegraded: true })).toEndWith(
    "▲ degraded · all repos",
  );
  expect(fgOf("degraded")).toEqual(hex(theme.yellow));
  setup.renderer.destroy();
  expect(await strip(96, { invokeInFlight: 2 })).toEndWith(
    "2 invoking · all repos",
  );
  expect(fgOf("invoking")).toEqual(hex(theme.peach));
  setup.renderer.destroy();
  const quiet = await strip(96, { daemonDegraded: false, invokeInFlight: 0 });
  expect(quiet).not.toContain("degraded");
  expect(quiet).not.toContain("invoking");
});

it("counts hidden rows as n/total and flags hide-idle apart from search", async () => {
  const idle = await strip(96, { total: 8, hideIdle: true });
  expect(idle).toContain("Sessions 3/8 ");
  expect(idle).toEndWith("active · all repos");
  expect(fgOf("active")).toEqual(hex(theme.overlay));
  setup.renderer.destroy();
  const search = await strip(96, { total: 8 });
  expect(search).toContain("Sessions 3/8 ");
  expect(search).not.toContain("active");
});

it("orders every signal ahead of the scope", async () => {
  expect(
    await strip(120, {
      connectionState: "reconnecting",
      daemonDegraded: true,
      invokeInFlight: 1,
      hideIdle: true,
      total: 8,
    }),
  ).toEndWith(
    "● reconnecting · ▲ degraded · 1 invoking · active · all repos",
  );
});

describe("rightSegments priority", () => {
  const all: StripStatus = {
    connectionState: "reconnecting",
    daemonDegraded: true,
    invokeInFlight: 2,
    hideIdle: true,
  };
  const fit = (budget: number, status: StripStatus = all) =>
    rightSegments(status, "all repos", theme.overlay, budget)
      .map((s) => s.text)
      .join(" · ");
  const full = "● reconnecting · ▲ degraded · 2 invoking · active";
  const cols = full.length;

  it("truncates, then drops, the scope before any signal", () => {
    expect(fit(cols + 12)).toBe(`${full} · all repos`);
    expect(fit(cols + 7)).toBe(`${full} · all…`);
    expect(fit(cols + 4)).toBe(`${full} · …`);
    expect(fit(cols)).toBe(full);
  });

  it("drops invoking, then active, then shrinks to the two glyphs", () => {
    // One column short: invoking drops and the scope takes what it freed.
    expect(fit(cols - 1)).toBe(
      "● reconnecting · ▲ degraded · active · all repos",
    );
    expect(fit(30)).toBe("● reconnecting · ▲ degraded");
    expect(fit(20)).toBe("● · ▲ degraded · al…");
    expect(fit(14)).toBe("● · ▲ degraded");
    expect(fit(5)).toBe("● · ▲");
    expect(fit(0)).toBe("● · ▲");
  });

  it("gives the whole budget to the scope when healthy", () => {
    expect(fit(9, {})).toBe("all repos");
    expect(fit(1, {})).toBe("…");
    expect(fit(0, { connectionState: "connected" })).toBe("");
  });
});

it("keeps connection and degraded on a narrow strip that has no room for scope", async () => {
  const line = await strip(50, {
    connectionState: "disconnected",
    daemonDegraded: true,
    invokeInFlight: 3,
    scope: "/code/some-repo",
  });
  expect(line).toEndWith("● · ▲ degraded");
  expect(line).not.toContain("some-repo");
  expect(line).not.toContain("invoking");
});
