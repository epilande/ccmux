import { describe, expect, it, spyOn, mock } from "bun:test";
import type { Preferences } from "../lib/preferences";

// In-memory preferences store so `config set`/`config get` tests never touch
// the real ~/.config/ccmux/ccmux.json. Spread the real module (types are
// erased, but VALID_*/BREAKPOINT_NAMES/COLUMN_FIELDS constants are runtime
// values config.ts imports) and override only the I/O functions.
let store: Preferences = {};
const realPreferences = await import("../lib/preferences");
mock.module("../lib/preferences", () => ({
  ...realPreferences,
  getPreferences: async () => structuredClone(store),
  setPreferences: async (updates: Partial<Preferences>) => {
    store = { ...structuredClone(store), ...structuredClone(updates) };
  },
}));

const {
  createConfigCommand,
  getNestedValue,
  flattenObject,
  KNOWN_KEYS,
  completableConfigKeys,
  configValueChoices,
} = await import("./config");

class ExitError extends Error {
  constructor(public code?: number) {
    super(`process.exit(${code})`);
  }
}

function withExitSentinel(): () => void {
  const original = process.exit;
  process.exit = ((code?: number) => {
    throw new ExitError(code);
  }) as never;
  return () => {
    process.exit = original;
  };
}

async function runConfigSet(
  key: string,
  value: string,
): Promise<ExitError | null> {
  try {
    await createConfigCommand().parseAsync(["set", key, value], {
      from: "user",
    });
    return null;
  } catch (err) {
    if (err instanceof ExitError) return err;
    throw err;
  }
}

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

  it("flattens notifications config (config get notifications)", () => {
    expect(
      flattenObject({
        notifications: {
          enabled: true,
          events: ["waiting", "finished"],
          backend: "auto",
          delayMs: 1000,
        },
      }),
    ).toEqual([
      ["notifications.enabled", "true"],
      ["notifications.events", '["waiting","finished"]'],
      ["notifications.backend", '"auto"'],
      ["notifications.delayMs", "1000"],
    ]);
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

describe("config set notifications.*", () => {
  it("sets notifications.enabled and prints the ccmux notify note", async () => {
    store = {};
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.enabled", "true");

      expect(exit).toBeNull();
      expect(store.notifications?.enabled).toBe(true);
      expect(
        logSpy.mock.calls.some((c) => String(c[0]).includes("ccmux notify")),
      ).toBe(true);
    } finally {
      restoreExit();
      logSpy.mockRestore();
    }
  });

  it("does not print the note when disabling", async () => {
    store = {};
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.enabled", "false");

      expect(exit).toBeNull();
      expect(store.notifications?.enabled).toBe(false);
      expect(
        logSpy.mock.calls.some((c) => String(c[0]).includes("ccmux notify")),
      ).toBe(false);
    } finally {
      restoreExit();
      logSpy.mockRestore();
    }
  });

  it("merges nested keys without clobbering previously set ones", async () => {
    store = { notifications: { enabled: true, sound: "Glass" } };
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.delayMs", "500");
      expect(exit).toBeNull();
      expect(store.notifications).toEqual({
        enabled: true,
        sound: "Glass",
        delayMs: 500,
      });
    } finally {
      restoreExit();
    }
  });

  it("rejects an invalid backend", async () => {
    store = {};
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.backend", "bogus");
      expect(exit?.code).toBe(1);
      expect(store.notifications?.backend).toBeUndefined();
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });

  it("rejects events outside waiting/finished", async () => {
    store = {};
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.events", "waiting,bogus");
      expect(exit?.code).toBe(1);
      expect(store.notifications?.events).toBeUndefined();
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });

  it("rejects a negative delayMs", async () => {
    store = {};
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.delayMs", "-5");
      expect(exit?.code).toBe(1);
      expect(store.notifications?.delayMs).toBeUndefined();
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });

  it("rejects a non-integer delayMs", async () => {
    store = {};
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.delayMs", "1.5");
      expect(exit?.code).toBe(1);
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });

  it("accepts a valid comma-separated events list", async () => {
    store = {};
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.events", "waiting");
      expect(exit).toBeNull();
      expect(store.notifications?.events).toEqual(["waiting"]);
    } finally {
      restoreExit();
    }
  });

  it("accepts sound as boolean or a sound name", async () => {
    store = {};
    const restoreExit = withExitSentinel();
    try {
      let exit = await runConfigSet("notifications.sound", "true");
      expect(exit).toBeNull();
      expect(store.notifications?.sound).toBe(true);

      exit = await runConfigSet("notifications.sound", "Glass");
      expect(exit).toBeNull();
      expect(store.notifications?.sound).toBe("Glass");
    } finally {
      restoreExit();
    }
  });

  it("rejects an unknown notifications key", async () => {
    store = {};
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("notifications.bogus", "x");
      expect(exit?.code).toBe(1);
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });
});

describe("KNOWN_KEYS.tmuxSocket", () => {
  const spec = KNOWN_KEYS.tmuxSocket!;

  it("validate accepts a label and a socket path", () => {
    expect(spec.validate("work")).toBe(true);
    expect(spec.validate("/tmp/tmux-501/work")).toBe(true);
  });

  it("validate rejects empty and whitespace-only values", () => {
    expect(spec.validate("")).toBe(false);
    expect(spec.validate("   ")).toBe(false);
  });

  it("parse trims, matching how the value is read back", () => {
    expect(spec.parse("  work  ")).toBe("work");
  });

  it("sets the key and prints the daemon-restart note", async () => {
    store = {};
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("tmuxSocket", "work");

      expect(exit).toBeNull();
      expect(store.tmuxSocket).toBe("work");
      expect(
        logSpy.mock.calls.some((c) => String(c[0]).includes("daemon restart")),
      ).toBe(true);
    } finally {
      restoreExit();
      logSpy.mockRestore();
    }
  });

  it("rejects a blank value rather than storing it", async () => {
    store = {};
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      const exit = await runConfigSet("tmuxSocket", "   ");
      expect(exit?.code).toBe(1);
      expect(store.tmuxSocket).toBeUndefined();
    } finally {
      restoreExit();
      errorSpy.mockRestore();
    }
  });
});

describe("KNOWN_KEYS.reviewHandback", () => {
  const spec = KNOWN_KEYS.reviewHandback!;

  it("validate accepts the known delivery modes", () => {
    expect(spec.validate("auto")).toBe(true);
    expect(spec.validate("confirm")).toBe(true);
    expect(spec.validate("fill")).toBe(true);
  });

  it("validate rejects unknown values", () => {
    expect(spec.validate("bogus")).toBe(false);
    expect(spec.validate("")).toBe(false);
  });

  it("parse returns the value unchanged", () => {
    expect(spec.parse("auto")).toBe("auto");
  });
});

// completableConfigKeys() is a hand-maintained literal array (KNOWN_KEYS plus
// eight hardcoded dotted strings); the "set" action's acceptance of those
// dotted keys is control flow (an if/else for sidebar.*, a switch for
// notifications.*), not a shared data structure. Nothing else asserts the two
// stay in sync, so a new notifications.<key> case can ship uncompletable with
// every other test still green. This suite fails the moment they drift.
describe("completableConfigKeys() parity with config set", () => {
  // Signals `config set` prints only on the "I don't recognize this key"
  // paths (top-level, sidebar.<key>, notifications.<key>). A value-validation
  // error (e.g. "Invalid value for previewWidth: ...") never includes these,
  // so checking for them isolates "key unrecognized" from "value rejected".
  const UNKNOWN_KEY_SIGNALS = [
    "Valid keys:",
    "Valid sidebar keys:",
    "Valid notifications keys:",
  ] as const;

  // A value `config set` should actually accept for each completable key, so
  // a rejection can only mean the key itself was not recognized. Enumerable
  // keys pull their first choice from configValueChoices(); the rest are
  // free-form and read straight off each validator in config.ts.
  function plausibleValueFor(key: string): string {
    const choices = configValueChoices(key);
    if (choices && choices.length > 0) return choices[0]!;
    switch (key) {
      case "previewWidth":
        return "40"; // integer 20-80
      case "searchPaneLines":
        return "50"; // integer 10-500
      case "command":
        return "claude"; // non-empty string
      case "tmuxSocket":
        return "work"; // non-empty string
      case "additionalClaudeConfigDirs":
        return '["~/.claude-personal"]'; // JSON array of abs/~ paths
      case "sidebar.width":
        return "40"; // integer 10-80
      case "promptLines":
      case "sidebar.promptLines":
        return "3"; // integer 0-MAX_PROMPT_LINES
      case "notifications.delayMs":
        return "500"; // non-negative integer
      case "notifications.command":
        return "notify-send"; // non-empty string
      default:
        throw new Error(
          `plausibleValueFor: no fixture value for "${key}" — ` +
            `add one so the parity test can exercise it`,
        );
    }
  }

  it("recognizes every key completableConfigKeys() offers as a valid config set key", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const restoreExit = withExitSentinel();
    try {
      for (const key of completableConfigKeys()) {
        store = {};
        errorSpy.mockClear();
        const value = plausibleValueFor(key);

        await runConfigSet(key, value);

        const unknownKeyRejection = errorSpy.mock.calls.some((call) =>
          UNKNOWN_KEY_SIGNALS.some((signal) =>
            String(call[0]).includes(signal),
          ),
        );
        if (unknownKeyRejection) {
          throw new Error(
            `completableConfigKeys() offers "${key}" but config set rejects ` +
              `it as unknown: ${errorSpy.mock.calls.map((c) => c.join(" ")).join(" | ")}`,
          );
        }
      }
    } finally {
      restoreExit();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
