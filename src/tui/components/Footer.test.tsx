import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { Footer } from "./Footer";
import { DEFAULT_GROUP_BY, type GroupBy } from "../../lib/preferences";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderFooter(props: {
  searchMode?: boolean;
  confirmMode?: boolean;
  helpMode?: boolean;
  previewFocused?: boolean;
  persistent?: boolean;
  groupBy?: GroupBy;
  reviewable?: boolean;
}) {
  setup = await testRender(
    () => (
      <Footer
        searchMode={props.searchMode ?? false}
        confirmMode={props.confirmMode}
        helpMode={props.helpMode}
        previewFocused={props.previewFocused}
        persistent={props.persistent}
        groupBy={props.groupBy}
        reviewable={props.reviewable}
      />
    ),
    { width: 120, height: 4 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("Footer", () => {
  it("renders default mode help text", async () => {
    const frame = await renderFooter({});
    expect(frame).toContain("j/k");
    expect(frame).toContain("enter");
    expect(frame).toContain("/ search");
    expect(frame).toContain("? help");
    expect(frame).toContain("q quit");
  });

  it("renders search mode help text", async () => {
    const frame = await renderFooter({ searchMode: true });
    expect(frame).toContain("type to search");
    expect(frame).toContain("esc cancel");
  });

  it("renders confirm mode help text", async () => {
    const frame = await renderFooter({ confirmMode: true });
    expect(frame).toContain("y confirm");
    expect(frame).toContain("cancel");
  });

  it("renders help mode dismiss text", async () => {
    const frame = await renderFooter({ helpMode: true });
    expect(frame).toContain("? or Esc close");
  });

  it("renders preview focused help text", async () => {
    const frame = await renderFooter({ previewFocused: true });
    expect(frame).toContain("exit focus");
    expect(frame).toContain("keys sent to pane");
  });

  it("shows switch label when persistent", async () => {
    const frame = await renderFooter({ persistent: true });
    expect(frame).toContain("switch");
  });

  it("shows select label when not persistent", async () => {
    const frame = await renderFooter({ persistent: false });
    expect(frame).toContain("select");
  });

  it("shows current groupBy mode", async () => {
    const frame = await renderFooter({ groupBy: "cwd" });
    expect(frame).toContain("group:cwd");
  });

  it("shows default groupBy when none specified", async () => {
    const frame = await renderFooter({});
    expect(frame).toContain(`group:${DEFAULT_GROUP_BY}`);
  });

  it("help mode takes priority over search mode", async () => {
    const frame = await renderFooter({ helpMode: true, searchMode: true });
    expect(frame).toContain("? or Esc close");
    expect(frame).not.toContain("type to search");
  });

  it("confirm mode takes priority over search mode", async () => {
    const frame = await renderFooter({ confirmMode: true, searchMode: true });
    expect(frame).toContain("y confirm");
    expect(frame).not.toContain("type to search");
  });

  it("shows the review hint when reviewable", async () => {
    const frame = await renderFooter({ reviewable: true });
    expect(frame).toContain("d review");
  });

  it("omits the review hint when not reviewable", async () => {
    const frame = await renderFooter({ reviewable: false });
    expect(frame).not.toContain("d review");
  });
});
