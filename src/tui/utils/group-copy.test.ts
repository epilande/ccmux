import { describe, expect, it } from "bun:test";
import { mergedToast, renamedToast, resetToast } from "./group-copy";
import { displayWidth } from "./format";

describe("mergedToast", () => {
  it("names the undo in full when everything fits", () => {
    expect(mergedToast("api", 40)).toBe("Merged into api · Reset name to undo");
  });

  it("keeps the target's name with a shorter undo at the toast's 36 columns", () => {
    expect(mergedToast("ProjectX", 36)).toBe(
      "Merged into ProjectX · Reset to undo",
    );
  });

  it("cuts a long name before it drops the undo", () => {
    const text = mergedToast("a-very-long-project-name", 36);
    expect(text).toMatch(/^Merged into a-very.*… · Reset to undo$/);
    expect(displayWidth(text)).toBeLessThanOrEqual(36);
  });

  it("drops the name before the undo in a narrow sidebar", () => {
    const text = mergedToast("a-very-long-project-name", 28);
    expect(text).toBe("Merged · Reset name to undo");
  });

  it("never runs past its width", () => {
    for (const width of [10, 20, 27, 30, 34, 36, 50])
      expect(
        displayWidth(mergedToast("x".repeat(64), width)),
      ).toBeLessThanOrEqual(width);
  });
});

describe("renamedToast", () => {
  it("fits the new name to the width", () => {
    expect(renamedToast("Backend", 36)).toBe("Renamed to Backend");
    const long = renamedToast("x".repeat(64), 36);
    expect(displayWidth(long)).toBe(36);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("resetToast", () => {
  it("names every group that came back when they fit", () => {
    expect(resetToast(["px-api", "px-web"], 36)).toBe("Reset: px-api, px-web");
  });

  it("counts the ones that do not fit", () => {
    const text = resetToast(
      ["px-api", "px-web", "px-infra", "px-docs", "px-mobile"],
      36,
    );
    expect(text).toBe("Reset: px-api, px-web, px-infra +2");
    expect(displayWidth(text)).toBeLessThanOrEqual(36);
  });

  it("cuts a long first name rather than naming nothing", () => {
    const text = resetToast([`/srv/${"deep/".repeat(10)}api`, "web"], 36);
    expect(text.startsWith("Reset: /srv/deep")).toBe(true);
    expect(text.endsWith("… +1")).toBe(true);
    expect(displayWidth(text)).toBeLessThanOrEqual(36);
  });

  it("never runs past its width", () => {
    for (const width of [8, 12, 20, 34])
      expect(
        displayWidth(resetToast(["alpha", "beta", "gamma"], width)),
      ).toBeLessThanOrEqual(width);
  });
});
