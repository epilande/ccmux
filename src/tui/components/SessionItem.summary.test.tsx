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
import type { ColumnsConfig } from "../../lib/preferences";

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

/**
 * The width budget for a flexible text cell is per ROW, not per item. A
 * custom layout can flex on both (`summary` on the identity line, the raw
 * `prompt` on its own row below), and the two rows have different siblings,
 * a different leading indent, and only one attention reserve between them.
 * Budgeting them together charged row 2 for row 1's furniture and truncated
 * the prompt with most of its line still empty.
 */
describe("the flexible cell's per-row width budget", () => {
  const BOTH_ROWS_FLEX: ColumnsConfig = {
    row1: { left: ["index", "status", "project", "summary"] },
    row2: { left: ["prompt"] },
  };
  const SIXTY = "Please implement the retry queue and cover it with tests";

  async function renderRows(lastPrompt: string, width = 100): Promise<string> {
    const [tick] = createSignal(0);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <SessionItem
            session={mockEnrichedSession({ ...WITH_SUMMARY, lastPrompt })}
            selected={false}
            index={0}
            previewWidth={30}
            columns={BOTH_ROWS_FLEX}
            promptDisplay="row2"
          />
        </TickContext.Provider>
      ),
      { width, height: 4 },
    );
    await setup.renderOnce();
    return setup.captureCharFrame();
  }

  /** The rendered line carrying the row-2 prompt. */
  const promptLine = (frame: string): string =>
    frame.split("\n").find((l) => l.includes("Please implement")) ?? "";

  it("gives row 2 its own line, so a prompt that fits is not truncated", async () => {
    const frame = await renderRows(SIXTY);
    // Row 1 keeps the summary, row 2 prints the prompt whole.
    expect(frame).toContain("Wire up the summary column");
    expect(promptLine(frame)).toContain(SIXTY);
    expect(promptLine(frame)).not.toContain("…");
  });

  it("truncates a too-long prompt at its own row's edge, not row 1's", async () => {
    const long = `${SIXTY} and then keep going well past the right edge of the row`;
    const frame = await renderRows(long);
    const line = promptLine(frame);
    expect(line).toContain("…");
    // The cell used nearly the whole 100-column row. Against row 1's budget
    // (its siblings, its project cell, its attention reserve) this landed
    // around 20 columns, leaving most of row 2 blank.
    expect(line.trimEnd().length).toBeGreaterThan(70);
  });
});
