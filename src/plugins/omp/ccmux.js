// ccmux-extension v__CCMUX_VERSION__
// Installed as one self-contained JavaScript extension by `ccmux setup --agent omp`.
import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

const decoratedMethods = new WeakMap();
const BUSY_FLAGS = ["isRunActive", "hasAdmittedSubmission", "isStreaming", "isCompacting", "isBackgroundCompacting", "isBashRunning", "isEvalRunning", "isRetrying", "isAborting"];
const OBSERVER_ROWS = Object.freeze([]);

function decorate(target, key, wrap, cleanups, rawOnly = false) {
  if (!target) return;
  const own = Object.getOwnPropertyDescriptor(target, key);
  if (own && (decoratedMethods.get(own.value) === cleanups || decoratedMethods.get(own.get) === cleanups)) return;
  let source = own;
  for (let prototype = Object.getPrototypeOf(target); !source && prototype; prototype = Object.getPrototypeOf(prototype)) {
    source = Object.getOwnPropertyDescriptor(prototype, key);
  }
  if (rawOnly && !source) return;
  let installed;
  if (source?.get) {
    if (own && !own.configurable) return;
    const wrappers = new WeakMap();
    installed = {
      ...source,
      configurable: own ? source.configurable : true,
      get: function () {
        const original = source.get.call(this);
        if (typeof original !== "function") return original;
        let wrapped = wrappers.get(original);
        if (!wrapped) {
          wrapped = wrap(original);
          wrappers.set(original, wrapped);
        }
        return wrapped;
      },
    };
  } else {
    const original = source ? source.value : target[key];
    if (typeof original !== "function" || (own && !own.configurable && !own.writable)) return;
    installed = source
      ? { ...source, configurable: own ? source.configurable : true, value: wrap(original) }
      : { configurable: true, enumerable: false, writable: true, value: wrap(original) };
  }
  if (installed.value) decoratedMethods.set(installed.value, cleanups);
  if (installed.get) decoratedMethods.set(installed.get, cleanups);
  Object.defineProperty(target, key, installed);
  cleanups.push(() => {
    const current = Object.getOwnPropertyDescriptor(target, key);
    if (current?.value !== installed.value || current?.get !== installed.get || current?.set !== installed.set) return;
    if (own) Object.defineProperty(target, key, own);
    else delete target[key];
  });
}

/** Build the installed extension. Hooks never wait for marker I/O. */
export function makeExtension({
  markersDir,
  version,
  now = Date.now,
  getActiveTerminal,
  writeMarkerFile = writeFile,
}) {
  let active;
  let stopped = false;
  let generation = 0;
  let fallbackEpoch = 0;
  let sequence = 0;
  let writing = false;
  let timer;
  const removals = new Set();
  const sessionOrigins = new WeakMap();

  const pathOf = id => join(markersDir, `omp-${id}.json`);
  const live = binding => active === binding && !binding.closed && !stopped;
  const report = (message, error) => console.error(`[ccmux-extension] ${message}`, error);

  function flush() {
    if (writing || (!removals.size && !active?.dirty)) return;
    writing = true;
    let failed = false;
    void (async () => {
      // Let synchronous UI failures remove their owner before snapshotting it.
      await Promise.resolve();
      for (const id of removals) {
        try {
          await unlink(pathOf(id));
          removals.delete(id);
        } catch (error) {
          if (error?.code === "ENOENT") removals.delete(id);
          else throw error;
        }
      }
      const binding = active;
      if (!binding || !live(binding) || !binding.dirty) return;
      const revision = binding.revision;
      const writerGeneration = binding.generation;
      const writerSessionId = binding.id;
      const timestamp = Math.floor(now() / 1000);
      const body = JSON.stringify({
        agent_type: "omp", pid: process.pid, session_id: writerSessionId,
        timestamp, state_timestamp: timestamp, ...binding.desired,
      });
      const file = pathOf(writerSessionId);
      const tmp = `${file}.tmp.${process.pid}.${writerGeneration}.${revision}`;
      try {
        await mkdir(markersDir, { recursive: true });
        if (!live(binding) || binding.generation !== writerGeneration || binding.id !== writerSessionId) return;
        await writeMarkerFile(tmp, body);
        if (live(binding) && binding.generation === writerGeneration && binding.id === writerSessionId) await rename(tmp, file);
        if (live(binding) && binding.generation === writerGeneration && binding.id === writerSessionId && revision === binding.revision) binding.dirty = false;
      } finally {
        await unlink(tmp).catch(error => {
          if (error?.code !== "ENOENT") report("temporary marker cleanup failed", error);
        });
      }
    })().catch(error => {
      failed = true;
      report("marker write failed; retrying latest state", error);
    }).finally(() => {
      writing = false;
      // A close during rename leaves a tombstone. No later callback can cancel it.
      if (!failed && (removals.size || active?.dirty)) queueMicrotask(flush);
      if (!active && !removals.size && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    });
  }

  function ensureTimer() {
    if (timer) return;
    timer = setInterval(() => {
      if (active && live(active)) observe(active);
      flush();
    }, 100);
    timer.unref?.();
  }

  function close(binding) {
    binding.closed = true;
    resetConversation(binding);
    if (active === binding) active = undefined;
    for (const cleanup of binding.cleanups.reverse()) {
      try { cleanup(); } catch (error) { report("observer cleanup failed", error); }
    }
    removals.add(binding.id);
    ensureTimer();
    flush();
  }

  function publish(binding) {
    if (!live(binding)) return;
    try {
      const ordinary = binding.waits.find(wait => !wait.closed && wait.kind !== "custom");
      let custom;
      for (const wait of binding.waits) {
        if (!wait.closed && wait.kind === "custom" && customOwnsInput(wait)) custom = wait;
      }
      let owner = custom && (!ordinary || custom.order > ordinary.order) ? custom : ordinary;
      let kind = owner?.kind === "permission" ? "permission" : owner ? "question" : undefined;
      let ambiguous = false;
      let waitId = owner?.id;
      let tool = owner?.tool;
      // Older SDKs expose approval events but no public AgentSession registry.
      if (!binding.session && binding.ctx.hasUI !== false && !owner && !binding.nativeWait && binding.approvals.size) {
        const [callId, approval] = binding.approvals.entries().next().value;
        owner = approval;
        kind = "permission";
        waitId = `approval:${binding.generation}:${callId}`;
        tool = approval.tool;
      }
      // OSC contains the visible standard dialog kind, never a guessed title or rendered text.
      if (binding.nativeWait && (!custom || owner !== custom)) {
        kind = binding.nativeWait.kind;
        owner = binding.waits.find(wait => !wait.closed && wait.kind === kind);
        waitId = owner?.id ?? binding.nativeWait.id;
        tool = owner?.tool;
        ambiguous = kind === "permission" && !owner;
      }
      const busy = binding.busy || binding.nativeActivity === true;
      if (binding.review && (!kind || (kind === "permission" && !owner))) {
        kind = "plan";
        ambiguous = false;
        waitId = `plan:${binding.generation}:${binding.review.reviewId}`;
      }
      const focused = binding.tui?.getFocused?.();
      if (focused?.nativeOverlay?.role === "omp.overlay.planSave" && typeof focused.handleInput === "function") {
        // This is semantic component metadata, not a title or rendered terminal text.
        let nativeId = binding.nativeOwners.get(focused);
        if (!nativeId) {
          nativeId = `native-ui:${binding.generation}:${++sequence}`;
          binding.nativeOwners.set(focused, nativeId);
        }
        kind = "question";
        waitId = nativeId;
        tool = undefined;
        ambiguous = false;
      }
      const desired = {
        state: kind ? `waiting_${kind}` : busy ? "working" : "idle",
        state_authoritative: true,
        conversation_epoch: binding.conversationEpoch,
        in_plan_mode: binding.inPlanMode,
        ambiguous_wait: ambiguous,
        directory: binding.ctx.cwd,
        transcript_path: binding.ctx.sessionManager.getSessionFile() ?? null,
        last_prompt: binding.prompt,
        ...(kind ? { wait_id: waitId } : {}),
        ...(kind === "permission" && tool ? { pending_tool: tool } : {}),
      };
      const encoded = JSON.stringify(desired);
      if (encoded === binding.encoded) return;
      binding.desired = desired;
      binding.encoded = encoded;
      binding.revision++;
      binding.dirty = true;
      flush();
    } catch (error) {
      report("input ownership observation failed", error);
    }
  }

  function customOwnsInput(wait) {
    if (!wait.component || !wait.tui || wait.handle?.isHidden?.()) return false;
    const focused = wait.tui.getFocused?.();
    if (typeof focused?.handleInput !== "function") return false;
    return focused === wait.component || (focused && wait.component.ownsOverlayFocusTarget?.(focused) === true);
  }

  function finishWait(binding, wait) {
    if (wait.closed) return;
    wait.closed = true;
    wait.signal?.removeEventListener("abort", wait.abort);
    const index = binding.waits.indexOf(wait);
    if (index !== -1) binding.waits.splice(index, 1);
    if (live(binding)) observe(binding);
  }

  function watchResult(result, finish) {
    if (result && typeof result.then === "function") result.then(finish, finish);
    else finish();
    return result;
  }

  function instrumentUI(binding, ui) {
    if (!ui) return;
    for (const method of ["select", "confirm", "input", "editor", "askDialog", "formDialog", "approve", "custom"]) {
      decorate(ui, method, original => function (...args) {
        if (!live(binding)) return original.apply(this, args);
        const options = method === "custom" ? args[1] : args.find(arg => arg && typeof arg === "object" && "signal" in arg);
        if (options?.signal?.aborted) return original.apply(this, args);
        const approval = method === "approve" ? [...binding.approvals.values()].find(item => !item.claimed) : undefined;
        if (approval) approval.claimed = true;
        const wait = {
          id: `ui:${binding.generation}:${++sequence}`,
          order: sequence,
          kind: method === "approve" ? "permission" : method === "custom" ? "custom" : "question",
          tool: approval?.tool,
          signal: options?.signal,
          closed: false,
        };
        wait.abort = () => finishWait(binding, wait);
        wait.signal?.addEventListener("abort", wait.abort, { once: true });
        binding.waits.push(wait);
        let callArgs = args;
        if (method === "custom" && typeof args[0] === "function") {
          const factory = args[0];
          callArgs = [...args];
          callArgs[0] = function (...factoryArgs) {
            wait.tui = factoryArgs[0];
            try { instrumentTui(binding, wait.tui); }
            catch (error) { report("custom focus observation failed", error); }
            const done = factoryArgs[3];
            const forwarded = [...factoryArgs];
            forwarded[3] = function (...doneArgs) {
              finishWait(binding, wait);
              return done.apply(this, doneArgs);
            };
            const component = factory.apply(this, forwarded);
            const ready = value => {
              if (!wait.closed && live(binding)) {
                wait.component = value;
                observe(binding);
              }
            };
            if (component && typeof component.then === "function") component.then(ready, () => finishWait(binding, wait));
            else ready(component);
            return component;
          };
        }
        publish(binding);
        try {
          const result = original.apply(this, callArgs);
          observe(binding);
          return watchResult(result, () => finishWait(binding, wait));
        } catch (error) {
          finishWait(binding, wait);
          throw error;
        }
      }, binding.cleanups, true);
    }
    if (binding.ctx.mode === "tui" && !binding.observerWidget && typeof ui.setWidget === "function") {
      const key = `ccmux-state-observer:${process.pid}:${binding.generation}`;
      binding.observerWidget = key;
      try {
        ui.setWidget(key, tui => {
          if (live(binding)) instrumentTui(binding, tui);
          return {
            render() {
              if (live(binding)) publish(binding);
              return OBSERVER_ROWS;
            },
          };
        }, { placement: "belowEditor" });
      } catch (error) {
        binding.observerWidget = undefined;
        throw error;
      }
      binding.cleanups.push(() => ui.setWidget(key, undefined));
    }
  }

  function instrumentTui(binding, tui) {
    if (!live(binding) || !tui) return;
    binding.tui = tui;
    instrumentTerminal(binding);
    if (binding.tuis.has(tui)) return;
    binding.tuis.add(tui);
    if (typeof tui.addPaintListener === "function") {
      binding.cleanups.push(tui.addPaintListener(() => {
        if (live(binding)) observe(binding);
      }));
    }
    for (const method of ["setFocus", "hideOverlay", ...(typeof tui.addPaintListener === "function" ? [] : ["requestRender"])]) {
      decorate(tui, method, original => function (...args) {
        const result = original.apply(this, args);
        if (live(binding)) publish(binding);
        return result;
      }, binding.cleanups);
    }
    decorate(tui, "showOverlay", original => function (...args) {
      const handle = original.apply(this, args);
      const wait = binding.waits.find(item => !item.closed && item.component === args[0]);
      if (wait) wait.handle = handle;
      if (handle) {
        for (const method of ["hide", "setHidden"]) {
          decorate(handle, method, action => function (...handleArgs) {
            const result = action.apply(this, handleArgs);
            if (method === "hide" && wait) finishWait(binding, wait);
            if (live(binding)) publish(binding);
            return result;
          }, binding.cleanups);
        }
      }
      if (live(binding)) publish(binding);
      return handle;
    }, binding.cleanups);
  }

  function instrumentTools(binding, tools) {
    for (const tool of tools ?? []) {
      if (!tool) continue;
      decorate(tool, "execute", original => function (...args) {
        // The native tool context is argument five, including RPC's distinct UI target.
        if (live(binding) && args[4]?.hasUI !== false) {
          try { instrumentUI(binding, args[4]?.ui); }
          catch (error) { report("tool UI observation failed", error); }
        }
        return original.apply(this, args);
      }, binding.cleanups);
    }
  }

  function instrumentTerminal(binding) {
    if (binding.ctx.mode !== "tui") return;
    const terminal = binding.tui?.terminal ?? getActiveTerminal?.();
    if (!terminal) return;
    binding.terminal = terminal;
    decorate(terminal, "write", original => function (...args) {
      const result = original.apply(this, args);
      if (!live(binding) || binding.terminal !== terminal || typeof args[0] !== "string") return result;
      if (/^\x1b\]7501;state=clear(?:\x07|\x1b\\)$/.test(args[0])) {
        binding.nativeActivity = false;
        binding.nativeWait = undefined;
        observe(binding);
        return result;
      }
      const match = /^\x1b\]7501;state=(idle|working|done|error|blocked)(?::kind=(permission|question))?:app=omp(?::msg=[A-Za-z0-9+/=]*)?(?:\x07|\x1b\\)$/.exec(args[0]);
      if (!match) return result;
      if ((match[1] === "blocked") !== (match[2] !== undefined)) return result;
      const kind = match[1] === "blocked" ? match[2] : undefined;
      if (kind) {
        if (binding.nativeWait?.report !== args[0]) binding.nativeWait = { kind, report: args[0], id: `osc:${binding.generation}:${++sequence}` };
      } else {
        binding.nativeWait = undefined;
        binding.nativeActivity = match[1] === "working";
      }
      observe(binding);
      return result;
    }, binding.cleanups);
  }

  function isMirroredSession(session) {
    const origin = sessionOrigins.get(session);
    if (!origin) return false;
    const file = session.sessionManager.getSessionFile();
    return origin?.file === file ? origin.mirrored : origin?.previousFile === file && origin.previousMirrored === true;
  }

  function attachSession(binding, session) {
    binding.session = session;
    binding.epoch = session.transcriptEpoch;
    // Guests adopt a replica through this documented public option pair. Their
    // ordered extension lifecycle is remote; their local AgentSession never runs.
    decorate(session, "switchSession", original => function (...args) {
      if (!live(binding)) return original.apply(this, args);
      const previous = sessionOrigins.get(session);
      const origin = {
        file: args[0],
        mirrored: args[1]?.preserveLocalCwd === true && args[1]?.keepModel === true,
        previousFile: session.sessionManager.getSessionFile(),
        previousMirrored: isMirroredSession(session),
      };
      sessionOrigins.set(session, origin);
      const settle = committed => {
        if (sessionOrigins.get(session) !== origin) return;
        if (committed === false) {
          if (previous) sessionOrigins.set(session, previous);
          else sessionOrigins.delete(session);
        } else sessionOrigins.set(session, { file: origin.file, mirrored: origin.mirrored });
        if (active?.session === session) observe(active);
      };
      try {
        const result = original.apply(this, args);
        if (result && typeof result.then === "function") result.then(settle, () => settle(false));
        else settle(result);
        return result;
      } catch (error) {
        settle(false);
        throw error;
      }
    }, binding.cleanups);
    if (typeof session.subscribe === "function") binding.cleanups.push(session.subscribe(() => {
      if (live(binding)) observe(binding);
    }));
    if (typeof session.subscribeRunState === "function") binding.cleanups.push(session.subscribeRunState(() => {
      if (live(binding)) observe(binding);
    }));
    const agent = session.agent;
    instrumentTools(binding, agent?.state?.tools);
    // Instrument at installation, not at the next 100ms sample. A tool can be called immediately.
    decorate(agent, "setTools", original => function (...args) {
      if (live(binding)) {
        try { instrumentTools(binding, args[0]); }
        catch (error) { report("new tool observation failed", error); }
      }
      const result = original.apply(this, args);
      if (live(binding)) {
        try { instrumentTools(binding, this.state?.tools); }
        catch (error) { report("installed tool observation failed", error); }
      }
      return result;
    }, binding.cleanups);
    decorate(session, "setPlanModeState", original => function (...args) {
      const result = original.apply(this, args);
      if (live(binding)) observe(binding);
      return result;
    }, binding.cleanups);
  }

  function resetConversation(binding) {
    for (const wait of [...binding.waits]) {
      wait.closed = true;
      wait.signal?.removeEventListener("abort", wait.abort);
    }
    binding.waits.length = 0;
    binding.nativeOwners = new WeakMap();
    binding.approvals.clear();
    binding.nativeWait = undefined;
    binding.nativeActivity = false;
    binding.review = undefined;
    binding.prompt = null;
    binding.hintBusy = false;
    binding.generation = ++generation;
  }

  function observe(binding) {
    if (!live(binding) || binding.observing) return;
    binding.observing = true;
    try {
      const registry = binding.omp.pi?.AgentRegistry?.global?.();
      const candidate = binding.ctx.agent?.id ? registry?.get(binding.ctx.agent.id)?.session : undefined;
      if (candidate && candidate.sessionManager !== binding.ctx.sessionManager) throw new Error("OMP registry session manager does not match extension context");
      if (candidate && !binding.session) attachSession(binding, candidate);
      if (registry && binding.ctx.agent?.id && !candidate) throw new Error("OMP registry has no session for the extension agent");
      const session = binding.session;
      if (session) {
        if (candidate !== session || session.sessionManager !== binding.ctx.sessionManager) {
          throw new Error("OMP registry session identity changed without a session rebind");
        }
        if (binding.epoch !== session.transcriptEpoch) {
          resetConversation(binding);
          binding.epoch = session.transcriptEpoch;
        }
        binding.mirrored = isMirroredSession(session);
        binding.busy = BUSY_FLAGS.some(key => session[key] === true) || (binding.mirrored && binding.hintBusy);
        binding.inPlanMode = session.getPlanModeState?.()?.enabled === true;
        binding.conversationEpoch = `${process.pid}:${session.instanceKey ?? binding.ctx.agent?.id ?? binding.id}:${session.transcriptEpoch ?? fallbackEpoch}`;
        if (session.extensionRunner?.hasUI?.() !== false) instrumentUI(binding, session.extensionRunner?.getUIContext?.());
        instrumentTools(binding, session.agent?.state?.tools);
      } else {
        binding.busy = binding.ctx.isIdle ? !binding.ctx.isIdle() : binding.hintBusy;
        binding.conversationEpoch = `${process.pid}:fallback:${fallbackEpoch}`;
        if (binding.ctx.hasUI !== false) instrumentUI(binding, binding.ctx.ui);
      }
      if (typeof binding.ctx.getPendingPlanReview === "function") binding.review = binding.ctx.getPendingPlanReview();
      instrumentTerminal(binding);
      publish(binding);
      binding.observationError = undefined;
    } catch (error) {
      if (binding.observationError !== String(error)) report("state observation failed", error);
      binding.observationError = String(error);
    } finally {
      binding.observing = false;
    }
  }

  function extension(omp) {
    function idOf(ctx) {
      if (ctx?.agent?.kind === "sub") return;
      const id = ctx?.sessionManager?.getSessionId();
      return typeof id === "string" && id ? id : undefined;
    }
    function current(ctx) {
      if (stopped || !active || idOf(ctx) !== active.id) return;
      return active;
    }
    function bind(event, ctx) {
      if (stopped) return;
      const id = idOf(ctx);
      if (!id) return;
      if (event?.reason === "fork" && active?.session && active.ctx.sessionManager === ctx.sessionManager && active.epoch === active.session.transcriptEpoch) {
        const candidate = ctx.agent?.id ? omp.pi?.AgentRegistry?.global?.().get(ctx.agent.id)?.session : undefined;
        if (candidate === active.session) {
          // Native no-argument fork keeps the run and UI alive. Keep this same
          // binding so pending factories, dialog settlements and observers still own it.
          if (active.id !== id) removals.add(active.id);
          active.id = id;
          active.ctx = ctx;
          active.prompt = null;
          active.encoded = undefined;
          observe(active);
          flush();
          return;
        }
      }
      if (active) close(active);
      const binding = {
        id, ctx, omp, generation: ++generation, closed: false,
        prompt: null, hintBusy: false, busy: false, inPlanMode: false,
        waits: [], approvals: new Map(), cleanups: [],
        tuis: new WeakSet(), nativeOwners: new WeakMap(),
        revision: 0, dirty: false,
      };
      active = binding;
      ensureTimer();
      observe(binding);
    }
    omp.on("session_start", bind);
    omp.on("session_switch", bind);
    omp.on("session_branch", bind);
    omp.on("session_clear", (_event, ctx) => {
      const binding = current(ctx);
      if (!binding) return;
      if (binding.session?.transcriptEpoch === undefined) fallbackEpoch++;
      resetConversation(binding);
      binding.epoch = binding.session?.transcriptEpoch;
      observe(binding);
    });
    omp.on("before_agent_start", (event, ctx) => {
      const binding = current(ctx);
      if (!binding) return;
      binding.hintBusy = true;
      const prompt = typeof event?.prompt === "string" ? event.prompt.trim() : "";
      if (prompt) binding.prompt = prompt.slice(0, 1024);
      observe(binding);
    });
    omp.on("agent_start", (_event, ctx) => {
      const binding = current(ctx);
      if (!binding) return;
      binding.hintBusy = true;
      observe(binding);
    });
    omp.on("agent_end", (event, ctx) => {
      const binding = current(ctx);
      if (!binding) return;
      if ((!binding.session || binding.mirrored) && event?.willContinue !== true) binding.hintBusy = false;
      if (!binding.session && event?.willContinue !== true && ctx.isIdle?.() !== false) binding.approvals.clear();
      // Local agent_end can describe an internal loop. Replicas alone use the ordered mirrored lifecycle.
      observe(binding);
    });
    omp.on("tool_approval_requested", (event, ctx) => {
      const binding = current(ctx);
      if (!binding || typeof event?.toolCallId !== "string") return;
      if (!binding.approvals.has(event.toolCallId)) binding.approvals.set(event.toolCallId, {
        tool: typeof event.toolName === "string" ? event.toolName : undefined,
        claimed: false,
      });
      if (!binding.session) binding.hintBusy = true;
      observe(binding);
    });
    omp.on("tool_approval_resolved", (event, ctx) => {
      const binding = current(ctx);
      if (!binding || typeof event?.toolCallId !== "string") return;
      binding.approvals.delete(event.toolCallId);
      observe(binding);
    });
    omp.on("plan_review_requested", (event, ctx) => {
      const binding = current(ctx);
      if (!binding || typeof event?.reviewId !== "string") return;
      binding.review = event;
      observe(binding);
    });
    omp.on("plan_review_resolved", (event, ctx) => {
      const binding = current(ctx);
      if (!binding || binding.review?.reviewId !== event?.reviewId) return;
      binding.review = undefined;
      observe(binding);
    });
    omp.on("session_shutdown", (_event, ctx) => {
      const binding = current(ctx);
      if (!binding) return;
      stopped = true;
      close(binding);
    });
  }
  extension.version = version;
  return extension;
}

const ccmuxExtension = makeExtension({
  markersDir: "__CCMUX_MARKERS_DIR__",
  version: "__CCMUX_VERSION__",
});
export default ccmuxExtension;
