import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { GroupPreview } from "./GroupPreview";
import { TickContext } from "../store";
import {
  mockEnrichedSession,
  emptySummary,
  membersFromSummary,
} from "./test-helpers";
import type { StatusSummary } from "../utils/grouping";
import type { EnrichedSession } from "../../types";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderGroupPreview(
  header: { label: string; count: number; statusSummary: StatusSummary },
  sessions: EnrichedSession[],
) {
  const [tick] = createSignal(0);
  const headerProps = {
    label: header.label,
    count: header.count,
    members: membersFromSummary(header.statusSummary),
  };
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <GroupPreview header={headerProps} sessions={sessions} width={40} />
      </TickContext.Provider>
    ),
    { width: 100, height: 20 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("GroupPreview", () => {
  it("renders group label and session count", async () => {
    const frame = await renderGroupPreview(
      {
        label: "ccmux",
        count: 4,
        statusSummary: { ...emptySummary(), idle: 4 },
      },
      [],
    );
    expect(frame).toContain("ccmux");
    expect(frame).toContain("(4 sessions)");
  });

  it("shows working count when > 0", async () => {
    const frame = await renderGroupPreview(
      {
        label: "proj",
        count: 3,
        statusSummary: { ...emptySummary(), working: 2 },
      },
      [],
    );
    expect(frame).toContain("2 working");
  });

  it("hides working when 0", async () => {
    const frame = await renderGroupPreview(
      {
        label: "proj",
        count: 3,
        statusSummary: { ...emptySummary(), idle: 3 },
      },
      [],
    );
    expect(frame).not.toContain("working");
  });

  it("shows idle summary", async () => {
    const frame = await renderGroupPreview(
      {
        label: "proj",
        count: 3,
        statusSummary: { ...emptySummary(), idle: 3 },
      },
      [],
    );
    expect(frame).toContain("3 idle");
  });

  it("renders session rows with tmux targets", async () => {
    const sessions = [
      mockEnrichedSession({
        id: "s1",
        tmuxTarget: "dev:1",
        lastActivityAt: "2024-01-15T12:00:00Z",
      }),
      mockEnrichedSession({
        id: "s2",
        tmuxTarget: "dev:2",
        lastActivityAt: "2024-01-15T12:00:00Z",
      }),
    ];
    const frame = await renderGroupPreview(
      {
        label: "proj",
        count: 2,
        statusSummary: { ...emptySummary(), idle: 2 },
      },
      sessions,
    );
    expect(frame).toContain("dev:1");
    expect(frame).toContain("dev:2");
  });
});
