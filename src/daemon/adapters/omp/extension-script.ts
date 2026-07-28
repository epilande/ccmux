// Text import: Bun inlines the extension source at bundle time and loads
// it natively when running from src. A filesystem read relative to
// `import.meta.url` breaks under `dist/index.js` (the relative path escapes
// the repo), so the source must travel inside the module graph. Mirrors
// `src/daemon/adapters/pi/extension-script.ts`.
import rawExtensionSource from "../../../plugins/omp/ccmux.js" with { type: "text" };

// tsc types the import via ccmux.d.ts; Bun's text loader actually yields
// the file's source string.
const extensionSource = rawExtensionSource as unknown as string;

const SENTINEL_MARKERS_DIR = '"__CCMUX_MARKERS_DIR__"';
const SENTINEL_VERSION = '"__CCMUX_VERSION__"';

interface RenderOmpExtensionOptions {
  markersDir: string;
  version: string;
}

/**
 * Render the authored extension with install-time sentinel substitution.
 * Quoted tokens get `JSON.stringify(value)` so paths with special chars
 * stay valid JS string literals. The bare version token in the
 * `// ccmux-extension v...` comment line gets a plain replace so the
 * sentinel comment carries the installed version.
 */
export function renderOmpExtension(opts: RenderOmpExtensionOptions): string {
  return extensionSource
    .replaceAll(SENTINEL_MARKERS_DIR, JSON.stringify(opts.markersDir))
    .replaceAll(SENTINEL_VERSION, JSON.stringify(opts.version))
    .replaceAll("__CCMUX_VERSION__", opts.version);
}

/** Exposed for tests that want to assert against the raw template. */
export function getOmpExtensionSourceForTests(): string {
  return extensionSource;
}
