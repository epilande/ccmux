import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateRelease,
  parseReleaseLines,
  type GuardInput,
} from "./release-guard";

const LINES = {
  branches: { main: "1.5", "release/1.4": "1.4" },
  rcLine: "1.5",
};
const TAGS = ["v1.2.1-rc.1", "v1.2.1", "v1.4.6", "v1.4.7"];

function evaluate(overrides: Partial<GuardInput> = {}) {
  return evaluateRelease({
    lines: LINES,
    ref: "refs/heads/main",
    version: "1.5.0-rc.1",
    tags: TAGS,
    dryRun: "",
    versionOverride: "",
    branchOverride: "",
    ...overrides,
  });
}

const patch = (version: string, overrides: Partial<GuardInput> = {}) =>
  evaluate({ ref: "refs/heads/release/1.4", version, ...overrides });

describe("refs", () => {
  it("denies every ref that is not a listed branch", () => {
    for (const ref of [
      "refs/heads/feature",
      "refs/heads/release/1.3",
      "refs/heads/main2",
      "refs/tags/main",
      "refs/pull/1/merge",
      "refs/heads/",
      "main",
      "",
      "refs/heads/toString",
      "refs/heads/__proto__",
    ]) {
      const { verdict, outputs } = evaluate({ ref });
      expect([ref, verdict]).toEqual([ref, "deny"]);
      expect(outputs.build).toBe(false);
      expect(outputs.publish).toBe(false);
    }
  });
});

describe("existing tag", () => {
  it("skips before validating anything else", () => {
    for (const input of [
      { ref: "refs/heads/main", version: "1.4.7" },
      { ref: "refs/heads/feature", version: "1.4.7" },
      { ref: "refs/heads/release/1.4", version: "1.2.1-rc.1" },
    ]) {
      const { verdict, outputs } = evaluate(input);
      expect(verdict).toBe("skip");
      expect(outputs.build).toBe(false);
      expect(outputs.publish).toBe(false);
    }
  });

  it("matches the whole tag", () => {
    expect(patch("1.4.70").verdict).toBe("release");
    expect(patch("1.4.8", { tags: [...TAGS, "nightly-v1.4.8"] }).verdict).toBe(
      "release",
    );
  });
});

describe("version format", () => {
  it("accepts only X.Y.Z and X.Y.Z-rc.N", () => {
    for (const version of [
      "",
      "1.5",
      "v1.5.0-rc.1",
      "1.5.0-rc",
      "1.5.0-rc1",
      "1.5.0-rc.01",
      "1.5.0-RC.1",
      "1.5.0-beta.1",
      "1.5.0-rc.1.2",
      "1.5.0-rc.1+build",
      "01.5.0-rc.1",
      "1.5.0-rc.1\n",
      " 1.5.0-rc.1",
      "1.5.0.0",
    ]) {
      expect([version, evaluate({ version }).verdict]).toEqual([
        version,
        "deny",
      ]);
    }
  });
});

describe("lines and channels", () => {
  it("main releases only X.Y.0-rc.N while its line is in rc", () => {
    expect(evaluate().verdict).toBe("release");
    for (const version of [
      "1.5.0",
      "1.5.1",
      "1.5.1-rc.1",
      "1.4.8",
      "1.4.8-rc.1",
      "1.6.0-rc.1",
      "2.5.0-rc.1",
    ]) {
      expect([version, evaluate({ version }).verdict]).toEqual([
        version,
        "deny",
      ]);
    }
  });

  it("main releases only stable once rcLine is cleared", () => {
    const lines = { ...LINES, rcLine: null };
    const tags = [...TAGS, "v1.5.0-rc.2"];
    expect(evaluate({ lines, tags, version: "1.5.0" }).verdict).toBe("release");
    expect(evaluate({ lines, tags, version: "1.5.1-rc.1" }).verdict).toBe(
      "deny",
    );
  });

  it("release/1.4 releases only 1.4.x stable", () => {
    expect(patch("1.4.8").verdict).toBe("release");
    for (const version of ["1.4.8-rc.1", "1.5.0", "1.5.0-rc.1", "1.3.3"]) {
      expect([version, patch(version).verdict]).toEqual([version, "deny"]);
    }
  });

  it("takes the lines from data", () => {
    const lines = { branches: { trunk: "3.2" }, rcLine: null };
    const ref = "refs/heads/trunk";
    expect(evaluate({ lines, ref, version: "3.2.4" }).verdict).toBe("release");
    expect(evaluate({ lines, version: "3.2.4" }).verdict).toBe("deny");
  });
});

describe("ordering", () => {
  it("must be higher than every tag on its line, numerically", () => {
    const tags = [...TAGS, "v1.5.0-rc.9", "v1.5.0-rc.2"];
    expect(evaluate({ tags, version: "1.5.0-rc.10" }).verdict).toBe("release");
    expect(evaluate({ tags, version: "1.5.0-rc.3" }).verdict).toBe("deny");
    expect(
      evaluate({ tags: [...tags, "v1.5.0"], version: "1.5.0-rc.10" }).verdict,
    ).toBe("deny");
    expect(patch("1.4.5").verdict).toBe("deny");
    expect(patch("1.4.10", { tags: [...TAGS, "v1.4.9"] }).verdict).toBe(
      "release",
    );
  });

  it("ignores tags on other lines", () => {
    const tags = [...TAGS, "v1.5.0-rc.1", "v1.5.0", "v1.40.0"];
    expect(patch("1.4.8", { tags }).verdict).toBe("release");
  });

  it("fails closed on a tag on its line that cannot be ordered", () => {
    expect(patch("1.4.8", { tags: [...TAGS, "v1.4.9.1"] }).verdict).toBe(
      "deny",
    );
  });

  it("denies when no release tags are found", () => {
    for (const tags of [[], ["nightly"], ["vnext"], ["1.4.7"]]) {
      const { verdict, reason } = evaluate({ tags });
      expect(verdict).toBe("deny");
      expect(reason).toContain("no release tags");
    }
  });
});

describe("ranking", () => {
  const rank = (version: string, tags: string[]) => {
    const { outputs } = evaluate({ version, tags });
    return [outputs.highest_stable, outputs.highest_overall];
  };

  it("ranks against stable tags and against all tags", () => {
    expect(rank("1.5.0-rc.1", TAGS)).toEqual([false, true]);
    expect(rank("1.4.8", TAGS)).toEqual([true, true]);
    expect(rank("1.4.8", [...TAGS, "v1.5.0-rc.1"])).toEqual([true, false]);
    expect(rank("1.4.8", [...TAGS, "v1.5.0"])).toEqual([false, false]);
    expect(rank("1.5.0", [...TAGS, "v1.5.0-rc.2"])).toEqual([true, true]);
    expect(rank("1.5.0-rc.9", [...TAGS, "v1.5.0-rc.10"])).toEqual([
      false,
      false,
    ]);
  });

  it("is unchanged once the version's own tag exists", () => {
    expect(rank("1.5.0-rc.1", [...TAGS, "v1.5.0-rc.1"])).toEqual([false, true]);
    expect(rank("1.4.8", [...TAGS, "v1.4.8", "v1.5.0-rc.1"])).toEqual([
      true,
      false,
    ]);
  });

  it("marks prereleases", () => {
    expect(evaluate().outputs.prerelease).toBe(true);
    expect(patch("1.4.8").outputs.prerelease).toBe(false);
  });
});

describe("dry run", () => {
  const overrides = {
    ref: "refs/heads/feature",
    version: "1.4.7",
    versionOverride: "1.4.8",
    branchOverride: "release/1.4",
  };

  it("applies the overrides and never publishes", () => {
    const { verdict, outputs } = evaluate({ ...overrides, dryRun: "true" });
    expect(verdict).toBe("release");
    expect(outputs).toMatchObject({
      version: "1.4.8",
      dry_run: true,
      build: true,
      publish: false,
    });
  });

  it("still enforces the rules on the overridden values", () => {
    const run = (input: Partial<GuardInput>) =>
      evaluate({ ...overrides, dryRun: "true", ...input }).verdict;
    expect(run({ branchOverride: "main" })).toBe("deny");
    expect(run({ branchOverride: "" })).toBe("deny");
    expect(run({ versionOverride: "1.4.6" })).toBe("skip");
    expect(run({ versionOverride: "1.4.8\npublish=true" })).toBe("deny");
  });

  it("treats an empty or false dry_run as a real run", () => {
    for (const dryRun of ["", "false"]) {
      expect(evaluate({ dryRun }).outputs).toMatchObject({
        dry_run: false,
        build: true,
        publish: true,
      });
    }
  });

  it("denies a real run that passes either override, even on an existing tag", () => {
    for (const dryRun of ["", "false"]) {
      for (const override of [
        { versionOverride: "1.5.0-rc.1" },
        { branchOverride: "main" },
      ]) {
        for (const version of ["1.5.0-rc.1", "1.4.7"]) {
          const { verdict, outputs } = evaluate({
            dryRun,
            version,
            ...override,
          });
          expect(verdict).toBe("deny");
          expect(outputs.publish).toBe(false);
        }
      }
    }
  });

  it("denies a dry_run that is not a boolean", () => {
    for (const dryRun of ["TRUE", "1", "yes"]) {
      expect(evaluate({ dryRun }).verdict).toBe("deny");
    }
  });
});

describe("parseReleaseLines", () => {
  it("accepts the checked-in policy", () => {
    const raw = readFileSync(
      join(import.meta.dir, "release-lines.json"),
      "utf8",
    );
    expect(() => parseReleaseLines(JSON.parse(raw))).not.toThrow();
  });

  it("rejects malformed policy", () => {
    for (const value of [
      null,
      {},
      { branches: {}, rcLine: null },
      { branches: { main: "1.5.0" }, rcLine: null },
      { branches: { main: 1.5 }, rcLine: null },
      { branches: { main: "1.5" } },
      { branches: { main: "1.5" }, rcLine: "1.6" },
    ]) {
      expect(() => parseReleaseLines(value)).toThrow();
    }
  });
});
