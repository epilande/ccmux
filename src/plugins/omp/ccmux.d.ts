/**
 * Type surface for the authored JS extension. The real implementation
 * lives in `ccmux.js`; this file is solely for TypeScript callers (tests,
 * the renderer). Kept intentionally loose: the extension talks to omp's
 * runtime whose types are not in our dependency graph.
 */

export interface MakeExtensionOptions {
  markersDir: string;
  version: string;
  now?: () => number;
}

export interface OmpExtensionContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string | undefined;
    getSessionFile(): string | undefined;
  };
}

/** Minimal slice of omp's ExtensionAPI used by the ccmux extension. */
export interface OmpExtensionApi {
  on(
    event: string,
    handler: (event: unknown, ctx: OmpExtensionContext) => void | Promise<void>,
  ): void;
}

export type OmpExtension = ((omp: OmpExtensionApi) => void) & {
  version: string;
};

export function makeExtension(opts: MakeExtensionOptions): OmpExtension;

declare const ccmuxExtension: OmpExtension;
export default ccmuxExtension;
