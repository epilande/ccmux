import { describe, expect, it } from "bun:test";
import {
  getOmpExtensionSourceForTests,
  renderOmpExtension,
} from "./extension-script";

describe("renderOmpExtension", () => {
  it("substitutes the markers dir and version, leaving no raw sentinels", () => {
    const out = renderOmpExtension({
      markersDir: "/home/u/.config/ccmux/session-pids",
      version: "1.2.3",
    });
    expect(out).toContain(`markersDir: "/home/u/.config/ccmux/session-pids"`);
    expect(out).toContain(`version: "1.2.3"`);
    // Sentinel comment carries the version.
    expect(out.split("\n", 1)[0]).toBe("// ccmux-extension v1.2.3");
    expect(out).not.toContain("__CCMUX_MARKERS_DIR__");
    expect(out).not.toContain("__CCMUX_VERSION__");
  });

  it("JSON-encodes paths so special characters stay valid string literals", () => {
    const out = renderOmpExtension({
      markersDir: `/tmp/with "quote"/markers`,
      version: "9.9.9",
    });
    expect(out).toContain(JSON.stringify(`/tmp/with "quote"/markers`));
  });

  it("raw template still carries the sentinels (pre-substitution)", () => {
    const raw = getOmpExtensionSourceForTests();
    expect(raw).toContain("__CCMUX_MARKERS_DIR__");
    expect(raw).toContain("__CCMUX_VERSION__");
  });

  it("renders the omp template, not pi's", () => {
    const raw = getOmpExtensionSourceForTests();
    expect(raw).toContain(`const AGENT_TYPE = "omp"`);
    // The approval handlers are the whole reason omp has its own template.
    expect(raw).toContain("tool_approval_requested");
    expect(raw).toContain("tool_approval_resolved");
  });
});
