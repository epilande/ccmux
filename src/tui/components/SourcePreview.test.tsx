import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testRender } from "@opentui/solid";
import type { OpenPR } from "../../daemon/pr-list";
import type { PRDetail } from "../../daemon/source-detail";
import { bodyText, SourcePreview } from "./SourcePreview";
import type { SourceRow } from "./source-picker-rows";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

const pr: OpenPR = {
  number: 206,
  title: "park the renderer while hidden",
  url: "https://github.com/o/r/pull/206",
  author: "epilande",
  isDraft: false,
  reviewDecision: "APPROVED",
  ciStatus: "failing",
  headRefName: "feat/parking",
  headRefOid: "sha",
  labels: ["tui"],
};

const prRow: SourceRow = {
  kind: "pr",
  key: "pr:/repo#206",
  repoRoot: "/repo",
  repoName: "repo",
  pr,
  checkedOutPath: "/repo/wt/parking",
  checkedOutName: "parking",
};

const detail: PRDetail = {
  number: 206,
  body: "<!-- template: delete me -->\r\n## Summary\n\n\n\nParks it.",
  truncated: false,
  baseRefName: "main",
  additions: 40,
  deletions: 7,
  changedFiles: 3,
  checks: [
    { name: "test", state: "fail" },
    { name: "lint", state: "pass" },
  ],
};

function answer(body: unknown) {
  const asked: string[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: unknown,
  ) => {
    asked.push(String(input));
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch);
  return asked;
}

async function render(refreshKey = 0) {
  setup = await testRender(
    () => (
      <SourcePreview row={prRow} age="3d" width={50} refreshKey={refreshKey} />
    ),
    { width: 120, height: 30 },
  );
  await setup.renderOnce();
}

describe("SourcePreview", () => {
  it("shows the list's facts at once and the detail once the cursor rests", async () => {
    const asked = answer({
      ok: true,
      detail: { ...detail, body: "Parks it." },
    });
    await render();
    let frame = setup!.captureCharFrame();
    expect(frame).toContain("⊙ #206 park the renderer while hidden");
    expect(frame).toContain("@epilande · 3d · approved · tui");
    expect(frame).toContain("→ parking");
    // A gh call per settled row, not per keypress: nothing asked yet.
    expect(asked).toEqual([]);

    await new Promise((r) => setTimeout(r, 300));
    await setup!.renderOnce();
    frame = setup!.captureCharFrame();
    expect(asked[0]).toContain("/prs/detail?repo=%2Frepo&number=206");
    expect(frame).toContain("feat/parking → main +40 −7");
    expect(frame).toContain("Checks (2)");
    expect(frame).toContain("✗ test");
    expect(frame).toContain("✓ lint");
    expect(frame).toContain("Parks it.");
  });

  it("shows a gh failure where the body would be", async () => {
    answer({ ok: false, error: "gh pr view exited 1: not found" });
    await render();
    await new Promise((r) => setTimeout(r, 300));
    await setup!.renderOnce();
    expect(setup!.captureCharFrame()).toContain(
      "gh pr view exited 1: not found",
    );
  });
});

describe("bodyText", () => {
  it("drops HTML comments and folds blank runs", () => {
    expect(bodyText(detail.body.replace(/\r/g, ""))).toBe(
      "## Summary\n\nParks it.",
    );
  });

  it("hides everything after an unclosed comment, as GitHub does", () => {
    expect(bodyText("shown\n<!-- never closed\nhidden")).toBe("shown");
  });

  it("turns tabs into spaces and trims trailing blanks", () => {
    expect(bodyText("a\tb   \nc")).toBe("a  b\nc");
  });
});
