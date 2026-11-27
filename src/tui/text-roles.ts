import { theme } from "./theme";

/**
 * Text colors chosen per theme for contrast rather than fixed to one token.
 *
 * A palette's `overlay` and `subtext` read as dimmed in a dark theme but fall
 * under WCAG AA in a light one: on Catppuccin Latte's `surface` (selected
 * rows, the toast, the rename prompt) only `text` reaches 4.5:1. No single
 * token is both dim in Mocha and legible in Latte, so a role names its
 * background and takes the dimmest token that reads there. Mocha keeps its
 * dimmed look; Latte gets the contrast. Applied at render time, after the
 * theme is resolved.
 */

/** WCAG AA's floor for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;

/** WCAG 2 contrast ratio between two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * The first of `candidates` that reads at {@link MIN_TEXT_CONTRAST} on
 * `background`, else the most legible of them (a palette whose own body
 * text is under AA there gets the best it has).
 */
function readableOn(background: string, ...candidates: string[]): string {
  const passing = candidates.find(
    (fg) => contrastRatio(fg, background) >= MIN_TEXT_CONTRAST,
  );
  if (passing) return passing;
  return candidates.reduce((best, fg) =>
    contrastRatio(fg, background) > contrastRatio(best, background) ? fg : best,
  );
}

/** Secondary text that still has to be read: as dim as legibility allows. */
function quietOn(background: string): string {
  return readableOn(background, theme.overlay, theme.subtext, theme.text);
}

/** An accent kept where it reads, plain text where it does not. */
function accentOn(accent: string, background: string): string {
  return readableOn(background, accent, theme.text);
}

/** A list row's background: the terminal's own, which a theme assumes is
 *  its `base`. A selected row, the toast and dialogs paint `surface`. */
const row = () => theme.base;
const raised = () => theme.surface;

/**
 * The text group rename draws, each with the background it sits on. A test
 * holds every role to AA in each built-in theme.
 */
export const TEXT_ROLES = {
  /** A renamed or merged header's `from x` / `N sources` marker. */
  groupMarker: { fg: () => quietOn(row()), bg: row },
  /** The same marker on the selected header. */
  groupMarkerSelected: { fg: () => quietOn(raised()), bg: raised },
  /** The group preview's `renamed from` / `N sources:` line. */
  groupSources: { fg: () => quietOn(row()), bg: row },
  /** The rename prompt's `Rename … to:` words and its placeholder. */
  renameTitle: { fg: () => quietOn(raised()), bg: raised },
  /** The rename prompt's key hints. */
  renameHint: { fg: () => quietOn(raised()), bg: raised },
  /** `enter merges into <group>`. */
  renameMerge: { fg: () => accentOn(theme.blue, raised()), bg: raised },
  /** The column count near the cap. */
  renameCount: { fg: () => quietOn(raised()), bg: raised },
  /** `70/64 · cut`, past the cap. */
  renameCut: { fg: () => accentOn(theme.peach, raised()), bg: raised },
  /** Every toast's message (merge, rename and reset among them). */
  toast: { fg: () => quietOn(raised()), bg: raised },
} as const satisfies Record<string, { fg: () => string; bg: () => string }>;
