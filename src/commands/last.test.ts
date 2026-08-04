import { describe, it, expect } from "bun:test";
import { createLastCommand, renderCandidates, resolutionEcho } from "./last";
import { renderTurns } from "../daemon/transcript-read";
import type { SessionRefCandidate } from "../daemon/session-ref";

describe("renderTurns", () => {
  it("prints a single turn bare so stdout stays pipeable", () => {
    expect(renderTurns([{ role: "assistant", text: "the answer" }])).toBe(
      "the answer",
    );
  });

  it("labels the rows once there is more than one", () => {
    expect(
      renderTurns([
        { role: "assistant", text: "older" },
        { role: "user", text: "then I asked" },
        { role: "assistant", text: "newer" },
      ]),
    ).toBe("assistant:\nolder\n\nuser:\nthen I asked\n\nassistant:\nnewer");
  });
});

describe("resolutionEcho", () => {
  const base = {
    sessionId: "codex-a1b2",
    agentType: "codex",
    source: "transcript" as const,
    turns: [],
    truncated: false,
  };

  it("says how a fuzzy ref was read", () => {
    expect(
      resolutionEcho({
        ...base,
        resolution: {
          ref: "codex",
          tier: "agent-type",
          exact: false,
          proximity: "same-window",
        },
      }),
    ).toBe("codex -> codex-a1b2 (same window)");
  });

  it("stays quiet for an exact ref", () => {
    expect(
      resolutionEcho({
        ...base,
        resolution: {
          ref: "codex-a1b2",
          tier: "id",
          exact: true,
          proximity: null,
        },
      }),
    ).toBeNull();
    expect(resolutionEcho(base)).toBeNull();
  });
});

describe("renderCandidates", () => {
  const candidates: SessionRefCandidate[] = [
    {
      sessionId: "codex-aaa",
      agentType: "codex",
      project: "near",
      cwd: "/Users/dev/near",
      status: "idle",
      paneId: "%2",
      coordinate: "work:1.1",
      proximity: "same-window",
    },
    {
      sessionId: "codex-bbb",
      agentType: "codex",
      project: "far",
      cwd: "/Users/dev/far",
      status: "working",
      paneId: null,
      coordinate: null,
      proximity: "global",
    },
  ];

  it("lists every candidate with an id and a coordinate to re-ask with", () => {
    const out = renderCandidates("codex", candidates);
    expect(out.split("\n")[0]).toBe(
      'Ambiguous session reference "codex" (2 matches):',
    );
    expect(out).toContain("codex-aaa  work:1.1  codex  idle");
    expect(out).toContain("[same window]");
    expect(out).toContain("codex-bbb  (no pane)");
    expect(out).toContain("[global]");
  });
});

describe("createLastCommand", () => {
  it("takes a session ref plus --turns and --json", () => {
    const cmd = createLastCommand();
    expect(cmd.name()).toBe("last");
    expect(cmd.registeredArguments.map((a) => a.name())).toEqual([
      "session-ref",
    ]);
    const flags = cmd.options.map((o) => o.flags);
    expect(flags).toContain("-t, --turns <n>");
    expect(flags).toContain("--json");
  });
});
