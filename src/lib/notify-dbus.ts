/**
 * Linux native D-Bus notification backend, speaking
 * `org.freedesktop.Notifications` directly via `dbus-next` (pure JS, no
 * native deps, bundles into the compiled binary).
 *
 * Unlike the spawn-based backends in `src/lib/notify.ts`, this is
 * connection-oriented: one persistent session-bus connection is reused
 * across deliveries, which is what makes Linux click-to-jump possible
 * (`ActionInvoked` is a signal on that live connection, not something a
 * one-shot spawn can observe).
 *
 * `dbus-next` is imported lazily (dynamic `import()`) inside `connect()`
 * only, so platforms that never resolve to the "dbus" backend never load it
 * — load-bearing for the compiled-binary + macOS-safety requirement.
 *
 * Every public method fails open: connection/probe/delivery failures resolve
 * `false`/`null` rather than throwing, and any failure resets the cached
 * connection so the next call reconnects from scratch rather than retrying a
 * known-broken bus forever.
 */

import type { NotificationPayload } from "./notify";

/** Minimal shape of `dbus-next`'s `Variant`, used to build the `a{sv}` hints
 * dict. Typed locally so this module's public surface has zero static
 * dependency on the package (only the dynamic import in `connect()` touches
 * it).
 *
 * IMPORTANT: against the real dbus-next connection this must be an actual
 * `Variant` *instance*, not merely an object with this shape — the
 * marshaller checks `value.constructor === Variant` when serializing an
 * `a{sv}` entry and throws `"expected a Variant for value"` otherwise.
 * `makeVariant` uses the real class when connected for real, and falls back
 * to a plain object when a `sessionBusFactory` was injected (fine for a test
 * double that never runs real marshalling). */
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
  CloseNotification(id: number): Promise<void>;
  GetServerInformation(): Promise<[string, string, string, string]>;
  GetCapabilities(): Promise<string[]>;
  on(
    event: "ActionInvoked",
    listener: (id: number, actionKey: string) => void,
  ): unknown;
  on(
    event: "NotificationClosed",
    listener: (id: number, reason: number) => void,
  ): unknown;
  on(
    event: "NotificationReplied",
    listener: (id: number, text: string) => void,
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
  /** Registered against the returned notification id. `actionKey` is the
   * freedesktop action key (`"default"`/`"Open"` for click-to-jump,
   * `"approve"`/`"deny"` for the buttons); `userText` carries the typed
   * inline reply (delivered via `NotificationReplied`, key `"answer"`).
   * When not provided, no `actions` are sent at all — actions only appear
   * when there's something to do on interaction. */
  onAction?: (actionKey: string, userText?: string) => void;
  /** Whether a `default`/`Open` click can actually jump somewhere (a bound
   * pane, or a background/unbound session with a resolvable `ccmux`). When
   * false, the `default`/`Open` action pair is omitted so the notification
   * never shows an "Open" button that does nothing; approve/deny/reply stay
   * gated on the payload independently. Defaults to false. */
  canDefault?: boolean;
}

export class DbusNotifier {
  private bus: BusLike | null = null;
  private notificationsInterface: NotificationsInterfaceLike | null = null;
  private connecting: Promise<boolean> | null = null;
  /** The real `dbus-next` `Variant` class, captured from the same dynamic
   * import as `sessionBus`; null when a `sessionBusFactory` was injected.
   * See `DbusVariant`'s doc for why this matters. */
  private variantCtor: VariantConstructor | null = null;
  /** Last notification id delivered per session id, so a session's
   * notification replaces in place (`replaces_id`) — parity with the macOS
   * helper's `--group`, and the id `retract`/`CloseNotification` targets. */
  private readonly replacesIds = new Map<string, number>();
  /** Notification id -> the `onAction` callback registered for it. Receives
   * the freedesktop action key (and, for inline reply, the typed text).
   * Pruned on `NotificationClosed`, per the plan. */
  private readonly actionCallbacks = new Map<
    number,
    (actionKey: string, userText?: string) => void
  >();
  /** Server capabilities from `GetCapabilities`, fetched once on connect.
   * Gates the inline-reply action (only added when the server advertises
   * `"inline-reply"`) — the plan's "do NOT fake it" rule. */
  private capabilities: string[] = [];

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

      iface.on("ActionInvoked", (id, actionKey) => {
        this.actionCallbacks.get(id)?.(actionKey);
      });
      // Inline reply (servers advertising the `inline-reply` capability) is
      // delivered as its own signal, not `ActionInvoked` — route the typed
      // text through the same per-id callback with the internal `answer` key.
      iface.on("NotificationReplied", (id, text) => {
        this.actionCallbacks.get(id)?.("answer", text);
      });
      iface.on("NotificationClosed", (id) => {
        this.actionCallbacks.delete(id);
      });

      // Best-effort capability probe; failure leaves `capabilities` empty
      // (inline reply simply stays off), never blocks connecting.
      try {
        this.capabilities = await iface.GetCapabilities();
      } catch {
        this.capabilities = [];
      }

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
      const actions = this.buildActions(payload, options);

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
      if (options.onAction) this.actionCallbacks.set(id, options.onAction);
      return id;
    } catch {
      this.resetConnection();
      return null;
    }
  }

  /** Builds the freedesktop `actions` array (flat `[key, label, ...]`):
   * `default`/`Open` for the click-to-jump base (only when `canDefault` — a
   * jump that can actually land), `approve`/`deny` when the payload advertises
   * them, and `inline-reply` only when the payload carries a reply AND the
   * server's capabilities include `"inline-reply"` (never faked, per the
   * plan). All are gated on a click handler being present. */
  private buildActions(
    payload: NotificationPayload,
    options: NotifyDbusOptions,
  ): string[] {
    if (!options.onAction) return [];
    const actions: string[] = [];
    if (options.canDefault) actions.push("default", "Open");
    if (payload.actions) {
      for (const a of payload.actions) actions.push(a.id, a.label);
    }
    if (payload.reply && this.capabilities.includes("inline-reply")) {
      actions.push("inline-reply", payload.reply.label);
    }
    return actions;
  }

  /** Closes (retracts) the live notification for `sessionId`, if one is
   * tracked. Fail-open: a missing id, an unconnected bus, or a rejecting
   * `CloseNotification` all resolve without throwing. Mirrors the macOS
   * helper's `remove --group`. */
  async retract(sessionId: string): Promise<void> {
    const id = this.replacesIds.get(sessionId);
    if (id === undefined) return;
    const connected = await this.connect();
    if (!connected || !this.notificationsInterface) return;
    try {
      await this.notificationsInterface.CloseNotification(id);
    } catch {
      // best-effort; leave the tracked id so a later delivery still replaces.
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
    this.actionCallbacks.clear();
  }
}
