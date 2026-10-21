import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import {
  fitStrip,
  ViewStrip,
  type StripStatus,
} from "./ViewStrip";
import type { RepoFacts } from "../../daemon/repo-facts";
import { RGBA, TextAttributes } from "@opentui/core";
import { theme } from "../theme";

type StripProps = Parameters<typeof ViewStrip>[0];
let setup: Awaited<ReturnType<typeof testRender>>;
afterEach(() => setup?.renderer.destroy());

const hex = (c: string) => RGBA.fromHex(c).toInts();

it("draws a titled rule, marks the active view by its label, and fills counts only when facts arrive", async () => {
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
  // The first tab starts flush at column 0, and no tab, active or not, has
  // an accent rule before it.
  expect(line.startsWith("Sessions (2) ── Worktrees ── Start ─")).toBe(true);
  expect(line).not.toContain("━");
  expect(line.trimEnd().endsWith(" scope: all repos ──")).toBe(true);
  // The rule runs to the edge inside the one-column right padding.
  expect(line.trimEnd().length).toBe(95);
  const spans = setup.captureSpans().lines[0]!.spans;
  const active = spans.find((s) => s.text.includes("Worktrees"));
  expect(active?.fg.toInts()).toEqual(hex(theme.blue));
  expect(active!.attributes & TextAttributes.BOLD).not.toBe(0);
  const idle = spans.find((s) => s.text.includes("Sessions"));
  expect(idle?.fg.toInts()).toEqual(hex(theme.subtext));
  expect(idle!.attributes & TextAttributes.BOLD).toBe(0);
  // The rule before the active tab is the same plain border rule.
  const rules = spans.filter((s) => s.text.startsWith("──"));
  for (const rule of rules) expect(rule.fg.toInts()).toEqual(hex(theme.border));
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
  expect(setup.captureCharFrame()).toContain("Worktrees (0) ── Start (82)");
  expect(setup.captureCharFrame().split("\n")[1]?.trim()).toBe("");
  // The active label's count takes its accent and weight; an inactive
  // count stays subtext and plain.
  const counted = setup.captureSpans().lines[0]!.spans;
  const activeCount = counted.find((s) => s.text.includes("Worktrees (0)"));
  expect(activeCount?.fg.toInts()).toEqual(hex(theme.blue));
  expect(activeCount!.attributes & TextAttributes.BOLD).not.toBe(0);
  const idleCount = counted.find((s) => s.text.includes("Start (82)"));
  expect(idleCount?.fg.toInts()).toEqual(hex(theme.subtext));
  expect(idleCount!.attributes & TextAttributes.BOLD).toBe(0);
});

it("marks every view's tab the same way and never moves a column between them", async () => {
  const frames: string[] = [];
  for (const view of ["sessions", "worktrees", "start"] as const) {
    setup = await testRender(
      () => (
        <ViewStrip
          view={view}
          scope="/code/dotfiles"
          sessions={4}
          total={16}
          facts={[]}
          onView={() => {}}
        />
      ),
      { width: 80, height: 1 },
    );
    await setup.renderOnce();
    frames.push(setup.captureCharFrame());
    const spans = setup.captureSpans().lines[0]!.spans;
    const name = {
      sessions: "Sessions",
      worktrees: "Worktrees",
      start: "Start",
    };
    for (const [v, label] of Object.entries(name)) {
      const span = spans.find((s) => s.text.includes(label));
      const isActive = v === view;
      expect([v, span?.fg.toInts()]).toEqual([
        v,
        hex(isActive ? theme.blue : theme.subtext),
      ]);
      expect([v, (span!.attributes & TextAttributes.BOLD) !== 0]).toEqual([
        v,
        isActive,
      ]);
    }
    expect(setup.captureCharFrame()).not.toContain("━");
    setup.renderer.destroy();
  }
  // Only colors and weight differ: the characters are identical.
  expect(frames[1]).toBe(frames[0]);
  expect(frames[2]).toBe(frames[0]);
});

it("marks a stale worktree count with a tilde", async () => {
  setup = await testRender(
    () => (
      <ViewStrip
        view="worktrees"
        scope={null}
        sessions={1}
        facts={[
          {
            repoRoot: "/repo",
            repoName: "repo",
            worktrees: {
              value: { repoRoot: "/repo", repoName: "repo", worktrees: [] },
              updatedAt: 1,
              stale: true,
            },
          },
        ]}
        onView={() => {}}
      />
    ),
    { width: 96, height: 2 },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Worktrees (0~)");
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
  // Scoped, the count carries the total the scope hides, as Sessions' does.
  expect(frame).toContain("Start (3/33)");
  expect(frame.trimEnd().endsWith(" scope: repo ──")).toBe(true);
  const scope = setup
    .captureSpans()
    .lines[0]!.spans.find((s) => s.text === "repo");
  expect(scope?.fg.toInts()).toEqual(hex(theme.blue));
});

it("counts the other views in the base scope while a jump narrows this one", async () => {
  const facts: RepoFacts[] = ["/repo", "/other"].map((root, i) => ({
    repoRoot: root,
    repoName: root.slice(1),
    counts: {
      value: { prs: i ? 10 : 1, issues: 0 },
      updatedAt: 1,
      stale: false,
    },
    worktrees: {
      value: {
        repoRoot: root,
        repoName: root.slice(1),
        worktrees: Array.from({ length: i ? 3 : 2 }, (_, n) => ({
          path: `${root}/${n}`,
          branch: `b${n}`,
          isMain: n === 0,
        })),
      },
      updatedAt: 1,
      stale: false,
    },
  }));
  setup = await testRender(
    () => (
      <ViewStrip
        view="worktrees"
        scope="/repo"
        baseScope={null}
        sessions={4}
        facts={facts}
        onView={() => {}}
      />
    ),
    { width: 110, height: 1 },
  );
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Sessions (4) ── Worktrees (2/5) ── Start (11) ─");
  expect(frame.trimEnd().endsWith(" scope: repo ──")).toBe(true);
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
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Worktrees (0~)");
  expect(frame).toContain("Start (11~)");
});

// The scope's name is never cut while anything else can give way. Tabs cost
// 35 columns here (`Sessions (2) ── Worktrees ── Start `: no rule before the
// first), the right padding 1 and the right end's dressing 4. Below the
// tabs' own width the strip CLIPS (line 2 must stay blank: OpenTUI wraps an
// overflowing row onto the next line, which here is the head line).
for (const [width, expected] of [
  [53, "Sessions (2) ── Worktrees ── Start ─ scope: scope ──"],
  [52, "Sessions ── Worktrees ── Start ──── scope: scope ──"],
  [48, "Sessions ── Worktrees ── Start ──── in scope ──"],
  [44, "Se ── Wt ── St ──────────────── in scope ──"],
] as const) {
  it(`keeps the scope's name whole at ${width} columns`, async () => {
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
    expect(line).toBe(expected);
    expect(line.length).toBe(width - 1);
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
  // Tabs 35, padding 1, scope dressing 11, name 9: 96 - 56 = 40 rule cells.
  expect(healthy).toBe(
    `Sessions (3) ── Worktrees ── Start ${"─".repeat(40)} scope: all repos ──`,
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

it("counts hidden rows as (n/total) and flags hide-idle apart from search", async () => {
  const idle = await strip(96, { total: 8, hideIdle: true });
  expect(idle).toContain("Sessions (3/8) ──");
  // The active tab's count rides in its accent; the rest of the strip's
  // read text is subtext, not overlay (under 4.5:1 on base in every
  // built-in theme).
  expect(fgOf("3/8")).toEqual(hex(theme.blue));
  expect(idle).toEndWith("─ active · scope: all repos ──");
  expect(fgOf("active")).toEqual(hex(theme.subtext));
  expect(fgOf("scope: ")).toEqual(hex(theme.subtext));
  setup.renderer.destroy();
  const search = await strip(96, { total: 8 });
  expect(search).toContain("Sessions (3/8) ──");
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

describe("fitStrip priority", () => {
  const all: StripStatus = {
    connectionState: "reconnecting",
    daemonDegraded: true,
    invokeInFlight: 2,
    hideIdle: true,
  };
  const counts = { sessions: " (12/16)", worktrees: " (9)", start: " (124)" };
  const line = (
    width: number,
    status: StripStatus = all,
    name = "dotfiles",
  ) => {
    const fit = fitStrip({
      counts,
      status,
      scopeName: name,
      width,
    });
    const tabs = (["sessions", "worktrees", "start"] as const)
      .map((v) => `${fit.tabs[v].name}${fit.tabs[v].count}`)
      .join(" ");
    const right = [
      ...fit.signals.map((s) => s.text),
      ...(fit.scope ? [fit.prefix + fit.scope] : []),
    ].join(" · ");
    return `${tabs} | ${right}`;
  };

  it("gives up signal words, then counts, then the prefix, then names, before the scope's name", () => {
    expect(line(200)).toBe(
      "Sessions (12/16) Worktrees (9) Start (124) | ● reconnecting · ▲ degraded · 2 invoking · active · scope: dotfiles",
    );
    // Signals first: invoking, active, then the words behind the glyphs.
    expect(line(110)).toBe(
      "Sessions (12/16) Worktrees (9) Start (124) | ● reconnecting · ▲ degraded · active · scope: dotfiles",
    );
    expect(line(107)).toBe(
      "Sessions (12/16) Worktrees (9) Start (124) | ● reconnecting · ▲ degraded · scope: dotfiles",
    );
    expect(line(97)).toBe(
      "Sessions (12/16) Worktrees (9) Start (124) | ● · ▲ degraded · scope: dotfiles",
    );
    expect(line(77)).toBe(
      "Sessions (12/16) Worktrees (9) Start (124) | ● · ▲ · scope: dotfiles",
    );
    // Then every count at once: never one tab's alone.
    expect(line(76)).toBe("Sessions Worktrees Start | ● · ▲ · scope: dotfiles");
    // Then the shorter prefix, every name at once, and the prefix itself.
    expect(line(58)).toBe("Sessions Worktrees Start | ● · ▲ · in dotfiles");
    expect(line(52)).toBe("Se Wt St | ● · ▲ · in dotfiles");
    expect(line(37)).toBe("Se Wt St | ● · ▲ · dotfiles");
  });

  it("cuts the name only when nothing else is left to give", () => {
    expect(line(34)).toBe("Se Wt St | ● · ▲ · dotfi…");
    // A one-column name would be a lone `…`: it goes, the glyphs stay.
    expect(line(0)).toBe("Se Wt St | ● · ▲");
  });

  it("keeps a healthy strip's counts while the name fits beside them", () => {
    expect(line(70, {})).toBe(
      "Sessions (12/16) Worktrees (9) Start (124) | scope: dotfiles",
    );
    expect(line(66, {})).toBe("Sessions Worktrees Start | scope: dotfiles");
  });

  it("shrinks every tab together, whatever their counts", () => {
    for (let width = 0; width <= 200; width++) {
      const fit = fitStrip({ counts, status: all, scopeName: "x", width });
      const counted = Object.values(fit.tabs).map((t) => t.count !== "");
      const short = Object.values(fit.tabs).map((t) => t.name.length === 2);
      expect([width, new Set(counted).size]).toEqual([width, 1]);
      expect([width, new Set(short).size]).toEqual([width, 1]);
    }
  });
});

it("keeps connection and degraded, and the scope's name, on a narrow strip", async () => {
  const line = await strip(60, {
    connectionState: "disconnected",
    daemonDegraded: true,
    invokeInFlight: 3,
    scope: "/code/some-repo",
  });
  expect(line).toEndWith("● · ▲ · in some-repo ──");
  expect(line).not.toContain("invoking");
  expect(line.length).toBe(59);
});

/**
 * Three repos with facts, so every count is a number and a scoped one shows
 * its total (`(2/9)`), the widest the strip's tabs get.
 */
function factsFor(...names: string[]): RepoFacts[] {
  return names.map((name, i) => ({
    repoRoot: `/code/${name}`,
    repoName: name,
    worktrees: {
      value: {
        repoRoot: `/code/${name}`,
        repoName: name,
        worktrees: Array.from({ length: i + 2 }, (_, n) => ({
          path: `/code/${name}/${n}`,
          branch: `b${n}`,
          isMain: n === 0,
        })),
      },
      updatedAt: 1,
      stale: false,
    },
    counts: {
      value: { prs: 3 * (i + 1), issues: 5 * (i + 1) },
      updatedAt: 1,
      stale: false,
    },
  }));
}

describe("the scope's name at 70 and 80 columns", () => {
  const LONG = "claude-code-plugin-marketplace";
  const facts = factsFor("dotfiles", "api-server", LONG);
  const right = (line: string) => line.slice(line.lastIndexOf(" ── ") - 40);
  for (const width of [70, 80])
    for (const [scope, name] of [
      [null, "all repos"],
      ["/code/dotfiles", "dotfiles"],
      ["/code/api-server", "api-server"],
      [`/code/${LONG}`, LONG],
    ] as const)
      it(`shows ${name} whole at ${width} columns`, async () => {
        const line = await strip(width, {
          scope,
          sessions: 12,
          total: 16,
          hideIdle: true,
          facts,
        });
        expect(line).toMatch(new RegExp(` (scope: |in )?${name} ──$`));
        expect(right(line)).not.toContain("…");
        expect(line.length).toBe(width - 1);
      });

  it("gives way in order: every count at 80, the long prefix too at 70", async () => {
    const scope = `/code/${LONG}`;
    const extra = { scope, sessions: 12, total: 16, facts };
    expect(await strip(80, extra)).toMatch(
      new RegExp(`^Sessions ── Worktrees ── Start ─+ scope: ${LONG} ──$`),
    );
    setup.renderer.destroy();
    expect(await strip(70, extra)).toMatch(
      new RegExp(`^Sessions ── Worktrees ── Start ─+ in ${LONG} ──$`),
    );
  });

  // Switching views changes only color and weight: every label, count and
  // rule sits on the same columns whichever view is active. The 36-column
  // name is long enough that a per-tab fit diverged at both narrow widths:
  // at 100 one view's count dropped while another's stayed, and at 70 only
  // the inactive names shortened.
  const LONGER = "acme-platform-infrastructure-cdk-ops";
  const longerFacts = factsFor("dotfiles", "api-server", LONGER);
  for (const width of [70, 100, 160])
    it(`keeps every label on the same columns in all three views at ${width} columns`, async () => {
      const lines: string[] = [];
      for (const view of ["sessions", "worktrees", "start"] as const) {
        lines.push(
          await strip(width, {
            view,
            scope: `/code/${LONGER}`,
            sessions: 12,
            total: 16,
            facts: longerFacts,
          }),
        );
        setup.renderer.destroy();
      }
      const columns = (line: string) =>
        [/Se(ssions)?\b/, /Wt|Worktrees/, /St(art)?\b/].map((re) =>
          line.search(re),
        );
      expect(columns(lines[1]!)).toEqual(columns(lines[0]!));
      expect(columns(lines[2]!)).toEqual(columns(lines[0]!));
      expect(lines[1]).toBe(lines[0]);
      expect(lines[2]).toBe(lines[0]);
      // And the long scope is still whole.
      expect(lines[0]).toEndWith(`${LONGER} ──`);
    });

  it("starts the first tab at column 0 in every view", async () => {
    for (const view of ["sessions", "worktrees", "start"] as const) {
      const line = await strip(80, { view, facts });
      expect(line.startsWith("Sessions (")).toBe(true);
      setup.renderer.destroy();
    }
  });
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
