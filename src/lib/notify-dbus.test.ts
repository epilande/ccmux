import { describe, it, expect } from "bun:test";
import {
  DbusNotifier,
  type BusLike,
  type NotificationsInterfaceLike,
} from "./notify-dbus";
import type { NotificationPayload } from "./notify";

const BASE_PAYLOAD: NotificationPayload = {
  title: "ccmux (main) · Claude Code",
  body: "Waiting for you",
  event: "waiting",
  sessionId: "abc123",
  agent: "claude",
  project: "ccmux",
  branch: "main",
  pane: "%3",
};

type NotifyCall = {
  appName: string;
  replacesId: number;
  appIcon: string;
  summary: string;
  body: string;
  actions: string[];
  hints: Record<string, { signature: string; value: unknown }>;
  expireTimeout: number;
};

/** A fake session bus: `getProxyObject`/`getInterface` return a fake
 * `NotificationsInterfaceLike` whose `Notify` calls are recorded and whose
 * signal listeners are capturable so tests can fire `ActionInvoked` /
 * `NotificationClosed` directly. */
function createFakeBus(
  options: {
    getProxyObjectImpl?: BusLike["getProxyObject"];
    getServerInformationImpl?: NotificationsInterfaceLike["GetServerInformation"];
    getCapabilitiesImpl?: NotificationsInterfaceLike["GetCapabilities"];
    notifyImpl?: NotificationsInterfaceLike["Notify"];
  } = {},
): {
  bus: BusLike;
  notifyCalls: NotifyCall[];
  disconnectCalls: number[];
  closeCalls: number[];
  fireActionInvoked: (id: number, actionKey: string) => void;
  fireNotificationClosed: (id: number, reason: number) => void;
  fireNotificationReplied: (id: number, text: string) => void;
  fireBusError: (err: unknown) => void;
} {
  const notifyCalls: NotifyCall[] = [];
  const disconnectCalls: number[] = [];
  const closeCalls: number[] = [];
  let nextId = 1;
  let actionInvokedListener: ((id: number, actionKey: string) => void) | null =
    null;
  let notificationClosedListener:
    | ((id: number, reason: number) => void)
    | null = null;
  let notificationRepliedListener: ((id: number, text: string) => void) | null =
    null;
  let busErrorListener: ((err: unknown) => void) | null = null;

  const iface: NotificationsInterfaceLike = {
    Notify:
      options.notifyImpl ??
      (async (
        appName,
        replacesId,
        appIcon,
        summary,
        body,
        actions,
        hints,
        expireTimeout,
      ) => {
        notifyCalls.push({
          appName,
          replacesId,
          appIcon,
          summary,
          body,
          actions,
          hints,
          expireTimeout,
        });
        return nextId++;
      }),
    CloseNotification: async (id: number) => {
      closeCalls.push(id);
    },
    GetServerInformation:
      options.getServerInformationImpl ??
      (async () => ["ccmux-test-server", "ccmux", "1.0", "1.2"]),
    GetCapabilities: options.getCapabilitiesImpl ?? (async () => []),
    on: ((event: string, listener: (...args: never[]) => void) => {
      if (event === "ActionInvoked") {
        actionInvokedListener = listener as (
          id: number,
          actionKey: string,
        ) => void;
      }
      if (event === "NotificationClosed") {
        notificationClosedListener = listener as (
          id: number,
          reason: number,
        ) => void;
      }
      if (event === "NotificationReplied") {
        notificationRepliedListener = listener as (
          id: number,
          text: string,
        ) => void;
      }
      return iface;
    }) as NotificationsInterfaceLike["on"],
  };

  const bus: BusLike = {
    getProxyObject:
      options.getProxyObjectImpl ??
      (async () => ({
        getInterface: () => iface,
      })),
    disconnect: () => {
      disconnectCalls.push(disconnectCalls.length);
    },
    on: (event, listener) => {
      if (event === "error") busErrorListener = listener;
      return bus;
    },
  };

  return {
    bus,
    notifyCalls,
    disconnectCalls,
    closeCalls,
    fireActionInvoked: (id, actionKey) =>
      actionInvokedListener?.(id, actionKey),
    fireNotificationClosed: (id, reason) =>
      notificationClosedListener?.(id, reason),
    fireNotificationReplied: (id, text) =>
      notificationRepliedListener?.(id, text),
    fireBusError: (err) => busErrorListener?.(err),
  };
}

describe("DbusNotifier: notify", () => {
  it("calls Notify with app_name ccmux, replaces_id 0 for a new session, no actions/sound/urgency-only hints by default", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    const id = await notifier.notify(BASE_PAYLOAD);

    expect(id).toBe(1);
    expect(notifyCalls).toHaveLength(1);
    const call = notifyCalls[0]!;
    expect(call.appName).toBe("ccmux");
    expect(call.replacesId).toBe(0);
    expect(call.summary).toBe(BASE_PAYLOAD.title);
    expect(call.body).toBe(BASE_PAYLOAD.body);
    expect(call.actions).toEqual([]);
    expect(call.hints).toEqual({ urgency: { signature: "y", value: 1 } });
  });

  it("reuses the last notification id as replaces_id for the same session", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    const firstId = await notifier.notify(BASE_PAYLOAD);
    const secondId = await notifier.notify(BASE_PAYLOAD);

    expect(firstId).toBe(1);
    expect(secondId).toBe(2);
    expect(notifyCalls[0]?.replacesId).toBe(0);
    expect(notifyCalls[1]?.replacesId).toBe(1);
  });

  it("tracks replaces_id independently per session", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    await notifier.notify({ ...BASE_PAYLOAD, sessionId: "a" });
    await notifier.notify({ ...BASE_PAYLOAD, sessionId: "b" });
    await notifier.notify({ ...BASE_PAYLOAD, sessionId: "a" });

    expect(notifyCalls[0]?.replacesId).toBe(0); // a, first
    expect(notifyCalls[1]?.replacesId).toBe(0); // b, first
    expect(notifyCalls[2]?.replacesId).toBe(1); // a, reuses a's last id
  });

  it("includes the default/Open pair when onAction and canDefault are both set", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    await notifier.notify(BASE_PAYLOAD, {
      onAction: () => {},
      canDefault: true,
    });

    expect(notifyCalls[0]?.actions).toEqual(["default", "Open"]);
  });

  it("omits the default/Open pair when canDefault is false (no dead Open button)", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    // onAction present (a button is wired) but the jump can't land: the
    // default/Open pair must not appear, while approve/deny still do.
    await notifier.notify(
      { ...BASE_PAYLOAD, actions: [{ id: "approve", label: "Approve" }] },
      { onAction: () => {}, canDefault: false },
    );

    expect(notifyCalls[0]?.actions).toEqual(["approve", "Approve"]);
  });

  it("sends no actions at all when onAction is absent", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    await notifier.notify(BASE_PAYLOAD, {});

    expect(notifyCalls[0]?.actions).toEqual([]);
  });

  it("maps sound: true to the message-new-instant hint", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    await notifier.notify({ ...BASE_PAYLOAD, sound: true });

    expect(notifyCalls[0]?.hints["sound-name"]).toEqual({
      signature: "s",
      value: "message-new-instant",
    });
  });

  it("passes a string sound through verbatim", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    await notifier.notify({ ...BASE_PAYLOAD, sound: "Glass" });

    expect(notifyCalls[0]?.hints["sound-name"]).toEqual({
      signature: "s",
      value: "Glass",
    });
  });

  it("omits the sound-name hint when sound is unset or false", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    await notifier.notify(BASE_PAYLOAD);
    await notifier.notify({ ...BASE_PAYLOAD, sound: false });

    expect(notifyCalls[0]?.hints["sound-name"]).toBeUndefined();
    expect(notifyCalls[1]?.hints["sound-name"]).toBeUndefined();
  });

  it("returns null and never throws when the bus is unreachable (connect fails)", async () => {
    const bus: BusLike = {
      getProxyObject: async () => {
        throw new Error("no session bus");
      },
      disconnect: () => {},
      on: () => bus,
    };
    const notifier = new DbusNotifier(() => bus);

    await expect(notifier.notify(BASE_PAYLOAD)).resolves.toBeNull();
  });

  it("returns null and never throws when Notify itself rejects", async () => {
    const { bus } = createFakeBus({
      notifyImpl: async () => {
        throw new Error("dbus call failed");
      },
    });
    const notifier = new DbusNotifier(() => bus);

    await expect(notifier.notify(BASE_PAYLOAD)).resolves.toBeNull();
  });

  it("returns null when the sessionBusFactory itself throws synchronously", async () => {
    const notifier = new DbusNotifier(() => {
      throw new Error("could not get DISPLAY environment variable");
    });

    await expect(notifier.notify(BASE_PAYLOAD)).resolves.toBeNull();
  });
});

describe("DbusNotifier: ActionInvoked / NotificationClosed", () => {
  it("dispatches ActionInvoked to the onAction registered for that notification id", async () => {
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => fakeBus.bus);
    let activated = false;

    const id = await notifier.notify(BASE_PAYLOAD, {
      onAction: () => {
        activated = true;
      },
    });

    fakeBus.fireActionInvoked(id!, "default");
    expect(activated).toBe(true);
  });

  it("does not dispatch to a different notification id's callback", async () => {
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => fakeBus.bus);
    let activatedCount = 0;

    const id = await notifier.notify(BASE_PAYLOAD, {
      onAction: () => {
        activatedCount++;
      },
    });

    fakeBus.fireActionInvoked(id! + 999, "default");
    expect(activatedCount).toBe(0);
  });

  it("NotificationClosed prunes the callback so a later ActionInvoked for the same id is a no-op", async () => {
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => fakeBus.bus);
    let activatedCount = 0;

    const id = await notifier.notify(BASE_PAYLOAD, {
      onAction: () => {
        activatedCount++;
      },
    });

    fakeBus.fireNotificationClosed(id!, 2);
    fakeBus.fireActionInvoked(id!, "default");

    expect(activatedCount).toBe(0);
  });

  it("a notification sent without onAction registers no callback (no-op on ActionInvoked)", async () => {
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => fakeBus.bus);

    const id = await notifier.notify(BASE_PAYLOAD);

    // Must not throw even though there's nothing registered for this id.
    expect(() => fakeBus.fireActionInvoked(id!, "default")).not.toThrow();
  });

  it("passes the action key through to onAction", async () => {
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => fakeBus.bus);
    const keys: string[] = [];

    const id = await notifier.notify(BASE_PAYLOAD, {
      onAction: (actionKey) => keys.push(actionKey),
    });

    fakeBus.fireActionInvoked(id!, "approve");
    expect(keys).toEqual(["approve"]);
  });

  it("routes NotificationReplied to onAction with the answer key and typed text", async () => {
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => fakeBus.bus);
    const calls: Array<{ key: string; text?: string }> = [];

    const id = await notifier.notify(BASE_PAYLOAD, {
      onAction: (key, text) => calls.push({ key, text }),
    });

    fakeBus.fireNotificationReplied(id!, "use the staging bucket");
    expect(calls).toEqual([{ key: "answer", text: "use the staging bucket" }]);
  });
});

describe("DbusNotifier: action buttons", () => {
  it("appends approve/deny actions after the base default/Open when the payload carries them", async () => {
    const { bus, notifyCalls } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    await notifier.notify(
      {
        ...BASE_PAYLOAD,
        actions: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
      },
      { onAction: () => {}, canDefault: true },
    );

    expect(notifyCalls[0]?.actions).toEqual([
      "default",
      "Open",
      "approve",
      "Approve",
      "deny",
      "Deny",
    ]);
  });

  it("adds the inline-reply action only when the server advertises the inline-reply capability", async () => {
    const withCap = createFakeBus({
      getCapabilitiesImpl: async () => ["body", "actions", "inline-reply"],
    });
    const notifier = new DbusNotifier(() => withCap.bus);

    await notifier.notify(
      { ...BASE_PAYLOAD, reply: { id: "answer", label: "Reply" } },
      { onAction: () => {}, canDefault: true },
    );

    expect(withCap.notifyCalls[0]?.actions).toEqual([
      "default",
      "Open",
      "inline-reply",
      "Reply",
    ]);
  });

  it("omits the inline-reply action when the capability is absent (never faked)", async () => {
    const noCap = createFakeBus({
      getCapabilitiesImpl: async () => ["body", "actions"],
    });
    const notifier = new DbusNotifier(() => noCap.bus);

    await notifier.notify(
      { ...BASE_PAYLOAD, reply: { id: "answer", label: "Reply" } },
      { onAction: () => {}, canDefault: true },
    );

    expect(noCap.notifyCalls[0]?.actions).toEqual(["default", "Open"]);
  });
});

describe("DbusNotifier: retract", () => {
  it("closes the tracked notification id for a session", async () => {
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => fakeBus.bus);

    const id = await notifier.notify(BASE_PAYLOAD);
    await notifier.retract(BASE_PAYLOAD.sessionId);

    expect(fakeBus.closeCalls).toEqual([id!]);
  });

  it("is a no-op for a session with no delivered notification", async () => {
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => fakeBus.bus);

    await notifier.notify(BASE_PAYLOAD);
    await notifier.retract("some-other-session");

    expect(fakeBus.closeCalls).toEqual([]);
  });

  it("never throws when CloseNotification rejects", async () => {
    const { bus } = createFakeBus();
    const iface = (await bus.getProxyObject("", "")).getInterface("");
    iface.CloseNotification = async () => {
      throw new Error("no such notification");
    };
    const notifier = new DbusNotifier(() => bus);

    await notifier.notify(BASE_PAYLOAD);
    await expect(
      notifier.retract(BASE_PAYLOAD.sessionId),
    ).resolves.toBeUndefined();
  });
});

describe("DbusNotifier: probe", () => {
  it("connects and calls GetServerInformation, resolving true on success", async () => {
    const { bus } = createFakeBus();
    const notifier = new DbusNotifier(() => bus);

    expect(await notifier.probe()).toBe(true);
  });

  it("fails open (false) when the bus is unreachable", async () => {
    const bus: BusLike = {
      getProxyObject: async () => {
        throw new Error("no session bus");
      },
      disconnect: () => {},
      on: () => bus,
    };
    const notifier = new DbusNotifier(() => bus);

    expect(await notifier.probe()).toBe(false);
  });

  it("fails open (false) when GetServerInformation rejects", async () => {
    const { bus } = createFakeBus({
      getServerInformationImpl: async () => {
        throw new Error("no reply");
      },
    });
    const notifier = new DbusNotifier(() => bus);

    expect(await notifier.probe()).toBe(false);
  });

  it("times out (false) when connect hangs past the timeout", async () => {
    const bus: BusLike = {
      getProxyObject: () => new Promise(() => {}), // never resolves
      disconnect: () => {},
      on: () => bus,
    };
    const notifier = new DbusNotifier(() => bus);

    expect(await notifier.probe(20)).toBe(false);
  });

  it("times out (false) when GetServerInformation hangs past the timeout", async () => {
    const { bus } = createFakeBus({
      getServerInformationImpl: () => new Promise(() => {}),
    });
    const notifier = new DbusNotifier(() => bus);

    expect(await notifier.probe(20)).toBe(false);
  });
});

describe("DbusNotifier: connection lifecycle", () => {
  it("reconnects (calls the factory again) after a failed notify", async () => {
    let factoryCalls = 0;
    const notifier = new DbusNotifier(() => {
      factoryCalls++;
      throw new Error("no session bus");
    });

    await notifier.notify(BASE_PAYLOAD);
    await notifier.notify(BASE_PAYLOAD);

    expect(factoryCalls).toBe(2);
  });

  it("does not reconnect between successful calls (factory called once)", async () => {
    let factoryCalls = 0;
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => {
      factoryCalls++;
      return fakeBus.bus;
    });

    await notifier.notify(BASE_PAYLOAD);
    await notifier.probe();
    await notifier.notify(BASE_PAYLOAD);

    expect(factoryCalls).toBe(1);
  });

  it("a bus 'error' event drops the cached connection, forcing a reconnect on next use", async () => {
    let factoryCalls = 0;
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => {
      factoryCalls++;
      return fakeBus.bus;
    });

    await notifier.notify(BASE_PAYLOAD);
    expect(factoryCalls).toBe(1);

    fakeBus.fireBusError(new Error("connection dropped"));

    await notifier.notify(BASE_PAYLOAD);
    expect(factoryCalls).toBe(2);
  });

  it("close() disconnects and drops the cached connection", async () => {
    let factoryCalls = 0;
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => {
      factoryCalls++;
      return fakeBus.bus;
    });

    await notifier.notify(BASE_PAYLOAD);
    await notifier.close();

    expect(fakeBus.disconnectCalls).toHaveLength(1);

    await notifier.notify(BASE_PAYLOAD);
    expect(factoryCalls).toBe(2);
  });

  it("close() never throws even when disconnect() itself throws", async () => {
    const iface: NotificationsInterfaceLike = {
      Notify: async () => 1,
      CloseNotification: async () => {},
      GetServerInformation: async () => ["", "", "", ""],
      GetCapabilities: async () => [],
      on: () => iface,
    };
    const bus: BusLike = {
      getProxyObject: async () => ({ getInterface: () => iface }),
      disconnect: () => {
        throw new Error("already disconnected");
      },
      on: () => bus,
    };
    const notifier = new DbusNotifier(() => bus);

    await notifier.connect();
    await expect(notifier.close()).resolves.toBeUndefined();
  });

  it("connect() is idempotent: concurrent calls share one in-flight connection attempt", async () => {
    let factoryCalls = 0;
    const fakeBus = createFakeBus();
    const notifier = new DbusNotifier(() => {
      factoryCalls++;
      return fakeBus.bus;
    });

    const [a, b] = await Promise.all([notifier.connect(), notifier.connect()]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(factoryCalls).toBe(1);
  });
});
