// ccmux-notifier — one-shot CLI helper that posts actionable macOS notifications
// on behalf of the ccmux daemon and relays the user's response back to it.
//
// ARCHITECTURE (validated live on macOS 26): usernoted will not present the
// authorization dialog — and will not register the app in com.apple.ncprefs —
// unless the requesting process is a real NSApplication with a live main run
// loop. A one-shot CLI that blocks the main thread on a DispatchSemaphore starves
// that run loop; requestAuthorization then either returns "not allowed" instantly
// or hangs for minutes and records a *permanent* denial. So EVERY notification
// mode runs inside NSApplication.run(), does its work fully async in
// applicationDidFinishLaunching (no main-thread semaphores), and exits only after
// all completion handlers have fired. This mirrors terminal-notifier, likewise a
// full LSUIElement app.
//
// @preconcurrency relaxes Swift 6 strict-concurrency Sendable checks on the
// UserNotifications completion handlers (they fire on background XPC queues).
@preconcurrency import UserNotifications
import Foundation
import AppKit

let kAuthTimeout = 180.0     // post / request-permission: dialog may sit for minutes
let kResponderTimeout = 10.0 // relaunch delivery should be near-immediate
let kRemoveTimeout = 30.0    // backstop only
let kCallbackTimeout = 2.0   // callback POST request timeout

// Version is the bundle's CFBundleShortVersionString so the app and the CLI stay
// in lockstep with the release tag; falls back to "0.0.0" outside a bundle.
func version() -> String {
    (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
}

// MARK: - stderr / stdout

func die(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(code)
}

// String(describing:) on these enums yields "UNAuthorizationStatus(rawValue: 1)"
// — useless to diagnostics. Map to stable, human-readable tokens instead.
func authStatusString(_ s: UNAuthorizationStatus) -> String {
    switch s {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown"
    }
}
func alertStyleString(_ s: UNAlertStyle) -> String {
    switch s {
    case .none: return "none"
    case .banner: return "banner"
    case .alert: return "alert"
    @unknown default: return "unknown"
    }
}
func alertSettingString(_ s: UNNotificationSetting) -> String {
    switch s {
    case .notSupported: return "notSupported"
    case .disabled: return "disabled"
    case .enabled: return "enabled"
    @unknown default: return "unknown"
    }
}

// Emit one compact JSON object to stdout (for `list` / `request-permission`,
// which `ccmux notify` diagnostics parse).
func printJSON(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// Fire `exit(code)` after `seconds` if the mode's async work never completes.
// Free function / DispatchQueue closure: no actor isolation to fight.
func scheduleTimeout(seconds: Double, exitCode: Int32) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(exitCode) }
}

// Arg parsing, category/sound construction, and the pure response helpers
// (optValue, parseActions, makeSound, categoryIdentifier, makeCategory,
// responderCategories, mapActionIdentifier, shouldPostCallback, callbackBody)
// live in NotifierCore.swift so they can be unit-tested without a run loop.

// MARK: - CLI modes (all invoked from applicationDidFinishLaunching, fully async)

func performPost(_ center: UNUserNotificationCenter, _ args: [String]) {
    scheduleTimeout(seconds: kAuthTimeout, exitCode: 1)
    center.getNotificationSettings { settings in
        if settings.authorizationStatus == .notDetermined {
            // Request only if undetermined; the live run loop lets usernoted show
            // the dialog. The completion may take minutes if the user delays.
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in
                deliverPost(center, args)
            }
        } else {
            deliverPost(center, args)
        }
    }
}

func deliverPost(_ center: UNUserNotificationCenter, _ args: [String]) {
    let group = optValue(args, "--group") ?? "default-group"

    let content = UNMutableNotificationContent()
    content.title = optValue(args, "--title") ?? ""
    content.body = optValue(args, "--body") ?? ""
    if let subtitle = optValue(args, "--subtitle") { content.subtitle = subtitle }
    content.sound = makeSound(optValue(args, "--sound"))

    // Everything the relaunched process needs, since it gets none of our argv/env.
    var userInfo: [String: Any] = [:]
    if let cb = optValue(args, "--callback-url") { userInfo["callbackUrl"] = cb }
    if let payload = optValue(args, "--payload") { userInfo["payload"] = payload }
    content.userInfo = userInfo

    let buttons = parseActions(optValue(args, "--actions"))
    let reply = parseActions(optValue(args, "--reply-action")).first // id:Title
    if !buttons.isEmpty || reply != nil {
        // Stamp this post's shape-derived id on the content, then register the
        // COMPLETE fixed set (not just this shape) so concurrent one-shot posts
        // write an identical, idempotent set — no cross-process clobber — and
        // the stamped id is always among the registered categories.
        // `setNotificationCategories` is synchronous, so add the request right
        // after (no completion chain).
        content.categoryIdentifier = categoryIdentifier(buttons: buttons, reply: reply)
        center.setNotificationCategories(responderCategories())
        addPost(center, group: group, content: content)
    } else {
        // No actions and no reply: leave categoryIdentifier unset (no category).
        addPost(center, group: group, content: content)
    }
}

// identifier == group: a same-group repost replaces in place.
func addPost(_ center: UNUserNotificationCenter, group: String, content: UNNotificationContent) {
    let request = UNNotificationRequest(identifier: group, content: content, trigger: nil)
    center.add(request) { err in
        if let err = err {
            FileHandle.standardError.write(Data("post failed: \(err.localizedDescription)\n".utf8))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(1) }
        } else {
            // Let the system settle, then exit; the notification outlives us.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
        }
    }
}

func performRemove(_ center: UNUserNotificationCenter, _ args: [String]) {
    let group = optValue(args, "--group") ?? ""
    scheduleTimeout(seconds: kRemoveTimeout, exitCode: 1)
    center.removeDeliveredNotifications(withIdentifiers: [group])
    center.removePendingNotificationRequests(withIdentifiers: [group])
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
}

func performRequestPermission(_ center: UNUserNotificationCenter) {
    scheduleTimeout(seconds: kAuthTimeout, exitCode: 1)
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
        center.getNotificationSettings { s in
            printJSON(["granted": granted,
                       "authorizationStatus": authStatusString(s.authorizationStatus)])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
        }
    }
}

// Read-only settings introspection: delivered ids + whether alerts are enabled
// for the current identity, so `ccmux notify` diagnostics can distinguish
// not-registered / denied / authorized-but-alerts-off (Focus).
func performList(_ center: UNUserNotificationCenter) {
    scheduleTimeout(seconds: kRemoveTimeout, exitCode: 1)
    center.getDeliveredNotifications { delivered in
        let ids = delivered.map { $0.request.identifier }
        center.getNotificationSettings { s in
            printJSON(["authorizationStatus": authStatusString(s.authorizationStatus),
                       "alertStyle": alertStyleString(s.alertStyle),
                       "alertSetting": alertSettingString(s.alertSetting),
                       "delivered": ids])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
        }
    }
}

// MARK: - Callback POST (fully async, 2s request timeout — never blocks main)

func postCallbackAsync(url: String, action: String, userText: String?, payload: String?,
                       completion: @escaping @Sendable () -> Void) {
    guard let u = URL(string: url) else { completion(); return }
    var req = URLRequest(url: u, timeoutInterval: kCallbackTimeout)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let body = callbackBody(action: action, userText: userText, payload: payload)
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    let task = URLSession.shared.dataTask(with: req) { _, _, _ in completion() }
    task.resume()
}

// MARK: - App delegate (drives every mode; hosts the relaunch responder)

// Not @MainActor at the class level: NSApplicationDelegate is @MainActor (so
// applicationDidFinishLaunching is main-isolated), while
// UNUserNotificationCenterDelegate is nonisolated (so didReceive is too — it only
// touches free functions and exit(), never a main-actor API).
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let mode: String?       // nil == responder (no-args relaunch)
    let args: [String]

    init(mode: String?, args: [String]) {
        self.mode = mode
        self.args = args
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        switch mode {
        case "post":
            performPost(center, args)
        case "remove":
            performRemove(center, args)
        case "request-permission":
            performRequestPermission(center)
        case "list":
            performList(center)
        default:
            // No-args relaunch: category registration is per-process, so
            // re-register the COMPLETE fixed set — identical to the post path —
            // in case macOS consults categories while resolving the response.
            // Using the same shape-derived derivation as post keeps a delivered
            // notification's category id resolvable here.
            center.setNotificationCategories(responderCategories())
            scheduleTimeout(seconds: kResponderTimeout, exitCode: 0)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        let payload = userInfo["payload"] as? String
        let callbackUrl = userInfo["callbackUrl"] as? String

        let action = mapActionIdentifier(response.actionIdentifier)

        let userText = (response as? UNTextInputNotificationResponse)?.userText

        // Signal the response as handled now, on the main thread. Calling it
        // before the async callback POST (rather than after) keeps the
        // non-Sendable completionHandler off the URLSession background closure;
        // it only needs to fire once before we exit.
        completionHandler()

        // shouldPostCallback encodes the invariants: a "dismiss" (swipe-away) is
        // NEVER approval and must not reach the callback, and a missing URL has
        // nowhere to post. Both cases exit without a callback.
        guard shouldPostCallback(action: action, callbackUrl: callbackUrl),
              let cb = callbackUrl else {
            exit(0)
        }
        postCallbackAsync(url: cb, action: action, userText: userText, payload: payload) {
            exit(0)
        }
    }
}

// MARK: - Entry

let rawArgs = Array(CommandLine.arguments.dropFirst())
let mode = rawArgs.first

// Fast path that needs no run loop.
if mode == "--version" {
    print(version())
    exit(0)
}
let cliModes: Set<String> = ["post", "remove", "request-permission", "list"]
if let m = mode, !cliModes.contains(m) {
    die("unknown command: \(m)", 2)
}

// mode is nil (responder) or a valid CLI mode: run inside NSApplication so
// usernoted has a live main run loop. The top-level `let` keeps the delegate
// retained for the life of the process (NSApplication.delegate is weak).
let app = NSApplication.shared
let delegate = AppDelegate(mode: mode, args: rawArgs)
app.delegate = delegate
UNUserNotificationCenter.current().delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
