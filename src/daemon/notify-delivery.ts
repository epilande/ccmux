/**
 * The daemon's `Notifier` deliver/retract dependency: wraps `src/lib/notify.ts`'s
 * bare `deliver` with everything that needs daemon/session context (the lib
 * module is deliberately dependency-free):
 *
 * - Resolves the backend fresh per delivery (config is read live) and probes
 *   each distinct backend once per daemon lifetime: a broken backend logs
 *   once and stays disabled for THAT backend for the rest of the run rather
 *   than retrying forever. Caching per backend (not globally) means switching
 *   `notifications.backend` away from a broken one and back doesn't get
 *   stuck disabled.
 * - For `ccmux-notifier` (the macOS v2 rung), resolves the helper binary once
 *   (env `CCMUX_NOTIFIER_PATH` -> brew `libexec` sibling of `ccmux` -> PATH),
 *   probes it with `--version`, and stamps `notifierPath` + `callbackUrl`
 *   onto the payload. Unresolvable or probe-failed -> falls to `osascript`
 *   silently (mirroring the dbus -> notify-send fallback below).
 * - For `dbus`, routes to a persistent, lazily-created `DbusNotifier`
 *   instead of `src/lib/notify.ts`'s spawn-based `deliver` (which treats
 *   "dbus" as a no-op — it's connection-oriented, not spawn-oriented). A
 *   failed dbus probe falls back to "notify-send" rather than hard-disabling
 *   notifications on Linux. Click/button actions run in-process through the
 *   shared `/notification-action` handler — the SAME code path the macOS
 *   HTTP callback uses, so jumps and safety gating can't diverge per platform.
 *
 * Retraction (`retract(sessionId)`) auto-clears a session's notification when
 * the user views its pane: `ccmux-notifier remove --group ...` on macOS,
 * `CloseNotification` on the live D-Bus connection, a no-op for backends that
 * can't retract. Fail-open like everything else.
 */

import type { Backend, NotificationPayload, SpawnFn } from "../lib/notify";
import { isUnrecognizedBackend, probeCcmuxNotifier } from "../lib/notify";
import type { NotificationsConfig } from "../lib/preferences";
import type { NotificationActionInput } from "./notification-action";

/** Structural subset of `DbusNotifier` (`src/lib/notify-dbus.ts`) this
 * module calls — lets tests inject a fake without touching the real
 * dbus-next connection. The real `DbusNotifier` satisfies this shape. */
export interface DbusNotifierLike {
  probe(): Promise<boolean>;
  notify(
    payload: NotificationPayload,
    options?: {
      onAction?: (actionKey: string, userText?: string) => void;
      canDefault?: boolean;
    },
  ): Promise<number | null>;
  retract(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface DeliveryDeps {
  getPrefs: () => Promise<{ notifications?: NotificationsConfig }>;
  /** Most-recently-active attached client, for the background-session popup
   * click target (`display-popup -c`) and bound-session `switch-client`. */
  resolveActiveClientTty: () => Promise<string | null>;
  resolveBackend: (config: {
    backend?: NotificationsConfig["backend"];
  }) => Backend | null;
  probeBackend: (backend: Backend) => Promise<boolean>;
  deliver: (backend: Backend, payload: NotificationPayload) => Promise<void>;
  /** Resolves the ccmux-notifier helper binary (env -> brew sibling -> PATH),
   * or null when unresolvable. Called at most once per closure (cached). */
  resolveNotifierPath: () => string | null;
  /** The `/notification-action` callback URL the ccmux-notifier helper POSTs
   * to (respects `CCMUX_PORT`); stamped onto the delivered payload. */
  notifierCallbackUrl: string;
  /** Probes a resolved ccmux-notifier binary (`<path> --version`). Defaults to
   * the lib helper bound to `spawn`; injectable for tests. */
  probeNotifier?: (binaryPath: string) => Promise<boolean>;
  /** Runs a notification-action callback in-process for the D-Bus buttons —
   * the SAME shared handler the macOS HTTP route uses, injected from
   * `index.ts`. */
  runNotificationAction: (input: NotificationActionInput) => unknown;
  /** Absolute path to the `ccmux` entry point, or null if unresolvable. The
   * D-Bus background/unbound popup jump is omitted when null. */
  ccmuxPath: string | null;
  /** Absolute path to `tmux` (falls back to the bare name if unresolved). */
  tmuxPath: string;
  /** Constructs the dbus notifier, called at most once per closure (lazily,
   * on the first "dbus" delivery/retract) and reused afterward. Injectable so
   * tests never touch a real dbus-next connection. */
  createDbusNotifier: () => DbusNotifierLike;
  /** Spawns the ccmux-notifier `post`/`remove` and the in-process dbus jump.
   * Defaults to `Bun.spawn`; injectable for tests. */
  spawn?: SpawnFn;
  log?: (message: string, error?: unknown) => void;
}

/** Builds the dbus backend's interaction wiring. No shell command is built
 * ahead of time — the callback runs in-process when the signal fires, and
 * every key (including `default`/`Open`) routes to the shared
 * `/notification-action` handler (see the module doc), which re-reads the
 * session's LIVE pane rather than this delivery-time snapshot.
 *
 * `canDefault` reports whether a default-click jump can actually land (a
 * bound pane, or a background/unbound session with a resolvable `ccmuxPath`);
 * the dbus layer omits the visible `default`/`Open` button when it can't, so
 * we never show a button that does nothing. `onAction` is `undefined` (no
 * actions sent at all) only when there's nothing wireable: no jump target
 * AND no buttons/reply on the payload. */
function resolveDbusActionWiring(
  payload: NotificationPayload,
  deps: DeliveryDeps,
): {
  onAction?: (actionKey: string, userText?: string) => void;
  canDefault: boolean;
} {
  const needsPopup = payload.background || !payload.pane;
  const canDefault = !needsPopup || !!deps.ccmuxPath;
  const hasButtons = !!payload.actions?.length || !!payload.reply;
  if (!canDefault && !hasButtons) return { canDefault: false };

  const onAction = (actionKey: string, userText?: string) => {
    if (actionKey === "approve" || actionKey === "deny") {
      void deps.runNotificationAction({
        sessionId: payload.sessionId,
        action: actionKey,
        statusChangedAt: payload.statusChangedAt,
        attentionGeneration: payload.attentionGeneration,
      });
      return;
    }
    if (actionKey === "answer") {
      void deps.runNotificationAction({
        sessionId: payload.sessionId,
        action: "answer",
        statusChangedAt: payload.statusChangedAt,
        attentionGeneration: payload.attentionGeneration,
        userText,
      });
      return;
    }
    // The freedesktop `inline-reply` action key only signals that the text
    // field opened; the typed reply arrives via `NotificationReplied` (mapped
    // to `answer` above), so this key itself is a no-op — never a jump.
    if (actionKey === "inline-reply") return;
    // "default" / "Open" (or any other key) -> the shared handler's
    // default-click jump.
    void deps.runNotificationAction({
      sessionId: payload.sessionId,
      action: "default",
      statusChangedAt: payload.statusChangedAt,
    });
  };
  return { onAction, canDefault };
}

/**
 * Builds the delivery closure the daemon wires into `Notifier`, plus a
 * `retract` companion that shares its per-backend probe cache, resolved
 * notifier path, and lazy dbus connection (retraction needs the SAME dbus
 * connection so its `replacesIds` map can find the notification to close).
 * Failure of every kind (prefs read, probe, the underlying `deliver`) is
 * swallowed here, matching the plan's "notifications must never affect session
 * tracking" rule.
 */
export function createNotifyDelivery(deps: DeliveryDeps): {
  deliver: (payload: NotificationPayload) => Promise<void>;
  retract: (sessionId: string) => Promise<void>;
} {
  /** `true` = probed and working, `false` = probed and disabled. Absent =
   * not yet probed. Shared across every backend so each gets its own cached,
   * once-only probe. */
  const probeResults = new Map<Backend, boolean>();
  const log =
    deps.log ??
    ((message: string, error?: unknown) => console.warn(message, error ?? ""));
  const spawn = deps.spawn ?? (Bun.spawn as unknown as SpawnFn);
  const probeNotifier =
    deps.probeNotifier ?? ((p: string) => probeCcmuxNotifier(p, spawn));

  /** Resolved at most once (undefined = not yet resolved, null = resolved to
   * "no helper"). Shared by deliver + retract. */
  let notifierPath: string | null | undefined;
  const getNotifierPath = (): string | null => {
    if (notifierPath === undefined) notifierPath = deps.resolveNotifierPath();
    return notifierPath;
  };

  let dbusNotifier: DbusNotifierLike | null = null;
  const getDbusNotifier = (): DbusNotifierLike => {
    if (!dbusNotifier) dbusNotifier = deps.createDbusNotifier();
    return dbusNotifier;
  };

  /** Logged at most once per run: a configured backend that isn't recognized
   * (a typo, or a value removed across versions) is ignored in favor of the
   * auto ladder rather than silently disabling notifications. */
  let loggedUnknownBackend = false;
  const resolveConfiguredBackend = (prefs: {
    notifications?: NotificationsConfig;
  }): Backend | null => {
    const configured = prefs.notifications?.backend;
    if (isUnrecognizedBackend(configured) && !loggedUnknownBackend) {
      loggedUnknownBackend = true;
      log(
        `Notifier: notifications.backend "${String(configured)}" is not a recognized backend; using the auto ladder`,
      );
    }
    return deps.resolveBackend({ backend: configured });
  };

  async function deliverNotification(
    payload: NotificationPayload,
  ): Promise<void> {
    try {
      const prefs = await deps.getPrefs();
      let backend = resolveConfiguredBackend(prefs);
      if (!backend) return;

      if (backend === "ccmux-notifier") {
        const path = getNotifierPath();
        if (path) {
          let ok = probeResults.get("ccmux-notifier");
          if (ok === undefined) {
            ok = await probeNotifier(path);
            probeResults.set("ccmux-notifier", ok);
            if (!ok) {
              log(
                'Notifier: backend "ccmux-notifier" failed its startup probe; falling back to "osascript" for this delivery',
              );
            }
          }
          if (ok) {
            await deps.deliver("ccmux-notifier", {
              ...payload,
              notifierPath: path,
              callbackUrl: deps.notifierCallbackUrl,
            });
            return;
          }
        }
        // Unresolvable helper or a failed probe: fall through to osascript,
        // which probes (and caches) exactly like any other backend below.
        backend = "osascript";
      }

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
          const { onAction, canDefault } = resolveDbusActionWiring(
            payload,
            deps,
          );
          await getDbusNotifier().notify(payload, { onAction, canDefault });
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

      await deps.deliver(backend, payload);
    } catch (error) {
      log("Notifier: delivery failed, dropping notification", error);
    }
  }

  async function retract(sessionId: string): Promise<void> {
    try {
      const prefs = await deps.getPrefs();
      const backend = resolveConfiguredBackend(prefs);
      if (!backend) return;

      if (backend === "ccmux-notifier") {
        const path = getNotifierPath();
        if (!path) return;
        // Only retract via the helper if deliver actually used it (probe
        // succeeded). If the probe failed, deliveries fell back to osascript —
        // which posts under a different identity and can't be retracted anyway;
        // if it never ran (undefined), nothing was posted via the helper yet.
        if (probeResults.get("ccmux-notifier") !== true) return;
        spawn([path, "remove", "--group", `ccmux-${sessionId}`], {
          stdout: "ignore",
          stderr: "ignore",
        });
        return;
      }
      if (backend === "dbus") {
        await getDbusNotifier().retract(sessionId);
        return;
      }
      // osascript / notify-send / command have no retraction capability.
    } catch (error) {
      log("Notifier: retract failed", error);
    }
  }

  return { deliver: deliverNotification, retract };
}
