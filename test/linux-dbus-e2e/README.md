# Linux D-Bus end-to-end test

Exercises ccmux's real `DbusNotifier` (`src/lib/notify-dbus.ts`) against a
**real** `dbus-daemon` session bus and an **independent** notification server
(`stub_server.py`, written with python-dbus rather than dbus-next, so it is a
genuine second implementation of the `org.freedesktop.Notifications`
protocol).

## What it verifies

The D-Bus **wire protocol** and the interactive signal round-trip:

- `probe()` completes a `GetServerInformation` round-trip against a live bus.
- The `Notify` args ccmux marshals: the exact `actions` arrays (permission
  `[default, Open, approve, Approve, deny, Deny]`; the capability-gated
  `inline-reply` for a question), the `ccmux` app name, and the urgency hint.
- `ActionInvoked` routes to the registered `onAction("approve")` callback.
- `NotificationReplied` (inline reply) routes to `onAction("answer", text)`.
- `retract()` issues `CloseNotification` for the tracked notification id.

## What it does NOT verify

Real GNOME/KDE/etc. notification daemons and their **visual** rendering. The
stub speaks the protocol and records what it received; it does not draw a
bubble. Visual correctness on a real desktop is out of scope.

## Running it

**Locally (macOS or any host with Docker):**

```bash
bash test/linux-dbus-e2e/run-local.sh
```

This spins up an ephemeral `oven/bun:1-debian` container, installs the bus +
python bindings, mounts the repo read-only, and runs the harness under
`dbus-run-session`. It exits non-zero unless all assertions pass. The pulled
image is removable afterward with `docker rmi oven/bun:1-debian`.

**CI:** `.github/workflows/linux-dbus-e2e.yml` runs the same harness
**natively** (the runner is already Linux, no Docker) on every PR that touches
the D-Bus backend, its delivery path, or this directory.
