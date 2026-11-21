import Anser from "anser";
import { StyledText, RGBA, TextAttributes } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import type { Ansi16 } from "../../lib/preferences";
import { theme } from "../theme";

/**
 * Ordered ANSI-16 keys, indexed 0-7 (normal) then 8-15 (bright). Maps Anser's
 * color-class index onto the live theme's `ansi` block, so captured pane output
 * in the preview renders in the active palette instead of Anser's washed-out
 * VGA defaults (e.g. red -> 187,0,0). Read at call time (per capture, after
 * `applyTheme`), so the preview follows the configured theme.
 */
const ANSI16_KEYS: (keyof Ansi16)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/** Resolve an ANSI-16 index (0-15) to the live theme's hex. */
function ansiHex(idx: number): string {
  return theme.ansi[ANSI16_KEYS[idx] ?? "white"];
}

const ANSI_CLASS_INDEX: Record<string, number> = {
  "ansi-black": 0,
  "ansi-red": 1,
  "ansi-green": 2,
  "ansi-yellow": 3,
  "ansi-blue": 4,
  "ansi-magenta": 5,
  "ansi-cyan": 6,
  "ansi-white": 7,
  "ansi-bright-black": 8,
  "ansi-bright-red": 9,
  "ansi-bright-green": 10,
  "ansi-bright-yellow": 11,
  "ansi-bright-blue": 12,
  "ansi-bright-magenta": 13,
  "ansi-bright-cyan": 14,
  "ansi-bright-white": 15,
};

const PALETTE_PREFIX = "ansi-palette-";

function parseRgbString(rgb: string): [number, number, number] {
  const parts = rgb.split(",").map((s) => parseInt(s.trim(), 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** xterm 6x6x6 cube level for a 0-5 component (0, then 95/135/175/215/255). */
function cubeChannel(c: number): number {
  return c === 0 ? 0 : c * 40 + 55;
}

/** Standard xterm 256-color index -> RGB (6x6x6 cube + 24-step grayscale). */
function xterm256ToRgb(n: number): [number, number, number] {
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  const i = n - 16;
  return [
    cubeChannel(Math.floor(i / 36)),
    cubeChannel(Math.floor((i % 36) / 6)),
    cubeChannel(i % 6),
  ];
}

/**
 * Resolve an Anser color class (use_classes mode) to an RGBA. The basic 16
 * colors and the first 16 palette entries route through the themed table; the
 * 6x6x6 cube and grayscale ramp are computed; truecolor uses Anser's exact RGB.
 * Anser applies reverse-video by swapping fg/bg before emitting the classes, so
 * no explicit reverse handling is needed here.
 */
function classToRgba(cls: string, truecolor: string): RGBA | undefined {
  if (cls === "ansi-truecolor") {
    return truecolor
      ? RGBA.fromInts(...parseRgbString(truecolor), 255)
      : undefined;
  }
  const idx = ANSI_CLASS_INDEX[cls];
  if (idx !== undefined) return RGBA.fromHex(ansiHex(idx));
  if (cls.startsWith(PALETTE_PREFIX)) {
    const n = Number(cls.slice(PALETTE_PREFIX.length));
    if (!Number.isInteger(n)) return undefined;
    // Defensive: Anser only emits ansi-palette-* for n >= 16 (0-15 resolve to
    // the named ansi-* classes handled above), so this branch is unreachable
    // today; kept as belt-and-suspenders for a hypothetical future Anser.
    if (n < 16) return RGBA.fromHex(ansiHex(n));
    return RGBA.fromInts(...xterm256ToRgb(n), 255);
  }
  return undefined;
}

function mapDecoration(decoration: string | null): number {
  if (!decoration) return 0;
  let attrs = 0;
  if (decoration.includes("bold")) attrs |= TextAttributes.BOLD;
  if (decoration.includes("dim")) attrs |= TextAttributes.DIM;
  if (decoration.includes("italic")) attrs |= TextAttributes.ITALIC;
  if (decoration.includes("underline")) attrs |= TextAttributes.UNDERLINE;
  return attrs;
}

/**
 * OSC sequences: `ESC ]`, a payload, then BEL or ST (`ESC \`). tmux
 * keeps hyperlinks under `capture-pane -e` as OSC 8 and writes both
 * terminators as ST. Anser only knows SGR, so it drops the ESC and paints the
 * rest (`]8;id=1;https://...`) as text. A payload never spans lines, and one
 * cut short stops at the next escape or line end rather than eating the row.
 */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=[\x1b\n])|$)/g;

/** Drop OSC sequences (hyperlinks, titles) and keep the text they wrap. */
function stripOscSequences(input: string): string {
  return input.includes("\x1b]") ? input.replace(OSC_SEQUENCE, "") : input;
}

export function parseAnsiToStyledText(input: string): StyledText {
  const parsed = Anser.ansiToJson(stripOscSequences(input), {
    json: true,
    use_classes: true,
    remove_empty: true,
  });

  const chunks: TextChunk[] = parsed.map((chunk) => ({
    __isChunk: true as const,
    text: chunk.content,
    fg: chunk.fg ? classToRgba(chunk.fg, chunk.fg_truecolor) : undefined,
    bg: chunk.bg ? classToRgba(chunk.bg, chunk.bg_truecolor) : undefined,
    attributes: mapDecoration(chunk.decoration),
  }));

  return new StyledText(chunks);
}

/**
 * Highlight occurrences of a search query in StyledText.
 * Splits chunks at match boundaries, applying a background color to matched segments.
 */
export function highlightSearchMatches(
  styled: StyledText,
  query: string,
  highlightBg: string,
): StyledText {
  if (!query) return styled;

  const lowerQuery = query.toLowerCase();
  const bg = RGBA.fromHex(highlightBg);
  const result: TextChunk[] = [];

  for (const chunk of styled.chunks) {
    const text = chunk.text;
    const lowerText = text.toLowerCase();
    let cursor = 0;

    while (cursor < text.length) {
      const matchIdx = lowerText.indexOf(lowerQuery, cursor);
      if (matchIdx === -1) {
        result.push({ ...chunk, text: text.slice(cursor) });
        break;
      }

      // Text before match
      if (matchIdx > cursor) {
        result.push({ ...chunk, text: text.slice(cursor, matchIdx) });
      }

      // Matched text with highlight background
      result.push({
        ...chunk,
        text: text.slice(matchIdx, matchIdx + lowerQuery.length),
        bg,
        fg: chunk.fg,
        attributes: (chunk.attributes ?? 0) | TextAttributes.BOLD,
      });

      cursor = matchIdx + lowerQuery.length;
    }
  }

  return new StyledText(result);
}
