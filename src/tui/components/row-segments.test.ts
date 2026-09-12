import { expect, it } from "bun:test";
import {
  fitSegments,
  oneLine,
  orderRepos,
  scrollTargetFor,
} from "./row-segments";
import { displayWidth } from "../utils/format";

it("fits colored segments without overflowing narrow or wide-glyph rows", () => {
  const segments = [
    { text: "日本語 ", fg: "blue" },
    { text: "branch and checks", fg: "yellow" },
  ];
  for (let width = 0; width <= 35; width++) {
    const fitted = fitSegments(segments, width);
    expect(
      displayWidth(fitted.map((s) => s.text).join("")),
    ).toBeLessThanOrEqual(width);
    expect(fitted.every((s, i) => s.fg === segments[i]?.fg)).toBe(true);
  }
  expect(fitSegments(segments, 40)).toEqual(segments);
});
it("flattens external errors before placing them on one visual line", () => {
  expect(oneLine(" gh failed\n  log in\tto continue ")).toBe(
    "gh failed log in to continue",
  );
});
it("scrolls by visual lines, including a row crossing the viewport edge", () => {
  const layout = new Map([
    ["first", { line: 1, height: 1 }],
    ["last", { line: 20, height: 2 }],
  ]);
  expect(scrollTargetFor(layout, "last", 0, 10)).toBe(12);
  expect(scrollTargetFor(layout, "last", 12, 10)).toBeNull();
  expect(scrollTargetFor(layout, "first", 12, 10)).toBe(1);
  expect(scrollTargetFor(layout, "missing", 0, 10)).toBeNull();
  expect(scrollTargetFor(layout, "first", 0, 0)).toBeNull();
});
it("orders repos without mutating the snapshot and keeps an explicit home first", () => {
  const repos = [
    { repoRoot: "/z", repoName: "z" },
    { repoRoot: "/a", repoName: "a" },
  ];
  expect(orderRepos(repos, null).map((r) => r.repoRoot)).toEqual(["/a", "/z"]);
  expect(orderRepos(repos, "/z").map((r) => r.repoRoot)).toEqual(["/z", "/a"]);
  expect(repos[0]?.repoRoot).toBe("/z");
});
