/**
 * Linux native D-Bus notification backend, speaking
 * `org.freedesktop.Notifications` directly via `dbus-next` (pure JS, no
 * native deps, bundles into the compiled binary — see
 * `notifications-plan.md`'s "Seamless backends" section).
 *
 * Unlike the spawn-based backends in `src/lib/notify.ts`, this is
 * connection-oriented: one persistent session-bus connection is reused
 * across deliveries (owned by the daemon's `notify-delivery.ts`), which is
 * what makes Linux click-to-jump possible (`ActionInvoked` is a signal on
 * that live connection, not something a one-shot spawn can observe).
 *
 * `dbus-next` is imported lazily (dynamic `import()`) inside `connect()`
 * only, so platforms that never resolve to the "dbus" backend (macOS, or
 * Linux configured for another backend) never load it — load-bearing for the
 * compiled-binary + macOS-safety requirement in the plan.
 *
 * Every public method fails open: connection/probe/delivery failures resolve
 * `false`/`null` rather than throwing, and any failure resets the cached
 * connection so the next call reconnects from scratch rather than retrying a
 * known-broken bus forever.
 */

import type { NotificationPayload } from "./notify";

/** Minimal shape of `dbus-next`'s `Variant` this module constructs — a
 * signature string plus the value, used to build the `a{sv}` hints dict. Not
 * imported from `dbus-next`'s own types so this module's public surface has
 * zero static dependency on the package (only the dynamic import inside
 * `connect()` touches it).
 *
 * IMPORTANT: against the real dbus-next connection this must be an actual
 * `dbus-next` `Variant` *instance*, not merely an object with this shape —
 * its marshaller checks `value.constructor === Variant` when serializing an
 * `a{sv}` dict entry and throws `"expected a Variant for value"` otherwise.
 * `DbusNotifier` builds these via `makeVariant`, which uses the real
 * `Variant` class (captured from the same dynamic import as `sessionBus`)
 * when connected for real, and falls back to a plain object — sufficient
 * for a test double that doesn't run real dbus-next marshalling — when a
 * `sessionBusFactory` was injected. */
export interface DbusVariant<T = unknown> {
  signature: string;
  value: T;
}

/** Constructs a `dbus-next` `Variant`. Typed locally (not imported from
 * `dbus-next`) for the same reason as `DbusVariant` above. */
type VariantConstructor = new (
  signature: string,
  value: unknown,
) => DbusVariant;

/** Structural subset of `dbus-next`'s `ClientInterface` for
 * `org.freedesktop.Notifications`. The real interface object satisfies this
 * shape at runtime (dbus-next builds it from the service's introspection
 * data), but its static type (`{ [name: string]: Function }`) isn't
 * assignable to these specific call signatures, hence the `as unknown as`
 * cast where it's obtained — a genuine type gap, not a laziness shortcut. */
export interface NotificationsInterfaceLike {
  Notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    actions: string[],
    hints: Record<string, DbusVariant>,
    expireTimeout: number,
  ): Promise<number>;
  GetServerInformation(): Promise<[string, string, string, string]>;
  on(
    event: "ActionInvoked",
    listener: (id: number, actionKey: string) => void,
  ): unknown;
  on(
    event: "NotificationClosed",
    listener: (id: number, reason: number) => void,
  ): unknown;
}

export interface ProxyObjectLike {
  getInterface(name: string): NotificationsInterfaceLike;
}

/** Structural subset of `dbus-next`'s `MessageBus`. */
export interface BusLike {
  getProxyObject(name: string, path: string): Promise<ProxyObjectLike>;
  disconnect(): void;
  on(event: "error", listener: (err: unknown) => void): unknown;
}

export type SessionBusFactory = () => BusLike;

const NOTIFICATIONS_BUS_NAME = "org.freedesktop.Notifications";
const NOTIFICATIONS_OBJECT_PATH = "/org/freedesktop/Notifications";
const APP_NAME = "ccmux";
const PROBE_TIMEOUT_MS = 1000;
/** freedesktop urgency levels: 0 low, 1 normal, 2 critical. ccmux always
 * sends normal — matches the plan's "urgency normal". */
const URGENCY_NORMAL = 1;

/** `true` -> a reasonable freedesktop default sound name; falsy -> no sound
 * hint at all; else passthrough (a user-configured sound name). Deliberately
 * a different default than `lib/notify.ts`'s `resolveSoundName` (`"default"`
 * is a macOS `NSSound` name, meaningless to `notify-send`/D-Bus). */
function resolveSoundHintName(
  sound: boolean | string | undefined,
): string | null {
  if (!sound) return null;
  return sound === true ? "message-new-instant" : sound;
}

/** Resolves `promise`, or `fallback` if it hasn't settled within `timeoutMs`.
 * The slow promise is left to settle on its own (its result is simply
 * ignored) rather than cancelled — `dbus-next` has no cancellation API. */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface NotifyDbusOptions {
  /** Registered against the returned notification id; invoked when the
   * user clicks the notification's "Open" action. Omitted entirely (no
   * `actions` sent) when not provided, matching the plan: actions only
   * appear when there's something to do on click. */
  onActivate?: () => void;
}

export class DbusNotifier {
  private bus: BusLike | null = null;
  private notificationsInterface: NotificationsInterfaceLike | null = null;
  private connecting: Promise<boolean> | null = null;
  /** The real `dbus-next` `Variant` class, captured from the same dynamic
   * import as `sessionBus` — null when a `sessionBusFactory` was injected
   * (no dbus-next import happens at all in that case; `makeVariant` falls
   * back to a plain object, fine for a fake bus). See `DbusVariant`'s doc
   * for why this matters. */
  private variantCtor: VariantConstructor | null = null;
  /** Last notification id delivered per session id, so a session's
   * notification replaces in place (`replaces_id`) — parity with
   * terminal-notifier's `-group`. */
  private readonly replacesIds = new Map<string, number>();
  /** Notification id -> the `onActivate` callback registered for it.
   * Pruned on `NotificationClosed`, per the plan. */
  private readonly activateCallbacks = new Map<number, () => void>();

  constructor(private readonly sessionBusFactory?: SessionBusFactory) {}

  private makeVariant(signature: string, value: unknown): DbusVariant {
    return this.variantCtor
      ? new this.variantCtor(signature, value)
      : { signature, value };
  }

  /** Lazily connects to the session bus and resolves the Notifications
   * interface, reusing an existing connection if one is live. Returns
   * `false` (never throws) on any failure — bus unreachable, introspection
   * failure, etc. */
  async connect(): Promise<boolean> {
    if (this.notificationsInterface) return true;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async doConnect(): Promise<boolean> {
    try {
      let bus: BusLike;
      if (this.sessionBusFactory) {
        bus = this.sessionBusFactory();
      } else {
        const dbusNext = await import("dbus-next");
        bus = dbusNext.sessionBus() as unknown as BusLike;
        this.variantCtor = dbusNext.Variant as unknown as VariantConstructor;
      }

      // A live connection can fail asynchronously after a successful
      // `getProxyObject` (the bus process dies, the socket drops). Drop the
      // cached interface so the next call reconnects instead of calling
      // methods on a dead connection forever.
      bus.on("error", () => {
        this.resetConnection();
      });

      const proxyObject = await bus.getProxyObject(
        NOTIFICATIONS_BUS_NAME,
        NOTIFICATIONS_OBJECT_PATH,
      );
      const iface = proxyObject.getInterface(NOTIFICATIONS_BUS_NAME);

      iface.on("ActionInvoked", (id, _actionKey) => {
        this.activateCallbacks.get(id)?.();
      });
      iface.on("NotificationClosed", (id) => {
        this.activateCallbacks.delete(id);
      });

      this.bus = bus;
      this.notificationsInterface = iface;
      return true;
    } catch {
      this.resetConnection();
      return false;
    }
  }

  private resetConnection(): void {
    this.bus = null;
    this.notificationsInterface = null;
  }

  /** Connect + `GetServerInformation`, both capped at `timeoutMs` (default
   * 1s per the plan). `false` on any failure or timeout. */
  async probe(timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
    const connected = await withTimeout(this.connect(), timeoutMs, false);
    if (!connected || !this.notificationsInterface) return false;

    return withTimeout(
      this.notificationsInterface.GetServerInformation().then(
        () => true,
        () => false,
      ),
      timeoutMs,
      false,
    );
  }

  /** Sends one notification, connecting first if needed. Returns the
   * notification id, or `null` on any failure (bus unreachable, the `Notify`
   * call itself rejects, etc.) — the failure also drops the cached
   * connection so the next call reconnects. */
  async notify(
    payload: NotificationPayload,
    options: NotifyDbusOptions = {},
  ): Promise<number | null> {
    const connected = await this.connect();
    if (!connected || !this.notificationsInterface) return null;

    try {
      const replacesId = this.replacesIds.get(payload.sessionId) ?? 0;
      const actions = options.onActivate ? ["default", "Open"] : [];

      const hints: Record<string, DbusVariant> = {
        urgency: this.makeVariant("y", URGENCY_NORMAL),
      };
      const soundName = resolveSoundHintName(payload.sound);
      if (soundName) hints["sound-name"] = this.makeVariant("s", soundName);

      const id = await this.notificationsInterface.Notify(
        APP_NAME,
        replacesId,
        "",
        payload.title,
        payload.body,
        actions,
        hints,
        -1,
      );

      this.replacesIds.set(payload.sessionId, id);
      if (options.onActivate)
        this.activateCallbacks.set(id, options.onActivate);
      return id;
    } catch {
      this.resetConnection();
      return null;
    }
  }

  /** Tears down the connection. Best-effort: `disconnect()` failing is
   * swallowed, since the caller is already done with this notifier. */
  async close(): Promise<void> {
    try {
      this.bus?.disconnect();
    } catch {
      // best-effort
    }
    this.resetConnection();
    this.activateCallbacks.clear();
  }
}
