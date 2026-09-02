// ccmux-plugin v__CCMUX_VERSION__
// OpenCode plugin shipped by ccmux. Writes marker files into the ccmux
// session-pids dir so the daemon can correlate OpenCode sessions to
// tmux panes. Installed + uninstalled via `ccmux setup --agent opencode`.
// Source: github.com/epilande/ccmux

import { writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * @typedef {object} OpencodeSessionInfo
 * @property {string} id
 * @property {string} directory
 * @property {string} title
 */

/**
 * @typedef {{type: "idle"} | {type: "busy"} | {type: "retry"}} OpencodeSessionStatus
 */

/**
 * @typedef {object} MarkerState
 * @property {"idle"|"working"|"waiting_permission"|"waiting_question"} [state]
 * @property {number} [state_timestamp] Float epoch seconds (sub-second
 *   precision, matching the jq-based hook scripts' `now`), so two sibling
 *   sessions updated within the same wall-clock second still order
 *   deterministically instead of tying.
 * @property {string} [directory]
 * @property {string} [title]
 * @property {string|null} [pending_tool]
 * @property {string|null} [permission_context]
 * @property {string} [last_prompt]
 */

/**
 * @typedef {object} MakePluginOptions
 * @property {string} markersDir   Absolute path to ccmux marker directory.
 * @property {string} version      ccmux version string (for the sentinel line).
 * @property {() => number} [now]  Injected clock, ms epoch. Defaults to Date.now.
 */

/**
 * Build an OpenCode plugin bound to the given markers dir.
 * @param {MakePluginOptions} opts
 */
export function makePlugin({ markersDir, version, now = Date.now }) {
  const AGENT_TYPE = "opencode";

  /** @type {Map<string, Promise<void>>} */
  const writeQueues = new Map();
  /**
   * Last-written marker state per session. Keeps `session.updated` from
   * clobbering an in-flight `working`/`waiting_permission`/`waiting_question`
   * back to idle when a rename event arrives (question asks trigger a title
   * rename mid-wait, observed live), and lets us suppress no-op writes when
   * a bus event would produce a byte-identical marker.
   * @type {Map<string, MarkerState>}
   */
  const sessionState = new Map();
  /**
   * Most recent user message ID per session, registered via
   * `message.updated`. The `message.part.updated` handler captures text
   * for this messageID only — earlier user messages are ignored, matching
   * the "lastPrompt" semantics. Cleared on `session.deleted` and
   * `removeMarker`.
   * @type {Map<string, string>} sessionId -> userMessageId
   */
  const lastUserMessageId = new Map();

  function markerPath(sessionId) {
    return join(markersDir, `${AGENT_TYPE}-${sessionId}.json`);
  }

  async function atomicWrite(path, body) {
    const tmp = `${path}.tmp.${process.pid}.${now()}`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  function buildMarkerBody(sessionId, state) {
    const ts = now();
    const body = {
      agent_type: AGENT_TYPE,
      pid: process.pid,
      session_id: sessionId,
      // Float seconds (not floored) so sibling sessions updated within the
      // same wall-clock second still order deterministically in aggregate.ts.
      timestamp: ts / 1000,
      state_timestamp: ts / 1000,
      ...state,
    };
    return JSON.stringify(body);
  }

  /**
   * Chain a per-session write so `permission.asked` and `session.status`
   * firing within the same tick serialize on disk in emit order.
   *
   * @param {string} sessionId
   * @param {() => Promise<void>} updater
   */
  function queueWrite(sessionId, updater) {
    const prior = writeQueues.get(sessionId) ?? Promise.resolve();
    const next = prior.then(updater).catch((err) => {
      console.error(`[ccmux-plugin] ${sessionId}: write failed`, err);
    });
    writeQueues.set(sessionId, next);
    return next;
  }

  /**
   * Merge `patch` into the session's in-memory state and flush a fresh
   * marker file. Null values in patch clear the prior field. Suppresses
   * the write when every patch field already matches `sessionState` so
   * heartbeat-like `session.status` re-emits don't burn a tmp+rename.
   *
   * @param {string} sessionId
   * @param {MarkerState} patch
   */
  function writeMerged(sessionId, patch) {
    const prev = sessionState.get(sessionId) ?? {};
    if (prev && patchIsNoop(prev, patch)) return Promise.resolve();
    const merged = { ...prev, ...patch };
    sessionState.set(sessionId, merged);
    return atomicWrite(
      markerPath(sessionId),
      buildMarkerBody(sessionId, merged),
    );
  }

  function patchIsNoop(prev, patch) {
    for (const key of Object.keys(patch)) {
      if (prev[key] !== patch[key]) return false;
    }
    return true;
  }

  async function removeMarker(sessionId) {
    sessionState.delete(sessionId);
    writeQueues.delete(sessionId);
    lastUserMessageId.delete(sessionId);
    try {
      await unlink(markerPath(sessionId));
    } catch (err) {
      // ENOENT is expected when we never wrote a marker for this session.
      if (err && err.code !== "ENOENT") {
        console.error(`[ccmux-plugin] ${sessionId}: unlink failed`, err);
      }
    }
  }

  /** Map OpenCode's session.status to a ccmux marker state. */
  function stateFromStatus(status) {
    if (!status) return "idle";
    if (status.type === "idle") return "idle";
    // "busy" and "retry" are both user-visible "working".
    return "working";
  }

  /**
   * Seed markers at boot for the sessions THIS server actually hosts.
   *
   * Ownership rule (issue #177). `session.list` is project-wide: OpenCode
   * serves it from the SQLite db every process in the directory SHARES, so
   * it returns the project's whole history plus every sibling process's live
   * sessions. A marker carries `pid: process.pid`, which makes it a HOSTING
   * CLAIM — seeding one for a session we do not host hands the daemon a
   * wrong pid for that session id, flipping the row to this pane, resetting
   * its state to idle and dropping the sibling's `last_prompt`.
   *
   * `client.session.status` is the only per-process evidence available: it
   * is backed by `SessionStatus.list()`, an in-memory Map owned by THIS
   * server, whose entries are deleted when a session goes idle. So an entry
   * exists only for a session this process is currently running, and
   * membership — not the entry's value — is the proof we may claim it.
   * Sessions with no entry are skipped entirely; a later `session.status`,
   * `session.created` or prompt event writes their marker normally, at which
   * point the pid claim is true. When `session.status` itself fails we seed
   * nothing, which is the safe direction.
   *
   * The old blanket seed also mis-set fresh rows even with one server
   * running: every listed historical session got a marker written in the
   * same millisecond, so the daemon's newest-marker fold picked an arbitrary
   * one and `ccmux last` on an untouched row read a random old transcript.
   */
  async function eagerSeed(client, directory) {
    const [listRes, statusRes] = await Promise.all([
      client.session.list({ query: { directory } }).catch((err) => {
        console.error("[ccmux-plugin] session.list failed", err);
        return null;
      }),
      client.session.status({ query: { directory } }).catch((err) => {
        console.error("[ccmux-plugin] session.status failed", err);
        return null;
      }),
    ]);

    if (!listRes) return;
    /** @type {OpencodeSessionInfo[]} */
    const sessions = listRes.data || [];
    /** @type {Record<string, OpencodeSessionStatus>} */
    const statusMap = (statusRes && statusRes.data) || {};

    const writes = sessions
      .filter((s) => Object.hasOwn(statusMap, s.id))
      .map((s) =>
        queueWrite(s.id, () =>
          writeMerged(s.id, {
            state: stateFromStatus(statusMap[s.id]),
            directory: s.directory,
            title: s.title,
          }),
        ),
      );
    await Promise.all(writes);
  }

  /**
   * @typedef {{type: string, properties: any}} BusEvent
   * @param {BusEvent} event
   */
  async function dispatchEvent(event) {
    const { type, properties } = event;
    if (!type || !properties) return;

    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = properties.info;
        if (!info?.id) return;
        const prior = sessionState.get(info.id);
        return queueWrite(info.id, () =>
          writeMerged(info.id, {
            state: prior?.state ?? "idle",
            directory: info.directory,
            title: info.title,
          }),
        );
      }

      case "session.deleted": {
        const info = properties.info;
        if (!info?.id) return;
        return queueWrite(info.id, () => removeMarker(info.id));
      }

      case "session.status": {
        const { sessionID, status } = properties;
        if (!sessionID) return;
        return queueWrite(sessionID, () =>
          writeMerged(sessionID, { state: stateFromStatus(status) }),
        );
      }

      // Relies on OpenCode firing `message.updated` before
      // `message.part.updated` for the same message (session.ts:476-492).
      case "message.updated": {
        const info = properties?.info;
        if (!info?.id || !info?.sessionID || info.role !== "user") return;
        lastUserMessageId.set(info.sessionID, info.id);
        return;
      }

      case "message.part.updated": {
        const part = properties?.part;
        if (!part || part.type !== "text") return;
        if (part.synthetic) return;
        const sessionId = part.sessionID;
        const messageId = part.messageID;
        if (!sessionId || !messageId) return;
        if (lastUserMessageId.get(sessionId) !== messageId) return;
        const text = typeof part.text === "string" ? part.text.trim() : "";
        if (!text) return;
        const last_prompt = text.slice(0, 1024);
        return queueWrite(sessionId, () =>
          writeMerged(sessionId, { last_prompt }),
        );
      }

      case "permission.asked": {
        const { sessionID, permission } = properties;
        if (!sessionID) return;
        return queueWrite(sessionID, () =>
          writeMerged(sessionID, {
            state: "waiting_permission",
            pending_tool: permission || null,
            permission_context: describePermission(properties),
          }),
        );
      }

      case "permission.replied": {
        const { sessionID } = properties;
        if (!sessionID) return;
        return queueWrite(sessionID, () =>
          writeMerged(sessionID, {
            state: "working",
            pending_tool: null,
            permission_context: null,
          }),
        );
      }

      // The `question` tool blocks the turn on a pending deferred exactly
      // like permissions do, but `session.status` stays `busy` the whole
      // time (verified live on OpenCode 1.18.15: no status event of any
      // kind fires at ask time), so without these cases the session pins
      // at `working` for as long as the picker is open. The unprefixed v1
      // event names are what the plugin bus publishes; the `question.v2.*`
      // family never reaches this hook.
      case "question.asked": {
        const { sessionID } = properties;
        if (!sessionID) return;
        return queueWrite(sessionID, () =>
          writeMerged(sessionID, {
            state: "waiting_question",
            pending_tool: null,
            permission_context: describeQuestion(properties),
          }),
        );
      }

      // Both resolutions land as `working`, mirroring `permission.replied`,
      // and the next `session.status` corrects within ~100ms. Only an ANSWER
      // actually resumes the turn; a REJECT ends it, so the `working` write
      // there is a sub-second transient the status event supersedes rather
      // than a claim that work resumed. Both settle, hence one arm for both.
      // That status event is also the self-heal for a missed reply: nothing
      // fires during the wait itself, so a stale `waiting_question` survives
      // only until OpenCode next reports status.
      case "question.replied":
      case "question.rejected": {
        const { sessionID } = properties;
        if (!sessionID) return;
        return queueWrite(sessionID, () =>
          writeMerged(sessionID, {
            state: "working",
            pending_tool: null,
            permission_context: null,
          }),
        );
      }
    }
  }

  /**
   * OpenCode awaits every plugin's async default export before it finishes
   * booting. `client.session.list` / `client.session.status` are served by
   * in-process handlers that depend on runtime state that is only ready
   * AFTER plugin init completes, so awaiting the seed here deadlocks boot.
   * Fire and forget: mkdir synchronously-awaitable, return hooks immediately,
   * let the seed resolve whenever the SDK is ready. Any bus events that fire
   * in the meantime are handled via the normal `event` hook below.
   *
   * @param {import("@opencode-ai/plugin").PluginInput} input
   */
  async function plugin(input) {
    await mkdir(markersDir, { recursive: true });
    const seedPromise = eagerSeed(input.client, input.directory);
    // Surface rejection for visibility without blocking init.
    seedPromise.catch(() => {});

    return {
      event: async ({ event }) => {
        try {
          await dispatchEvent(event);
        } catch (err) {
          console.error(`[ccmux-plugin] event ${event?.type} failed`, err);
        }
      },
      /** @internal Exposed for tests so they can await the deferred seed. OpenCode ignores unknown hook keys. */
      _seedReady: seedPromise,
    };
  }

  plugin.version = version;
  return plugin;
}

/**
 * Best-effort human-readable description for a permission.asked event.
 * Falls back to the permission class name when metadata has no obvious
 * summary field.
 *
 * @param {any} properties
 * @returns {string|null}
 */
function describePermission(properties) {
  const meta = properties?.metadata;
  if (meta && typeof meta === "object") {
    if (typeof meta.command === "string") return meta.command;
    if (typeof meta.description === "string") return meta.description;
    if (typeof meta.path === "string") return meta.path;
  }
  const patterns = properties?.patterns;
  if (Array.isArray(patterns) && patterns.length > 0) {
    return String(patterns[0]);
  }
  if (typeof properties?.permission === "string") return properties.permission;
  return null;
}

/**
 * First question's text for a question.asked event, with a count suffix
 * when the request carries more than one question. Payload shape verified
 * live on OpenCode 1.18.15: `properties.questions` is an array of
 * `{question, header, options}`.
 *
 * @param {any} properties
 * @returns {string|null}
 */
function describeQuestion(properties) {
  const questions = properties?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const first = questions[0];
  const text =
    typeof first?.question === "string"
      ? first.question
      : typeof first?.header === "string"
        ? first.header
        : null;
  if (!text) return null;
  return questions.length > 1
    ? `${text} (+${questions.length - 1} more)`
    : text;
}

const ccmuxPlugin = makePlugin({
  markersDir: "__CCMUX_MARKERS_DIR__",
  version: "__CCMUX_VERSION__",
});

export default ccmuxPlugin;
