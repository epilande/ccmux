import { describe, expect, it } from "bun:test";
import { parseKeypress } from "@opentui/core";
import {
  ACTIONS,
  PALETTE_ONLY,
  PALETTE_SECTION,
  filterPalette,
  helpGroups,
  keySequence,
  paletteCommands,
} from "./actions";

describe("paletteCommands", () => {
  it("offers each side of a paired key as its own row", () => {
    const labels = paletteCommands("sessions").map((c) => c.label);
    expect(labels).toContain("Kill session");
    expect(labels).toContain("Kill all sessions");
    expect(labels).toContain("Review working tree");
    expect(labels).toContain("Review branch vs base");
  });

  it("uses the view's own label where a key differs by view", () => {
    const label = (view: "sessions" | "worktrees" | "start") =>
      paletteCommands(view).find((c) => c.keys === "x")?.label;
    expect(label("sessions")).toBe("Kill session");
    expect(label("worktrees")).toBe("Remove worktree");
  });

  it("offers only what the view handles", () => {
    const worktrees = paletteCommands("worktrees").map((c) => c.label);
    expect(worktrees).not.toContain("Fork session");
    expect(worktrees).not.toContain("Search");
    expect(worktrees).not.toContain("Group by directory");
    // Every view has a preview now.
    expect(worktrees).toContain("Toggle preview");
    expect(paletteCommands("start").map((c) => c.label)).toContain("Search");
  });

  it("leaves review out where it is not installed", () => {
    const labels = paletteCommands("sessions", { reviewable: false }).map(
      (c) => c.label,
    );
    expect(labels).not.toContain("Review working tree");
  });

  it("is empty in the sidebar, which has no palette", () => {
    expect(paletteCommands("sessions", { sidebar: true })).toEqual([]);
  });

  it("lists the keyed actions in registry order, then the palette-only ones", () => {
    const commands = paletteCommands("sessions");
    const firstOnly = commands.findIndex((c) => !c.keys);
    expect(firstOnly).toBeGreaterThan(0);
    expect(commands.slice(firstOnly).every((c) => !c.keys)).toBe(true);
    expect(commands.slice(firstOnly).map((c) => c.id)).toEqual(
      PALETTE_ONLY.map((c) => c.id),
    );
  });

  it("gives every row a unique id", () => {
    const ids = paletteCommands("sessions").map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not list itself", () => {
    expect(paletteCommands("sessions").some((c) => c.keys === ":")).toBe(false);
  });
});

describe("filterPalette", () => {
  const commands = paletteCommands("sessions");

  it("lists everything, unmarked, for an empty query", () => {
    const matches = filterPalette(commands, "  ");
    expect(matches.map((m) => m.command)).toEqual(commands);
    expect(matches[0]!.labelMarkup).toBe(commands[0]!.label);
  });

  it("ranks the best fuzzy match first and marks what matched", () => {
    const [best] = filterPalette(commands, "toggle prev");
    expect(best!.command.label).toBe("Toggle preview");
    expect(best!.labelMarkup).toContain("<b>");
  });

  it("finds a command by its section", () => {
    const labels = filterPalette(commands, "groups").map(
      (m) => m.command.label,
    );
    expect(labels).toContain("Collapse all groups");
    expect(labels).toContain("Group by directory");
  });

  it("finds nothing for nonsense", () => {
    expect(filterPalette(commands, "zzqxv")).toEqual([]);
  });
});

describe("keySequence", () => {
  const parsed = (keys: string) =>
    keySequence(keys).map((raw) => {
      const key = parseKeypress(raw)!;
      return {
        name: key.name,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
      };
    });

  it("types plain keys one character at a time", () => {
    expect(keySequence("zm")).toEqual(["z", "m"]);
    expect(parsed("P")).toEqual([
      { name: "p", ctrl: false, meta: false, shift: true },
    ]);
  });

  it("sends the bytes a terminal sends for named and modified keys", () => {
    expect(parsed("Enter")[0]!.name).toBe("return");
    expect(parsed("Space")[0]!.name).toBe("space");
    expect(parsed("Tab")[0]!.name).toBe("tab");
    expect(parsed("Ctrl+D")).toEqual([
      { name: "d", ctrl: true, meta: false, shift: false },
    ]);
    expect(parsed("Alt+H")[0]).toMatchObject({ name: "h", meta: true });
  });

  it("can replay every key the palette offers", () => {
    for (const view of ["sessions", "worktrees", "start"] as const)
      for (const command of paletteCommands(view))
        if (command.keys)
          for (const raw of keySequence(command.keys))
            expect(
              parseKeypress(raw)?.name ?? `${command.keys}: unparsed`,
            ).not.toEndWith("unparsed");
  });
});

describe("helpGroups", () => {
  it("lists the palette-only commands under their own section", () => {
    const section = helpGroups(false, true, "sessions").find(
      (g) => g.section === PALETTE_SECTION,
    );
    expect(section?.items.map((i) => i.desc)).toContain("Open transcript");
  });

  it("leaves the palette out of the sidebar's help", () => {
    const groups = helpGroups(true, true, "sessions");
    expect(groups.some((g) => g.section === PALETTE_SECTION)).toBe(false);
    expect(groups.flatMap((g) => g.items).some((i) => i.key === ":")).toBe(
      false,
    );
  });

  it("names a key for every keyed palette entry", () => {
    for (const action of ACTIONS)
      if ("palette" in action)
        for (const entry of action.palette) expect(entry.keys).not.toBe("");
  });
});
