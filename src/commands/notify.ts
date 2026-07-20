import { Command } from "commander";
import { getPreferences } from "../lib/preferences";
import {
  deliver,
  isUnrecognizedBackend,
  probeBackend,
  resolveBackend,
  resolveCcmuxNotifierBinary,
  type NotificationPayload,
} from "../lib/notify";
import { DbusNotifier } from "../lib/notify-dbus";
import {
  deliverOscNotification,
  isKittyTermnames,
  probeAllowPassthrough,
} from "../lib/notify-osc";
import { DAEMON_HOST, DAEMON_PORT } from "../lib/config";

const TEST_MESSAGE = "Notifications are working";

/**
 * The test/diagnostic notification payload, shared by every backend branch so a
 * contract change (new field, changed default) lands in one place. Mirrors a
 * real notification's shape: event line in the subtitle, message in the body.
 * `extra` carries the per-backend fields (ccmux-notifier's helper path/callback,
 * the "command" backend's shell command).
 */
function buildTestPayload(
  message: string | undefined,
  notifications: { sound?: boolean | string },
  extra: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    title: "ccmux",
    // The bare invocation demos the real event/body split with "Finished" as
    // the event; a caller-supplied message is delivered as-is, with no event
    // line implying something happened that didn't.
    subtitle: message ? undefined : "Finished",
    body: message ?? TEST_MESSAGE,
    event: "finished",
    sessionId: "notify-cli",
    agent: "ccmux",
    project: "ccmux",
    sound: notifications.sound,
    ...extra,
  };
}

/** macOS Settings deep-link to the ccmux-notifier notifications pane, where the
 * user grants permission and sets Alert Style. The CLI-launched permission
 * dialog never appears on macOS 26 (see the spike results in
 * `notifier-app-plan.md`), so this manual step is the real grant path. */
const NOTIFICATIONS_SETTINGS_DEEP_LINK =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

const CALLBACK_URL = `http://${DAEMON_HOST}:${DAEMON_PORT}/notification-action`;

/** Statuses under which the helper can actually deliver an alert. */
const DELIVERABLE_AUTH_STATUSES = new Set([
  "authorized",
  "provisional",
  "ephemeral",
]);

/** On a fresh install the helper blocks in `requestAuthorization` for up to its
 * own 180s `kAuthTimeout` before it can answer; sit just above that so the
 * timeout only bites a genuinely wedged process. */
const REQUEST_PERMISSION_TIMEOUT_MS = 190_000;
/** `list` only reads settings — it returns in well under a second normally, so
 * a much shorter cap is enough to avoid an indefinite hang. */
const LIST_TIMEOUT_MS = 35_000;

/** Runs a ccmux-notifier subcommand that prints one JSON object to stdout
 * (`request-permission`, `list`), returning the parsed object or null on any
 * failure OR on `timeoutMs` (the helper is killed). Never throws. */
async function runNotifierJson(
  binaryPath: string,
  args: string[],
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([binaryPath, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // best-effort; the parse below fails and we return null
      }
    }, timeoutMs);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const parsed = JSON.parse(out.trim());
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Prints the honest limits + brew hint for the macOS osascript floor (the
 * backend `ccmux notify` lands on when the helper isn't installed). */
function printOsascriptHints(): void {
  console.error(
    "osascript notifications post under Script Editor's identity, are suppressed by " +
      "Focus/Do Not Disturb, and have no Approve/Deny buttons or inline reply.",
  );
  console.error(
    "For actionable notifications with ccmux's own identity, install the helper: " +
      "brew install epilande/tap/ccmux",
  );
}

/** Fires when delivery may have been silently blocked. */
function printFailureHints(backend: string): void {
  if (process.platform === "darwin") {
    if (backend === "osascript") {
      printOsascriptHints();
    } else {
      console.error(
        "Check System Settings > Notifications for the app that owns this backend.",
      );
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

/** Prints the grant instructions + Settings deep-link for a helper that isn't
 * authorized (denied / notDetermined / alerts disabled). */
function printGrantInstructions(): void {
  console.error("ccmux-notifier is not authorized to post notifications yet.");
  console.error(
    "The permission dialog does not appear for CLI-launched apps on recent macOS; grant it manually:",
  );
  console.error(`  1. Open: ${NOTIFICATIONS_SETTINGS_DEEP_LINK}`);
  console.error('  2. Find "ccmux" and enable "Allow notifications".');
  console.error(
    '  3. Set its Alert Style to "Persistent" so alerts do not auto-dismiss.',
  );
}

/**
 * `ccmux notify` grant + diagnostics flow for the ccmux-notifier backend. The
 * permission dialog never appears for a CLI-launched app on recent macOS, so
 * this: requests authorization (best-effort), posts a probe notification, then
 * reads back `list` to report the real authorization/alert state and, when not
 * deliverable, prints the manual grant steps. Stays quiet on a custom message.
 */
async function runCcmuxNotifierFlow(
  binaryPath: string,
  notifications: { sound?: boolean | string },
  message: string | undefined,
): Promise<void> {
  // Best-effort: nudges the OS to register the identity. On recent macOS this
  // resolves denied/notDetermined without a dialog; we rely on `list` for truth.
  // On a fresh install this call can block for up to ~180s while the helper
  // waits on the authorization prompt, so warn before it and cap it.
  console.error(
    "Checking notification authorization (this can take a moment; " +
      "macOS may require you to grant it in System Settings)...",
  );
  const permission = await runNotifierJson(
    binaryPath,
    ["request-permission"],
    REQUEST_PERMISSION_TIMEOUT_MS,
  );
  if (permission === null) {
    console.error(
      "Authorization check did not complete (it may have timed out). If a " +
        "notification does not appear below, grant permission manually:",
    );
    console.error(`  Open: ${NOTIFICATIONS_SETTINGS_DEEP_LINK}`);
  }

  const payload = buildTestPayload(message, notifications, {
    notifierPath: binaryPath,
    callbackUrl: CALLBACK_URL,
  });
  await deliver("ccmux-notifier", payload);

  const settings = await runNotifierJson(binaryPath, ["list"], LIST_TIMEOUT_MS);

  // A custom message stays script-friendly and quiet on success.
  if (message) return;

  const authStatus =
    typeof settings?.authorizationStatus === "string"
      ? settings.authorizationStatus
      : "unknown";
  const alertSetting =
    typeof settings?.alertSetting === "string"
      ? settings.alertSetting
      : "unknown";
  const alertStyle =
    typeof settings?.alertStyle === "string" ? settings.alertStyle : "unknown";

  console.log("Backend: ccmux-notifier");
  console.log(`Helper: ${binaryPath}`);
  console.log(`Authorization: ${authStatus}`);
  console.log(`Alerts: ${alertSetting} (style: ${alertStyle})`);

  const deliverable = DELIVERABLE_AUTH_STATUSES.has(authStatus);
  if (!deliverable || alertSetting === "disabled") {
    console.log("");
    printGrantInstructions();
  } else if (alertStyle !== "alert") {
    console.log(
      'Tip: set Alert Style to "Persistent" (Settings > Notifications > ' +
        "ccmux) so alerts do not auto-dismiss after a few seconds.",
    );
  }
}

/** Runs a tmux command synchronously, returning stdout or null on failure. */
function runTmuxCapture(args: string[]): string | null {
  try {
    const result = Bun.spawnSync(["tmux", ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success) return null;
    return result.stdout.toString();
  } catch {
    return null;
  }
}

/**
 * `ccmux notify` flow for the osc backend. Unlike the daemon (which stays
 * silent and drops), this diagnostics command explains every failure: it must
 * run inside tmux (to reach a pane tty), tmux needs `allow-passthrough` on, and
 * the escape is written to THIS command's own pane so the user sees it appear.
 * Returns true when it delivered, false when it printed an error and the caller
 * should exit non-zero.
 */
function runOscFlow(
  notifications: { sound?: boolean | string },
  message: string | undefined,
): boolean {
  const paneId = process.env.TMUX_PANE;
  if (!process.env.TMUX || !paneId) {
    console.error(
      "The osc backend writes notifications through a tmux pane, so run this inside tmux.",
    );
    return false;
  }

  const tty = runTmuxCapture([
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{pane_tty}",
  ])?.trim();
  if (!tty) {
    console.error("Could not resolve this pane's tty from tmux.");
    return false;
  }

  if (!probeAllowPassthrough(runTmuxCapture)) {
    console.error(
      "tmux option allow-passthrough is not enabled; the escape sequence would be swallowed.",
    );
    console.error("Enable it with: tmux set -g allow-passthrough on");
    return false;
  }

  // Stamp the pane id so delivery scopes its termname sniff to THIS session.
  deliverOscNotification(
    buildTestPayload(message, notifications, { pane: paneId }),
    tty,
    {
      runTmux: runTmuxCapture,
      log: (msg, error) => console.error(msg, error ?? ""),
    },
  );

  // Script-friendly: a caller-supplied message stays quiet on success.
  if (message) return true;

  const termnames = runTmuxCapture([
    "list-clients",
    "-t",
    paneId,
    "-F",
    "#{client_termname}",
  ]);
  const format =
    termnames && isKittyTermnames(termnames) ? "OSC 99 (kitty)" : "OSC 9";
  console.log("Backend: osc");
  console.log(`Pane tty: ${tty}`);
  console.log(`Sequence: ${format}`);
  console.log(
    "Sent. If nothing appeared, your terminal may not implement this escape " +
      "(supported: Ghostty, iTerm2, WezTerm for OSC 9; Kitty for OSC 99).",
  );
  return true;
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
      if (isUnrecognizedBackend(notifications.backend)) {
        console.error(
          `notifications.backend "${String(notifications.backend)}" is not a recognized backend; using the auto ladder.`,
        );
      }
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

      if (backend === "ccmux-notifier") {
        const binaryPath = resolveCcmuxNotifierBinary({
          execPath: process.execPath,
          ccmuxPath: Bun.which("ccmux"),
        });
        if (binaryPath) {
          await runCcmuxNotifierFlow(binaryPath, notifications, message);
          return;
        }
        // The helper isn't installed; the daemon falls down its ladder to
        // osascript for the same reason (see `notify-delivery.ts`), and v1
        // always delivered via osascript on macOS. Mirror that here: actually
        // post through the osascript floor instead of printing diagnostics and
        // dropping the notification.
        const osascriptOk = await probeBackend("osascript");
        if (!osascriptOk) {
          console.error('Notification backend "osascript" is not available.');
          printFailureHints("osascript");
          process.exit(1);
        }
        await deliver("osascript", buildTestPayload(message, notifications));
        // A caller-supplied message stays quiet on success (the script-friendly
        // contract); the bare invocation reports the effective floor + limits.
        if (message) return;
        console.log("Backend: osascript (ccmux-notifier helper not found)");
        printOsascriptHints();
        return;
      }

      if (backend === "osc") {
        // Tty-oriented, one-shot: resolve this pane's tty, check
        // allow-passthrough, write the escape here so the user sees it. All
        // diagnostics live in `runOscFlow`.
        if (!runOscFlow(notifications, message)) process.exit(1);
        return;
      }

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

          const id = await dbusNotifier.notify(
            buildTestPayload(message, notifications),
          );
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

        const payload = buildTestPayload(message, notifications, {
          command: notifications.command,
        });

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
      if (backend === "osascript") {
        console.log("");
        printOsascriptHints();
      }
    });
}
