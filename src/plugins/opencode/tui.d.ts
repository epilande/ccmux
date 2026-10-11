/**
 * Type surface for the authored OpenCode 2 TUI plugin. The real
 * implementation lives in `tui.js`; this file is solely for TypeScript
 * callers (tests, the renderer). Kept intentionally loose: the plugin talks
 * to OpenCode's runtime, whose types are not in our dependency graph.
 */

export interface MakeTuiPluginOptions {
  markersDir: string;
  version: string;
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  pollMs?: number;
}

export type OpencodeRoute =
  | { type: "home" }
  | { type: "session"; sessionID: string }
  | { type: "plugin"; id: string; name: string };

/** The slice of OpenCode 2's TUI plugin context the plugin reads. */
export interface OpencodeTuiContext {
  ui: { router: { current(): OpencodeRoute } };
  data: {
    listen(
      handler: (event: { details: { type: string; data?: unknown } }) => void,
    ): () => void;
    session: {
      get(
        sessionID: string,
      ): { title?: string; location?: { directory?: string } } | undefined;
      root(sessionID: string): string;
      family(sessionID: string): string[];
      status(sessionID: string): "idle" | "running";
      message: { list(sessionID: string): unknown[] | undefined };
      permission: {
        list(sessionID: string): unknown[] | undefined;
        sync(sessionID: string): Promise<void>;
      };
      form: {
        list(sessionID: string): unknown[] | undefined;
        sync(sessionID: string): Promise<void>;
      };
    };
  };
}

export interface OpencodeTuiPlugin {
  id: string;
  version: string;
  setup(ctx: OpencodeTuiContext): () => void;
}

export function makeTuiPlugin(opts: MakeTuiPluginOptions): OpencodeTuiPlugin;
export function describePermission(request: unknown): string | null;
export function describeForm(form: unknown): string | null;

declare const ccmuxTuiPlugin: OpencodeTuiPlugin;
export default ccmuxTuiPlugin;
