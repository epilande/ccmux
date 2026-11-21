// ccmux-extension v__CCMUX_VERSION__
// oh-my-pi (omp) extension shipped by ccmux. Writes marker files into the
// ccmux session-pids dir so the daemon can correlate omp sessions to tmux
// panes. Installed + uninstalled via `ccmux setup --agent omp`.
// Source: github.com/epilande/ccmux
//
// omp is a hard fork of Pi and kept Pi's extension API, so this file is a
// near-copy of src/plugins/pi/ccmux.js. Kept separate because the two agents
// install into different dirs, write different marker prefixes, and diverge
// on approval tracking (omp has a tool-approval pause; Pi does not).
//
// omp auto-discovers both *.ts and *.js extensions, so this plain-JS file
// runs unchanged under whichever runtime (node or bun) launched omp.
// Authored as JS (not TS) so it stays out of ccmux's own TypeScript
// compilation.

import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate, setTimeout } from "node:timers/promises";

/**
 * @typedef {object} MarkerState
 * @property {"idle"|"working"|"waiting_permission"} [state]
 * @property {string} [directory]
 * @property {string} [transcript_path]
 * @property {string} [last_prompt]
 * @property {string} [pending_tool]
 */

/**
 * @typedef {object} MakeExtensionOptions
 * @property {string} markersDir   Absolute path to ccmux marker directory.
 * @property {string} version      ccmux version string (for the sentinel line).
 * @property {() => number} [now]  Injected clock, ms epoch. Defaults to Date.now.
 * @property {(ms: number) => Promise<void>} [sleep] Injected retry delay.
 */

/**
 * Build an omp extension bound to the given markers dir.
 *
 * Only the main session owns the pane marker. In-process subagents load
 * this extension too, but share the main session's PID and tmux pane.
 *
 * Unlike upstream Pi, a session switch (`/new`, `/resume`) does not emit
 * `session_shutdown` + `session_start`: omp mutates the session in place and
 * emits `session_switch` (`session_branch` for `/branch`). Both change the
 * session id, so both are bound to the shared `rebindToCurrentSession`
 * handler below, which keeps the old session's marker from leaking and seeds
 * the new one.
 *
 * @param {MakeExtensionOptions} opts
 */
export function makeExtension({
  markersDir,
  version,
  now = Date.now,
  sleep = setTimeout,
}) {
  const AGENT_TYPE = "omp";

  /**
   * Last-written marker state per session, so a `state` flip preserves the
   * `directory`/`transcript_path`/`last_prompt` captured at session_start.
   * @type {Map<string, MarkerState>}
   */
  const sessionState = new Map();
  /**
   * Tool calls awaiting an approval decision, per session, as an
   * insertion-ordered `toolCallId -> toolName`. One assistant turn can gate
   * several calls at once; see `publishState` for what the set means.
   * @type {Map<string, Map<string, string|undefined>>}
   */
  const pendingApprovals = new Map();
  /**
   * Activity reasons (`turn` / `continuing` / `compaction` / `retry`)
   * currently holding each session `working`. Handlers never write the
   * state directly: they flip a reason and publish the derived state, so
   * overlapping and repeated start events are idempotent and a state can
   * only leak when an end event is lost (which the reconcile timer below
   * heals — for the `turn` reason alone; `continuing`, `compaction`, and
   * `retry` are trusted to their own clearing events).
   * @type {Map<string, Set<string>>}
   */
  const activityReasons = new Map();
  /**
   * Managed `ctx.setInterval` reconcile per session: armed while an
   * activity reason is on, disarmed on the first idle tick with none, and
   * kept armed as a watchdog while a reason-less session reads busy.
   * Value: the ctx that armed it and the managed timer id.
   * @type {Map<string, {ctx: object, id: unknown}>}
   */
  const reconcileTimers = new Map();
  const RECONCILE_INTERVAL_MS = 5000;
  /**
   * Serialize tmp+rename writes so events firing in the same tick
   * (before_agent_start -> agent_start) can't race on disk.
   * @type {Promise<unknown>}
   */
  let writeChain = Promise.resolve();

  function markerPath(sessionId) {
    return join(markersDir, `${AGENT_TYPE}-${sessionId}.json`);
  }

  async function atomicWrite(path, body) {
    const tmp = `${path}.tmp.${process.pid}.${now()}`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  function buildMarkerBody(sessionId, state) {
    const ts = Math.floor(now() / 1000);
    return JSON.stringify({
      agent_type: AGENT_TYPE,
      pid: process.pid,
      session_id: sessionId,
      timestamp: ts,
      state_timestamp: ts,
      ...state,
    });
  }

  /** Chain a write so concurrent handlers serialize on disk. */
  function queue(updater) {
    const next = writeChain.then(updater).catch((err) => {
      console.error("[ccmux-extension] write failed", err);
    });
    writeChain = next;
    return next;
  }

  /**
   * Merge `patch` into the session's state and flush a fresh marker.
   * @param {string} sessionId
   * @param {MarkerState} patch
   */
  function writeMerged(sessionId, patch) {
    const merged = { ...(sessionState.get(sessionId) ?? {}), ...patch };
    sessionState.set(sessionId, merged);
    return atomicWrite(
      markerPath(sessionId),
      buildMarkerBody(sessionId, merged),
    );
  }

  async function removeMarker(sessionId) {
    sessionState.delete(sessionId);
    pendingApprovals.delete(sessionId);
    activityReasons.delete(sessionId);
    stopReconcile(sessionId);
    try {
      await unlink(markerPath(sessionId));
    } catch (err) {
      // ENOENT is expected when we never wrote a marker for this session.
      if (err && err.code !== "ENOENT") {
        console.error("[ccmux-extension] unlink failed", err);
      }
    }
  }

  /**
   * Tool name of the oldest outstanding approval, i.e. the prompt omp is
   * currently showing (`Map` iterates in insertion order).
   * @param {Map<string, string|undefined>} pending
   */
  function headToolName(pending) {
    return pending.values().next().value;
  }

  /**
   * Marker state implied by the outstanding approvals and activity
   * reasons: an approval wait wins, then any activity reason means
   * `working`, otherwise `idle`.
   */
  function derivedState(sessionId) {
    if ((pendingApprovals.get(sessionId)?.size ?? 0) > 0)
      return "waiting_permission";
    if ((activityReasons.get(sessionId)?.size ?? 0) > 0) return "working";
    return "idle";
  }

  /**
   * Publish the derived state. Two rules, both load-bearing since the
   * approval-only era: stay `waiting_permission` until the last id resolves
   * (reporting `working` mid-wait would clear the row's attention while
   * prompts are still on screen), and name the oldest entry, because omp's
   * dialog surface is FIFO and newest-wins would point ccmux's Approve/Deny
   * notification at a tool the user cannot see.
   *
   * Returns the queued write so a handler can await the marker hitting disk.
   * @param {string} sessionId
   */
  function publishState(sessionId) {
    const pending = pendingApprovals.get(sessionId);
    /** @type {MarkerState} */
    const patch =
      pending && pending.size > 0
        ? {
            state: "waiting_permission",
            pending_tool: headToolName(pending),
          }
        : { state: derivedState(sessionId), pending_tool: undefined };
    return queue(() => writeMerged(sessionId, patch));
  }

  /**
   * Turn an activity reason on and publish. The ctx arms the reconcile
   * timer; omp's managed `ctx.setInterval` never outlives the session.
   */
  function startActivity(sessionId, reason, ctx) {
    let reasons = activityReasons.get(sessionId);
    if (!reasons) {
      reasons = new Set();
      activityReasons.set(sessionId, reasons);
    }
    reasons.add(reason);
    ensureReconcile(sessionId, ctx);
    return publishState(sessionId);
  }

  /**
   * Turn an activity reason off and publish.
   */
  function endActivity(sessionId, reason) {
    activityReasons.get(sessionId)?.delete(reason);
    return publishState(sessionId);
  }

  /**
   * Arm the low-frequency reconcile unless one is already running. Only
   * the public context surface is used: `ctx.isIdle()` (omp's
   * `!isStreaming`) can vouch for the `turn` reason alone, so a lost
   * agent_end cannot pin the row at `working` forever.
   */
  function ensureReconcile(sessionId, ctx) {
    if (reconcileTimers.has(sessionId)) return;
    if (typeof ctx?.setInterval !== "function") return;
    const entry = { ctx, id: null };
    entry.id = ctx.setInterval(() => {
      const reasons = activityReasons.get(sessionId);
      const busy = reasons !== undefined && reasons.size > 0;
      let idle;
      try {
        idle = ctx.isIdle?.();
      } catch {
        return;
      }
      if (idle !== true && idle !== false) return;
      if (busy) {
        // `ctx.isIdle()` is `!isStreaming`, which stays true through
        // compaction and retry backoff, so it may only clear the turn
        // reason; compaction and retry end events are paired on every
        // path (aborts included) and are trusted to deliver idle. An
        // approval wait is a deliberate pause, not a stuck reason: the
        // resolve path republishes, so leave it alone.
        if (
          idle &&
          (pendingApprovals.get(sessionId)?.size ?? 0) === 0 &&
          reasons.delete("turn")
        ) {
          // Return the queued write so a caller that inspects the marker
          // can await it (omp's timer ignores the return value).
          return publishState(sessionId);
        }
      } else if (idle) {
        stopReconcile(sessionId);
        if (sessionState.get(sessionId)?.state !== "idle")
          return publishState(sessionId);
      } else if (
        (pendingApprovals.get(sessionId)?.size ?? 0) === 0 &&
        sessionState.get(sessionId)?.state !== "working"
      ) {
        // Busy with no reason on record (an event we never saw): lean the
        // row toward working rather than let it read idle while omp runs,
        // but never over an approval wait.
        return queue(() =>
          writeMerged(sessionId, { state: "working", pending_tool: undefined }),
        );
      }
    }, RECONCILE_INTERVAL_MS);
    reconcileTimers.set(sessionId, entry);
  }

  function stopReconcile(sessionId) {
    const entry = reconcileTimers.get(sessionId);
    if (!entry) return;
    reconcileTimers.delete(sessionId);
    try {
      entry.ctx.clearTimer?.(entry.id);
    } catch {
      // The timer being cleared is the one that matters; a dead ctx is not
      // worth reporting.
    }
  }

  /** Resolve the main session id; subagents do not own a pane marker. */
  function sessionIdOf(ctx) {
    try {
      if (ctx?.agent?.kind === "sub") return null;
      const id = ctx?.sessionManager?.getSessionId();
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }

  function transcriptOf(ctx) {
    try {
      const file = ctx?.sessionManager?.getSessionFile();
      return typeof file === "string" && file ? file : undefined;
    } catch {
      return undefined;
    }
  }

  /** @param {any} omp */
  function ccmuxExtension(omp) {
    // session_start fires at launch (reason "startup") with the session id,
    // transcript path, and cwd all already resolved, so the marker carries
    // full identity immediately (unlike Codex, whose marker waits for the
    // first turn).
    omp.on("session_start", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      await mkdir(markersDir, { recursive: true });
      return queue(() =>
        writeMerged(sessionId, {
          state: "idle",
          directory: ctx.cwd,
          transcript_path: transcriptOf(ctx),
        }),
      );
    });

    // Fires after the user submits, before the agent loop. Carries the
    // prompt text, which ccmux surfaces as the session's last prompt.
    omp.on("before_agent_start", async (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const prompt =
        typeof event?.prompt === "string" ? event.prompt.trim() : "";
      if (!prompt) return;
      return queue(() =>
        writeMerged(sessionId, { last_prompt: prompt.slice(0, 1024) }),
      );
    });

    // Internal turns and tools do not finish a user prompt. Even agent_end
    // can schedule a continuation or arrive after the next prompt starts.
    omp.on("agent_start", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      // A user turn cannot start while an approval dialog is open, so any
      // approval still pending here is stale from an aborted turn. It also
      // supersedes a parked continuation from an earlier async wait.
      pendingApprovals.delete(sessionId);
      activityReasons.get(sessionId)?.delete("continuing");
      return startActivity(sessionId, "turn", ctx);
    });

    omp.on("agent_end", async (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      if (event?.willContinue === true) {
        // omp is waiting on async work before continuing this turn, and
        // nothing is streaming while it waits, so `ctx.isIdle()` reads
        // true and the reconcile must not flatten the turn. Park an
        // explicit continuation reason that only the next agent_start,
        // the terminal agent_end, or a rebind clears.
        return startActivity(sessionId, "continuing", ctx);
      }
      void (async () => {
        // Drop the turn reason first; a compaction or retry that outlived
        // the turn keeps the row working until its own end event.
        activityReasons.get(sessionId)?.delete("turn");
        activityReasons.get(sessionId)?.delete("continuing");
        if ((activityReasons.get(sessionId)?.size ?? 0) > 0) {
          pendingApprovals.delete(sessionId);
          return publishState(sessionId);
        }
        const state = await queue(() => sessionState.get(sessionId));
        await setImmediate();
        for (let retries = 10; retries >= 0; retries--) {
          const settled = await queue(async () => {
            if (sessionState.get(sessionId) !== state) return true;
            if (ctx.isIdle?.() === false) return false;
            pendingApprovals.delete(sessionId);
            await writeMerged(sessionId, {
              state: "idle",
              pending_tool: undefined,
            });
            return true;
          });
          if (settled !== false || retries === 0) return;
          await sleep(100);
        }
      })().catch((err) => {
        console.error("[ccmux-extension] idle settle failed", err);
      });
    });

    // omp emits the approval pair only when an approval is actually required,
    // so subscribing does not force pauses on the default `yolo` mode; it
    // only makes configured pauses observable. This is the one behavior where
    // omp diverges from Pi, which has no approval pause at all.
    omp.on("tool_approval_requested", async (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const toolCallId =
        typeof event?.toolCallId === "string" ? event.toolCallId : null;
      if (!toolCallId) return;
      let pending = pendingApprovals.get(sessionId);
      if (!pending) {
        pending = new Map();
        pendingApprovals.set(sessionId, pending);
      }
      pending.set(
        toolCallId,
        typeof event?.toolName === "string" ? event.toolName : undefined,
      );
      // omp awaits this handler before it renders the prompt, so returning
      // the queued write puts the waiting marker on disk by the time the
      // user can answer.
      return publishState(sessionId);
    });

    // Fires for both outcomes (approve and deny) and for the no-UI/aborted
    // paths omp resolves fail-closed. The agent loop resumes either way,
    // so `working` is right for both; `agent_end` still delivers the final
    // idle when the turn actually finishes.
    omp.on("tool_approval_resolved", async (event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      const pending = pendingApprovals.get(sessionId);
      // Nothing of ours is waiting (never saw the request, or `agent_end`
      // already cleared an aborted turn), so this resolve has no state to
      // undo. Writing `working` here would drag an idle row back up.
      if (!pending) return;
      const toolCallId =
        typeof event?.toolCallId === "string" ? event.toolCallId : null;
      if (toolCallId) pending.delete(toolCallId);
      // A resolve we cannot correlate must not pin the row at waiting
      // forever, so treat it as resolving everything outstanding.
      else pending.clear();
      // Re-publish so the notification retargets the prompt that just moved
      // to the front of the queue. The loop resumes on every resolve
      // (approve, deny, or the fail-closed no-UI path), so re-arm the
      // turn: an agent_end that gave up waiting for idle may already have
      // consumed it.
      if (pending.size === 0) pendingApprovals.delete(sessionId);
      return startActivity(sessionId, "turn", ctx);
    });

    // Compaction and auto-retry are activity the approval-era marker missed
    // most visibly: a session running auto-compaction after a turn read as
    // `idle` while it was busy and not ready for input. omp names a start
    // and an end event for each shape (manual `/compact` pairs
    // manual_compaction_* with session_compact, auto-compaction pairs
    // auto_compaction_* with it), so subscribe to every start and every end
    // and let the named-reason set make the overlap idempotent.
    // `session.compacting` is hasHandlers-gated: it fires only because this
    // extension subscribes, and omp reads only the optional
    // `context`/`prompt`/`preserveData` off the handler's return, so the
    // queued marker write we return is inert. The end events are paired on
    // every path (aborts included), so they are trusted to deliver idle;
    // the reconcile timer heals only a lost `turn`.
    //
    // Deliberately NOT subscribed: `session_before_compact`. omp skips its
    // speculative and mid-turn compaction entirely when an extension
    // registers that hook, and ccmux must not cost users background
    // compaction just to observe it.
    const trackActivity = (reason) => async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      return startActivity(sessionId, reason, ctx);
    };
    const untrackActivity = (reason) => async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      return endActivity(sessionId, reason);
    };

    for (const name of [
      "session.compacting",
      "auto_compaction_start",
      "manual_compaction_start",
    ]) {
      omp.on(name, trackActivity("compaction"));
    }
    for (const name of [
      "session_compact",
      "auto_compaction_end",
      "manual_compaction_end",
    ]) {
      omp.on(name, untrackActivity("compaction"));
    }
    omp.on("auto_retry_start", trackActivity("retry"));
    omp.on("auto_retry_end", untrackActivity("retry"));

    // `/new`, `/resume`, and `/branch` land here, not on a shutdown/start pair
    // (see the factory doc above). omp installs the new session id before it
    // emits, so every other id we still track belongs to the session we just
    // left: reap those markers, then seed a fresh idle marker for the current
    // id. The new file's chokidar add event drives the existing
    // `onMarkerAdded` re-link.
    const rebindToCurrentSession = async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      await mkdir(markersDir, { recursive: true });
      const stale = [...sessionState.keys()].filter((id) => id !== sessionId);
      // A same-id rebind is real (`reload()` re-enters switchSession), and
      // the rebind aborts the running turn, so drop any outstanding approval
      // rather than publish an idle marker that a late resolve could drag
      // back to working.
      pendingApprovals.delete(sessionId);
      // The rebind aborts any running turn, so drop its activity reasons
      // too; the fresh idle marker below is the whole truth.
      activityReasons.delete(sessionId);
      stopReconcile(sessionId);
      return queue(async () => {
        for (const id of stale) await removeMarker(id);
        await writeMerged(sessionId, {
          state: "idle",
          directory: ctx.cwd,
          transcript_path: transcriptOf(ctx),
          pending_tool: undefined,
        });
      });
    };

    omp.on("session_switch", rebindToCurrentSession);

    // `session_branch` is the same id-changing event class as `session_switch`,
    // just reached through `/branch` and the `app.session.fork` keybinding;
    // omp mints the fresh id before emitting, so the handler sees the new id
    // exactly as it does for a switch. Without this the old marker leaks for
    // the life of the process, and the per-scan link pass cannot heal the row
    // because it skips sessions already holding a marker-matched id.
    //
    // Deliberately NOT registered for `session_tree`: a tree switch moves a
    // leaf within the same session and leaves the session id untouched.
    omp.on("session_branch", rebindToCurrentSession);

    // Forward-compat alias: upstream pi-mono renamed `session_branch` ->
    // `session_fork`. omp has not taken the rename yet but tracks upstream,
    // so subscribing to both keeps a future omp from regressing to the
    // leaked-marker bug this handler fixes; an unused handler costs nothing.
    omp.on("session_fork", rebindToCurrentSession);

    omp.on("session_shutdown", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      return queue(() => removeMarker(sessionId));
    });
  }

  // Carry the installed version as metadata (parity with the OpenCode
  // plugin). omp ignores unknown properties on the default-exported factory.
  ccmuxExtension.version = version;
  return ccmuxExtension;
}

const ccmuxExtension = makeExtension({
  markersDir: "__CCMUX_MARKERS_DIR__",
  version: "__CCMUX_VERSION__",
});

export default ccmuxExtension;
