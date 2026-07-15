import { describe, expect, it } from "bun:test";
import type { SessionStatus } from "../types/session";
import {
  correctAmbiguousPermissionMarker,
  evaluateCascade,
  type CascadeSource,
  type CascadeState,
} from "./cascade-evaluator";

function markerSource(opts: {
  ts: number;
  state: CascadeState;
}): CascadeSource {
  return { name: "marker", timestamp: opts.ts, state: opts.state };
}

function logSource(opts: { ts: number; state: CascadeState }): CascadeSource {
  return { name: "log", timestamp: opts.ts, state: opts.state };
}

function terminalUpgrade(opts: {
  ts: number;
  state: CascadeState;
  canUpgrade?: SessionStatus[];
}): CascadeSource {
  return {
    name: "terminal",
    timestamp: opts.ts,
    state: opts.state,
    canUpgrade: opts.canUpgrade ?? ["waiting"],
  };
}

type Case = {
  name: string;
  sources: CascadeSource[];
  expected: CascadeState;
};

const cases: Case[] = [
  // --- Baseline selection ---
  {
    name: "no sources -> default idle",
    sources: [],
    expected: { status: "idle", attentionType: null, pendingTool: null },
  },
  {
    name: "single marker baseline passes through",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
          lastActivityAt: "2026-05-17T10:00:00.000Z",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "2026-05-17T10:00:00.000Z",
    },
  },
  {
    name: "single log baseline passes through",
    sources: [
      logSource({
        ts: 12_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "2026-05-17T10:00:12.000Z",
        },
      }),
    ],
    expected: {
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: "2026-05-17T10:00:12.000Z",
    },
  },
  {
    name: "marker fresher than log wins as baseline",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Edit",
          lastActivityAt: "T+10",
        },
      }),
      logSource({
        ts: 8_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+8",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Edit",
      lastActivityAt: "T+10",
    },
  },
  {
    name: "log fresher than marker wins as baseline (no terminal upgrade)",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "idle",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
      logSource({
        ts: 12_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+12",
        },
      }),
    ],
    expected: {
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: "T+12",
    },
  },
  {
    name: "input order does not change baseline winner",
    sources: [
      logSource({
        ts: 8_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+8",
        },
      }),
      markerSource({
        ts: 10_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Read",
          lastActivityAt: "T+10",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Read",
      lastActivityAt: "T+10",
    },
  },

  // --- Upgrade-only application ---
  {
    name: "terminal upgrades log-working baseline to waiting",
    sources: [
      logSource({
        ts: 10_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
      terminalUpgrade({
        ts: 11_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "T+10",
    },
  },
  {
    name: "terminal upgrade skipped when baseline already waiting",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Edit",
          lastActivityAt: "T+10",
        },
      }),
      terminalUpgrade({
        ts: 11_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Edit",
      lastActivityAt: "T+10",
    },
  },
  {
    name: "terminal upgrade skipped when its status is not in canUpgrade",
    sources: [
      logSource({
        ts: 10_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
      terminalUpgrade({
        ts: 11_000,
        state: { status: "idle", attentionType: null, pendingTool: null },
        canUpgrade: ["waiting"],
      }),
    ],
    expected: {
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: "T+10",
    },
  },
  {
    name: "terminal upgrade applies even with no baseline source",
    sources: [
      terminalUpgrade({
        ts: 11_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
    },
  },

  // --- Field-merge semantics ---
  {
    // Option Y pin (Decision 1a): the imperative branch at
    // state-reconciler.ts:518-523 clears stale attention when no marker
    // or terminal rule says waiting. In the cascade model this works
    // only because the log source factory emits explicit nulls, and the
    // evaluator preserves the freshest baseline's nulls. If a future
    // tweak makes the evaluator "carry over prior attention", this
    // assertion fails first.
    name: "log baseline with null attention preserves nulls (Option Y cleanup)",
    sources: [
      logSource({
        ts: 12_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+12",
        },
      }),
    ],
    expected: {
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: "T+12",
    },
  },
  {
    name: "upgrade overlay does not overwrite baseline lastActivityAt",
    sources: [
      logSource({
        ts: 10_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
      terminalUpgrade({
        ts: 11_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
          lastActivityAt: "T+11-should-be-ignored",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "T+10",
    },
  },
  {
    name: "baseline attention preserved when overlay would set a different value",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "working",
          attentionType: "question",
          pendingTool: "Read",
          lastActivityAt: "T+10",
        },
      }),
      terminalUpgrade({
        ts: 11_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "question",
      pendingTool: "Read",
      lastActivityAt: "T+10",
    },
  },
  {
    name: "upgrade fills attentionType/pendingTool when baseline left them undefined",
    sources: [
      logSource({
        ts: 10_000,
        state: { status: "working", lastActivityAt: "T+10" },
      }),
      terminalUpgrade({
        ts: 11_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "T+10",
    },
  },

  // --- Three-way scenarios from the plan ---
  {
    name: "plan ex 1: marker waiting fresh, log working, terminal idle -> waiting",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
          lastActivityAt: "T+10",
        },
      }),
      logSource({
        ts: 8_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+8",
        },
      }),
      terminalUpgrade({
        ts: 8_500,
        state: { status: "idle", attentionType: null, pendingTool: null },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "T+10",
    },
  },
  {
    name: "plan ex 2: marker idle, log working freshest, terminal idle -> working",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "idle",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
      logSource({
        ts: 12_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+12",
        },
      }),
      terminalUpgrade({
        ts: 12_500,
        state: { status: "idle", attentionType: null, pendingTool: null },
      }),
    ],
    expected: {
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: "T+12",
    },
  },
  {
    name: "plan ex 3: no marker, log working, terminal Permission -> waiting (upgrade)",
    sources: [
      logSource({
        ts: 10_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
      terminalUpgrade({
        ts: 10_500,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "T+10",
    },
  },
  {
    name: "plan ex 4: marker idle freshest, log idle, terminal Permission -> waiting",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "idle",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
      logSource({
        ts: 8_000,
        state: {
          status: "idle",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+8",
        },
      }),
      terminalUpgrade({
        ts: 10_500,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Edit",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Edit",
      lastActivityAt: "T+10",
    },
  },

  // --- Tie-breaking by source priority (marker > log > terminal) ---
  // Mirrors the imperative `markerTs >= logTs` rule the cascade replaces.
  {
    name: "tie: marker and log at identical timestamp -> marker wins",
    sources: [
      logSource({
        ts: 10_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10-log",
        },
      }),
      markerSource({
        ts: 10_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
          lastActivityAt: "T+10-marker",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "T+10-marker",
    },
  },
  {
    name: "tie: input order does not affect marker-wins-tie outcome",
    sources: [
      markerSource({
        ts: 10_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
          lastActivityAt: "T+10-marker",
        },
      }),
      logSource({
        ts: 10_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10-log",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "T+10-marker",
    },
  },

  // --- Multiple upgrades (algorithm supports many, freshest wins) ---
  {
    name: "two upgrades: freshest wins, second is skipped (status now equal)",
    sources: [
      logSource({
        ts: 10_000,
        state: {
          status: "idle",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
      terminalUpgrade({
        ts: 11_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "OlderBash",
        },
      }),
      terminalUpgrade({
        ts: 12_000,
        state: {
          status: "waiting",
          attentionType: "question",
          pendingTool: "NewerEdit",
        },
      }),
    ],
    expected: {
      status: "waiting",
      attentionType: "question",
      pendingTool: "NewerEdit",
      lastActivityAt: "T+10",
    },
  },
  {
    name: "evaluator returns a fresh object (does not alias the baseline state)",
    sources: [
      logSource({
        ts: 10_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+10",
        },
      }),
    ],
    expected: {
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: "T+10",
    },
  },
];

describe("evaluateCascade", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(evaluateCascade(c.sources)).toEqual(c.expected);
    });
  }

  it("normalises undefined attention fields to explicit null (Option Y cleanup contract)", () => {
    // A baseline source that omits attentionType/pendingTool. Without
    // normalisation the result would carry `undefined` through to
    // SessionManager.updateSession, which treats undefined as "skip" and
    // would silently leave stale attention from a prior tick. Pin the
    // explicit-null guarantee here so a future evaluator change that
    // returns `undefined` fails the test before reaching production.
    const result = evaluateCascade([
      {
        name: "log",
        timestamp: 10_000,
        state: { status: "working", lastActivityAt: "T+10" },
      },
    ]);
    expect(result.attentionType).toBeNull();
    expect(result.pendingTool).toBeNull();
  });

  it("does not mutate input baseline state (defensive copy)", () => {
    const baselineState: CascadeState = {
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: "T+10",
    };
    const sources: CascadeSource[] = [
      logSource({ ts: 10_000, state: baselineState }),
      terminalUpgrade({
        ts: 11_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
        },
      }),
    ];
    evaluateCascade(sources);
    expect(baselineState).toEqual({
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: "T+10",
    });
  });

  it("does not mutate the input sources array", () => {
    const sources: CascadeSource[] = [
      logSource({
        ts: 8_000,
        state: {
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: "T+8",
        },
      }),
      markerSource({
        ts: 10_000,
        state: {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
          lastActivityAt: "T+10",
        },
      }),
    ];
    const snapshot = sources.map((s) => s.name);
    evaluateCascade(sources);
    expect(sources.map((s) => s.name)).toEqual(snapshot);
  });
});

describe("correctAmbiguousPermissionMarker", () => {
  it("relabels a permission marker to question when a terminal question source is present and the flag is set", () => {
    const marker = markerSource({
      ts: 10_000,
      state: { status: "waiting", attentionType: "permission", pendingTool: null },
    });
    const terminal = terminalUpgrade({
      ts: 5_000,
      state: { status: "waiting", attentionType: "question", pendingTool: null },
    });
    const sources = [marker, terminal];
    correctAmbiguousPermissionMarker(sources, true);
    expect(marker.state.attentionType).toBe("question");
    // Status and freshness untouched: the marker still wins the fold.
    expect(marker.state.status).toBe("waiting");
    expect(evaluateCascade(sources)).toMatchObject({
      status: "waiting",
      attentionType: "question",
    });
  });

  it("is a no-op when the flag is absent", () => {
    const marker = markerSource({
      ts: 10_000,
      state: { status: "waiting", attentionType: "permission", pendingTool: null },
    });
    const terminal = terminalUpgrade({
      ts: 5_000,
      state: { status: "waiting", attentionType: "question", pendingTool: null },
    });
    correctAmbiguousPermissionMarker([marker, terminal], undefined);
    expect(marker.state.attentionType).toBe("permission");
  });

  it("is a no-op when the terminal source is not a question", () => {
    const marker = markerSource({
      ts: 10_000,
      state: { status: "waiting", attentionType: "permission", pendingTool: "Bash" },
    });
    const terminal = terminalUpgrade({
      ts: 5_000,
      state: { status: "waiting", attentionType: "permission", pendingTool: null },
    });
    correctAmbiguousPermissionMarker([marker, terminal], true);
    expect(marker.state.attentionType).toBe("permission");
  });

  it("is a no-op when there is no terminal source", () => {
    const marker = markerSource({
      ts: 10_000,
      state: { status: "waiting", attentionType: "permission", pendingTool: "Bash" },
    });
    correctAmbiguousPermissionMarker([marker], true);
    expect(marker.state.attentionType).toBe("permission");
  });

  it("is a no-op when the marker is not a permission wait", () => {
    const marker = markerSource({
      ts: 10_000,
      state: { status: "working", attentionType: null, pendingTool: null },
    });
    const terminal = terminalUpgrade({
      ts: 5_000,
      state: { status: "waiting", attentionType: "question", pendingTool: null },
    });
    correctAmbiguousPermissionMarker([marker, terminal], true);
    expect(marker.state.attentionType).toBeNull();
  });
});
