// ccmux-extension v__CCMUX_VERSION__
// oh-my-pi (omp) extension shipped by ccmux. Writes marker files into the
// ccmux session-pids dir so the daemon can correlate omp sessions to tmux
// panes. Installed + uninstalled via `ccmux setup --agent omp`.
// Source: github.com/epilande/ccmux
//
// omp is a hard fork of Pi and kept Pi's extension API, so this file is a
// near-copy of src/plugins/pi/ccmux.js. It is duplicated rather than shared
// because the two agents install into different dirs, write different
// marker prefixes, and diverge on approval tracking (omp HAS a tool-approval
// pause; Pi does not). A shared module would have to be parameterized on all
// three and would still ship as two rendered files.
//
// omp auto-discovers both *.ts and *.js extensions from
// `<agent dir>/extensions/`, so this plain-JS file runs unchanged under
// whichever runtime (node or bun) launched omp. Authored as JS (not TS) so it
// stays out of ccmux's own TypeScript compilation.

import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

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
 */

/**
 * Build an omp extension bound to the given markers dir.
 *
 * omp runs ONE session per process, so markers (keyed by session id) never
 * overlap and need no OpenCode-style aggregation. We still key all
 * bookkeeping by session id so a re-bound instance can't cross-contaminate.
 *
 * Unlike upstream Pi, a session switch (`/new`, `/resume`) does NOT emit
 * `session_shutdown` + `session_start`: omp mutates the session in place and
 * emits `session_before_switch` then `session_switch` (verified on omp
 * 17.1.3), never reconstructing the extension runner. The `session_switch`
 * handler below is what keeps the old session's marker from leaking and
 * seeds the new one.
 *
 * @param {MakeExtensionOptions} opts
 */
export function makeExtension({ markersDir, version, now = Date.now }) {
  const AGENT_TYPE = "omp";

  /**
   * Last-written marker state per session, so a `state` flip preserves the
   * `directory`/`transcript_path`/`last_prompt` captured at session_start.
   * @type {Map<string, MarkerState>}
   */
  const sessionState = new Map();
  /**
   * Tool calls awaiting an approval decision, per session, as an
   * insertion-ordered `toolCallId -> toolName`. omp can gate several tool
   * calls from one assistant turn (shared-concurrency tools run in parallel
   * and each requests approval before any resolves), so the session stays
   * `waiting_permission` until the LAST id resolves; resolving one of three
   * must not report the session back as working while two prompts remain.
   *
   * `pending_tool` publishes the OLDEST outstanding entry, not the newest,
   * because omp's dialog surface is FIFO: the prompt actually on screen is
   * the first one requested. Newest-wins would name a tool the user cannot
   * see, and ccmux's Approve/Deny notification would describe the wrong call.
   * Insertion order is trustworthy because omp awaits each handler, so the
   * requests arrive here in the same order they queue on screen.
   * @type {Map<string, Map<string, string|undefined>>}
   */
  const pendingApprovals = new Map();
  /**
   * Serialize tmp+rename writes so events firing in the same tick
   * (before_agent_start -> agent_start) can't race on disk.
   * @type {Promise<void>}
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
   * currently showing.
   * @param {Map<string, string|undefined>} pending
   */
  function headToolName(pending) {
    for (const toolName of pending.values()) return toolName;
    return undefined;
  }

  /** Resolve the active session id from the read-only session manager. */
  function sessionIdOf(ctx) {
    try {
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

    // agent_start / agent_end bracket one full user prompt (the whole
    // agentic loop, including every internal turn/tool call), so they are
    // the flicker-free working<->idle signal. turn_start/turn_end repeat
    // within a prompt and would bounce the row to idle mid-response.
    omp.on("agent_start", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      return queue(() =>
        writeMerged(sessionId, { state: "working", pending_tool: undefined }),
      );
    });

    omp.on("agent_end", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      // Defensive clear: an aborted turn (Ctrl-C, session abort) can end the
      // loop while a prompt is still open, and a leaked id would pin every
      // later turn's resolve to "still waiting".
      pendingApprovals.delete(sessionId);
      return queue(() =>
        writeMerged(sessionId, { state: "idle", pending_tool: undefined }),
      );
    });

    // omp emits the approval pair only when `approvalCheck.required` AND an
    // extension has a handler for one of them (the `hasHandlers` gate in
    // src/extensibility/extensions/wrapper.ts, verified on omp 17.1.3).
    // Subscribing therefore does NOT force approval pauses on the default
    // `yolo` mode; it only makes the pauses observable for users who have
    // configured an approval mode. This is the one behavior where omp
    // diverges from Pi, which has no approval pause at all.
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
      // Publish the head, not this request: with two calls gated at once the
      // second request arrives while the FIRST one's dialog is on screen.
      const toolName = headToolName(pending);
      // omp awaits this handler before it renders the prompt, so the
      // waiting marker is on disk by the time the user can answer.
      return queue(() =>
        writeMerged(sessionId, {
          state: "waiting_permission",
          pending_tool: toolName,
        }),
      );
    });

    // Fires for BOTH outcomes (approve and deny) and for the no-UI/aborted
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
      // Overlapping approvals: stay waiting until the LAST id resolves, and
      // re-publish so `pending_tool` names the dialog that just moved to the
      // front of the FIFO queue. Answering the first of two prompts must
      // retarget the notification at the second, not keep naming the answered
      // one (and, before this, not name the newest one that is still buried).
      if (pending.size > 0) {
        const toolName = headToolName(pending);
        return queue(() =>
          writeMerged(sessionId, {
            state: "waiting_permission",
            pending_tool: toolName,
          }),
        );
      }
      pendingApprovals.delete(sessionId);
      return queue(() =>
        writeMerged(sessionId, { state: "working", pending_tool: undefined }),
      );
    });

    // `/new` and `/resume` land here, not on a shutdown/start pair (see the
    // factory doc above). omp installs the new session id BEFORE it emits, so
    // every OTHER id we still track belongs to the session we just left: reap
    // those markers, then seed a fresh idle marker for the current id. The
    // daemon needs no change; the new file's chokidar add event drives the
    // existing `onMarkerAdded` re-link.
    omp.on("session_switch", async (_event, ctx) => {
      const sessionId = sessionIdOf(ctx);
      if (!sessionId) return;
      await mkdir(markersDir, { recursive: true });
      const stale = [...sessionState.keys()].filter((id) => id !== sessionId);
      // A same-id switch is real (`reload()` re-enters switchSession with the
      // current file), and the switch aborts the running turn, so drop any
      // approval this id still had outstanding rather than publish an idle
      // marker that a late resolve could drag back to working.
      pendingApprovals.delete(sessionId);
      return queue(async () => {
        for (const id of stale) await removeMarker(id);
        await writeMerged(sessionId, {
          state: "idle",
          directory: ctx.cwd,
          transcript_path: transcriptOf(ctx),
          pending_tool: undefined,
        });
      });
    });

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
