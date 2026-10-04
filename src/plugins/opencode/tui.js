// ccmux-plugin v__CCMUX_VERSION__
// OpenCode 2 TUI plugin shipped by ccmux. Writes marker files into the ccmux
// session-pids dir so the daemon can correlate OpenCode sessions to tmux
// panes. Installed + uninstalled via `ccmux setup --agent opencode` as
// `<opencode config>/plugins/ccmux/tui.js`.
// Source: github.com/epilande/ccmux
//
// Why a TUI plugin (issue #214): OpenCode 2 runs every session in one shared
// background service outside all tmux panes, and server plugins run there,
// so a server plugin's pid cannot locate a pane. A TUI plugin is imported
// into the TUI process itself, which IS the pane's process, so its pid works
// with the same pid -> pane lookup as the 1.x server plugin, and it knows
// which session the pane is showing. OpenCode 1 ignores this location (it
// only loads loose `plugin/*.js` files), so it is safe to install on both.
//
// Markers keep the 1.x schema and file name (`opencode-<sessionID>.json`,
// `pid` = this process), so the daemon's adapter, aggregation, link healing
// and marker-ownership check all run unchanged. One rule is new: in 2.x two
// TUIs can show the SAME session (e.g. `opencode --continue` in a second
// pane), and with one marker file per session they would overwrite each
// other's pid. So the first TUI to show a session owns its marker, and the
// others leave it alone until the owner moves on or exits; a non-owner pane
// keeps the daemon's terminal-pattern status for the same session.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const AGENT_TYPE = "opencode";

/** The route's session id before `--continue` resolves a real session. */
const CONTINUE_PLACEHOLDER_ID = "dummy";

/** Events after which the reported state may have changed. */
const STATE_EVENT = /^(session\.execution\.|session\.retry\.|permission\.|form\.|session\.inbox\.enqueued$|session\.renamed$|session\.deleted$)/;

/**
 * @typedef {object} MakeTuiPluginOptions
 * @property {string} markersDir  Absolute path to ccmux marker directory.
 * @property {string} version     ccmux version string (for the sentinel line).
 * @property {() => number} [now] Injected clock, ms epoch.
 * @property {number} [pid]       This process's pid (the marker's pane claim).
 * @property {(pid: number) => boolean} [isAlive] Whether a pid is running.
 * @property {number} [pollMs]    How often to re-read the route; 0 disables.
 */

/**
 * Build an OpenCode 2 TUI plugin bound to the given markers dir.
 * @param {MakeTuiPluginOptions} opts
 */
export function makeTuiPlugin({
  markersDir,
  version,
  now = Date.now,
  pid = process.pid,
  isAlive = isProcessAlive,
  pollMs = 500,
}) {
  function markerPath(sessionId) {
    return join(markersDir, `${AGENT_TYPE}-${sessionId}.json`);
  }

  function readMarker(sessionId) {
    try {
      return JSON.parse(readFileSync(markerPath(sessionId), "utf-8"));
    } catch {
      return null;
    }
  }

  /** Another live TUI already reports this session. */
  function ownedElsewhere(sessionId) {
    const existing = readMarker(sessionId);
    return (
      !!existing &&
      typeof existing.pid === "number" &&
      existing.pid !== pid &&
      isAlive(existing.pid)
    );
  }

  /** @param {any} ctx OpenCode's TUI plugin context. */
  function setup(ctx) {
    mkdirSync(markersDir, { recursive: true });

    /** Root session id the pane is showing, or null. */
    let observed = null;
    /** Session id whose marker this process wrote and has not removed. */
    let owned = null;
    /** JSON of the state fields last written, to skip identical writes. */
    let written = null;
    /** Last user prompt per session, from `session.inbox.enqueued`. */
    const lastPrompt = new Map();

    function release() {
      if (!owned) return;
      const sessionId = owned;
      owned = null;
      written = null;
      // Never delete a marker another TUI has since claimed.
      if (readMarker(sessionId)?.pid !== pid) return;
      try {
        unlinkSync(markerPath(sessionId));
      } catch {
        // Already gone (e.g. the daemon reaped it).
      }
    }

    function currentRoot() {
      const route = ctx.ui.router.current();
      if (route?.type !== "session" || !route.sessionID) return null;
      // `opencode --continue` starts on this placeholder and stays there when
      // the directory has nothing to continue; OpenCode's own session tabs
      // skip it the same way. Reporting it would give every such pane, in
      // any repo, one shared fake session id.
      if (route.sessionID === CONTINUE_PLACEHOLDER_ID) return null;
      return ctx.data.session.root(route.sessionID) || route.sessionID;
    }

    function seed(root) {
      const family = familyOf(ctx, root);
      Promise.all(
        family.flatMap((id) => [
          ctx.data.session.permission.sync(id),
          ctx.data.session.form.sync(id),
        ]),
      )
        .catch((err) => console.error("[ccmux-plugin] seed failed", err))
        .then(refresh);
    }

    function write(sessionId, fields) {
      const body = JSON.stringify(fields);
      // Unchanged state needs no write, unless the file went missing.
      if (
        owned === sessionId &&
        body === written &&
        existsSync(markerPath(sessionId))
      ) {
        return;
      }
      if (ownedElsewhere(sessionId)) {
        if (owned === sessionId) {
          // Lost a simultaneous claim; the other TUI keeps it.
          owned = null;
          written = null;
        }
        return;
      }
      const ts = now() / 1000;
      const path = markerPath(sessionId);
      const tmp = `${path}.tmp.${pid}.${now()}`;
      writeFileSync(
        tmp,
        JSON.stringify({
          agent_type: AGENT_TYPE,
          pid,
          session_id: sessionId,
          timestamp: ts,
          state_timestamp: ts,
          ...fields,
        }),
      );
      renameSync(tmp, path);
      owned = sessionId;
      written = body;
    }

    function refresh() {
      try {
        const root = currentRoot();
        if (root !== observed) {
          release();
          observed = root;
          if (root) seed(root);
        }
        if (!observed) return;
        write(observed, describeSession(ctx, observed, lastPrompt));
      } catch (err) {
        console.error("[ccmux-plugin] refresh failed", err);
      }
    }

    const offListen = ctx.data.listen(({ details }) => {
      const type = details?.type;
      if (!type || !STATE_EVENT.test(type)) return;
      const data = details.data ?? {};
      if (type === "session.inbox.enqueued" && data.item?.type === "user") {
        const text = data.item.payload?.text;
        if (typeof text === "string" && text.trim()) {
          lastPrompt.set(data.sessionID, text.trim().slice(0, 1024));
        }
      }
      if (type === "session.deleted" && data.sessionID === owned) {
        release();
        observed = null;
        return;
      }
      // OpenCode patches its stores from the same event; read them after.
      setTimeout(refresh, 0);
    });

    // The route has no change event a plain-JS plugin can subscribe to, so
    // poll it; each tick is a few in-memory reads and usually no write.
    const timer = pollMs > 0 ? setInterval(refresh, pollMs) : null;
    timer?.unref?.();
    // The TUI may exit without running plugin cleanup.
    process.once("exit", release);
    refresh();

    return () => {
      if (timer) clearInterval(timer);
      offListen();
      process.removeListener("exit", release);
      release();
    };
  }

  return { id: "ccmux", version, setup };
}

/** A session plus its subagent sessions, root first. */
function familyOf(ctx, root) {
  const family = ctx.data.session.family(root) ?? [];
  return [root, ...family.filter((id) => id !== root)];
}

/**
 * The marker fields for a root session: waiting when any session in its
 * family has a pending permission or question, working when any is running,
 * else idle.
 */
function describeSession(ctx, root, lastPrompt) {
  const family = familyOf(ctx, root);
  const permissions = family.flatMap(
    (id) => ctx.data.session.permission.list(id) ?? [],
  );
  const forms = family.flatMap((id) => ctx.data.session.form.list(id) ?? []);
  const running = family.some((id) => ctx.data.session.status(id) === "running");
  const info = ctx.data.session.get(root);

  let state = "idle";
  let pendingTool = null;
  let context = null;
  if (permissions.length > 0) {
    state = "waiting_permission";
    pendingTool = permissions[0].action ?? null;
    context = describePermission(permissions[0]);
  } else if (forms.length > 0) {
    state = "waiting_question";
    context = describeForm(forms[0]);
  } else if (running) {
    state = "working";
  }

  const fields = {
    state,
    pending_tool: pendingTool,
    permission_context: context,
    directory: info?.location?.directory,
    title: info?.title,
  };
  const prompt = lastPrompt.get(root) ?? lastUserText(ctx, root);
  if (prompt) fields.last_prompt = prompt;
  return fields;
}

/** Newest user prompt already loaded for the session, capped at 1KB. */
function lastUserText(ctx, sessionId) {
  const messages = ctx.data.session.message.list(sessionId) ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.type === "user" && typeof message.text === "string") {
      const text = message.text.trim();
      if (text) return text.slice(0, 1024);
    }
  }
  return null;
}

/**
 * Best-effort summary of a permission request: its message, else an
 * obvious metadata field, else the first resource (the command, for shell)
 * unless it is the bare `*` wildcard (the question tool's own permission),
 * else the action.
 *
 * @param {any} request
 * @returns {string|null}
 */
export function describePermission(request) {
  if (typeof request?.message === "string" && request.message) {
    return request.message;
  }
  const meta = request?.metadata;
  if (meta && typeof meta === "object") {
    if (typeof meta.command === "string") return meta.command;
    if (typeof meta.description === "string") return meta.description;
    if (typeof meta.path === "string") return meta.path;
  }
  const resources = request?.resources;
  if (Array.isArray(resources) && resources.length > 0 && resources[0] !== "*") {
    return String(resources[0]);
  }
  return typeof request?.action === "string" ? request.action : null;
}

/**
 * The first question of a form (OpenCode 2's question tool), with a count
 * suffix when it asks more than one.
 *
 * @param {any} form
 * @returns {string|null}
 */
export function describeForm(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const first = fields[0];
  const text =
    typeof first?.description === "string" && first.description
      ? first.description
      : typeof first?.title === "string" && first.title
        ? first.title
        : typeof form?.title === "string"
          ? form.title
          : null;
  if (!text) return null;
  return fields.length > 1 ? `${text} (+${fields.length - 1} more)` : text;
}

function isProcessAlive(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

const ccmuxTuiPlugin = makeTuiPlugin({
  markersDir: "__CCMUX_MARKERS_DIR__",
  version: "__CCMUX_VERSION__",
});

export default ccmuxTuiPlugin;
