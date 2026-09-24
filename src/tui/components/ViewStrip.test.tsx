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
    { width, height: 2 },
  );
  await setup.renderOnce();
  // Line 2 must stay blank: an overflowing strip wraps onto the head line.
  expect(setup.captureCharFrame().split("\n")[1]?.trim()).toBe("");
  return setup.captureCharFrame().split("\n")[0]!.trimEnd();
};
const fgOf = (text: string) =>
  setup
    .captureSpans()
    .lines[0]!.spans.find((s) => s.text.includes(text))
    ?.fg.toInts();

it("renders the healthy board exactly as the plain titled rule", async () => {
  const bare = await strip(96);
  setup.renderer.destroy();
  const healthy = await strip(96, {
    connectionState: "connected",
    daemonDegraded: false,
    invokeInFlight: 0,
    hideIdle: false,
  });
  expect(healthy).toBe(bare);
  // Tabs 37, padding 2, scope dressing 11, name 9: 96 - 59 = 37 rule cells.
  expect(healthy).toBe(
    ` ━━ Sessions ·3 ── Worktrees ── Start ${"─".repeat(37)} scope: all repos ──`,
  );
});

it("marks a lost connection with its state color, never when connected", async () => {
  expect(await strip(96, { connectionState: "reconnecting" })).toEndWith(
    "─ ● reconnecting · scope: all repos ──",
  );
  expect(fgOf("reconnecting")).toEqual(hex(theme.yellow));
  setup.renderer.destroy();
  expect(await strip(96, { connectionState: "disconnected" })).toEndWith(
    "─ ● disconnected · scope: all repos ──",
  );
  expect(fgOf("disconnected")).toEqual(hex(theme.red));
  setup.renderer.destroy();
  expect(await strip(96, { connectionState: "connected" })).not.toContain(
    "●",
  );
});

it("shows degraded and in-flight invokes only while they hold", async () => {
  expect(await strip(96, { daemonDegraded: true })).toEndWith(
    "─ ▲ degraded · scope: all repos ──",
  );
  expect(fgOf("degraded")).toEqual(hex(theme.yellow));
  setup.renderer.destroy();
  expect(await strip(96, { invokeInFlight: 2 })).toEndWith(
    "─ 2 invoking · scope: all repos ──",
  );
  expect(fgOf("invoking")).toEqual(hex(theme.peach));
  setup.renderer.destroy();
  const quiet = await strip(96, { daemonDegraded: false, invokeInFlight: 0 });
  expect(quiet).not.toContain("degraded");
  expect(quiet).not.toContain("invoking");
});

it("counts hidden rows as ·n/total and flags hide-idle apart from search", async () => {
  const idle = await strip(96, { total: 8, hideIdle: true });
  expect(idle).toContain("Sessions ·3/8 ──");
  expect(fgOf("3/8")).toEqual(hex(theme.overlay));
  expect(idle).toEndWith("─ active · scope: all repos ──");
  expect(fgOf("active")).toEqual(hex(theme.overlay));
  setup.renderer.destroy();
  const search = await strip(96, { total: 8 });
  expect(search).toContain("Sessions ·3/8 ──");
  expect(search).not.toContain("active");
});

it("orders every signal ahead of the scope and keeps the rule edge to edge", async () => {
  const line = await strip(120, {
    connectionState: "reconnecting",
    daemonDegraded: true,
    invokeInFlight: 1,
    hideIdle: true,
    total: 8,
  });
  expect(line).toEndWith(
    "─ ● reconnecting · ▲ degraded · 1 invoking · active · scope: all repos ──",
  );
  expect(line.length).toBe(119);
});

describe("rightSegments priority", () => {
  const all: StripStatus = {
    connectionState: "reconnecting",
    daemonDegraded: true,
    invokeInFlight: 2,
    hideIdle: true,
  };
  const fit = (budget: number, status: StripStatus = all) => {
    const { signals, scope } = rightSegments(status, "all repos", budget);
    return [...signals.map((s) => s.text), ...(scope ? [`scope: ${scope}`] : [])]
      .join(" · ");
  };
  const full = "● reconnecting · ▲ degraded · 2 invoking · active";
  const cols = full.length;

  it("truncates, then drops, the scope's name before any signal", () => {
    // ` · ` + `scope: ` is 10 columns ahead of the name.
    expect(fit(cols + 19)).toBe(`${full} · scope: all repos`);
    expect(fit(cols + 14)).toBe(`${full} · scope: all…`);
    expect(fit(cols + 12)).toBe(`${full} · scope: a…`);
    // A one-column name would be a lone `…`: the prefix goes with it.
    expect(fit(cols + 11)).toBe(full);
    expect(fit(cols)).toBe(full);
  });

  it("drops invoking, then active, then shrinks to the two glyphs", () => {
    // One column short: invoking drops and the scope takes what it freed.
    expect(fit(cols - 1)).toBe(
      "● reconnecting · ▲ degraded · active · scope: a…",
    );
    expect(fit(30)).toBe("● reconnecting · ▲ degraded");
    expect(fit(26)).toBe("● · ▲ degraded · scope: a…");
    expect(fit(14)).toBe("● · ▲ degraded");
    expect(fit(5)).toBe("● · ▲");
    expect(fit(0)).toBe("● · ▲");
  });

  it("gives the whole budget to the scope when healthy", () => {
    expect(fit(16, {})).toBe("scope: all repos");
    expect(fit(9, {})).toBe("scope: a…");
    expect(fit(8, {})).toBe("");
    expect(fit(0, { connectionState: "connected" })).toBe("");
  });
});

it("keeps connection and degraded on a narrow strip that has no room for scope", async () => {
  const line = await strip(60, {
    connectionState: "disconnected",
    daemonDegraded: true,
    invokeInFlight: 3,
    scope: "/code/some-repo",
  });
  expect(line).toEndWith("● · ▲ degraded ──");
  expect(line).not.toContain("scope:");
  expect(line).not.toContain("invoking");
  expect(line.length).toBe(59);
});

it("draws a signal that arrives after the first paint ahead of the scope", async () => {
  const [degraded, setDegraded] = createSignal(false);
  const [invoking, setInvoking] = createSignal(0);
  setup = await testRender(
    () => (
      <ViewStrip
        view="sessions"
        scope={null}
        sessions={3}
        facts={[]}
        daemonDegraded={degraded()}
        invokeInFlight={invoking()}
        onView={() => {}}
      />
    ),
    { width: 96, height: 1 },
  );
  await setup.renderOnce();
  const line = () => setup.captureCharFrame().split("\n")[0]!.trimEnd();
  expect(line()).toEndWith("─ scope: all repos ──");
  setDegraded(true);
  setInvoking(1);
  await setup.renderOnce();
  expect(line()).toEndWith("─ ▲ degraded · 1 invoking · scope: all repos ──");
  expect(line().length).toBe(95);
  setDegraded(false);
  setInvoking(0);
  await setup.renderOnce();
  expect(line()).toEndWith("─ scope: all repos ──");
  expect(line().length).toBe(95);
});
