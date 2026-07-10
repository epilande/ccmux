/**
 * The daemon's `Notifier` deliver dependency: wraps `src/lib/notify.ts`'s
 * bare `deliver` with everything that needs daemon/session context the lib
 * module deliberately doesn't know about (per its own docs, it's
 * dependency-free so the TUI could reuse it):
 *
 * - Resolves the backend fresh per delivery (config is read live) and probes
 *   each distinct backend once per daemon lifetime, per
 *   `notifications-plan.md`'s "Fail-open everywhere": a broken backend logs
 *   once and disables delivery for THAT backend for the rest of the daemon's
 *   run rather than retrying forever. Because the probe result is cached per
 *   backend (not globally), switching `notifications.backend` away from a
 *   broken one and back doesn't get stuck disabled, and a backend that was
 *   never tried gets its own fresh probe.
 * - For `terminal-notifier` only, enriches the payload with the click
 *   actions the plan's "Click-to-jump" section describes: `-sender` (the
 *   configurable icon), `-activate` (always the resolved terminal bundle id,
 *   regardless of icon setting), and `-execute` (jump to the session's pane,
 *   or - for background/unbound sessions with no pane - open the picker
 *   popup on the most-recently-active tmux client instead).
 * - For `dbus`, routes to a persistent `DbusNotifier` (created lazily on
 *   first use) instead of `src/lib/notify.ts`'s spawn-based `deliver` (which
 *   treats "dbus" as a no-op — it's connection-oriented, not spawn-oriented).
 *   A failed dbus probe falls back to resolving "notify-send" for that
 *   delivery rather than hard-disabling notifications on Linux, per the
 *   "Seamless backends" section of the plan. The click action runs
 *   in-process (no `sh -c` wrapper needed — we're already in the daemon):
 *   a bound session spawns `tmux switch-client`, a background/unbound one
 *   spawns `tmux display-popup`, mirroring `switch.ts`'s argv.
 *
 * Click actions for the spawn-based backends run in Notification Center's
 * minimal-PATH shell, so the built `-execute` command is wrapped as
 * `/bin/sh -c 'PATH=<daemon PATH> exec <abs binary> ...'`, capturing the
 * daemon's own PATH and resolved absolute binaries once at construction
 * time (see `createDeliverFn`'s `ccmuxPath`/`tmuxPath` params).
 */

import type { Backend, NotificationPayload, SpawnFn } from "../lib/notify";
import type { NotificationsConfig } from "../lib/preferences";
import { shellQuote } from "../lib/shell-quote";

/** Structural subset of `DbusNotifier` (`src/lib/notify-dbus.ts`) this
 * module calls — lets tests inject a fake without touching the real
 * dbus-next connection. The real `DbusNotifier` satisfies this shape. */
export interface DbusNotifierLike {
  probe(): Promise<boolean>;
  notify(
    payload: NotificationPayload,
    options?: { onActivate?: () => void },
  ): Promise<number | null>;
  close(): Promise<void>;
}

export interface DeliveryDeps {
  getPrefs: () => Promise<{ notifications?: NotificationsConfig }>;
  /** tmux client pid backing `-sender`/`-activate` bundle-id resolution. */
  getClientPid: () => Promise<number | null>;
  resolveTerminalBundleId: (clientPid: number) => Promise<string | null>;
  /** Most-recently-active attached client, for the background-session popup
   * click target (`display-popup -c`). */
  resolveActiveClientTty: () => Promise<string | null>;
  resolveBackend: (config: {
    backend?: NotificationsConfig["backend"];
  }) => Backend | null;
  probeBackend: (backend: Backend) => Promise<boolean>;
  deliver: (backend: Backend, payload: NotificationPayload) => Promise<void>;
  /** Absolute path to the `ccmux` entry point, or null if unresolvable (see
   * `createDeliverFn`'s doc comment). Click actions are omitted when null. */
  ccmuxPath: string | null;
  /** Absolute path to `tmux` (falls back to the bare name if unresolved). */
  tmuxPath: string;
  /** The daemon's own `PATH`, prefixed onto the wrapped click command so the
   * resolved binaries (and whatever they in turn exec, e.g. `bin/ccmux`'s
   * own `bun`) can be found from Notification Center's minimal-PATH shell. */
  path: string;
  /** Constructs the dbus notifier, called at most once per `createDeliverFn`
   * closure (lazily, on the first "dbus" delivery) and reused afterward.
   * Injectable so tests never touch a real dbus-next connection. */
  createDbusNotifier: () => DbusNotifierLike;
  /** Spawns the in-process click action for the dbus backend (pane jump or
   * popup). Defaults to `Bun.spawn`; injectable for tests. */
  spawn?: SpawnFn;
  log?: (message: string, error?: unknown) => void;
}

function buildShCommand(innerCommand: string, path: string): string {
  return `/bin/sh -c ${shellQuote(`PATH=${shellQuote(path)} exec ${innerCommand}`)}`;
}

/** Resolves the `-execute` click target: a pane jump for bound sessions, or
 * the picker popup for background/paneless ones (background sessions, and
 * defensively any pane-tracked session that's currently unbound - `pane`
 * alone can't tell those apart, see `NotificationPayload.background`'s
 * doc). Returns undefined when the popup path has no client to target, or
 * when `ccmuxPath` couldn't be resolved at all. */
async function resolveExecuteCommand(
  payload: NotificationPayload,
  deps: DeliveryDeps,
): Promise<string | undefined> {
  if (!deps.ccmuxPath) return undefined;

  if (payload.background || !payload.pane) {
    const clientTty = await deps.resolveActiveClientTty();
    if (!clientTty) return undefined;
    return buildShCommand(
      `${shellQuote(deps.tmuxPath)} display-popup -c ${shellQuote(clientTty)} -E ${shellQuote(deps.ccmuxPath)}`,
      deps.path,
    );
  }

  return buildShCommand(
    `${shellQuote(deps.ccmuxPath)} switch ${shellQuote(payload.sessionId)}`,
    deps.path,
  );
}

/** Resolves `-sender` per `notifications.icon`: `"none"` unsets it, an
 * explicit bundle id passes through as-is, and the default `"terminal"`
 * borrows the resolved terminal bundle id (undefined if unresolvable). */
function resolveSenderBundleId(
  icon: string,
  terminalBundleId: string | null,
): string | undefined {
  if (icon === "none") return undefined;
  if (icon === "terminal") return terminalBundleId ?? undefined;
  return icon;
}

async function enrichForTerminalNotifier(
  payload: NotificationPayload,
  cfg: NotificationsConfig | undefined,
  deps: DeliveryDeps,
): Promise<NotificationPayload> {
  const clientPid = await deps.getClientPid();
  const terminalBundleId =
    clientPid !== null ? await deps.resolveTerminalBundleId(clientPid) : null;

  return {
    ...payload,
    senderBundleId: resolveSenderBundleId(
      cfg?.icon ?? "terminal",
      terminalBundleId,
    ),
    // Always the resolved terminal id (not icon-gated): clicking should
    // focus the terminal even when icon impersonation is turned off.
    activateBundleId: terminalBundleId ?? undefined,
    executeCommand: await resolveExecuteCommand(payload, deps),
  };
}

/** Builds the dbus backend's click action: unlike the spawn-based backends,
 * there's no shell command to build ahead of time — the callback itself
 * spawns the tmux command in-process (no `sh -c` wrapper needed, we're
 * already in the daemon) when `ActionInvoked` actually fires. Same routing
 * as `resolveExecuteCommand`: a bound session jumps to its pane, a
 * background/unbound one opens the picker popup on the most-recently-active
 * client. `undefined` when the popup path has no `ccmuxPath` to open -
 * mirrors `resolveExecuteCommand` omitting the action entirely in that case
 * (a bound-session jump never needs `ccmuxPath`, so it's never gated on it).
 */
function resolveDbusOnActivate(
  payload: NotificationPayload,
  deps: DeliveryDeps,
): (() => void) | undefined {
  const spawn = deps.spawn ?? (Bun.spawn as unknown as SpawnFn);
  const log =
    deps.log ??
    ((message: string, error?: unknown) => console.warn(message, error ?? ""));

  if (payload.background || !payload.pane) {
    if (!deps.ccmuxPath) return undefined;
    const ccmuxPath = deps.ccmuxPath;
    return () => {
      void (async () => {
        try {
          const clientTty = await deps.resolveActiveClientTty();
          if (!clientTty) return;
          spawn(
            [deps.tmuxPath, "display-popup", "-c", clientTty, "-E", ccmuxPath],
            { stdout: "ignore", stderr: "ignore" },
          );
        } catch (error) {
          log("Notifier: dbus popup click action failed", error);
        }
      })();
    };
  }

  const pane = payload.pane;
  return () => {
    void (async () => {
      try {
        const clientTty = await deps.resolveActiveClientTty();
        if (!clientTty) return;
        spawn([deps.tmuxPath, "switch-client", "-c", clientTty, "-t", pane], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch (error) {
        log("Notifier: dbus pane-jump click action failed", error);
      }
    })();
  };
}

/**
 * Builds the `NotifierDeps["deliver"]` function the daemon wires into
 * `Notifier`. Each distinct backend is probed once, on its first delivery
 * attempt; a failed probe disables that backend for the lifetime of the
 * returned closure (i.e. for the daemon's run) and logs once for it. The
 * probe cache is keyed per backend (not a single global flag), so switching
 * `notifications.backend` to a different backend still gets its own probe,
 * and switching back to a previously-failed one stays disabled without
 * re-probing or re-logging. Every other failure (prefs read, enrichment, the
 * underlying `deliver` call itself) is swallowed here too, matching the
 * plan's "notifications must never affect session tracking" rule -
 * `Notifier.fire` already wraps its caller in a try/catch, but this stays
 * defensive on its own.
 */
export function createDeliverFn(
  deps: DeliveryDeps,
): (payload: NotificationPayload) => Promise<void> {
  /** `true` = probed and working, `false` = probed and disabled. Absent =
   * not yet probed. Shared across "dbus" and the spawn-based backends so a
   * dbus probe failure and its notify-send fallback each get their own
   * cached, once-only probe. */
  const probeResults = new Map<Backend, boolean>();
  const log =
    deps.log ??
    ((message: string, error?: unknown) => console.warn(message, error ?? ""));

  /** Constructed at most once, on the first "dbus" delivery, and reused for
   * every delivery after (the persistent connection is the whole point —
   * see the module doc comment). */
  let dbusNotifier: DbusNotifierLike | null = null;
  const getDbusNotifier = (): DbusNotifierLike => {
    if (!dbusNotifier) dbusNotifier = deps.createDbusNotifier();
    return dbusNotifier;
  };

  return async function deliverNotification(
    payload: NotificationPayload,
  ): Promise<void> {
    try {
      const prefs = await deps.getPrefs();
      let backend = deps.resolveBackend({
        backend: prefs.notifications?.backend,
      });
      if (!backend) return;

      if (backend === "dbus") {
        let dbusOk = probeResults.get("dbus");
        if (dbusOk === undefined) {
          dbusOk = await getDbusNotifier().probe();
          probeResults.set("dbus", dbusOk);
          if (!dbusOk) {
            log(
              'Notifier: backend "dbus" failed its startup probe; falling back to "notify-send" for this delivery',
            );
          }
        }
        if (dbusOk) {
          const onActivate = resolveDbusOnActivate(payload, deps);
          await getDbusNotifier().notify(
            payload,
            onActivate ? { onActivate } : {},
          );
          return;
        }
        // Fall through to the shared spawn-based path below, which probes
        // (and caches) "notify-send" exactly like any other backend.
        backend = "notify-send";
      }

      let ok = probeResults.get(backend);
      if (ok === undefined) {
        ok = await deps.probeBackend(backend);
        probeResults.set(backend, ok);
        if (!ok) {
          log(
            `Notifier: backend "${backend}" failed its startup probe; disabling notification delivery for "${backend}" for this daemon run`,
          );
        }
      }
      if (!ok) return;

      const enriched =
        backend === "terminal-notifier"
          ? await enrichForTerminalNotifier(payload, prefs.notifications, deps)
          : payload;

      await deps.deliver(backend, enriched);
    } catch (error) {
      log("Notifier: delivery failed, dropping notification", error);
    }
  };
}
