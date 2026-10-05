// Text import: Bun inlines the plugin source at bundle time and loads it
// natively when running from src. A filesystem read relative to
// `import.meta.url` breaks under `dist/index.js` (the relative path
// escapes the repo), so the source must travel inside the module graph.
import rawPluginSource from "../../../plugins/opencode/plugin.js" with { type: "text" };
import rawTuiPluginSource from "../../../plugins/opencode/tui.js" with { type: "text" };

// tsc types the imports as the plugin modules; Bun's text loader actually
// yields each file's source string.
const pluginSource = rawPluginSource as unknown as string;
const tuiPluginSource = rawTuiPluginSource as unknown as string;

const SENTINEL_MARKERS_DIR = '"__CCMUX_MARKERS_DIR__"';
const SENTINEL_VERSION = '"__CCMUX_VERSION__"';

interface RenderOpenCodePluginOptions {
  markersDir: string;
  version: string;
}

/**
 * Render the authored plugin with install-time sentinel substitution.
 * Quoted tokens get `JSON.stringify(value)` so paths with special chars
 * stay valid JS string literals. The bare version token in the
 * `// ccmux-plugin v...` comment line gets a plain replace so the
 * sentinel comment carries the installed version.
 */
export function renderOpenCodePlugin(
  opts: RenderOpenCodePluginOptions,
): string {
  return render(pluginSource, opts);
}

/** Render the OpenCode 2 TUI plugin (`tui.js`) the same way. */
export function renderOpenCodeTuiPlugin(
  opts: RenderOpenCodePluginOptions,
): string {
  return render(tuiPluginSource, opts);
}

function render(source: string, opts: RenderOpenCodePluginOptions): string {
  return source
    .replaceAll(SENTINEL_MARKERS_DIR, JSON.stringify(opts.markersDir))
    .replaceAll(SENTINEL_VERSION, JSON.stringify(opts.version))
    .replaceAll("__CCMUX_VERSION__", opts.version);
}

/** Exposed for tests that want to assert against the raw template. */
export function getPluginSourceForTests(): string {
  return pluginSource;
}
