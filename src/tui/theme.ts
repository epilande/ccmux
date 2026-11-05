import type {
  SemanticColors,
  Ansi16,
  ThemePalette,
  ThemeConfig,
} from "../lib/preferences";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_NAMES,
  DEFAULT_THEME_NAME,
} from "./themes";

/**
 * Live TUI palette. Mutable on purpose: `applyTheme()` overwrites its keys in
 * place before `render()`, so every `import { theme }` site sees the active
 * theme through a stable object identity (no reactivity, launch-time only).
 *
 * Seeded from the default theme so component tests and any code path that never
 * calls `applyTheme()` render the default palette unchanged.
 */
export const theme: SemanticColors & { ansi: Ansi16 } = {
  ...BUILTIN_THEMES[DEFAULT_THEME_NAME]!.semantic,
  ansi: { ...BUILTIN_THEMES[DEFAULT_THEME_NAME]!.ansi },
};

/**
 * How far a view behind a dialog fades toward the background (the `opacity`
 * of its content): enough to read as not in play, not so far that the row
 * under its cursor is lost. Blending keeps each color's hue, so it works
 * with any theme.
 */
export const DIMMED_OPACITY = 0.45;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface ThemeResolution {
  palette: ThemePalette;
  /** Built-in name actually used after fallback (the effective theme). */
  resolvedBase: string;
  /** True if at least one override survived validation and changed the base. */
  appliedOverrides: boolean;
  /** Human-readable problems (unknown base, invalid/unknown override keys). */
  warnings: string[];
}

/**
 * Resolve a {@link ThemeConfig} into a concrete palette, collecting warnings
 * instead of printing them. Fail-soft: an unknown base falls back to the
 * default; an invalid-hex or unknown override key is dropped (base value kept).
 * Shared by `applyTheme` (launch) and `ccmux config themes` (validation).
 */
export function resolveThemeVerbose(
  config: ThemeConfig | undefined,
): ThemeResolution {
  const warnings: string[] = [];

  let baseName = DEFAULT_THEME_NAME;
  let colors: Partial<SemanticColors> | undefined;
  let ansi: Partial<Ansi16> | undefined;

  if (typeof config === "string") {
    baseName = config;
  } else if (config && typeof config === "object") {
    baseName = config.base ?? DEFAULT_THEME_NAME;
    colors = config.colors;
    ansi = config.ansi;
  }

  let base = BUILTIN_THEMES[baseName];
  let resolvedBase = baseName;
  if (!base) {
    warnings.push(
      `unknown theme "${baseName}"; using ${DEFAULT_THEME_NAME}. Valid themes: ${BUILTIN_THEME_NAMES.join(", ")}`,
    );
    base = BUILTIN_THEMES[DEFAULT_THEME_NAME]!;
    resolvedBase = DEFAULT_THEME_NAME;
  }

  const semantic: SemanticColors = { ...base.semantic };
  const ansiOut: Ansi16 = { ...base.ansi };

  const applied =
    applyOverrides(semantic, colors, "colors", warnings) +
    applyOverrides(ansiOut, ansi, "ansi", warnings);

  return {
    palette: { semantic, ansi: ansiOut },
    resolvedBase,
    appliedOverrides: applied > 0,
    warnings,
  };
}

/**
 * Apply per-key hex overrides onto a base color map in place, dropping unknown
 * keys and invalid hex (each with a warning). Returns the count applied.
 * Generic over the target so callers pass `SemanticColors`/`Ansi16` directly;
 * the one internal cast covers the dynamic key write.
 */
function applyOverrides<T extends object>(
  target: T,
  overrides: Partial<Record<keyof T, unknown>> | undefined,
  label: string,
  warnings: string[],
): number {
  if (!overrides) return 0;
  const rec = target as Record<string, string>;
  let applied = 0;
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in rec)) {
      warnings.push(`ignoring unknown ${label} key "${key}"`);
      continue;
    }
    if (typeof value !== "string" || !HEX_RE.test(value)) {
      warnings.push(
        `invalid hex for ${label}.${key}: ${JSON.stringify(value)}; keeping base value`,
      );
      continue;
    }
    rec[key] = value;
    applied++;
  }
  return applied;
}

/** Resolve a {@link ThemeConfig} into a palette, discarding warnings. */
export function resolveTheme(config?: ThemeConfig): ThemePalette {
  return resolveThemeVerbose(config).palette;
}

/**
 * Resolve `config` and overwrite the live {@link theme} singleton in place.
 * Call once before `render()`. Warnings go to stderr (visible in scrollback on
 * exit); `ccmux config themes` is the authoritative place to inspect them.
 */
export function applyTheme(config?: ThemeConfig): void {
  const { palette, warnings } = resolveThemeVerbose(config);
  for (const w of warnings) console.error(`ccmux: theme: ${w}`);
  Object.assign(theme, palette.semantic);
  Object.assign(theme.ansi, palette.ansi);
}

/**
 * Reset the live singleton to the default palette. For test hygiene: the
 * mutation is process-global, so any test that calls `applyTheme` must reset
 * afterwards to avoid leaking state into later tests.
 */
export function resetTheme(): void {
  const def = BUILTIN_THEMES[DEFAULT_THEME_NAME]!;
  Object.assign(theme, def.semantic);
  Object.assign(theme.ansi, def.ansi);
}
