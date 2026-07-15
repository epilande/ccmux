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

// MARK: - Arg parsing

func optValue(_ args: [String], _ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

// "approve:Approve,deny:Deny" -> [(id, title)]
func parseActions(_ s: String?) -> [(String, String)] {
    guard let s = s, !s.isEmpty else { return [] }
    return s.split(separator: ",").compactMap { pair in
        let parts = pair.split(separator: ":", maxSplits: 1)
        guard parts.count == 2 else { return nil }
        return (String(parts[0]), String(parts[1]))
    }
}

// --sound mapping: "default" -> the system default, any other name -> a named
// sound, omitted -> no sound (nil).
func makeSound(_ name: String?) -> UNNotificationSound? {
    guard let name = name else { return nil }
    if name == "default" { return .default }
    return UNNotificationSound(named: UNNotificationSoundName(name))
}

// A deterministic category id derived from the action SHAPE, so same-shape posts
// share one id (replace-in-place per session still works) while different shapes
// get distinct ids (no clobber). `setNotificationCategories` replaces the app's
// whole category set, so a single fixed id would let two concurrent posts with
// different action shapes overwrite each other's registration. Examples:
// "ccmux.approve,deny" / "ccmux.reply=answer" / "ccmux.approve,deny,reply=answer".
func categoryIdentifier(buttons: [(String, String)], reply: (String, String)?) -> String {
    var tokens = buttons.map { $0.0 }
    if let reply = reply { tokens.append("reply=\(reply.0)") }
    return "ccmux." + tokens.joined(separator: ",")
}

// Plain buttons plus an optional inline text-input action. All use options: []
// — no .authenticationRequired, no .foreground — so a press (or a Send from the
// text field) works without focusing/relaunching into the UI. The text action,
// when present, is appended last. `identifier` is the shape-derived id.
func makeCategory(identifier: String, buttons: [(String, String)], reply: (String, String)?) -> UNNotificationCategory {
    var acts: [UNNotificationAction] = buttons.map {
        UNNotificationAction(identifier: $0.0, title: $0.1, options: [])
    }
    if let reply = reply {
        acts.append(UNTextInputNotificationAction(identifier: reply.0,
                                                  title: reply.1,
                                                  options: [],
                                                  textInputButtonTitle: "Send",
                                                  textInputPlaceholder: "Type your answer"))
    }
    return UNNotificationCategory(identifier: identifier, actions: acts, intentIdentifiers: [], options: [])
}

// Merge-preserving category registration. `setNotificationCategories` REPLACES
// the app's whole set, so we first fetch the currently registered categories,
// drop any sharing an incoming identifier (replace-in-place for the same shape),
// and register the UNION. This preserves other shapes' categories across posts,
// shrinking the cross-process race (each post is its own one-shot process) to
// same-shape re-registration, which is harmless. `getNotificationCategories` is
// async and fires on a background queue; we bridge it into the existing
// completion-chain style (no @Sendable needed under the @preconcurrency import,
// matching `center.add`'s completion below).
func registerCategories(_ center: UNUserNotificationCenter,
                        _ categories: Set<UNNotificationCategory>,
                        completion: @escaping () -> Void) {
    let incomingIds = Set(categories.map { $0.identifier })
    center.getNotificationCategories { existing in
        var merged = Set(existing.filter { !incomingIds.contains($0.identifier) })
        merged.formUnion(categories)
        center.setNotificationCategories(merged)
        completion()
    }
}

// The full set of action shapes ccmux may post (permission Approve/Deny and the
// question inline reply). The no-args relaunch responder registers these under
// their shape-derived ids so a delivered notification's category still resolves
// its buttons after the app is relaunched to handle the press.
func responderCategories() -> Set<UNNotificationCategory> {
    let permissionButtons = parseActions("approve:Approve,deny:Deny")
    let questionReply = parseActions("answer:Reply").first
    return [
        makeCategory(identifier: categoryIdentifier(buttons: permissionButtons, reply: nil),
                     buttons: permissionButtons, reply: nil),
        makeCategory(identifier: categoryIdentifier(buttons: [], reply: questionReply),
                     buttons: [], reply: questionReply),
    ]
}

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
        // Shape-keyed category: derive the id, stamp it on the content, and
        // register merge-preserving so a concurrent post of a different shape
        // isn't clobbered. Add the request only after registration completes.
        let categoryId = categoryIdentifier(buttons: buttons, reply: reply)
        content.categoryIdentifier = categoryId
        let category = makeCategory(identifier: categoryId, buttons: buttons, reply: reply)
        registerCategories(center, [category]) {
            addPost(center, group: group, content: content)
        }
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
    let body: [String: Any] = ["action": action,
                               "userText": userText ?? NSNull(),
                               "payload": payload ?? NSNull()]
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
            // re-register (merge-preserving) every shape ccmux may post — each
            // under its own shape-derived id — in case macOS consults categories
            // while resolving the response. Using the same derivation as post
            // keeps a delivered notification's category id resolvable here.
            registerCategories(center, responderCategories()) {}
            scheduleTimeout(seconds: kResponderTimeout, exitCode: 0)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        let payload = userInfo["payload"] as? String
        let callbackUrl = userInfo["callbackUrl"] as? String

        let action: String
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier: action = "default"
        case UNNotificationDismissActionIdentifier: action = "dismiss"
        default: action = response.actionIdentifier
        }

        let userText = (response as? UNTextInputNotificationResponse)?.userText

        // Signal the response as handled now, on the main thread. Calling it
        // before the async callback POST (rather than after) keeps the
        // non-Sendable completionHandler off the URLSession background closure;
        // it only needs to fire once before we exit.
        completionHandler()

        // Dismiss must NEVER reach the callback: a swipe-away is not approval.
        if action == "dismiss" {
            exit(0)
        }

        if let cb = callbackUrl {
            postCallbackAsync(url: cb, action: action, userText: userText, payload: payload) {
                exit(0)
            }
        } else {
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
