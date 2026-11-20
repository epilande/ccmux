export interface OmpTerminal {
  write(data: string, ...args: unknown[]): unknown;
}

export interface MakeExtensionOptions {
  markersDir: string;
  version: string;
  now?: () => number;
  getActiveTerminal?: () => OmpTerminal | null;
  writeMarkerFile?: (path: string, body: string) => Promise<unknown>;
}

export interface OmpSessionManager {
  getSessionId(): string | undefined;
  getSessionFile(): string | undefined;
}

export interface OmpPlanReview {
  reviewId: string;
}

export interface OmpExtensionContext {
  cwd: string;
  mode?: string;
  ui?: object;
  hasUI?: boolean;
  agent?: { id?: string; kind: "main" | "sub" };
  isIdle?(): boolean;
  getPendingPlanReview?(): OmpPlanReview | undefined;
  sessionManager: OmpSessionManager;
}

export interface OmpSessionSwitchOptions {
  preserveLocalCwd?: boolean;
  keepModel?: boolean;
}

export interface OmpNativeSession {
  readonly instanceKey?: string;
  sessionManager: OmpSessionManager;
  readonly transcriptEpoch?: number;
  readonly isRunActive?: boolean;
  readonly hasAdmittedSubmission?: boolean;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly isBackgroundCompacting?: boolean;
  readonly isBashRunning?: boolean;
  readonly isEvalRunning?: boolean;
  readonly isRetrying?: boolean;
  readonly isAborting?: boolean;
  subscribe?(listener: (event: unknown) => void): () => void;
  subscribeRunState?(listener: (state: "running" | "idle") => void): () => void;
  switchSession?(file: string, options?: OmpSessionSwitchOptions): Promise<boolean>;
  getPlanModeState?(): { enabled: boolean } | undefined;
  extensionRunner?: { getUIContext(): object; hasUI?(): boolean };
  agent?: object;
}

export interface OmpExtensionApi {
  pi?: {
    AgentRegistry?: {
      global(): { get(id: string): { session: OmpNativeSession | null } | undefined };
    };
  };
  on(
    event: string,
    handler: (event: unknown, ctx: OmpExtensionContext) => void | Promise<void>,
  ): void;
}

export type OmpExtension = ((omp: OmpExtensionApi) => void) & { version: string };
export function makeExtension(opts: MakeExtensionOptions): OmpExtension;
declare const ccmuxExtension: OmpExtension;
export default ccmuxExtension;
