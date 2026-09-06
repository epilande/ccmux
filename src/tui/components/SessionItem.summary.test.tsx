import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { SessionItem } from "./SessionItem";
import { TickContext } from "../store";
import { mockEnrichedSession } from "./test-helpers";
import {
  resolveColumns,
  withoutPrompt,
  withoutFlexText,
} from "./session-columns";
import type { ResolvedColumns } from "./session-columns";
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

// `summary` is what the daemon ships (`summaryFromPaneTitle` runs there);
// `paneTitle` rides along raw and no cell reads it.
const WITH_SUMMARY: Partial<EnrichedSession> = {
  agentType: "claude",
  paneTitle: "✳ Wire up the summary column",
  summary: "Wire up the summary column",
  lastPrompt: "commit and push",
};

const NO_RULE: Partial<EnrichedSession> = {
  agentType: "codex",
  paneTitle: "probe-codex-x7",
  summary: null,
  lastPrompt: "commit and push",
};

async function render(
  overrides: Partial<EnrichedSession>,
  opts: {
    promptBlock?: string[];
    /** The row's layout, as SessionList would have chosen it for this
     *  session. Defaults to the stock two-row picker layout. */
    layout?: ResolvedColumns;
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
          layout={opts.layout ?? resolveColumns(120)}
          promptBlock={opts.promptBlock}
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

/**
 * With the block drawn, SessionList picks the row's layout per session:
 * `withoutPrompt` for a row whose agent wrote a summary, `withoutFlexText`
 * for one whose cell could only repeat the block. The row draws what it is
 * handed, which is the same object its height was measured from.
 */
describe("the summary cell with the wrapped prompt block", () => {
  it("keeps a real summary on the identity line above the block", async () => {
    // The one way to see both at once: the agent's summary names the session,
    // the block below it carries the prompt's full text.
    const frame = await render(WITH_SUMMARY, {
      promptBlock: ["commit and push"],
      layout: withoutPrompt(resolveColumns(120)),
    });
    expect(frame).toContain("Wire up the summary column");
    expect(frame).toContain("commit and push");
  });

  it("yields the cell when it would only repeat the block", async () => {
    const frame = await render(NO_RULE, {
      promptBlock: ["commit and push"],
      layout: withoutFlexText(resolveColumns(120)),
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
      // What the store ranks a summary-only hit as: the summary shares the
      // prompt's contribution because the two share one cell.
      matchSource: "prompt",
    });
    expect(frame).not.toContain("[summary]");
    expect(frame).toContain("Wire up the summary column");
  });
});

/**
 * The `prompt` opt-out layout (`config set columns.row2.left prompt`), where
 * no summary is rendered anywhere on the row. A match the summary text alone
 * explains would otherwise leave the row looking like it matched nothing.
 */
describe("the prompt cell's match tags", () => {
  const PROMPT_LAYOUT = () =>
    resolveColumns(120, { row2: { left: ["prompt"] } });

  it("tags a summary-only match so the row says why it matched", async () => {
    const frame = await render(WITH_SUMMARY, {
      layout: PROMPT_LAYOUT(),
      highlights: { summary: "Wire up the <b>summary</b> column" },
      matchSource: "prompt",
    });
    expect(frame).toContain("[summary]");
    // The cell still shows the prompt: the tag is the evidence, not the text.
    expect(frame).toContain("commit and push");
  });

  it("keeps the cwd tag when the match hit both the cwd and the summary", async () => {
    // A cwd-primary match that also happened to hit the summary is still a
    // cwd match, and `[cwd]` is the only thing on the row that says so.
    const frame = await render(WITH_SUMMARY, {
      layout: PROMPT_LAYOUT(),
      highlights: { summary: "Wire up the <b>summary</b> column" },
      matchSource: "cwd",
    });
    expect(frame).toContain("[cwd]");
    expect(frame).not.toContain("[summary]");
  });

  it("shows no tag when a visible highlight already explains the match", async () => {
    const frame = await render(WITH_SUMMARY, {
      layout: PROMPT_LAYOUT(),
      highlights: {
        summary: "Wire up the <b>summary</b> column",
        lastPrompt: "commit and <b>push</b>",
      },
      matchSource: "prompt",
    });
    expect(frame).not.toContain("[summary]");
  });
});
