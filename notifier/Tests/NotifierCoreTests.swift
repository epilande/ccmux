// Unit tests for the pure, headless-testable logic in NotifierCore.swift.
//
// These exercise arg parsing, category-id derivation, sound mapping, and the
// response/callback helpers WITHOUT posting notifications, requesting
// authorization, or touching UNUserNotificationCenter — so they run in a plain
// XCTest bundle on CI with no GUI session and no granted authorization.
//
// Load-bearing invariants under test:
//   - responderCategories() registers EXACTLY the three action shapes ccmux can
//     post (the anti-clobber fix — a real bug we shipped).
//   - a "dismiss" (swipe-away) NEVER fires the callback (a swipe is not approval).
@preconcurrency import UserNotifications
import XCTest

final class NotifierCoreTests: XCTestCase {

    // MARK: parseActions

    func testParseActionsTwoPairs() {
        let r = parseActions("approve:Approve,deny:Deny")
        XCTAssertEqual(r.count, 2)
        XCTAssertEqual(r[0].0, "approve"); XCTAssertEqual(r[0].1, "Approve")
        XCTAssertEqual(r[1].0, "deny"); XCTAssertEqual(r[1].1, "Deny")
    }

    func testParseActionsSinglePair() {
        let r = parseActions("approve:Approve")
        XCTAssertEqual(r.count, 1)
        XCTAssertEqual(r[0].0, "approve"); XCTAssertEqual(r[0].1, "Approve")
    }

    func testParseActionsEmptyStringIsEmpty() {
        XCTAssertTrue(parseActions("").isEmpty)
    }

    func testParseActionsNilIsEmpty() {
        XCTAssertTrue(parseActions(nil).isEmpty)
    }

    func testParseActionsEntryWithoutColonIsDropped() {
        // "approve" has no ":" so it is not a valid id:title pair and is dropped.
        XCTAssertTrue(parseActions("approve").isEmpty)
    }

    func testParseActionsTrailingCommaIsIgnored() {
        // split(separator:) omits the empty trailing subsequence, so a trailing
        // comma yields just the one valid pair.
        let r = parseActions("approve:Approve,")
        XCTAssertEqual(r.count, 1)
        XCTAssertEqual(r[0].0, "approve"); XCTAssertEqual(r[0].1, "Approve")
    }

    func testParseActionsExtraColonsSplitOnlyOnce() {
        // maxSplits: 1 means "a:b:c" -> id "a", title "b:c".
        let r = parseActions("a:b:c")
        XCTAssertEqual(r.count, 1)
        XCTAssertEqual(r[0].0, "a"); XCTAssertEqual(r[0].1, "b:c")
    }

    func testParseActionsSkipsMalformedButKeepsValid() {
        // A malformed middle entry is dropped; surrounding valid pairs survive.
        let r = parseActions("approve:Approve,bogus,deny:Deny")
        XCTAssertEqual(r.count, 2)
        XCTAssertEqual(r[0].0, "approve")
        XCTAssertEqual(r[1].0, "deny")
    }

    // MARK: categoryIdentifier

    func testCategoryIdentifierPermissionButtons() {
        let buttons = parseActions("approve:Approve,deny:Deny")
        XCTAssertEqual(categoryIdentifier(buttons: buttons, reply: nil), "ccmux.approve,deny")
    }

    func testCategoryIdentifierReplyOnly() {
        let reply = parseActions("answer:Reply").first
        XCTAssertEqual(categoryIdentifier(buttons: [], reply: reply), "ccmux.reply=answer")
    }

    func testCategoryIdentifierCombined() {
        let buttons = parseActions("approve:Approve,deny:Deny")
        let reply = parseActions("answer:Reply").first
        XCTAssertEqual(categoryIdentifier(buttons: buttons, reply: reply),
                       "ccmux.approve,deny,reply=answer")
    }

    // MARK: responderCategories (anti-clobber invariant)

    func testResponderCategoriesContainsExactlyTheThreeShapes() {
        let ids = Set(responderCategories().map { $0.identifier })
        XCTAssertEqual(ids, [
            "ccmux.approve,deny",
            "ccmux.reply=answer",
            "ccmux.approve,deny,reply=answer",
        ])
    }

    // MARK: optValue

    func testOptValuePresentReturnsValue() {
        let args = ["post", "--title", "Hello", "--body", "World"]
        XCTAssertEqual(optValue(args, "--title"), "Hello")
        XCTAssertEqual(optValue(args, "--body"), "World")
    }

    func testOptValueAbsentReturnsNil() {
        XCTAssertNil(optValue(["post", "--title", "Hello"], "--subtitle"))
    }

    func testOptValueFlagAsLastArgWithNoValueReturnsNil() {
        // Flag present but nothing after it -> nil (no out-of-bounds read).
        XCTAssertNil(optValue(["post", "--title"], "--title"))
    }

    // MARK: makeSound

    func testMakeSoundNilReturnsNil() {
        XCTAssertNil(makeSound(nil))
    }

    func testMakeSoundDefaultReturnsSound() {
        // "default" maps to the system default sound (non-nil).
        XCTAssertNotNil(makeSound("default"))
    }

    func testMakeSoundNamedReturnsSound() {
        // Any other name maps to a named sound (non-nil).
        XCTAssertNotNil(makeSound("Ping"))
    }

    // MARK: mapActionIdentifier

    func testMapActionIdentifierDefaultConstant() {
        XCTAssertEqual(mapActionIdentifier(UNNotificationDefaultActionIdentifier), "default")
    }

    func testMapActionIdentifierDismissConstant() {
        XCTAssertEqual(mapActionIdentifier(UNNotificationDismissActionIdentifier), "dismiss")
    }

    func testMapActionIdentifierCustomPassThrough() {
        XCTAssertEqual(mapActionIdentifier("approve"), "approve")
        XCTAssertEqual(mapActionIdentifier("answer"), "answer")
    }

    // MARK: shouldPostCallback

    func testShouldPostCallbackDismissNeverPosts() {
        // The load-bearing invariant: a swipe-away is not approval.
        XCTAssertFalse(shouldPostCallback(action: "dismiss", callbackUrl: "http://x"))
    }

    func testShouldPostCallbackNilUrlDoesNotPost() {
        XCTAssertFalse(shouldPostCallback(action: "approve", callbackUrl: nil))
    }

    func testShouldPostCallbackApproveWithUrlPosts() {
        XCTAssertTrue(shouldPostCallback(action: "approve", callbackUrl: "http://x"))
    }

    func testShouldPostCallbackDefaultWithUrlPosts() {
        XCTAssertTrue(shouldPostCallback(action: "default", callbackUrl: "http://x"))
    }

    func testShouldPostCallbackAnswerWithUrlPosts() {
        XCTAssertTrue(shouldPostCallback(action: "answer", callbackUrl: "http://x"))
    }

    // MARK: callbackBody

    func testCallbackBodyWithTextAndPayload() throws {
        let body = callbackBody(action: "answer", userText: "hi there", payload: "p1")
        let data = try JSONSerialization.data(withJSONObject: body)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["action"] as? String, "answer")
        XCTAssertEqual(obj?["userText"] as? String, "hi there")
        XCTAssertEqual(obj?["payload"] as? String, "p1")
    }

    func testCallbackBodyWithNilsSerializesNull() throws {
        let body = callbackBody(action: "approve", userText: nil, payload: nil)
        // In-dict: nils are represented as NSNull, action is always present.
        XCTAssertEqual(body["action"] as? String, "approve")
        XCTAssertTrue(body["userText"] is NSNull)
        XCTAssertTrue(body["payload"] is NSNull)
        // Round-tripped through JSON: nils become JSON null.
        let data = try JSONSerialization.data(withJSONObject: body)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["action"] as? String, "approve")
        XCTAssertTrue(obj?["userText"] is NSNull)
        XCTAssertTrue(obj?["payload"] is NSNull)
    }
}
