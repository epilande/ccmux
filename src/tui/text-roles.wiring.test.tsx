import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { RGBA } from "@opentui/core";
import { applyTheme, resetTheme } from "./theme";
import { TEXT_ROLES } from "./text-roles";
import { Toast } from "./components/Toast";
import { RenamePrompt } from "./components/RenamePrompt";
import { GroupHeader } from "./components/GroupHeader";
import { GroupPreview } from "./components/GroupPreview";
import { aliasNotice } from "./components/SessionList";
import { TickContext } from "./store";
import { emptySummary, membersFromSummary } from "./components/test-helpers";

// Latte is where the old colors failed (overlay 1.69:1, subtext 3.20:1 on
// its surface), so each surface is checked there: it must draw the role.

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  resetTheme();
});

const hex = (color: string) => RGBA.fromHex(color).toInts();

/** The foreground of the first span containing `needle`. */
function fgOf(needle: string) {
  const span = setup!
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((s) => s.text.includes(needle));
  expect(span).toBeDefined();
  return span!.fg.toInts();
}

async function render(node: () => unknown, width = 100, height = 16) {
  setup = await testRender(node as () => never, { width, height });
  await setup.renderOnce();
}

describe("group rename text in latte", () => {
  it("draws toasts in the toast role", async () => {
    applyTheme("catppuccin-latte");
    await render(() => <Toast message="Reset: px-api, px-web" />);
    expect(fgOf("Reset: px-api")).toEqual(hex(TEXT_ROLES.toast.fg()));
  });

  it("draws the rename prompt's title, hints, count and cut in their roles", async () => {
    applyTheme("catppuccin-latte");
    const [value] = createSignal("x".repeat(70));
    await render(() => (
      <RenamePrompt
        label="beta"
        value={value()}
        onInput={() => {}}
        onSubmit={() => {}}
      />
    ));
    expect(fgOf("Rename")).toEqual(hex(TEXT_ROLES.renameTitle.fg()));
    expect(fgOf("esc cancel")).toEqual(hex(TEXT_ROLES.renameHint.fg()));
    expect(fgOf("70/64 · cut")).toEqual(hex(TEXT_ROLES.renameCut.fg()));
  });

  it("draws the count and the merge hint in their roles", async () => {
    applyTheme("catppuccin-latte");
    await render(() => (
      <RenamePrompt
        label="beta"
        value={"x".repeat(50)}
        onInput={() => {}}
        onSubmit={() => {}}
      />
    ));
    expect(fgOf("50/64")).toEqual(hex(TEXT_ROLES.renameCount.fg()));
    setup!.renderer.destroy();
    await render(() => (
      <RenamePrompt
        label="beta"
        value="alpha"
        onInput={() => {}}
        onSubmit={() => {}}
        mergesInto="alpha"
      />
    ));
    expect(fgOf("merges into alpha")).toEqual(hex(TEXT_ROLES.renameMerge.fg()));
  });

  it("draws a header's marker in the row role, and the selected role when selected", async () => {
    applyTheme("catppuccin-latte");
    const header = {
      type: "header" as const,
      groupKey: "Backend",
      label: "Backend",
      count: 1,
      collapsed: false,
      members: [],
      rawKeys: ["beta"],
    };
    const notice = aliasNotice(header)!;
    for (const selected of [false, true]) {
      await render(
        () => (
          <GroupHeader
            label="Backend"
            count={1}
            width={60}
            notice={notice}
            collapsed={false}
            selected={selected}
            members={membersFromSummary({ ...emptySummary(), idle: 1 })}
          />
        ),
        60,
        1,
      );
      expect(fgOf("from beta")).toEqual(
        hex(
          (selected
            ? TEXT_ROLES.groupMarkerSelected
            : TEXT_ROLES.groupMarker
          ).fg(),
        ),
      );
      setup!.renderer.destroy();
      setup = undefined;
    }
  });

  it("draws the group preview's sources line in its role", async () => {
    applyTheme("catppuccin-latte");
    const [tick] = createSignal(0);
    await render(() => (
      <TickContext.Provider value={{ tick }}>
        <GroupPreview
          header={{
            label: "ProjectX",
            groupKey: "ProjectX",
            rawKeys: ["px-api", "px-web"],
            count: 2,
            members: membersFromSummary({ ...emptySummary(), idle: 2 }),
          }}
          sessions={[]}
          width={40}
        />
      </TickContext.Provider>
    ));
    expect(fgOf("2 sources")).toEqual(hex(TEXT_ROLES.groupSources.fg()));
  });
});
