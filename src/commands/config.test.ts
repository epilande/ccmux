import { describe, expect, it } from "bun:test";
import { getNestedValue, flattenObject, KNOWN_KEYS } from "./config";
import type { Preferences } from "../lib/preferences";

describe("getNestedValue", () => {
  const prefs: Preferences = {
    showPreview: true,
    iconStyle: "nerdfont",
    columns: {
      row1: {
        left: ["index", "status:icon", "project"],
        right: ["agent:short", "pane"],
      },
      row2: {
        left: ["prompt"],
      },
    },
    breakpoints: { xs: 35, sm: 55, lg: 120 },
  };

  it("gets top-level values", () => {
    expect(getNestedValue(prefs, ["showPreview"])).toBe(true);
    expect(getNestedValue(prefs, ["iconStyle"])).toBe("nerdfont");
  });

  it("gets nested column row sides as arrays", () => {
    expect(getNestedValue(prefs, ["columns", "row1", "left"])).toEqual([
      "index",
      "status:icon",
      "project",
    ]);
    expect(getNestedValue(prefs, ["columns", "row2", "left"])).toEqual([
      "prompt",
    ]);
  });

  it("gets breakpoints", () => {
    expect(getNestedValue(prefs, ["breakpoints", "xs"])).toBe(35);
    expect(getNestedValue(prefs, ["breakpoints", "lg"])).toBe(120);
  });

  it("gets intermediate objects", () => {
    expect(getNestedValue(prefs, ["columns", "row1"])).toEqual({
      left: ["index", "status:icon", "project"],
      right: ["agent:short", "pane"],
    });
  });

  it("returns undefined for missing keys", () => {
    expect(getNestedValue(prefs, ["nonexistent"])).toBeUndefined();
    expect(
      getNestedValue(prefs, ["columns", "row1", "middle"]),
    ).toBeUndefined();
  });

  it("returns undefined when traversing through a primitive", () => {
    expect(getNestedValue(prefs, ["showPreview", "nested"])).toBeUndefined();
  });

  it("gets sidebar nested values", () => {
    const withSidebar: Preferences = {
      ...prefs,
      sidebar: { width: 35, position: "left" },
    };
    expect(getNestedValue(withSidebar, ["sidebar", "width"])).toBe(35);
    expect(getNestedValue(withSidebar, ["sidebar", "position"])).toBe("left");
  });
});

describe("flattenObject", () => {
  it("flattens simple key-value pairs", () => {
    expect(flattenObject({ iconStyle: "dot", showPreview: true })).toEqual([
      ["iconStyle", '"dot"'],
      ["showPreview", "true"],
    ]);
  });

  it("flattens nested objects with dotted keys", () => {
    expect(
      flattenObject({
        breakpoints: { sm: 55, lg: 120 },
      }),
    ).toEqual([
      ["breakpoints.sm", "55"],
      ["breakpoints.lg", "120"],
    ]);
  });

  it("flattens row-based column config with array leaves", () => {
    expect(
      flattenObject({
        columns: {
          row1: { left: ["index", "status"], right: ["pane"] },
          row2: { left: ["prompt"] },
        },
      }),
    ).toEqual([
      ["columns.row1.left", '["index","status"]'],
      ["columns.row1.right", '["pane"]'],
      ["columns.row2.left", '["prompt"]'],
    ]);
  });

  it("uses prefix when provided", () => {
    expect(flattenObject({ sm: 55, lg: 120 }, "breakpoints")).toEqual([
      ["breakpoints.sm", "55"],
      ["breakpoints.lg", "120"],
    ]);
  });

  it("handles mixed simple and nested values", () => {
    expect(
      flattenObject({
        iconStyle: "dot",
        breakpoints: { sm: 55 },
      }),
    ).toEqual([
      ["iconStyle", '"dot"'],
      ["breakpoints.sm", "55"],
    ]);
  });

  it("returns empty array for empty object", () => {
    expect(flattenObject({})).toEqual([]);
  });

  it("skips arrays without recursing into elements", () => {
    expect(flattenObject({ items: [1, 2, 3] })).toEqual([["items", "[1,2,3]"]]);
  });
});

describe("KNOWN_KEYS.additionalClaudeConfigDirs", () => {
  const spec = KNOWN_KEYS.additionalClaudeConfigDirs!;

  it("validate accepts absolute and ~/-prefixed path arrays", () => {
    expect(spec.validate('["~/.claude-personal"]')).toBe(true);
    expect(spec.validate('["/abs/path"]')).toBe(true);
    expect(spec.validate('["~/a","/b"]')).toBe(true);
    expect(spec.validate("[]")).toBe(true);
  });

  it("validate rejects non-JSON, non-array, and non-conforming entries", () => {
    expect(spec.validate("~/.claude-personal")).toBe(false);
    expect(spec.validate('"~/.claude-personal"')).toBe(false);
    expect(spec.validate("5")).toBe(false);
    expect(spec.validate('{"a":1}')).toBe(false);
    expect(spec.validate('["personal"]')).toBe(false);
    expect(spec.validate('["~"]')).toBe(false);
    expect(spec.validate('[""]')).toBe(false);
    expect(spec.validate('["~/x", 5]')).toBe(false);
  });

  it("parse returns the parsed array", () => {
    expect(spec.parse('["~/a","~/b"]')).toEqual(["~/a", "~/b"]);
  });
});
