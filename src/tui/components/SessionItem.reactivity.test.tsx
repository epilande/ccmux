import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { SessionItem } from "./SessionItem";
import { TickContext } from "../store";
import { mockEnrichedSession } from "./test-helpers";
import type { EnrichedSession } from "../../types";

/**
 * Live-update tests: the picker keeps row components mounted across SSE
 * deltas (the store memos preserve array identity when no row moves), so
 * every cell must re-render from fine-grained reads — not rely on a
 * remount to pick up new data. Sessions come through a Solid store proxy
 * here, matching how the real store delivers them.
 */

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderLive(
  overrides: Partial<EnrichedSession> = {},
  columns?: import("../../lib/preferences").ColumnsConfig,
) {
  const [tick, setTick] = createSignal(0);
  const [state, setState] = createStore({
    session: mockEnrichedSession(overrides),
  });
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <SessionItem
          session={state.session}
          selected={false}
          index={0}
          previewWidth={30}
          columns={columns}
        />
      </TickContext.Provider>
    ),
    { width: 120, height: 3 },
  );
  await setup.renderOnce();
  return { setState, setTick };
}

describe("SessionItem live updates (no remount)", () => {
  it("updates the time label when the timestamp changes", async () => {
    const start = Date.now();
    const { setState, setTick } = await renderLive({
      lastUserInputAt: new Date(start - 65_000).toISOString(),
    });
    expect(setup.captureCharFrame()).toContain("1m");

    setState(
      "session",
      "lastUserInputAt",
      new Date(start - 6 * 60_000).toISOString(),
    );
    setTick(1);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("6m");
  });

  it("updates the status badge when the session transitions idle -> working", async () => {
    const { setState } = await renderLive({ status: "idle" });
    expect(setup.captureCharFrame()).toContain("idle");

    setState("session", "status", "working");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("working");
    expect(frame).not.toContain("idle");
  });

  it("updates the version cell when enrichment lands", async () => {
    const { setState } = await renderLive({ version: null });
    expect(setup.captureCharFrame()).not.toContain("v9.9.9");

    setState("session", "version", "9.9.9");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("v9.9.9");
  });

  it("updates the prompt cell when a new prompt arrives", async () => {
    const { setState } = await renderLive({ lastPrompt: "first prompt" });
    expect(setup.captureCharFrame()).toContain("first prompt");

    setState("session", "lastPrompt", "second prompt");
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("second prompt");
  });

  it("updates the standalone branch column after a checkout (S6)", async () => {
    // The standalone `branch` column (opt-in, not in the default layout)
    // used to read `ctx.session.gitBranch` into a plain const inside
    // FieldCell's body, which runs once per mount; since rows stay mounted
    // across SSE deltas, the cell froze at whatever branch was checked out
    // when the row first mounted. A single `renderOnce` can't catch this
    // class of bug (it would pass on both the frozen and the live version);
    // it takes a second render after a live mutation, matching every other
    // test in this file.
    const { setState } = await renderLive(
      { gitBranch: "main", isWorktree: false },
      { row1: { left: [{ field: "branch" }] } },
    );
    expect(setup.captureCharFrame()).toContain("main");

    setState("session", "gitBranch", "feature/checked-out");
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("feature/checked-out");
    expect(frame).not.toContain("main");
  });

  it("updates the PR cell when a PR is detected", async () => {
    const { setState } = await renderLive({ gitBranch: "feat" });
    // Inline (default) drops the `PR ` prefix, so the cell reads `#7`.
    expect(setup.captureCharFrame()).not.toContain("#7");

    setState("session", "branchPRs", [
      { id: "7", href: "https://github.com/x/y/pull/7" },
    ]);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("#7");
    expect(frame).not.toContain("PR #7");
  });
});
