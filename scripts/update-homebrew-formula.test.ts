import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "update-homebrew-formula.sh");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-formula-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the generator the way `release.yml` does, with fixed checksums. */
function generate(name: string, env: Record<string, string> = {}): string {
  const output = join(dir, `${name}.rb`);
  const result = Bun.spawnSync(["bash", SCRIPT, output], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SHA_MACOS_ARM64: "a".repeat(64),
      SHA_MACOS_X64: "b".repeat(64),
      SHA_LINUX_X64: "c".repeat(64),
      SHA_NOTIFIER_APP: "d".repeat(64),
      ...env,
    },
  });
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf-8");
}

const rcFormula = () =>
  generate("ccmux-rc", {
    VERSION: "1.5.0-rc.1",
    CLASS_NAME: "CcmuxRc",
    DESCRIPTION:
      "Monitor AI coding agent sessions running in tmux (release candidate)",
    CONFLICTS_WITH: "ccmux",
  });

describe("update-homebrew-formula.sh", () => {
  it("generates the stable formula byte for byte", () => {
    // The stable formula is what every existing user upgrades through, so any
    // change to it is deliberate: regenerate the fixture in the same commit.
    expect(generate("ccmux", { VERSION: "1.5.0" })).toBe(
      readFileSync(join(import.meta.dir, "fixtures", "ccmux.rb"), "utf-8"),
    );
  });

  it("switches back from the rc with brew alone", () => {
    // The daemon left running is replaced by the CLI that remains (it
    // publishes no build once its binary is uninstalled), and hooks are
    // identical across the two lines, so neither `ccmux daemon stop` nor
    // `ccmux setup` belongs in the steps.
    const caveats = rcFormula().match(/def caveats\n([\s\S]*?)\n  end\n/)?.[1];
    expect(caveats).toBe(
      [
        "    <<~EOS",
        "      To switch back to the ccmux formula:",
        "        brew uninstall ccmux-rc",
        "        brew install epilande/tap/ccmux",
        "",
        "      If ccmux is already installed but unlinked, use",
        '      "brew link ccmux" in place of the install step.',
        "    EOS",
      ].join("\n"),
    );
  });

  it("keeps the conflict with the stable formula", () => {
    expect(rcFormula()).toContain(
      'conflicts_with "ccmux", because: "both install a ccmux binary"',
    );
  });
});
