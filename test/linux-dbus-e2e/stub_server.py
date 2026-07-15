#!/usr/bin/env python3
"""Independent org.freedesktop.Notifications stub server (python-dbus, not
dbus-next) so it is a genuine second implementation checking ccmux's client
over a real session bus. Records every Notify/CloseNotification to
$CCMUX_DBUS_E2E_OUT and, after each Notify, deterministically emits the signal
ccmux's DbusNotifier listens for: ActionInvoked when an 'approve' action is
present, and NotificationReplied when an 'inline-reply' action is present."""
import json
import os
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

OUT = os.environ["CCMUX_DBUS_E2E_OUT"]
BUS_NAME = "org.freedesktop.Notifications"
OBJ_PATH = "/org/freedesktop/Notifications"


def record(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(obj, f)


class Notifications(dbus.service.Object):
    def __init__(self, bus_name):
        super().__init__(bus_name, OBJ_PATH)
        self.next_id = 1
        self.notify_count = 0

    @dbus.service.method(BUS_NAME, in_signature="susssasa{sv}i", out_signature="u")
    def Notify(
        self, app_name, replaces_id, app_icon, summary, body, actions, hints, timeout
    ):
        nid = int(replaces_id) if int(replaces_id) != 0 else self.next_id
        if int(replaces_id) == 0:
            self.next_id += 1
        self.notify_count += 1
        acts = [str(a) for a in actions]
        record(
            "notify-%d.json" % self.notify_count,
            {
                "app_name": str(app_name),
                "replaces_id": int(replaces_id),
                "summary": str(summary),
                "body": str(body),
                "actions": acts,
                "hints": {k: _variant(v) for k, v in hints.items()},
                "timeout": int(timeout),
                "assigned_id": nid,
            },
        )
        # Deterministically simulate the user acting on the notification.
        if "approve" in acts:
            GLib.timeout_add(200, lambda: self._emit_action(nid, "approve"))
        if "inline-reply" in acts:
            GLib.timeout_add(200, lambda: self._emit_reply(nid, "e2e-typed-reply"))
        return dbus.UInt32(nid)

    def _emit_action(self, nid, key):
        self.ActionInvoked(dbus.UInt32(nid), key)
        return False

    def _emit_reply(self, nid, text):
        self.NotificationReplied(dbus.UInt32(nid), text)
        return False

    @dbus.service.method(BUS_NAME, in_signature="", out_signature="as")
    def GetCapabilities(self):
        return ["body", "actions", "inline-reply", "body-markup"]

    @dbus.service.method(BUS_NAME, in_signature="", out_signature="ssss")
    def GetServerInformation(self):
        return ("ccmux-test-stub", "ccmux", "1.0", "1.2")

    @dbus.service.method(BUS_NAME, in_signature="u", out_signature="")
    def CloseNotification(self, nid):
        record("closed-%d.json" % int(nid), {"id": int(nid)})
        self.NotificationClosed(dbus.UInt32(nid), dbus.UInt32(3))

    @dbus.service.signal(BUS_NAME, signature="uu")
    def NotificationClosed(self, nid, reason):
        pass

    @dbus.service.signal(BUS_NAME, signature="us")
    def ActionInvoked(self, nid, action_key):
        pass

    @dbus.service.signal(BUS_NAME, signature="us")
    def NotificationReplied(self, nid, text):
        pass


def _variant(v):
    try:
        return v if isinstance(v, (int, str, float)) else str(v)
    except Exception:
        return str(v)


def main():
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    name = dbus.service.BusName(BUS_NAME, bus)
    Notifications(name)
    open(os.path.join(OUT, "server-ready"), "w").close()
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
