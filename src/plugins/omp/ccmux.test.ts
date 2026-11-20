import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNativeHarness, waitUntil } from "./marker-test-helpers";
import type { MakeExtensionOptions } from "./ccmux.js";

let directory: string;
let close: (() => Promise<void>)[];

function harness<T extends object>(ui: T, options?: Partial<MakeExtensionOptions>) {
  const instance = createNativeHarness(directory, ui, options);
  close.push(instance.shutdown);
  return instance;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ccmux-omp-producer-"));
  close = [];
});

afterEach(async () => {
  for (const shutdown of close) await shutdown();
  rmSync(directory, { recursive: true, force: true });
});

interface CustomOptions { overlay?: boolean; signal?: AbortSignal }
interface FocusComponent {
  handleInput?(data: string): void;
  ownsOverlayFocusTarget?(value: object): boolean;
}
interface CustomOverlayHandle {
  hide(): void;
  setHidden(value: boolean): void;
  isHidden(): boolean;
}
interface CustomTui {
  getFocused(): object | null;
  setFocus(value: object | null): void;
  requestRender(): void;
  showOverlay(component: object): CustomOverlayHandle;
}
type CustomFactory = (tui: CustomTui, theme: object, keys: object, done: (value: unknown) => void) => FocusComponent | Promise<FocusComponent>;

function customFixture() {
  let focused: object | null = null;
  let hidden = false;
  const tui: CustomTui = {
    getFocused: () => focused,
    setFocus(value: object | null) { focused = value; },
    requestRender() {},
    showOverlay(component: object) {
      focused = component;
      return {
        hide() { hidden = true; focused = null; },
        setHidden(value: boolean) { hidden = value; focused = value ? null : component; },
        isHidden: () => hidden,
      };
    },
  };
  const ui = {
    custom(factory: CustomFactory, options?: CustomOptions) {
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      let closed = false;
      const done = (value: unknown) => {
        if (closed) return;
        closed = true;
        tui.setFocus(null);
        resolve(value);
      };
      const abort = () => { closed = true; tui.setFocus(null); reject(options?.signal?.reason); };
      options?.signal?.addEventListener("abort", abort, { once: true });
      Promise.try(() => factory(tui, {}, {}, done)).then(component => {
        if (closed) return;
        if (options?.overlay) tui.showOverlay(component);
        else tui.setFocus(component);
        tui.requestRender();
      }, error => { closed = true; reject(error); });
      promise.then(() => options?.signal?.removeEventListener("abort", abort), () => options?.signal?.removeEventListener("abort", abort));
      return promise;
    },
  };
  return { ui, tui };
}

describe("OMP public session observation", () => {
  it("publishes authoritative identity and explicit empty conversation metadata", async () => {
    const h = harness({}, { now: () => 1_700_000_000_000 });
    await h.start();
    expect(h.read()).toMatchObject({
      agent_type: "omp", pid: process.pid, session_id: "parent", state: "idle",
      state_authoritative: true, in_plan_mode: false, ambiguous_wait: false,
      last_prompt: null, transcript_path: "/sessions/parent.jsonl", state_timestamp: 1_700_000_000,
    });
    expect(h.read().wait_id).toBeUndefined();
    expect(h.read().conversation_epoch).toBeString();
  });

  it.each(["hasAdmittedSubmission", "isCompacting", "isBackgroundCompacting", "isBashRunning", "isEvalRunning", "isRetrying"] as const)(
    "observes %s without an agent_start, then settles without an agent_end",
    async field => {
      const h = harness({});
      await h.start();
      h.session[field] = true;
      await h.wait("working");
      h.session[field] = false;
      await h.wait("idle");
    },
  );

  it("captures preflight prompt text without awaiting marker I/O", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const h = harness({}, { writeMarkerFile: async (file, body) => {
      if (hold) { entered.resolve(); await release.promise; }
      await writeFile(file, body);
    } });
    await h.start();
    hold = true;
    h.session.hasAdmittedSubmission = true;
    expect(h.fire("before_agent_start", { prompt: "  fix the bug  " })).toBeUndefined();
    await entered.promise;
    release.resolve();
    await h.wait("working", marker => marker.last_prompt === "fix the bug");
  });

  it("ignores internal and delayed lifecycle completion while the actual run remains open", async () => {
    const h = harness({});
    await h.start();
    h.run(true);
    await h.wait("working");
    h.fire("agent_end", { willContinue: false });
    h.notify({ type: "agent_end" });
    expect(h.read().state).toBe("working");
    h.run(false);
    await h.wait("idle");
  });

  it("keeps async pauses and continuations working until the native run closes", async () => {
    const h = harness({});
    await h.start();
    h.run(true);
    await h.wait("working");
    h.fire("agent_end", { willContinue: true, awaitingAsyncWork: true });
    h.notify({ type: "agent_pause" });
    expect(h.read().state).toBe("working");
    h.run(false);
    await h.wait("idle");
  });

  it("clears same-id conversation state and ignores old custom factory settlement", async () => {
    const ready = Promise.withResolvers<object>();
    const finished = Promise.withResolvers<void>();
    const ui = { custom(factory: () => Promise<object>) { factory(); return finished.promise; } };
    const h = harness(ui);
    await h.start();
    h.run(true);
    h.fire("before_agent_start", { prompt: "old conversation" });
    await h.wait("working", marker => marker.last_prompt === "old conversation");
    const previousEpoch = h.read().conversation_epoch;
    const custom = ui.custom(() => ready.promise);
    h.session.isRunActive = false;
    h.session.transcriptEpoch++;
    h.fire("session_clear");
    await h.wait("idle", marker => marker.last_prompt === null);
    expect(h.read().conversation_epoch).not.toBe(previousEpoch);
    ready.resolve({});
    finished.resolve();
    await custom;
    h.fire("agent_end", { willContinue: false });
    expect(h.read().last_prompt).toBeNull();
    expect(h.read().state).toBe("idle");
    const clearedEpoch = h.read().conversation_epoch;
    h.notify();
    expect(h.read().conversation_epoch).toBe(clearedEpoch);
  });

  it("preserves a genuinely running zero-argument SDK fork and resets prompt metadata", async () => {
    const h = harness({});
    await h.start();
    h.run(true);
    h.fire("before_agent_start", { prompt: "old prompt" });
    await h.wait("working", marker => marker.last_prompt === "old prompt");
    await h.rebind("fork", "session_branch");
    expect(h.read()).toMatchObject({ state: "working", last_prompt: null, transcript_path: "/sessions/fork.jsonl" });
    await waitUntil(() => !existsSync(join(directory, "omp-parent.json")), "old fork marker removal");
    h.run(false);
    await h.wait("idle");
  });

  it("resets same-id reload metadata and drops obsolete future event aliases", async () => {
    const h = harness({});
    await h.start();
    h.fire("before_agent_start", { prompt: "old prompt" });
    await h.wait("idle", marker => marker.last_prompt === "old prompt");
    await h.rebind("parent");
    await h.wait("idle", marker => marker.last_prompt === null);
    expect(h.handlers.has("session_clear")).toBe(true);
    expect(h.handlers.has("session_fork")).toBe(false);
    expect(h.handlers.has("session_tree")).toBe(false);
  });

  it("keeps real getter failures from fabricating idle", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const h = harness({});
    try {
      await h.start();
      h.run(true);
      await h.wait("working");
      h.session.isRunActive = false;
      Object.defineProperty(h.session, "isStreaming", { configurable: true, get() { throw new Error("native observation failure"); } });
      h.notify();
      expect(error).toHaveBeenCalled();
      expect(h.read().state).toBe("working");
      Object.defineProperty(h.session, "isStreaming", { configurable: true, writable: true, value: false });
      h.notify();
      await h.wait("idle");
    } finally { error.mockRestore(); }
  });
});

describe("OMP mirrored replica lifecycle", () => {
  it("uses mirrored lifecycle only after public replica adoption, independently of idle local getters", async () => {
    const h = harness({});
    await h.start();
    await h.session.switchSession("/arbitrary/location/replica.jsonl", { preserveLocalCwd: true, keepModel: true });
    await h.wait("idle");
    h.fire("agent_start");
    await h.wait("working");
    expect(h.session.isRunActive).toBe(false);
    expect(h.session.isStreaming).toBe(false);
    h.notify();
    expect(h.read().state).toBe("working");
    h.fire("agent_end", { willContinue: true, awaitingAsyncWork: true });
    expect(h.read().state).toBe("working");
    h.fire("agent_end", { willContinue: false });
    await h.wait("idle");
  });

  it.each([{}, { preserveLocalCwd: true }, { keepModel: true }])("clears replica hints on an ordinary same-file switch: %j", async options => {
    const h = harness({});
    await h.start();
    const file = "/not-a-path-heuristic/replica.jsonl";
    await h.session.switchSession(file, { preserveLocalCwd: true, keepModel: true });
    await h.wait("idle");
    await h.session.switchSession(file, options);
    h.fire("before_agent_start", { prompt: "ordinary native context" });
    await h.wait("idle", marker => marker.last_prompt === "ordinary native context");
    h.run(true);
    await h.wait("working");
    h.fire("agent_end", { willContinue: false });
    h.fire("before_agent_start", { prompt: "still actual native work" });
    await h.wait("working", marker => marker.last_prompt === "still actual native work");
    h.run(false);
    await h.wait("idle");
  });

  it("retains the prior replica role when an ordinary switch is cancelled", async () => {
    const h = harness({});
    await h.start();
    await h.session.switchSession("/sessions/replica.jsonl", { preserveLocalCwd: true, keepModel: true });
    await h.wait("idle");
    h.session.switchAllowed = false;
    expect(await h.session.switchSession("/sessions/local.jsonl")).toBe(false);
    h.fire("agent_start");
    await h.wait("working");
    h.fire("agent_end", { willContinue: false });
    await h.wait("idle");
  });
});

describe("OMP older SDK feature detection", () => {
  it("preserves event-based permission support without the public registry", async () => {
    const h = harness({});
    delete h.api.pi;
    await h.start();
    h.fire("agent_start");
    await h.wait("working");
    h.fire("tool_approval_requested", { toolCallId: "legacy", toolName: "bash" });
    await h.wait("waiting_permission", marker => marker.pending_tool === "bash");
    h.fire("tool_approval_resolved", { toolCallId: "legacy" });
    await h.wait("working");
    h.fire("agent_end");
    await h.wait("idle");
  });

  it("observes legacy raw UI without inventing a wait for a headless approval event", async () => {
    const answer = Promise.withResolvers<void>();
    const ui = { select: () => answer.promise };
    const h = harness(ui);
    delete h.api.pi;
    await h.start();
    const question = ui.select();
    await h.wait("waiting_question");
    answer.resolve();
    await question;
    await h.wait("idle");
    h.ctx.hasUI = false;
    h.fire("tool_approval_requested", { toolCallId: "headless", toolName: "bash" });
    await h.wait("working");
    h.fire("tool_approval_resolved", { toolCallId: "headless" });
    h.fire("agent_end");
    await h.wait("idle");
  });
});

describe("OMP OSC withdrawal", () => {
  it.each(["working", "blocked:kind=permission", "blocked:kind=question"])("withdraws only the OSC-derived %s evidence on native clear", async status => {
    const h = harness({});
    await h.start();
    h.status(status);
    await h.wait(status === "working" ? "working" : status.endsWith("permission") ? "waiting_permission" : "waiting_question");
    const clear = "\x1b]7501;state=clear\x1b\\";
    h.terminal.write(clear);
    expect(h.terminalWrites.at(-1)).toEqual([clear]);
    await h.wait("idle", marker => marker.wait_id === undefined && !marker.ambiguous_wait);
  });

  it.each(["select", "approve"])("retains a real %s owner after OSC withdrawal and observes its eventual settlement", async method => {
    const answer = Promise.withResolvers<unknown>();
    const ui: Record<string, (...args: unknown[]) => Promise<unknown>> = { [method]: () => answer.promise };
    const h = harness(ui);
    await h.start();
    h.run(true);
    await h.wait("working");
    if (method === "approve") h.fire("tool_approval_requested", { toolCallId: "held", toolName: "bash" });
    const pending = ui[method]("visible dialog");
    const state = method === "approve" ? "waiting_permission" : "waiting_question";
    h.status(method === "approve" ? "blocked:kind=permission" : "blocked:kind=question");
    const owner = await h.wait(state);
    h.terminal.write("\x1b]7501;state=clear\x1b\\");
    h.fire("before_agent_start", { prompt: "after OSC withdrawal" });
    await h.wait(state, marker => marker.wait_id === owner.wait_id && marker.last_prompt === "after OSC withdrawal");
    answer.resolve("answered");
    await pending;
    await h.wait("working", marker => marker.wait_id === undefined && !marker.ambiguous_wait);
    h.run(false);
    await h.wait("idle");
  });
});

describe("OMP live SDK fork ownership", () => {
  it.each(["select", "approve", "editor"])("preserves a live %s owner and its settlement callback across a native identity-only fork", async method => {
    const answer = Promise.withResolvers<unknown>();
    const ui: Record<string, (...args: unknown[]) => Promise<unknown>> = { [method]: () => answer.promise };
    const h = harness(ui);
    await h.start();
    h.run(true);
    h.fire("before_agent_start", { prompt: "before fork" });
    await h.wait("working", marker => marker.last_prompt === "before fork");
    if (method === "approve") h.fire("tool_approval_requested", { toolCallId: "live-approval", toolName: "bash" });
    const pending = ui[method]("still visible after fork");
    const state = method === "approve" ? "waiting_permission" : "waiting_question";
    const owner = await h.wait(state);
    expect(await h.session.fork()).toBe(true);
    const forked = await h.wait(state, marker => marker.last_prompt === null && marker.transcript_path === "/sessions/fork.jsonl");
    expect(forked.session_id).toBe("fork");
    expect(forked.wait_id).toBe(owner.wait_id);
    expect(forked.conversation_epoch).toBe(owner.conversation_epoch);
    expect(forked.pending_tool).toBe(owner.pending_tool);
    await waitUntil(() => !existsSync(join(directory, "omp-parent.json")), "old live-fork marker removal");
    answer.resolve("answered after fork");
    await pending;
    await h.wait("working", marker => marker.wait_id === undefined);
    h.run(false);
    await h.wait("idle");
  });

  it.each(["permission", "question"])("preserves an OSC-only %s owner when a live fork emits no replacement report", async kind => {
    const h = harness({});
    await h.start();
    h.run(true);
    await h.wait("working");
    h.status(`blocked:kind=${kind}`);
    const owner = await h.wait(`waiting_${kind}`);
    expect(await h.session.fork()).toBe(true);
    const forked = await h.wait(`waiting_${kind}`);
    expect(forked.wait_id).toBe(owner.wait_id);
    expect(forked.ambiguous_wait).toBe(kind === "permission");
    h.status("working");
    await h.wait("working");
    h.run(false);
    h.status("done");
    await h.wait("idle");
  });

  it("keeps an in-flight custom factory and its done callback alive across a native fork", async () => {
    const fixture = customFixture();
    const ready = Promise.withResolvers<FocusComponent>();
    const h = harness(fixture.ui);
    await h.start();
    h.run(true);
    await h.wait("working");
    let finish: ((value: unknown) => void) | undefined;
    const pending = fixture.ui.custom((_tui, _theme, _keys, done) => { finish = done; return ready.promise; });
    expect(await h.session.fork()).toBe(true);
    await h.wait("working");
    ready.resolve({ handleInput(_data: string) {} });
    await h.wait("waiting_question");
    if (!finish) throw new Error("Native custom factory did not receive done");
    finish("answered after fork");
    expect(await pending).toBe("answered after fork");
    await h.wait("working");
    h.run(false);
    await h.wait("idle");
  });
});

describe("OMP input ownership", () => {
  it.each(["select", "confirm", "input", "editor", "askDialog", "formDialog"])("tracks raw %s independently of run activity", async method => {
    const answer = Promise.withResolvers<unknown>();
    const ui: Record<string, (...args: unknown[]) => Promise<unknown>> = { [method]: () => answer.promise };
    const h = harness(ui);
    await h.start();
    const result = ui[method]("title");
    expect(result).toBe(answer.promise);
    await h.wait("waiting_question");
    h.run(true);
    h.fire("agent_end", { willContinue: false });
    expect(h.read().state).toBe("waiting_question");
    answer.resolve("answer");
    await result;
    await h.wait("working");
    h.run(false);
    await h.wait("idle");
  });

  it("retargets FIFO wait identity for adjacent same-kind dialogs", async () => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    let count = 0;
    const ui = { select: () => ++count === 1 ? first.promise : second.promise };
    const h = harness(ui);
    await h.start();
    const a = ui.select();
    const before = await h.wait("waiting_question");
    const b = ui.select();
    first.resolve("first");
    await a;
    const after = await h.wait("waiting_question", marker => marker.wait_id !== before.wait_id);
    expect(after.wait_id).toBeString();
    second.resolve("second");
    await b;
    await h.wait("idle");
  });

  it("does not let a queued aborted dialog steal FIFO ownership", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let count = 0;
    const ui = { input: (..._args: unknown[]) => ++count === 1 ? first.promise : second.promise };
    const h = harness(ui);
    await h.start();
    const a = ui.input();
    const before = await h.wait("waiting_question");
    const controller = new AbortController();
    const b = ui.input("queued", undefined, { signal: controller.signal });
    controller.abort();
    second.resolve();
    await b;
    expect(h.read().wait_id).toBe(before.wait_id);
    first.resolve();
    await a;
    await h.wait("idle");
  });

  it("preserves rejected dialog results and removes their input ownership", async () => {
    const answer = Promise.withResolvers<unknown>();
    const ui = { editor: () => answer.promise };
    const h = harness(ui);
    await h.start();
    const result = ui.editor();
    expect(result).toBe(answer.promise);
    await h.wait("waiting_question");
    const failure = new Error("dialog rejected");
    answer.reject(failure);
    await expect(result).rejects.toBe(failure);
    await h.wait("idle");
  });

  it.each(["bash", "write"])("retargets consecutive %s approval owners and ignores unknown resolutions", async secondTool => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let calls = 0;
    const ui = { approve: () => ++calls === 1 ? first.promise : second.promise };
    const h = harness(ui);
    await h.start();
    h.fire("tool_approval_requested", { toolCallId: "first", toolName: "bash" });
    const a = ui.approve();
    const initial = await h.wait("waiting_permission");
    h.fire("tool_approval_requested", { toolCallId: "second", toolName: secondTool });
    const b = ui.approve();
    h.fire("tool_approval_resolved", {});
    h.fire("tool_approval_resolved", { toolCallId: "unknown" });
    expect(h.read().wait_id).toBe(initial.wait_id);
    first.resolve();
    await a;
    const next = await h.wait("waiting_permission", marker => marker.wait_id !== initial.wait_id);
    expect(next.pending_tool).toBe(secondTool);
    second.resolve();
    await b;
    await h.wait("idle");
  });

  it("only publishes approvals when UI owns input, and follows mixed-dialog FIFO", async () => {
    const question = Promise.withResolvers<void>();
    const permission = Promise.withResolvers<void>();
    const ui = { select: () => question.promise, approve: () => permission.promise };
    const h = harness(ui);
    await h.start();
    h.run(true);
    h.fire("tool_approval_requested", { toolCallId: "bash-1", toolName: "bash" });
    await h.wait("working");
    const q = ui.select();
    await h.wait("waiting_question");
    const p = ui.approve();
    h.status("blocked:kind=question");
    await h.wait("waiting_question");
    question.resolve();
    h.status("blocked:kind=permission");
    await q;
    await h.wait("waiting_permission", marker => marker.pending_tool === "bash" && !marker.ambiguous_wait);
    permission.resolve();
    h.status("working");
    await p;
    h.fire("tool_approval_resolved", { toolCallId: "bash-1" });
    await h.wait("working");
    h.run(false);
    h.status("done");
    await h.wait("idle");
  });

  it("tracks collab guest standard dialogs by exact OSC kind and refuses unsafe permission targeting", async () => {
    const h = harness({});
    await h.start();
    h.status("working");
    await h.wait("working");
    h.status("blocked:kind=permission");
    const permission = await h.wait("waiting_permission");
    expect(permission.ambiguous_wait).toBe(true);
    expect(permission.pending_tool).toBeUndefined();
    h.status("blocked:kind=question");
    await h.wait("waiting_question", marker => marker.wait_id !== permission.wait_id);
    h.status("done");
    await h.wait("idle");
  });

  it("passes terminal writes through and ignores ordinary text, embedded reports, and other apps", async () => {
    const h = harness({});
    await h.start();
    for (const text of ["Allow tool: bash", "rendered \x1b]7501;state=blocked:kind=permission:app=omp\x1b\\", "\x1b]7501;state=blocked:kind=permission:app=other\x1b\\"]) {
      expect(h.terminal.write(text, "extra")).toBe(h.terminalWrites.length);
      expect(h.terminalWrites.at(-1)).toEqual([text, "extra"]);
    }
    expect(h.read().state).toBe("idle");
  });

  it.each(["unavailable", "different"])("uses the captured TUI terminal when the imported terminal is %s", async source => {
    const fixture = customFixture();
    const widgets = new Map<string, { render(width: number): readonly string[] }>();
    const ui = {
      setWidget(key: string, factory: ((tui: CustomTui) => { render(width: number): readonly string[] }) | undefined) {
        if (factory) widgets.set(key, factory(fixture.tui));
        else widgets.delete(key);
      },
    };
    const otherTerminal = { write(_data: string) {} };
    let importedReads = 0;
    const h = harness(ui, { getActiveTerminal: () => {
      importedReads++;
      return source === "unavailable" ? null : otherTerminal;
    } });
    Object.assign(fixture.tui, { terminal: h.terminal });
    await h.start();
    expect(importedReads).toBe(0);
    h.status("working");
    await h.wait("working");
    h.status("blocked:kind=permission");
    const permission = await h.wait("waiting_permission", marker => marker.ambiguous_wait);
    expect(permission.pending_tool).toBeUndefined();
    otherTerminal.write("\x1b]7501;state=blocked:kind=question:app=omp\x1b\\");
    expect(h.read().state).toBe("waiting_permission");
    h.status("blocked:kind=question");
    await h.wait("waiting_question", marker => marker.wait_id !== permission.wait_id);
    h.status("done");
    await h.wait("idle");
    await h.shutdown();
    expect(widgets.size).toBe(0);
  });

  it("does not use another foreground TUI's OSC in SDK print or RPC mode", async () => {
    const h = harness({});
    h.ctx.mode = "rpc";
    await h.start();
    h.status("working");
    h.status("blocked:kind=permission");
    expect(h.read().state).toBe("idle");
  });

  it("observes first calls of newly installed RPC tools through their fifth argument", async () => {
    const answer = Promise.withResolvers<void>();
    const rpcUi = { askDialog: () => answer.promise };
    const h = harness({});
    h.ctx.mode = "rpc";
    await h.start();
    let receiver: unknown;
    let received: unknown[] = [];
    const tool = { execute(this: unknown, ...args: unknown[]) {
      receiver = this;
      received = args;
      return rpcUi.askDialog();
    } };
    h.session.agent.setTools([tool]);
    const context = { ui: rpcUi, hasUI: true };
    const args = ["call", { question: "yes?" }, undefined, undefined, context];
    const result = tool.execute(...args);
    expect(result).toBe(answer.promise);
    expect(receiver).toBe(tool);
    expect(received).toEqual(args);
    await h.wait("waiting_question");
    answer.resolve();
    await result;
    await h.wait("idle");
  });

  it("keeps live UI getters, descriptors, receivers, and dynamic method replacement", async () => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    const receiver: unknown[] = [];
    let implementation = function (this: unknown, ..._args: unknown[]) { receiver.push(this); return first.promise; };
    const ui = { get askDialog() { return implementation; } };
    const before = Object.getOwnPropertyDescriptor(ui, "askDialog");
    const h = harness(ui);
    await h.start();
    const a = ui.askDialog("one");
    await h.wait("waiting_question");
    first.resolve("one");
    await a;
    await h.wait("idle");
    implementation = function (this: unknown) { receiver.push(this); return second.promise; };
    const b = ui.askDialog();
    await h.wait("waiting_question");
    second.resolve("two");
    await b;
    await h.shutdown();
    expect(receiver).toEqual([ui, ui]);
    expect(Object.getOwnPropertyDescriptor(ui, "askDialog")).toEqual(before);
  });

  it("never captures the user-wait proxy's synthesized functions or wraps its raw target twice", async () => {
    const answer = Promise.withResolvers<void>();
    const raw = { select: () => answer.promise };
    let userWaits = 0;
    const proxy = new Proxy(raw, { get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { userWaits++; return value.apply(target, args); };
    } });
    const h = harness(proxy);
    await h.start();
    const tool = { execute: (..._args: unknown[]) => proxy.select() };
    h.session.agent.setTools([tool]);
    const result = tool.execute("id", {}, undefined, undefined, { ui: new Proxy(raw, {}), hasUI: true });
    await h.wait("waiting_question");
    answer.resolve();
    await result;
    await h.wait("idle");
    expect(userWaits).toBe(1);
  });

  it("restores instance methods only when no third party replaced them", async () => {
    const ui = { select: () => Promise.resolve("original") };
    const h = harness(ui);
    await h.start();
    const replacement = () => Promise.resolve("replacement");
    ui.select = replacement;
    await h.shutdown();
    expect(ui.select).toBe(replacement);
  });

  it("does not let subagent hooks publish or remove the parent's marker", async () => {
    const h = harness({});
    await h.start();
    h.run(true);
    await h.wait("working");
    const child = { ...h.ctx, agent: { id: "child", kind: "sub" as const } };
    for (const event of ["session_start", "agent_end", "session_switch", "session_shutdown"]) h.fire(event, {}, child);
    expect(readdirSync(directory).filter(name => name.endsWith(".json"))).toEqual(["omp-parent.json"]);
    expect(h.read().state).toBe("working");
  });
});

describe("OMP prototype-based RPC input", () => {
  it("shadows raw inherited methods and dynamic getters per instance without accounting-proxy recursion", async () => {
    const select = Promise.withResolvers<unknown>();
    const editor = Promise.withResolvers<unknown>();
    const approval = Promise.withResolvers<unknown>();
    const ask = Promise.withResolvers<unknown>();
    const calls: { receiver: unknown; args: unknown[] }[] = [];
    class RpcUi {
      askEnabled = false;
      select(...args: unknown[]) { calls.push({ receiver: this, args }); return select.promise; }
      editor(...args: unknown[]) { calls.push({ receiver: this, args }); return editor.promise; }
      approve(...args: unknown[]) { calls.push({ receiver: this, args }); return approval.promise; }
      get askDialog() {
        if (!this.askEnabled) return undefined;
        return (...args: unknown[]) => { calls.push({ receiver: this, args }); return ask.promise; };
      }
    }
    const originalPrototype = Object.getOwnPropertyDescriptors(RpcUi.prototype);
    const raw = new RpcUi();
    let accountingCalls = 0;
    const proxy = new Proxy(raw, { get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { accountingCalls++; return value.apply(target, args); };
    } });
    const h = harness({});
    h.ctx.mode = "rpc";
    await h.start();
    const tool = { execute: (..._args: unknown[]) => proxy.select("first RPC prompt", ["yes"]) };
    h.session.agent.setTools([tool]);
    const first = tool.execute("call", {}, undefined, undefined, { ui: proxy, hasUI: true });
    expect(first).toBe(select.promise);
    await h.wait("waiting_question");
    expect(Object.hasOwn(raw, "select")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(raw, "select")?.enumerable).toBe(originalPrototype.select.enumerable);
    select.resolve("yes");
    await first;
    await h.wait("idle");
    const editing = proxy.editor("feedback");
    expect(editing).toBe(editor.promise);
    await h.wait("waiting_question");
    editor.resolve("feedback");
    await editing;
    await h.wait("idle");
    h.fire("tool_approval_requested", { toolCallId: "approval", toolName: "bash" });
    const deciding = proxy.approve("permit");
    await h.wait("waiting_permission", marker => marker.pending_tool === "bash");
    approval.resolve("approve");
    await deciding;
    await h.wait("idle");
    expect(proxy.askDialog).toBeUndefined();
    raw.askEnabled = true;
    const askDialog = proxy.askDialog;
    if (!askDialog) throw new Error("Enabled native RPC askDialog missing");
    const asking = askDialog("dynamic ask");
    expect(asking).toBe(ask.promise);
    await h.wait("waiting_question");
    ask.resolve("answer");
    await asking;
    await h.wait("idle");
    expect(accountingCalls).toBe(4);
    expect(calls.map(call => call.receiver)).toEqual([raw, raw, raw, raw]);
    expect(calls[0].args).toEqual(["first RPC prompt", ["yes"]]);
    await h.shutdown();
    for (const key of ["select", "editor", "approve", "askDialog"]) expect(Object.hasOwn(raw, key)).toBe(false);
    expect(Object.getOwnPropertyDescriptors(RpcUi.prototype)).toEqual(originalPrototype);
  });
});

describe("OMP custom UI ownership", () => {
  it("waits for factory readiness and actual focus, then yields and regains ownership", async () => {
    const fixture = customFixture();
    const ready = Promise.withResolvers<FocusComponent>();
    const h = harness(fixture.ui);
    await h.start();
    let finish: ((value: unknown) => void) | undefined;
    const result = fixture.ui.custom((_tui, _theme, _keys, done) => { finish = done; return ready.promise; });
    expect(h.read().state).toBe("idle");
    const component = { handleInput(_data: string) {} };
    ready.resolve(component);
    const wait = await h.wait("waiting_question");
    fixture.tui.setFocus({});
    await h.wait("idle");
    fixture.tui.setFocus(component);
    await h.wait("waiting_question", marker => marker.wait_id === wait.wait_id);
    finish?.("answer");
    expect(await result).toBe("answer");
    await h.wait("idle");
  });

  it("tracks overlay hiding, showing, owned child focus, and permanent removal", async () => {
    const fixture = customFixture();
    const h = harness(fixture.ui);
    await h.start();
    const child = { handleInput(_data: string) {} };
    const component = { handleInput(_data: string) {}, ownsOverlayFocusTarget: (value: object) => value === child };
    let finish: ((value: unknown) => void) | undefined;
    const result = fixture.ui.custom((_tui, _theme, _keys, done) => { finish = done; return component; }, { overlay: true });
    await h.wait("waiting_question");
    fixture.tui.setFocus(child);
    expect(h.read().state).toBe("waiting_question");
    // The public handle remains the native handle; toggling it changes actual focus.
    const overlay = fixture.tui.showOverlay(component);
    overlay.setHidden(true);
    await h.wait("idle");
    overlay.setHidden(false);
    await h.wait("waiting_question");
    overlay.hide();
    await h.wait("idle");
    finish?.(undefined);
    await result;
  });

  it("never reports a custom factory that calls done before mounting", async () => {
    const fixture = customFixture();
    const h = harness(fixture.ui);
    await h.start();
    expect(await fixture.ui.custom((_tui, _theme, _keys, done) => { done("early"); return { handleInput(_data: string) {} }; })).toBe("early");
    expect(h.read().state).toBe("idle");
  });

  it("cleans up rejected factories and aborted mounted custom UI without swallowing errors", async () => {
    const fixture = customFixture();
    const h = harness(fixture.ui);
    await h.start();
    const failure = new Error("factory failed");
    await expect(fixture.ui.custom(() => { throw failure; })).rejects.toBe(failure);
    expect(h.read().state).toBe("idle");
    const controller = new AbortController();
    const result = fixture.ui.custom(() => ({ handleInput(_data: string) {} }), { signal: controller.signal });
    await h.wait("waiting_question");
    controller.abort("cancelled");
    await expect(result).rejects.toBe("cancelled");
    await h.wait("idle");
  });

  it("does not turn a focused static custom overlay into an input question", async () => {
    const fixture = customFixture();
    const h = harness(fixture.ui);
    await h.start();
    h.run(true);
    await h.wait("working");
    let finish: ((value: unknown) => void) | undefined;
    const result = fixture.ui.custom((_tui, _theme, _keys, done) => { finish = done; return {}; }, { overlay: true });
    await waitUntil(() => fixture.tui.getFocused() !== null, "static custom overlay mount");
    h.notify();
    expect(h.read().state).toBe("working");
    expect(h.read().wait_id).toBeUndefined();
    finish?.("closed");
    await result;
    h.run(false);
    await h.wait("idle");
  });
});

describe("OMP plan and marker lifecycle", () => {
  it("observes semantic native Save input bypassing raw UI dialogs while the plan permission hold stays unchanged", async () => {
    const fixture = customFixture();
    const paintListeners = new Set<() => void>();
    Object.assign(fixture.tui, {
      addPaintListener(listener: () => void) {
        paintListeners.add(listener);
        return () => { paintListeners.delete(listener); };
      },
    });
    const widgets = new Map<string, { render(width: number): readonly string[] }>();
    widgets.set("user-widget", { render: () => ["user content"] });
    const ui = {
      ...fixture.ui,
      setWidget(key: string, factory: ((tui: CustomTui, theme: object) => { render(width: number): readonly string[] }) | undefined, _options?: { placement: string }) {
        if (factory) widgets.set(key, factory(fixture.tui, {}));
        else widgets.delete(key);
      },
    };
    const h = harness(ui);
    await h.start();
    expect(paintListeners.size).toBe(1);
    h.session.setPlanModeState({ enabled: true });
    h.session.pendingReview = { reviewId: "native-review" };
    h.fire("plan_review_requested", h.session.pendingReview);
    const review = { nativeOverlay: { role: "omp.overlay.planReview" }, handleInput(_data: string) {} };
    fixture.tui.setFocus(review);
    h.status("blocked:kind=permission");
    const original = await h.wait("waiting_plan");
    const save = { nativeOverlay: { role: "omp.overlay.planSave" }, handleInput(_data: string) {} };
    const handle = fixture.tui.showOverlay(save);
    const question = await h.wait("waiting_question");
    expect(question.in_plan_mode).toBe(true);
    expect(question.wait_id).not.toBe(original.wait_id);
    for (const listener of paintListeners) listener();
    expect(h.read().wait_id).toBe(question.wait_id);
    handle.hide();
    fixture.tui.setFocus(review);
    await h.wait("waiting_plan", marker => marker.wait_id === original.wait_id);
    const nextSave = { nativeOverlay: { role: "omp.overlay.planSave" }, handleInput(_data: string) {} };
    fixture.tui.showOverlay(nextSave);
    await h.wait("waiting_question", marker => marker.wait_id !== question.wait_id);
    await h.shutdown();
    expect([...widgets.keys()]).toEqual(["user-widget"]);
    expect(paintListeners.size).toBe(0);
  });

  it("never registers the nonvisual TUI observer in RPC mode", async () => {
    let registrations = 0;
    const h = harness({ setWidget() { registrations++; } });
    h.ctx.mode = "rpc";
    await h.start();
    await h.shutdown();
    expect(registrations).toBe(0);
  });

  it("publishes plan mode and active review, temporarily yields to save dialogs, and stops waiting after an accepted compaction", async () => {
    const saved = Promise.withResolvers<void>();
    const approved = Promise.withResolvers<void>();
    const ui = { input: () => saved.promise, approve: () => approved.promise };
    const h = harness(ui);
    await h.start();
    h.session.setPlanModeState({ enabled: true });
    await h.wait("idle", marker => marker.in_plan_mode);
    h.session.pendingReview = { reviewId: "review-1" };
    h.fire("plan_review_requested", h.session.pendingReview);
    h.status("blocked:kind=permission");
    const review = await h.wait("waiting_plan");
    expect(review.ambiguous_wait).toBe(false);
    h.fire("tool_approval_requested", { toolCallId: "local-approval", toolName: "bash" });
    const decision = ui.approve();
    await h.wait("waiting_permission", marker => marker.pending_tool === "bash");
    approved.resolve();
    await decision;
    await h.wait("waiting_plan", marker => marker.wait_id === review.wait_id);
    const save = ui.input();
    h.status("blocked:kind=question");
    await h.wait("waiting_question");
    saved.resolve();
    await save;
    h.status("blocked:kind=permission");
    await h.wait("waiting_plan", marker => marker.wait_id === review.wait_id);
    h.session.pendingReview = undefined;
    h.status("idle");
    h.session.isCompacting = true;
    h.notify();
    await h.wait("working");
    h.fire("plan_review_resolved", { reviewId: "review-1", choice: "compact" });
    h.session.isCompacting = false;
    h.notify();
    await h.wait("idle");
    h.session.setPlanModeState(undefined);
    await h.wait("idle", marker => !marker.in_plan_mode);
  });

  it("retries the latest desired state after a final write fails without a fresh lifecycle event", async () => {
    let failing = false;
    let failures = 0;
    const error = spyOn(console, "error").mockImplementation(() => {});
    const h = harness({}, { writeMarkerFile: async (file, body) => {
      if (failing) { failures++; throw new Error("injected marker write failure"); }
      await writeFile(file, body);
    } });
    try {
      await h.start();
      h.run(true);
      await h.wait("working");
      failing = true;
      h.run(false);
      await waitUntil(() => failures > 0, "failed final write");
      expect(h.read().state).toBe("working");
      failing = false;
      await h.wait("idle");
    } finally { error.mockRestore(); }
  });

  it("closes synchronously before a queued write and captured native callbacks can run", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const h = harness({}, { writeMarkerFile: async (file, body) => {
      if (hold) { entered.resolve(); await release.promise; }
      await writeFile(file, body);
    } });
    await h.start();
    const delayed = [...h.listeners];
    const delayedRuns = [...h.runListeners];
    hold = true;
    h.run(true);
    await entered.promise;
    expect(h.fire("session_shutdown")).toBeUndefined();
    for (const callback of delayed) callback({ type: "agent_end" });
    for (const callback of delayedRuns) callback("running");
    h.fire("agent_start");
    h.fire("agent_end");
    release.resolve();
    await h.shutdown();
    await waitUntil(() => readdirSync(directory).length === 0, "closed marker and temporary files");
    expect(h.listeners.size).toBe(0);
    expect(h.runListeners.size).toBe(0);
  });
});
