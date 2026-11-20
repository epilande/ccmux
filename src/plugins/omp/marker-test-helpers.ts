import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeExtension } from "./ccmux.js";
import type { MakeExtensionOptions, OmpExtensionApi, OmpExtensionContext, OmpPlanReview } from "./ccmux.js";

export interface OmpMarker {
  agent_type: string;
  pid: number;
  session_id: string;
  timestamp: number;
  state_timestamp: number;
  state: string;
  state_authoritative: boolean;
  conversation_epoch: string;
  in_plan_mode: boolean;
  ambiguous_wait: boolean;
  last_prompt: string | null;
  transcript_path: string | null;
  pending_tool?: string;
  wait_id?: string;
}

export function readOmpMarker(directory: string, id: string): OmpMarker {
  return JSON.parse(readFileSync(join(directory, `omp-${id}.json`), "utf8"));
}

export async function waitUntil(check: () => boolean, label: string) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

export async function waitForMarker(directory: string, id: string, predicate: (marker: OmpMarker) => boolean) {
  let result: OmpMarker | undefined;
  await waitUntil(() => {
    try {
      const marker = readOmpMarker(directory, id);
      if (!predicate(marker)) return false;
      result = marker;
      return true;
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
      throw error;
    }
  }, `matching OMP marker ${id}`);
  if (!result) throw new Error(`No matching marker for ${id}`);
  return result;
}

export const waitForIdleMarker = (directory: string, id: string) => waitForMarker(directory, id, marker => marker.state === "idle");

export interface NativeTool {
  execute(...args: unknown[]): unknown;
}

/** SDK boundary fixture. State changes and UI calls remain separate, as in native OMP. */
export function createNativeHarness<T extends object>(directory: string, ui: T, options: Partial<MakeExtensionOptions> = {}) {
  let id = "parent";
  let transcript: string | undefined = "/sessions/parent.jsonl";
  const handlers = new Map<string, (event: unknown, ctx: OmpExtensionContext) => void | Promise<void>>();
  const listeners = new Set<(event: unknown) => void>();
  const runListeners = new Set<(state: "running" | "idle") => void>();
  const terminalWrites: unknown[][] = [];
  const terminal = {
    write(...args: unknown[]) {
      terminalWrites.push(args);
      return terminalWrites.length;
    },
  };
  const sessionManager = {
    getSessionId: () => id,
    getSessionFile: () => transcript,
  };
  const reviewState: { pendingReview: OmpPlanReview | undefined } = { pendingReview: undefined };
  const toolState: { tools: NativeTool[] } = { tools: [] };
  const session = {
    instanceKey: `fixture:${directory}`,
    sessionManager,
    transcriptEpoch: 0,
    isRunActive: false,
    hasAdmittedSubmission: false,
    isStreaming: false,
    isCompacting: false,
    isBackgroundCompacting: false,
    isBashRunning: false,
    isEvalRunning: false,
    isRetrying: false,
    isAborting: false,
    planEnabled: false,
    switchAllowed: true,
    async switchSession(file: string, _options?: { preserveLocalCwd?: boolean; keepModel?: boolean }) {
      if (!this.switchAllowed) return false;
      transcript = file;
      id = file.split("/").at(-1)?.replace(/\.jsonl$/, "") ?? id;
      handlers.get("session_switch")?.({ type: "session_switch", reason: "resume" }, ctx);
      return true;
    },
    async fork() {
      const previousSessionFile = transcript;
      id = "fork";
      transcript = "/sessions/fork.jsonl";
      handlers.get("session_switch")?.({ type: "session_switch", reason: "fork", previousSessionFile }, ctx);
      return true;
    },
    get pendingReview() { return reviewState.pendingReview; },
    set pendingReview(value: OmpPlanReview | undefined) { reviewState.pendingReview = value; },
    getPlanModeState() { return { enabled: this.planEnabled }; },
    setPlanModeState(state: { enabled: boolean } | undefined) { this.planEnabled = state?.enabled === true; },
    extensionRunner: { getUIContext: () => ui },
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeRunState(listener: (state: "running" | "idle") => void) {
      runListeners.add(listener);
      return () => { runListeners.delete(listener); };
    },
    agent: {
      state: toolState,
      setTools(tools: NativeTool[]) { this.state.tools = tools; },
    },
  };
  const ctx: OmpExtensionContext = {
    cwd: "/repo",
    mode: "tui",
    ui,
    hasUI: true,
    agent: { id: "registered-parent", kind: "main" },
    sessionManager,
    getPendingPlanReview: () => session.pendingReview,
  };
  const api: OmpExtensionApi = {
    pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) } },
    on: (event, handler) => { handlers.set(event, handler); },
  };
  makeExtension({ markersDir: directory, version: "test", getActiveTerminal: () => terminal, ...options })(api);
  const fire = (event: string, payload: unknown = {}, context = ctx) => handlers.get(event)?.(payload, context);
  const wait = (state: string, predicate: (marker: OmpMarker) => boolean = () => true) => waitForMarker(directory, id, marker => marker.state === state && predicate(marker));
  return {
    ctx, session, terminal, terminalWrites, ui, api, handlers, listeners, runListeners, fire, wait,
    read: () => readOmpMarker(directory, id),
    notify(event: unknown = {}) { for (const listener of listeners) listener(event); },
    run(busy: boolean) {
      session.isRunActive = busy;
      for (const listener of runListeners) listener(busy ? "running" : "idle");
    },
    status(state: string) { return terminal.write(`\x1b]7501;state=${state}:app=omp\x1b\\`); },
    async start() { fire("session_start"); return wait("idle"); },
    async rebind(nextId: string, event = "session_switch", file: string | undefined = `/sessions/${nextId}.jsonl`) {
      id = nextId;
      transcript = file;
      fire(event);
      return wait(session.isRunActive ? "working" : "idle");
    },
    async shutdown() {
      fire("session_shutdown");
      await waitUntil(() => !existsSync(join(directory, `omp-${id}.json`)), "closed OMP marker");
    },
  };
}
