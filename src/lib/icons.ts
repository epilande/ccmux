import type { SessionStatus, AttentionType, AttentionState } from "../types";

export type IconStyle = "none" | "emoji" | "nerdfont" | "dot";

export const VALID_ICON_STYLES: IconStyle[] = [
  "none",
  "emoji",
  "nerdfont",
  "dot",
];

export function isValidIconStyle(value: string): value is IconStyle {
  return (VALID_ICON_STYLES as readonly string[]).includes(value);
}

/**
 * Columns a status glyph of `style` occupies. A status cell is sized from this
 * rather than from its label, because the label's length says nothing about
 * the glyph in front of it: every emoji here is two columns wide. `none` keeps
 * the one column its empty glyph has always been given.
 */
export function statusIconWidth(style: IconStyle = "dot"): number {
  return style === "emoji" ? 2 : 1;
}

/** Half-circle spinner frames for dot style working state */
export const DOT_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;

/** Progress spinner frames for nerdfont working state */
export const NERDFONT_SPINNER_FRAMES = [
  "\uEE06",
  "\uEE07",
  "\uEE08",
  "\uEE09",
  "\uEE0A",
  "\uEE0B",
] as const;

const emojiIcons: Record<string, string> = {
  working: "⚡",
  "waiting:permission": "🔐",
  "waiting:plan_approval": "📋",
  "waiting:": "⏳",
  "waiting:other": "❓",
  idle: "💤",
  done: "✅",
  unread: "📬",
  read: "✅",
};

const nerdfontIcons: Record<string, string> = {
  working: "\uF0E7",
  "waiting:permission": "\uF023",
  "waiting:plan_approval": "\uF0EA",
  "waiting:": "\uF253",
  "waiting:other": "\uF059",
  idle: "\u{F04B2}",
  done: "\uF00C",
  unread: "\u{F0EB0}",
  read: "\uF00C",
};

/**
 * Terminal-outcome glyphs for a finished `ccmux invoke` worker row, per
 * icon style. The `running` state has no entry here: it reuses the normal
 * animated "working" spinner (see `InvokeStatusBadge`). `none` returns ""
 * to honor the no-icons preference, matching `getStatusIcon`.
 */
const invokeTerminalIcons: Record<
  Exclude<IconStyle, "none">,
  Record<"succeeded" | "failed" | "cancelled", string>
> = {
  dot: { succeeded: "✓", failed: "✗", cancelled: "⊘" },
  emoji: { succeeded: "✅", failed: "❌", cancelled: "🚫" },
  nerdfont: { succeeded: "", failed: "", cancelled: "" },
};

/** Returns the glyph for a finished invoke outcome (succeeded/failed/cancelled). */
export function getInvokeTerminalIcon(
  status: "succeeded" | "failed" | "cancelled",
  style: IconStyle = "dot",
): string {
  if (style === "none") return "";
  return invokeTerminalIcons[style][status];
}

/**
 * Distinct single-glyph set for background (background-agent) rows. A diamond
 * family (◆/◈/◇) for dot/nerdfont reads as "a different kind of row" against
 * the normal circle/square (●/■); emoji gets its own set. Single-char so it
 * fits the status cell's 1-char `icon` budget, and static (no spinner) because
 * background state updates at turn boundaries, not continuously. Color still
 * carries the waiting subtype via `getStatusColor`.
 */
export function getBackgroundIcon(
  status: SessionStatus | string,
  style: IconStyle = "dot",
): string {
  if (style === "none") return "";
  if (style === "emoji") {
    if (status === "working") return "🤖";
    if (status === "waiting") return "🙋";
    return "😴";
  }
  // dot + nerdfont: diamond family
  if (status === "working") return "◆";
  if (status === "waiting") return "◈";
  return "◇";
}

/** Returns the icon for an attention state (unread/read). */
export function getAttentionIcon(
  attentionState: AttentionState,
  style: IconStyle = "dot",
): string {
  if (style === "none" || !attentionState) return "";
  if (style === "dot") return "●";
  const icons = style === "emoji" ? emojiIcons : nerdfontIcons;
  return icons[attentionState] ?? icons.done;
}

/** Returns the static icon for a given status + style. */
export function getStatusIcon(
  status: SessionStatus | string,
  attentionType?: AttentionType | null,
  style: IconStyle = "dot",
): string {
  if (style === "none") return "";

  if (style === "dot") {
    if (status === "waiting") return "■";
    // "working" returns static ●; animation handled by TUI
    return "●";
  }

  const icons = style === "emoji" ? emojiIcons : nerdfontIcons;

  if (status === "working") return icons.working;
  if (status === "idle") return icons.idle;

  if (status === "waiting") {
    if (attentionType === "permission") return icons["waiting:permission"];
    if (attentionType === "plan_approval")
      return icons["waiting:plan_approval"];
    if (attentionType) return icons["waiting:other"];
    // waiting with no attention subtype (generic)
    return icons["waiting:"];
  }

  return "●";
}
