// NotifierCore — the pure, headless-testable logic of ccmux-notifier, extracted
// from main.swift so it can be unit-tested without an NSApplication run loop.
//
// Everything here is either a pure value transform (arg parsing, id derivation,
// callback-body shaping) or a UN* object constructor that NEVER posts, requests
// authorization, or touches UNUserNotificationCenter — so it is safe to compile
// and exercise in a headless XCTest bundle. main.swift owns the app delegate,
// run loop, and all the modes that actually talk to the notification center;
// those functions call into the helpers below so there is a single source of
// truth for the shared logic.
//
// @preconcurrency mirrors main.swift: it relaxes Swift 6 strict-concurrency
// Sendable checks on the UserNotifications types these constructors touch.
@preconcurrency import UserNotifications
import Foundation

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

// A deterministic category id derived from the action SHAPE, so each distinct
// button/reply layout gets its own stable id. The complete fixed set of shapes
// (see `responderCategories`) is registered together, and a notification stamps
// the id matching its own shape — so its buttons always resolve to the right
// layout regardless of which other shapes are registered. Examples:
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

// The COMPLETE, fixed set of action shapes ccmux can ever post: permission
// Approve/Deny, the question inline reply, and the combined Approve/Deny+reply
// (both `--actions` and `--reply-action` can be passed together, so deliverPost
// can stamp that id too — enumerate it so this set is a true superset of every
// categoryIdentifier deliverPost can produce).
//
// `setNotificationCategories` REPLACES the app's whole set and there is no
// cross-process lock, so a read-modify-write merge is fundamentally racy: two
// one-shot post processes can both read the same base set and the second write
// then drops the first's freshly-added category, breaking that notification's
// buttons. The fix is to register this ENTIRE fixed set on every post instead of
// just the current post's shape. Because every process writes the IDENTICAL
// complete set, concurrent `setNotificationCategories` calls are idempotent — no
// clobber, ever — and any delivered notification's categoryIdentifier always
// resolves because all shapes are always registered. Both the post path and the
// no-args relaunch responder register this same set via the same shape-derived
// id derivation, so a delivered notification's category resolves in either.
func responderCategories() -> Set<UNNotificationCategory> {
    let permissionButtons = parseActions("approve:Approve,deny:Deny")
    let questionReply = parseActions("answer:Reply").first
    return [
        makeCategory(identifier: categoryIdentifier(buttons: permissionButtons, reply: nil),
                     buttons: permissionButtons, reply: nil),
        makeCategory(identifier: categoryIdentifier(buttons: [], reply: questionReply),
                     buttons: [], reply: questionReply),
        makeCategory(identifier: categoryIdentifier(buttons: permissionButtons, reply: questionReply),
                     buttons: permissionButtons, reply: questionReply),
    ]
}

// MARK: - Response handling (pure)

// Normalize a UNNotificationResponse.actionIdentifier into the token ccmux uses
// on the wire: the system default/dismiss sentinels become "default"/"dismiss",
// and any custom button id (e.g. "approve", "answer") passes through unchanged.
func mapActionIdentifier(_ raw: String) -> String {
    switch raw {
    case UNNotificationDefaultActionIdentifier: return "default"
    case UNNotificationDismissActionIdentifier: return "dismiss"
    default: return raw
    }
}

// Decide whether a response should fire the daemon callback. A "dismiss" (a
// swipe-away) is NEVER approval, so it must never reach the callback; a missing
// callback URL likewise has nowhere to post. Every other action with a URL does.
func shouldPostCallback(action: String, callbackUrl: String?) -> Bool {
    if action == "dismiss" { return false }
    if callbackUrl == nil { return false }
    return true
}

// The JSON body posted back to the daemon. `userText`/`payload` are absent-safe:
// a nil becomes JSON null (NSNull), while `action` is always present.
func callbackBody(action: String, userText: String?, payload: String?) -> [String: Any] {
    return ["action": action,
            "userText": userText ?? NSNull(),
            "payload": payload ?? NSNull()]
}
