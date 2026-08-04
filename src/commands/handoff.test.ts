import { describe, it, expect } from "bun:test";
import {
  createHandoffCommand,
  renderOutcome,
  resolutionEchoes,
} from "./handoff";

const from = {
  sessionId: "codex-a1b2",
  agentType: "codex",
  resolution: {
    ref: "self",
    tier: "self",
    exact: true,
    proximity: null,
  },
};

const to = {
  sessionId: "claude-c3d4",
  agentType: "claude",
  resolution: {
    ref: "claude",
    tier: "agent-type",
    exact: false,
    proximity: "same-window" as const,
  },
};

describe("renderOutcome", () => {
  it("reports a delivery with both ends and the size", () => {
    expect(
      renderOutcome({
        status: "delivered",
        from,
        to,
        chars: 1234,
        truncated: false,
      }),
    ).toBe("Delivered codex-a1b2 -> claude-c3d4 (claude): 1,234 chars.");
  });

  it("says a payload was cut", () => {
    expect(
      renderOutcome({
        status: "delivered",
        from,
        to,
        chars: 65536,
        truncated: true,
      }),
    ).toContain("65,536 chars, truncated");
  });

  it("explains a queued handoff, and what it replaced", () => {
    const queued = renderOutcome({
      status: "queued",
      from,
      to,
      chars: 100,
      truncated: false,
      replaced: { fromSessionId: "old-1" },
    });
    expect(queued).toContain("Queued for claude-c3d4 (claude is working)");
    expect(queued).toContain("delivered when the turn ends");
    expect(queued).toContain("Replaced a pending handoff from old-1.");
  });

  it("names the pane a --spawn handoff landed in", () => {
    expect(
      renderOutcome({
        status: "spawned",
        from,
        to: { agentType: "claude", cwd: "/Users/dev/repo", paneId: "%7" },
        chars: 42,
        truncated: false,
      }),
    ).toBe(
      "Spawned claude in /Users/dev/repo (pane %7) with the handoff as its opening prompt: 42 chars.",
    );
  });
});

describe("resolutionEchoes", () => {
  it("explains only the ends the user did not spell out exactly", () => {
    expect(
      resolutionEchoes({
        status: "delivered",
        from,
        to,
        chars: 1,
        truncated: false,
      }),
    ).toEqual(["to: claude -> claude-c3d4 (same window)"]);
  });

  it("stays quiet when both ends were exact", () => {
    expect(
      resolutionEchoes({
        status: "delivered",
        from,
        to: { ...to, resolution: { ...to.resolution, exact: true } },
        chars: 1,
        truncated: false,
      }),
    ).toEqual([]);
  });
});

describe("createHandoffCommand", () => {
  it("takes both refs plus the option set", () => {
    const cmd = createHandoffCommand();
    expect(cmd.name()).toBe("handoff");
    expect(cmd.registeredArguments.map((a) => a.name())).toEqual([
      "from",
      "to",
    ]);
    // `to` is optional so `--spawn` can stand in for it.
    expect(cmd.registeredArguments[1].required).toBe(false);
    const flags = cmd.options.map((o) => o.flags);
    expect(flags).toContain("-t, --turns <n>");
    expect(flags).toContain("-n, --note <text>");
    expect(flags).toContain("--spawn");
    expect(flags).toContain("--agent <name>");
    expect(flags).toContain("--cwd <path>");
    expect(flags).toContain("--json");
  });
});
