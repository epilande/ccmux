import { Command } from "commander";
import { getPreferences } from "../lib/preferences";
import {
  deliver,
  probeBackend,
  resolveBackend,
  type NotificationPayload,
} from "../lib/notify";
import { DbusNotifier } from "../lib/notify-dbus";
import { resolveTerminalBundleId } from "../daemon/focus";
import { getActiveTmuxClientPid } from "../lib/tmux-client";

const TEST_MESSAGE = "Notifications are working";

/**
 * Resolves `-sender` per `notifications.icon`: `"none"` unsets it, an
 * explicit bundle id passes through as-is, and the default `"terminal"`
 * borrows the hosting terminal's icon via `src/daemon/focus.ts`'s ancestor
 * walk. Only meaningful inside a tmux client on macOS (the walk needs
 * `#{client_pid}`, and the daemon/other platforms don't have a bundle id to
 * borrow anyway); outside tmux, on another platform, or on any resolution
 * failure this falls back to no sender rather than failing the command.
 */
export async function resolveSenderBundleId(
  icon: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (icon === "none") return undefined;
  if (icon !== "terminal") return icon;
  if (platform !== "darwin" || !process.env.TMUX) return undefined;

  try {
    const clientPid = await getActiveTmuxClientPid();
    if (clientPid === null) return undefined;
    return (await resolveTerminalBundleId(clientPid)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Fires when delivery may have been silently blocked (see plan's Icon note). */
function printFailureHints(backend: string): void {
  if (process.platform === "darwin") {
    console.error(
      "Check System Settings > Notifications for the app that owns this backend " +
        "(Script Editor for osascript, terminal-notifier for terminal-notifier).",
    );
    console.error(
      "If notifications.icon is impersonating a disabled app, run `ccmux config set notifications.icon none`.",
    );
    if (backend === "terminal-notifier") {
      console.error("Install with: brew install terminal-notifier");
    }
  } else if (process.platform === "linux") {
    if (backend === "dbus") {
      console.error(
        "No D-Bus session bus reachable (DBUS_SESSION_BUS_ADDRESS unset, or " +
          "the bus is unavailable — common for a daemon started headless, " +
          "e.g. over SSH or as a systemd service).",
      );
      console.error(
        "The running daemon falls back to notify-send automatically; set notifications.backend to notify-send to test that path directly with this command.",
      );
    } else {
      console.error(
        "Install notify-send (usually via the libnotify-bin / libnotify package).",
      );
    }
  } else {
    console.error(
      'No built-in backend for this platform; set notifications.backend to "command".',
    );
  }
}

export function createNotifyCommand(): Command {
  return new Command("notify")
    .description(
      "Send a notification through the configured backend (bare: send a test message and print diagnostics)",
    )
    .argument("[message]", "Message to send instead of the test message")
    .action(async (message?: string) => {
      const prefs = await getPreferences();
      const notifications = prefs.notifications ?? {};

      const backend = resolveBackend({ backend: notifications.backend });
      if (!backend) {
        console.error("No supported notification backend for this platform.");
        printFailureHints("none");
        process.exit(1);
      }

      // The "command" backend silently no-ops in `deliver` when no command
      // is configured; surface that here instead of printing success.
      if (backend === "command" && !notifications.command) {
        console.error(
          'notifications.backend is "command" but notifications.command is not set.',
        );
        console.error(
          "Set it with: ccmux config set notifications.command '<your command>'",
        );
        process.exit(1);
      }

      const icon = notifications.icon ?? "terminal";

      if (backend === "dbus") {
        // Connection-oriented, one-shot: connect, probe, notify (no click
        // action — there's no daemon around to run it in-process), close.
        // `deliver`/`probeBackend` from lib/notify.ts don't handle "dbus"
        // at all (see that module's docs); the real dispatch lives here and
        // in the daemon's DbusNotifier-backed delivery path.
        const dbusNotifier = new DbusNotifier();
        try {
          const probeOk = await dbusNotifier.probe();
          if (!probeOk) {
            console.error('Notification backend "dbus" is not available.');
            printFailureHints("dbus");
            process.exit(1);
          }

          const id = await dbusNotifier.notify({
            title: "ccmux",
            body: message ?? TEST_MESSAGE,
            event: "finished",
            sessionId: "notify-cli",
            agent: "ccmux",
            project: "ccmux",
            sound: notifications.sound,
          });
          if (id === null) {
            console.error("Failed to deliver the dbus notification.");
            printFailureHints("dbus");
            process.exit(1);
          }
        } finally {
          await dbusNotifier.close();
        }
      } else {
        const probeOk = await probeBackend(backend);
        if (!probeOk) {
          console.error(`Notification backend "${backend}" is not available.`);
          printFailureHints(backend);
          process.exit(1);
        }

        const senderBundleId = await resolveSenderBundleId(icon);

        const payload: NotificationPayload = {
          title: "ccmux",
          body: message ?? TEST_MESSAGE,
          event: "finished",
          sessionId: "notify-cli",
          agent: "ccmux",
          project: "ccmux",
          sound: notifications.sound,
          command: notifications.command,
          senderBundleId,
        };

        await deliver(backend, payload);
      }

      // Script-friendly: a caller-supplied message stays quiet on success.
      if (message) return;

      console.log(`Backend: ${backend}`);
      console.log("Probe: ok");
      console.log("Effective config:");
      console.log(`  enabled: ${notifications.enabled ?? false}`);
      console.log(
        `  events: ${(notifications.events ?? ["waiting", "finished"]).join(", ")}`,
      );
      console.log(`  sound: ${notifications.sound ?? false}`);
      console.log(`  delayMs: ${notifications.delayMs ?? 1000}`);
      console.log(`  backend: ${notifications.backend ?? "auto"}`);
      console.log(`  icon: ${icon}`);
      if (process.platform === "darwin") {
        console.log(
          "Didn't see a notification? Check System Settings > Notifications " +
            "for the app this backend delivers through.",
        );
      }
    });
}
