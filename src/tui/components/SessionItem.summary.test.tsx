import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { SessionItem } from "./SessionItem";
import { TickContext } from "../store";
import { mockEnrichedSession } from "./test-helpers";
import { resolveColumns } from "./session-columns";
import type { EnrichedSession } from "../../types";
import type { SessionItemHighlights } from "./SessionItem";
import type { MatchSource } from "../utils/grouping";

/**
 * The `summary` cell: one line that shows the agent's own summary of the
 * session when its agent writes one, and the last prompt when it does not.
 * Never both (issue #183).
 */
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

const WITH_SUMMARY: Partial<EnrichedSession> = {
  agentType: "claude",
  paneTitle: "✳ Wire up the summary column",
  lastPrompt: "commit and push",
};

const NO_RULE: Partial<EnrichedSession> = {
  agentType: "codex",
  paneTitle: "probe-codex-x7",
  lastPrompt: "commit and push",
};

async function render(
  overrides: Partial<EnrichedSession>,
  opts: {
    promptBlock?: string[];
    promptBlockActive?: boolean;
    highlights?: SessionItemHighlights | null;
    transcriptSnippet?: string;
    matchSource?: MatchSource;
  } = {},
): Promise<string> {
  const [tick] = createSignal(0);
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <SessionItem
          session={mockEnrichedSession(overrides)}
          selected={false}
          index={0}
          previewWidth={30}
          layout={resolveColumns(120)}
          promptBlock={opts.promptBlock}
          promptBlockActive={opts.promptBlockActive}
          highlights={opts.highlights}
          transcriptSnippet={opts.transcriptSnippet}
          matchSource={opts.matchSource}
        />
      </TickContext.Provider>
    ),
    { width: 120, height: 6 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("the summary cell", () => {
  it("shows the agent's summary instead of the prompt", async () => {
    const frame = await render(WITH_SUMMARY);
    expect(frame).toContain("Wire up the summary column");
    expect(frame).not.toContain("commit and push");
  });

  it("never shows the status glyph the status column already draws", async () => {
    const frame = await render(WITH_SUMMARY);
    expect(frame).not.toContain("✳");
  });

  it("falls back to the prompt for an agent with no rule", async () => {
    const frame = await render(NO_RULE);
    expect(frame).toContain("commit and push");
    // The cwd basename codex writes as its title is the `project` column's job.
    expect(frame).not.toContain("probe-codex-x7");
  });

  it("shows nothing at all when there is no summary and no prompt", async () => {
    const frame = await render({ ...NO_RULE, lastPrompt: null });
    expect(frame).not.toContain("commit and push");
    expect(frame).not.toContain("probe-codex-x7");
  });
});

describe("the summary cell with the wrapped prompt block", () => {
  it("keeps a real summary on the identity line above the block", async () => {
    // The one way to see both at once: the agent's summary names the session,
    // the block below it carries the prompt's full text.
    const frame = await render(WITH_SUMMARY, {
      promptBlock: ["commit and push"],
      promptBlockActive: true,
    });
    expect(frame).toContain("Wire up the summary column");
    expect(frame).toContain("commit and push");
  });

  it("yields the cell when it would only repeat the block", async () => {
    const frame = await render(NO_RULE, {
      promptBlock: ["commit and push"],
      promptBlockActive: true,
    });
    // Once, in the block — not twice.
    expect(frame.split("commit and push").length - 1).toBe(1);
  });
});

describe("the summary cell under search", () => {
  it("renders the summary highlighted when the query hit the summary", async () => {
    const frame = await render(WITH_SUMMARY, {
      highlights: { summary: "Wire up the <b>summary</b> column" },
    });
    expect(frame).toContain("Wire up the summary column");
  });

  it("shows the matched older prompt, as the prompt cell does", async () => {
    // The row matched a prompt that is not the newest one. That evidence has
    // to reach the screen, so the summary steps aside for it.
    const frame = await render(WITH_SUMMARY, {
      highlights: { prompts: "rename <b>paneTitle</b> to summary" },
      matchSource: "prompt",
    });
    expect(frame).toContain("rename paneTitle to summary");
    expect(frame).not.toContain("Wire up the summary column");
  });

  it("shows a transcript snippet and its source tag", async () => {
    const frame = await render(WITH_SUMMARY, {
      transcriptSnippet: "the reconciler folds marker over log",
      matchSource: "transcript",
    });
    expect(frame).toContain("[transcript]");
    expect(frame).toContain("the reconciler folds marker over log");
  });

  it("shows the source tag for a pane-only match", async () => {
    const frame = await render(WITH_SUMMARY, { matchSource: "pane" });
    expect(frame).toContain("[pane]");
  });

  it("suppresses the source tag when the summary itself is highlighted", async () => {
    const frame = await render(WITH_SUMMARY, {
      highlights: { summary: "Wire up the <b>summary</b> column" },
      matchSource: "pane",
    });
    expect(frame).not.toContain("[pane]");
    expect(frame).toContain("Wire up the summary column");
  });
});
