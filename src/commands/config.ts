import { Command } from "commander";
import { isAbsolute } from "node:path";
import {
  getPreferences,
  setPreferences,
  VALID_GROUP_BY,
  VALID_PROMPT_DISPLAYS,
  VALID_REVIEW_HANDBACK,
  BREAKPOINT_NAMES,
  COLUMN_FIELDS,
  VALID_NOTIFICATION_BACKENDS,
  VALID_NOTIFICATION_EVENTS,
  type BreakpointConfig,
  type ColumnsConfig,
  type ColumnEntry,
  type NotificationsConfig,
  type Preferences,
  type RowConfig,
} from "../lib/preferences";
import { VALID_ICON_STYLES, type IconStyle } from "../lib/icons";
import { BUILTIN_THEME_NAMES, DEFAULT_THEME_NAME } from "../tui/themes";
import { resolveThemeVerbose } from "../tui/theme";

export const KNOWN_KEYS: Record<
  string,
  {
    validate: (v: string) => boolean;
    parse: (v: string) => unknown;
    description: string;
    /** Printed after a successful set (e.g. "takes effect on restart"). */
    note?: string;
  }
> = {
  iconStyle: {
    validate: (v) => VALID_ICON_STYLES.includes(v as IconStyle),
    parse: (v) => v as IconStyle,
    description: `Icon style (${VALID_ICON_STYLES.join(", ")})`,
  },
  showPreview: {
    validate: (v) => v === "true" || v === "false",
    parse: (v) => v === "true",
    description: "Show preview panel in picker (true, false)",
  },
  previewWidth: {
    validate: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 20 && n <= 80;
    },
    parse: (v) => Number(v),
    description: "Preview panel width percentage (20–80, default 40)",
  },
  command: {
    validate: (v) => v.trim().length > 0,
    parse: (v) => v.trim(),
    description: "CLI command for session restart (e.g., c, claude)",
  },
  groupBy: {
    validate: (v) => (VALID_GROUP_BY as readonly string[]).includes(v),
    parse: (v) => v,
    description: `Group sessions by (${VALID_GROUP_BY.join(", ")})`,
  },
  promptDisplay: {
    validate: (v) => (VALID_PROMPT_DISPLAYS as readonly string[]).includes(v),
    parse: (v) => v,
    description: `Prompt display mode (${VALID_PROMPT_DISPLAYS.join(", ")}; default inline)`,
  },
  backgroundAgents: {
    validate: (v) => v === "true" || v === "false",
    parse: (v) => v === "true",
    description:
      "Show Claude background agents as rows (true, false; default true, daemon restart required)",
    note: "Takes effect after a daemon restart (ccmux daemon restart)",
  },
  additionalClaudeConfigDirs: {
    validate: (v) => {
      try {
        const parsed = JSON.parse(v);
        return (
          Array.isArray(parsed) &&
          parsed.every(
            (d) =>
              typeof d === "string" && (isAbsolute(d) || d.startsWith("~/")),
          )
        );
      } catch {
        return false;
      }
    },
    parse: (v) => JSON.parse(v) as string[],
    description:
      "Additional Claude config dirs to watch, as a JSON array of absolute or ~/-prefixed paths (e.g. '[\"~/.claude-personal\"]')",
    note: "Run `ccmux setup --agent claude` to install hooks into the new dirs, then restart the daemon (ccmux daemon restart)",
  },
  searchPaneContent: {
    validate: (v) => v === "true" || v === "false",
    parse: (v) => v === "true",
    description:
      "Search pane content in TUI search (true, false; default true)",
  },
  searchPaneLines: {
    validate: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 10 && n <= 500;
    },
    parse: (v) => Number(v),
    description:
      "Lines of pane content to scan in TUI search (10–500, default 100)",
  },
  searchTranscript: {
    validate: (v) => v === "true" || v === "false",
    parse: (v) => v === "true",
    description:
      "Search live Claude/Codex transcripts via the daemon (true, false; default true)",
  },
  persistent: {
    validate: (v) => v === "true" || v === "false",
    parse: (v) => v === "true",
    description:
      "Keep picker open after switching sessions (true, false; default false)",
  },
  reviewHandback: {
    validate: (v) => (VALID_REVIEW_HANDBACK as readonly string[]).includes(v),
    parse: (v) => v,
    description: `Hunk review note delivery (${VALID_REVIEW_HANDBACK.join(", ")}; default confirm)`,
  },
  theme: {
    validate: (v) => BUILTIN_THEME_NAMES.includes(v),
    parse: (v) => v,
    description: `TUI theme (${BUILTIN_THEME_NAMES.join(", ")}; default ${DEFAULT_THEME_NAME})`,
    note: "Takes effect on next picker/sidebar launch. For per-key overrides, edit theme as an object in ccmux.json (see ccmux config themes).",
  },
};

const ROW_NAMES = ["row1", "row2"] as const;
const SIDE_NAMES = ["left", "right"] as const;

function isBreakpointName(
  key: string,
): key is (typeof BREAKPOINT_NAMES)[number] {
  return (BREAKPOINT_NAMES as readonly string[]).includes(key);
}

function isRowName(key: string): key is (typeof ROW_NAMES)[number] {
  return (ROW_NAMES as readonly string[]).includes(key);
}

function isSideName(key: string): key is (typeof SIDE_NAMES)[number] {
  return (SIDE_NAMES as readonly string[]).includes(key);
}

/**
 * Parse a comma-separated entry list like "index,status:icon,project".
 * Each entry is `<field>` or `<field>:<mode>`. Returns null on invalid input.
 */
function parseEntryList(value: string): ColumnEntry[] | null {
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0 && value.trim().length > 0) return null;
  for (const p of parts) {
    const colonIdx = p.indexOf(":");
    const fieldStr = colonIdx === -1 ? p : p.slice(0, colonIdx);
    if (!COLUMN_FIELDS.includes(fieldStr as (typeof COLUMN_FIELDS)[number])) {
      return null;
    }
  }
  return parts;
}

export function getNestedValue(prefs: Preferences, parts: string[]): unknown {
  let current: unknown = prefs;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Flatten an object into dotted-key notation for display */
export function flattenObject(
  obj: Record<string, unknown>,
  prefix: string = "",
): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      entries.push(...flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      entries.push([fullKey, JSON.stringify(value)]);
    }
  }
  return entries;
}

function setColumnsRowSide(
  prefs: Preferences,
  rowKey: (typeof ROW_NAMES)[number],
  sideKey: (typeof SIDE_NAMES)[number],
  entries: ColumnEntry[],
): ColumnsConfig {
  const columns: ColumnsConfig = { ...(prefs.columns ?? {}) };
  const row: RowConfig = { ...(columns[rowKey] ?? {}) };
  row[sideKey] = entries;
  columns[rowKey] = row;
  return columns;
}

export function createConfigCommand(): Command {
  const cmd = new Command("config").description("Manage preferences");

  cmd
    .command("set")
    .description("Set a preference")
    .argument("<key>", "Preference key")
    .argument("<value>", "Preference value")
    .action(async (key: string, value: string) => {
      const parts = key.split(".");

      if (parts.length === 1) {
        const spec = KNOWN_KEYS[key];
        if (!spec) {
          console.error(`Unknown key: ${key}`);
          console.error(
            `Valid keys: ${Object.keys(KNOWN_KEYS).join(", ")}, columns.<row>.<side>, breakpoints.<name>, sidebar.<key>, notifications.<key>`,
          );
          process.exit(1);
        }
        if (!spec.validate(value)) {
          console.error(`Invalid value for ${key}: ${value}`);
          console.error(`  ${spec.description}`);
          process.exit(1);
        }
        await setPreferences({ [key]: spec.parse(value) });
        console.log(`${key} = ${value}`);
        if (spec.note) console.log(spec.note);
        return;
      }

      if (parts[0] === "breakpoints" && parts.length === 2) {
        const bpName = parts[1];
        if (!isBreakpointName(bpName)) {
          console.error(`Unknown breakpoint: ${bpName}`);
          console.error(`Valid breakpoints: ${BREAKPOINT_NAMES.join(", ")}`);
          process.exit(1);
        }
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          console.error(
            `Invalid breakpoint value: ${value} (must be positive integer)`,
          );
          process.exit(1);
        }
        const prefs = await getPreferences();
        const breakpoints: BreakpointConfig = {
          ...prefs.breakpoints,
          [bpName]: n,
        };
        await setPreferences({ breakpoints });
        console.log(`${key} = ${value}`);
        return;
      }

      if (parts[0] === "columns" && parts.length === 3) {
        const rowKey = parts[1];
        const sideKey = parts[2];
        if (!isRowName(rowKey)) {
          console.error(`Unknown row: ${rowKey}`);
          console.error(`Valid rows: ${ROW_NAMES.join(", ")}`);
          process.exit(1);
        }
        if (!isSideName(sideKey)) {
          console.error(`Unknown side: ${sideKey}`);
          console.error(`Valid sides: ${SIDE_NAMES.join(", ")}`);
          process.exit(1);
        }
        const entries = parseEntryList(value);
        if (entries === null) {
          console.error(`Invalid entry list: ${value}`);
          console.error(
            `  Comma-separated; each entry: <field> or <field>:<mode>`,
          );
          console.error(`  Valid fields: ${COLUMN_FIELDS.join(", ")}`);
          process.exit(1);
        }
        const prefs = await getPreferences();
        const columns = setColumnsRowSide(prefs, rowKey, sideKey, entries);
        await setPreferences({ columns });
        console.log(`${key} = ${JSON.stringify(entries)}`);
        return;
      }

      if (parts[0] === "sidebar" && parts.length === 2) {
        const sidebarKey = parts[1];
        if (sidebarKey === "width") {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 10 || n > 80) {
            console.error("Invalid sidebar width (must be integer 10-80)");
            process.exit(1);
          }
          const prefs = await getPreferences();
          await setPreferences({ sidebar: { ...prefs.sidebar, width: n } });
        } else if (sidebarKey === "position") {
          if (value !== "left" && value !== "right") {
            console.error("Invalid sidebar position (left, right)");
            process.exit(1);
          }
          const prefs = await getPreferences();
          await setPreferences({
            sidebar: { ...prefs.sidebar, position: value },
          });
        } else {
          console.error(`Unknown sidebar key: ${sidebarKey}`);
          console.error("Valid sidebar keys: width, position");
          process.exit(1);
        }
        console.log(`${key} = ${value}`);
        return;
      }

      if (parts[0] === "notifications" && parts.length === 2) {
        const notifKey = parts[1];
        const prefs = await getPreferences();
        const notifications: NotificationsConfig = { ...prefs.notifications };
        let note: string | undefined;

        switch (notifKey) {
          case "enabled": {
            if (value !== "true" && value !== "false") {
              console.error("Invalid notifications.enabled (true, false)");
              process.exit(1);
            }
            notifications.enabled = value === "true";
            if (notifications.enabled) {
              note =
                "Run `ccmux notify` to send a test notification and grant permission (macOS)";
            }
            break;
          }
          case "delayMs": {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 0) {
              console.error(
                "Invalid notifications.delayMs (non-negative integer)",
              );
              process.exit(1);
            }
            notifications.delayMs = n;
            break;
          }
          case "backend": {
            if (
              !(VALID_NOTIFICATION_BACKENDS as readonly string[]).includes(
                value,
              )
            ) {
              console.error(`Invalid notifications.backend: ${value}`);
              console.error(
                `Valid backends: ${VALID_NOTIFICATION_BACKENDS.join(", ")}`,
              );
              process.exit(1);
            }
            notifications.backend = value as NotificationsConfig["backend"];
            break;
          }
          case "events": {
            const events = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            const valid =
              events.length > 0 &&
              events.every((e) =>
                (VALID_NOTIFICATION_EVENTS as readonly string[]).includes(e),
              );
            if (!valid) {
              console.error(`Invalid notifications.events: ${value}`);
              console.error(
                `  Comma-separated subset of: ${VALID_NOTIFICATION_EVENTS.join(", ")}`,
              );
              process.exit(1);
            }
            notifications.events = events as NotificationsConfig["events"];
            break;
          }
          case "sound": {
            if (value === "true" || value === "false") {
              notifications.sound = value === "true";
            } else if (value.trim().length > 0) {
              notifications.sound = value;
            } else {
              console.error(
                "Invalid notifications.sound (true, false, or a sound name)",
              );
              process.exit(1);
            }
            break;
          }
          case "command": {
            if (value.trim().length === 0) {
              console.error(
                "Invalid notifications.command (must be non-empty)",
              );
              process.exit(1);
            }
            notifications.command = value;
            break;
          }
          case "icon": {
            if (value.trim().length === 0) {
              console.error("Invalid notifications.icon (must be non-empty)");
              process.exit(1);
            }
            notifications.icon = value;
            break;
          }
          default: {
            console.error(`Unknown notifications key: ${notifKey}`);
            console.error(
              "Valid notifications keys: enabled, events, sound, delayMs, backend, command, icon",
            );
            process.exit(1);
          }
        }

        await setPreferences({ notifications });
        console.log(`${key} = ${value}`);
        if (note) console.log(note);
        return;
      }

      console.error(`Unknown key: ${key}`);
      console.error(
        `Valid keys: ${Object.keys(KNOWN_KEYS).join(", ")}, columns.<row>.<side>, breakpoints.<name>, sidebar.<key>, notifications.<key>`,
      );
      process.exit(1);
    });

  cmd
    .command("get")
    .description("Get a preference value")
    .argument("<key>", "Preference key")
    .action(async (key: string) => {
      const prefs = await getPreferences();
      const parts = key.split(".");
      const value = getNestedValue(prefs, parts);
      if (value === undefined) {
        console.log(`${key}: (not set)`);
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const flattened = flattenObject(value as Record<string, unknown>, key);
        for (const [k, v] of flattened) {
          console.log(`${k} = ${v}`);
        }
      } else {
        console.log(`${key} = ${JSON.stringify(value)}`);
      }
    });

  cmd
    .command("themes")
    .description("List built-in themes and show the active one")
    .action(async () => {
      const prefs = await getPreferences();
      // resolveThemeVerbose owns the fallback rule; it reports the effective
      // base name and whether any override actually survived validation.
      const { resolvedBase, appliedOverrides, warnings } = resolveThemeVerbose(
        prefs.theme,
      );

      console.log("Built-in themes:");
      for (const name of BUILTIN_THEME_NAMES) {
        const tags: string[] = [];
        if (name === DEFAULT_THEME_NAME) tags.push("default");
        if (name === resolvedBase) {
          tags.push(appliedOverrides ? "active, +overrides" : "active");
        }
        const suffix = tags.length > 0 ? `  (${tags.join(", ")})` : "";
        console.log(`  ${name}${suffix}`);
      }

      if (warnings.length > 0) {
        console.log("");
        console.log("Problems with current theme config:");
        for (const w of warnings) console.log(`  ! ${w}`);
      }
    });

  cmd
    .command("list", { isDefault: true })
    .description("List all preferences")
    .action(async () => {
      const prefs = await getPreferences();
      const entries = flattenObject(prefs as Record<string, unknown>);
      if (entries.length === 0) {
        console.log("No preferences set");
        return;
      }
      for (const [key, value] of entries) {
        console.log(`${key} = ${value}`);
      }
    });

  return cmd;
}
