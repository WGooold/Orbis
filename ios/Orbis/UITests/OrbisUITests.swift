import XCTest
import UIKit

final class OrbisUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch(_ screen: String, dark: Bool = false, arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--preview-screen=" + screen] + arguments
        if dark { app.launchArguments.append("--preview-dark") }
        app.launch()
        return app
    }
    private func capture(_ name: String, app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways
        add(screenshot)
    }
    func testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache() {
        let app = launch("changes")
        let open = app.buttons["turn-changes-open-preview-review"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["change-detail-requests"].label, "reads=0,0,0")
        capture("turn-change-summary-light-narrow", app: app)
        open.tap()
        XCTAssertTrue(app.staticTexts["+CHANGE_FIRST"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(identifier: "change-detail-requests").allElementsBoundByIndex.last?.label, "reads=1,0,0")
        capture("turn-change-detail-light-narrow", app: app)
        let pager = app.otherElements["turn-change-pager"]
        let origin = pager.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.6))
        origin.press(forDuration: 0.1, thenDragTo: pager.coordinate(withNormalizedOffset: CGVector(dx: 0.54, dy: 0.6)), withVelocity: .slow, thenHoldForDuration: 0.4)
        XCTAssertEqual(app.staticTexts["turn-change-page"].label, "1 / 3")
        XCTAssertEqual(app.staticTexts.matching(identifier: "change-detail-requests").allElementsBoundByIndex.last?.label, "reads=1,0,0")
        pager.swipeRight() // First-file boundary rebounds without a new request.
        XCTAssertEqual(app.staticTexts["turn-change-page"].label, "1 / 3")
        XCTAssertEqual(app.staticTexts.matching(identifier: "change-detail-requests").allElementsBoundByIndex.last?.label, "reads=1,0,0")
        pager.swipeLeft()
        XCTAssertTrue(app.staticTexts["+CHANGE_SECOND"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(identifier: "change-detail-requests").allElementsBoundByIndex.last?.label, "reads=1,1,0")
        pager.swipeRight()
        XCTAssertTrue(app.staticTexts["+CHANGE_FIRST"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(identifier: "change-detail-requests").allElementsBoundByIndex.last?.label, "reads=1,1,0")
        app.buttons["下一个文件"].tap(); app.buttons["下一个文件"].tap()
        XCTAssertTrue(app.staticTexts["二进制文件，仅显示变更信息。"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts.matching(identifier: "change-detail-requests").allElementsBoundByIndex.last?.label, "reads=1,1,0")
        capture("turn-change-binary", app: app)
    }
    func testTurnFileReviewDarkAppearance() {
        let app = launch("changes", dark: true, arguments: ["--preview-reduce-motion", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        let open = app.buttons["turn-changes-open-preview-review"]
        XCTAssertTrue(open.waitForExistence(timeout: 10)); open.tap()
        XCTAssertTrue(app.staticTexts["+CHANGE_FIRST"].waitForExistence(timeout: 5))
        capture("turn-change-detail-dark-narrow-large-text", app: app)
        app.buttons["下一个文件"].tap()
        XCTAssertTrue(app.staticTexts["+CHANGE_SECOND"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["turn-change-page"].label, "2 / 3")
        capture("turn-change-reduced-motion-settled", app: app)
    }

    func testCachedOnlineChatEntryTiming() {
        let app = launch("entry", arguments: ["--measure-chat-entry", "--preview-entry-long-turn"])
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        for entry in 1...3 {
            let syncsBefore = Int(app.staticTexts["chat-entry-sync-count"].label)!
            card.tap()
            let report = app.staticTexts["chat-entry-metrics"]
            let measured = NSPredicate(format: "label BEGINSWITH %@", "entry=\(entry) ")
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: measured, object: report)], timeout: 15), .completed)
            print("OrbisChatEntry \(report.label)")
            let drawMs = Double(report.label.components(separatedBy: "drawMs=").last!)!
            XCTAssertLessThan(drawMs, entry == 1 ? 1200 : 500)
            XCTAssertTrue(app.staticTexts["ENTRY_LATEST"].isHittable)
            XCTAssertEqual(Int(app.staticTexts["chat-entry-sync-count"].label), syncsBefore + 1)
            if entry == 3 { capture("long-turn-entry-segments", app: app) }
            app.buttons["返回"].firstMatch.tap()
            XCTAssertTrue(card.waitForExistence(timeout: 5))
        }
    }
    func testClosedDisclosureDefersWorkAcrossChatReentryAndRetainsState() {
        let app = launch("disclosure")
        let disclosure = app.buttons["展开Detail 0"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 8))
        for _ in 0..<3 {
            app.buttons["Sample"].tap()
            XCTAssertEqual(app.staticTexts["disclosure-counts"].label, "builds=0 layouts=0")
            app.buttons["Reopen"].tap()
        }
        disclosure.tap()
        let counter = app.buttons["disclosure-counter"].firstMatch
        XCTAssertTrue(counter.waitForExistence(timeout: 3))
        XCTAssertTrue(counter.isHittable)
        counter.tap()
        XCTAssertEqual(counter.label, "Count 1")
        app.buttons["Sample"].tap()
        XCTAssertFalse(app.staticTexts["disclosure-counts"].label.contains("builds=0"))
        XCTAssertFalse(app.staticTexts["disclosure-counts"].label.contains("layouts=0"))
        app.buttons["收起Detail 0"].tap()
        XCTAssertFalse(counter.isHittable)
        app.buttons["Update"].tap()
        disclosure.tap()
        XCTAssertEqual(counter.label, "Count 1")
        XCTAssertTrue(app.staticTexts["Updated body"].firstMatch.isHittable)
    }
    func testRefreshKeepsHeaderTextAndTruncationStable() throws {
        let app = launch("chat", arguments: ["--preview-slow-sync"])
        let title = app.descendants(matching: .any)["chat-title"].firstMatch
        let refresh = app.buttons["刷新"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        let ready = NSPredicate(format: "enabled == true")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: refresh)], timeout: 15), .completed)
        let titleFrame = title.frame
        let historyFrame = app.buttons["历史与分支"].frame
        let downloadsFrame = app.buttons["下载"].frame
        // Exclude the leading icon slot, then compare the actual rendered text pixels.
        let textFrame = CGRect(x: titleFrame.minX + 25, y: titleFrame.minY,
                               width: titleFrame.width - 25, height: titleFrame.height)
        func headerPixels() throws -> Data {
            let screenshot = app.screenshot().image
            let scale = screenshot.scale
            let crop = CGRect(x: textFrame.minX * scale, y: textFrame.minY * scale,
                              width: textFrame.width * scale, height: textFrame.height * scale).integral
            let image = try XCTUnwrap(screenshot.cgImage?.cropping(to: crop))
            return try XCTUnwrap(UIImage(cgImage: image).pngData())
        }
        let idlePixels = try headerPixels()
        for cycle in 0..<3 {
            refresh.tap()
            XCTAssertFalse(refresh.isEnabled)
            XCTAssertEqual(titleFrame, title.frame)
            XCTAssertEqual(historyFrame, app.buttons["历史与分支"].frame)
            XCTAssertEqual(downloadsFrame, app.buttons["下载"].frame)
            XCTAssertTrue(idlePixels == (try headerPixels()), "Header text changed during refresh \(cycle)")
            if cycle == 0 { capture("chat-header-refresh", app: app) }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: refresh)], timeout: 12), .completed)
            XCTAssertTrue(idlePixels == (try headerPixels()), "Header text changed after refresh \(cycle)")
        }
    }
    func testHomeDirectorySearchAndNewSession() {
        let app = launch("home")
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 8))
        app.buttons["打开会话目录"].tap()
        XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3))
        let search = app.textFields["搜索会话或目录"]
        search.tap(); search.typeText("no-matching-session")
        XCTAssertTrue(app.staticTexts["没有匹配的会话"].waitForExistence(timeout: 3))
        app.buttons["清除搜索"].tap()
        app.buttons["新会话"].tap()
        XCTAssertTrue(app.staticTexts["新建会话"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["在这里新建 Pi 会话"].exists)
        capture("new-session", app: app)
    }
    func testHomeLongPressSelectsAndClosesOnlyCheckedSessions() {
        let app = launch("home")
        let codex = app.buttons["home-runtime-preview-codex"]
        let pi = app.buttons["home-runtime-preview-pi"]
        let dsh = app.buttons["home-runtime-preview-dsh"]
        XCTAssertTrue(codex.waitForExistence(timeout: 8))
        let selectionFrame = codex.frame
        codex.press(forDuration: 0.8)
        XCTAssertTrue(app.staticTexts["已选择 1 项"].waitForExistence(timeout: 3))
        XCTAssertEqual(codex.frame, selectionFrame, "长按选择不能移动或改变卡片大小")
        XCTAssertFalse(app.descendants(matching: .any)["chat-composer"].firstMatch.exists)
        pi.tap()
        XCTAssertTrue(app.staticTexts["已选择 2 项"].waitForExistence(timeout: 3))
        pi.tap()
        XCTAssertTrue(app.staticTexts["已选择 1 项"].exists)
        app.buttons["退出多选"].tap()
        XCTAssertTrue(app.buttons["打开会话目录"].exists)
        codex.press(forDuration: 0.8)
        pi.tap()
        capture("home-session-selection", app: app)
        app.buttons["关闭选中会话"].tap()
        XCTAssertTrue(codex.waitForNonExistence(timeout: 5))
        XCTAssertTrue(pi.waitForNonExistence(timeout: 5))
        XCTAssertTrue(dsh.exists)
        XCTAssertTrue(app.buttons["打开会话目录"].exists)
        dsh.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 3))
    }
    func testHomeShortSwipeReboundsAndLongSwipeClosesOnlyThatRuntime() {
        let app = launch("home")
        let codex = app.buttons["home-runtime-preview-codex"]
        let pi = app.buttons["home-runtime-preview-pi"]
        XCTAssertTrue(codex.waitForExistence(timeout: 8))
        let originalFrame = codex.frame
        capture("home-neumorphic-cards", app: app)
        let start = codex.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -originalFrame.width * 0.45, dy: 0)))
        XCTAssertTrue(codex.exists)
        let rebounded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            abs(codex.frame.minX - originalFrame.minX) <= 1
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [rebounded], timeout: 3), .completed)
        XCTAssertFalse(app.descendants(matching: .any)["chat-composer"].firstMatch.exists)
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -originalFrame.width * 0.6, dy: 0)))
        XCTAssertTrue(codex.waitForNonExistence(timeout: 5))
        XCTAssertTrue(pi.exists)
        XCTAssertTrue(app.buttons["打开会话目录"].exists)
    }
    func testSwipeRightFromLeftSideOpensDirectory() {
        let app = launch("home")
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 8))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.6))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.6)))
        XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
        // 从会话卡片上起手横拖：只拉出抽屉，不能同时打开卡片对应的会话。
        let card = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "对齐移动端的使用体验")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 3))
        card.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.3)))
        XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["chat-composer"].firstMatch.exists)
    }
    func testDraftSurvivesBackNavigationAndSlashRequiresSelection() {
        let app = launch("chat")
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("保留这段草稿")
        app.buttons["返回"].firstMatch.tap()
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
        let runtime = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "对齐移动端的使用体验")).firstMatch
        XCTAssertTrue(runtime.waitForExistence(timeout: 3)); runtime.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertTrue((composer.value as? String)?.contains("保留这段草稿") == true)
        composer.tap()
        composer.press(forDuration: 1)
        // The standalone slash screen exercises its menu without depending on system edit menus.
        app.terminate()
        let slash = launch("slash")
        XCTAssertTrue(slash.buttons.matching(NSPredicate(format: "label CONTAINS %@", "/compact")).firstMatch.waitForExistence(timeout: 8))
        capture("slash-menu", app: slash)
    }
    func testChatSwipeBackReboundsThenReturnsHome() {
        let app = launch("chat")
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.55))
        start.press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.32, dy: 0.55)),
                    withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(composer.isHittable)
        XCTAssertFalse(app.buttons["打开会话目录"].isHittable)
        capture("chat-swipe-rebounded", app: app)
        start.press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.55)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
        XCTAssertFalse(composer.exists)
        capture("chat-swipe-home", app: app)
    }
    func testSlashPickerStaysAboveKeyboard() {
        let app = launch("slash")
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap()

        let keyboard = app.keyboards.firstMatch
        let command = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "/compact")).firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        XCTAssertTrue(command.waitForExistence(timeout: 5))
        XCTAssertTrue(command.isHittable)
        XCTAssertLessThanOrEqual(command.frame.maxY, keyboard.frame.minY)
        capture("slash-keyboard", app: app)
    }
    func testHistoryPreviewAndNavigation() {
        let app = launch("chat")
        XCTAssertTrue(app.buttons["历史与分支"].waitForExistence(timeout: 8))
        app.buttons["历史与分支"].tap()
        XCTAssertTrue(app.staticTexts["历史与分支"].waitForExistence(timeout: 3))
        let node = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "梳理页面和交互")).firstMatch
        XCTAssertTrue(node.waitForExistence(timeout: 3)); node.tap()
        XCTAssertTrue(app.buttons["从这条回复后继续"].waitForExistence(timeout: 3))
        capture("history-preview", app: app)
        app.buttons["从这条回复后继续"].tap()
        XCTAssertTrue(app.buttons["历史与分支"].waitForExistence(timeout: 5))
    }
    func testUserMessageCopyAndRewind() {
        let app = launch("chat")
        let copy = app.buttons["copy-message-m3"]
        XCTAssertTrue(copy.waitForExistence(timeout: 8))
        if !copy.isHittable { app.swipeDown() }
        copy.tap()
        XCTAssertEqual(copy.label, "已复制")
        let rewind = app.buttons["rewind-message-m3"]
        XCTAssertTrue(rewind.isEnabled)
        capture("user-message-actions", app: app)
        rewind.tap()
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        let restored = NSPredicate(format: "value CONTAINS %@", "聊天输入和滚动也要保持一致。")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: restored, object: composer)], timeout: 8), .completed)
    }
    func testToolDetailsLoadPagesAndClose() {
        let app = launch("tool")
        let disclosure = app.buttons["展开read，已完成"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 8)); disclosure.tap()
        XCTAssertTrue(app.buttons["查看输出"].waitForExistence(timeout: 3)); app.buttons["查看输出"].tap()
        XCTAssertTrue(app.buttons["读取下一页"].waitForExistence(timeout: 5))
        for _ in 0..<4 {
            if app.staticTexts["已到当前读取范围末尾"].exists { break }
            if app.buttons["读取下一页"].waitForExistence(timeout: 3) { app.buttons["读取下一页"].tap() }
        }
        XCTAssertTrue(app.staticTexts["已到当前读取范围末尾"].waitForExistence(timeout: 5))
        capture("tool-detail", app: app)
        app.buttons["关闭"].firstMatch.tap()
        XCTAssertTrue(app.buttons["历史与分支"].waitForExistence(timeout: 3))
    }

    func testLongTranscriptAppearsAndToolExpansionKeepsItsPositionWithoutDragging() {
        let app = launch("tool", arguments: ["--preview-long-transcript"])
        let disclosure = app.buttons["展开read，已完成"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 8))
        XCTAssertTrue(disclosure.isHittable)
        let before = disclosure.frame.minY
        disclosure.tap()
        let expanded = app.buttons["收起read，已完成"]
        XCTAssertTrue(expanded.waitForExistence(timeout: 3))
        capture("tool-expanded-without-drag", app: app)
        XCTAssertTrue(expanded.isHittable, "Expanded tool frame: \(expanded.frame)")
        XCTAssertEqual(before, expanded.frame.minY, accuracy: 1)
        expanded.tap()
        XCTAssertTrue(disclosure.isHittable)
        XCTAssertTrue(app.staticTexts["源文件检查完成。展开工具可查看摘要和按需读取完整输出。"].isHittable)
        app.buttons["返回"].firstMatch.tap()
        let runtime = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "对齐移动端的使用体验")).firstMatch
        XCTAssertTrue(runtime.waitForExistence(timeout: 3)); runtime.tap()
        XCTAssertTrue(disclosure.waitForExistence(timeout: 5))
        XCTAssertTrue(disclosure.isHittable)
        capture("long-transcript-reopened-without-drag", app: app)
    }

    func testLongFinalReplyKeepsReadingPositionAndOnlyFollowsAfterJump() {
        let app = launch("viewport")
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = app.scrollViews.firstMatch
        transcript.swipeDown()
        transcript.swipeDown()
        let visible = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 "))
            .allElementsBoundByIndex.filter { $0.isHittable && $0.frame.minY > transcript.frame.minY + 10 && $0.frame.maxY < transcript.frame.maxY - 10 }
        XCTAssertFalse(visible.isEmpty)
        guard let anchor = visible.first else { return }
        let before = anchor.frame.minY
        let refresh = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "刷新 Git 工作分支")).firstMatch
        XCTAssertTrue(refresh.waitForExistence(timeout: 3))
        refresh.tap()
        XCTAssertTrue(app.buttons["跳到最新消息"].waitForExistence(timeout: 3))
        XCTAssertEqual(before, anchor.frame.minY, accuracy: 1)
        capture("viewport-reading", app: app)
        app.buttons["跳到最新消息"].tap()
        let last = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "新增尾部 ")).allElementsBoundByIndex.last
        capture("viewport-after-jump", app: app)
        XCTAssertTrue(last?.isHittable == true, "Latest text frame: \(String(describing: last?.frame)); viewport: \(transcript.frame)")
        refresh.tap()
        let newest = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "新增尾部 ")).allElementsBoundByIndex.last
        XCTAssertTrue(newest?.isHittable == true)
        XCTAssertFalse(app.buttons["跳到最新消息"].exists)
        capture("viewport-following", app: app)
    }

    func testNewMessagesAndToolsPreserveTheMovingReadingAnchor() {
        let app = launch("viewport", arguments: ["--preview-viewport-rows", "--preview-viewport-drag"])
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = app.scrollViews.firstMatch
        transcript.swipeDown()
        transcript.swipeDown()
        var readingAnchor: XCUIElement?
        let viewport = transcript.frame
        for _ in 0..<5 {
            readingAnchor = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 "))
                .allElementsBoundByIndex.first { $0.exists && $0.isHittable && $0.frame.minY > viewport.minY + 120 && $0.frame.maxY < viewport.maxY - 120 }
            if readingAnchor != nil { break }
            transcript.swipeDown()
        }
        guard let anchor = readingAnchor else { return XCTFail("No reading anchor inside the viewport") }
        let refresh = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "刷新 Git 工作分支")).firstMatch
        func drag(_ direction: Double) {
            let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
            let end = start.withOffset(CGVector(dx: 0, dy: direction * 70))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 3)
        }
        let calibrationStart = anchor.frame.minY
        drag(1)
        let manualDistance = anchor.frame.minY - calibrationStart
        XCTAssertGreaterThan(manualDistance, 30, "The injected gesture must actually scroll before testing concurrent updates")
        for direction in [-1.0, 1.0] {
            let before = anchor.frame.minY
            refresh.tap() // Six source patches arrive two seconds later, while the finger is held.
            drag(direction)
            XCTAssertEqual(anchor.frame.minY - before, direction * manualDistance, accuracy: 2,
                           "Only finger movement may displace the reading anchor; appended rows must not")
            let resting = anchor.frame.minY
            refresh.tap()
            // Wait for the delayed batch without sending another scroll gesture.
            RunLoop.current.run(until: Date().addingTimeInterval(3))
            XCTAssertEqual(anchor.frame.minY, resting, accuracy: 1)
        }
        XCTAssertTrue(app.buttons["跳到最新消息"].exists)
        app.buttons["跳到最新消息"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "ViewportTool")).firstMatch.waitForExistence(timeout: 3))
        capture("viewport-live-tools-and-manual-drag", app: app)
    }

    func testApprovalOverlayKeepsComposerStableWhileSubmitting() {
        let app = launch("approval")
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let allow = app.buttons["允许"]
        XCTAssertTrue(allow.waitForExistence(timeout: 3))
        XCTAssertTrue(allow.isHittable)
        let before = composer.frame
        allow.tap()
        XCTAssertEqual(before.minY, composer.frame.minY, accuracy: 1)
        XCTAssertEqual(before.height, composer.frame.height, accuracy: 1)
        capture("approval-submitting", app: app)
    }
    func testSettingsPriorityAndProviderSwitchConfirmation() {
        let app = launch("settings")
        let relay = app.descendants(matching: .any)["path-priority-relay"].firstMatch
        let p2p = app.descendants(matching: .any)["path-priority-p2p"].firstMatch
        XCTAssertTrue(relay.waitForExistence(timeout: 8))
        XCTAssertGreaterThan(relay.frame.minY, p2p.frame.minY)
        app.buttons["上移中继"].tap()
        XCTAssertLessThan(relay.frame.minY, p2p.frame.minY)
        app.buttons["供应商配置与切换"].tap()
        let team = app.buttons["provider-action-team"]
        XCTAssertTrue(team.waitForExistence(timeout: 5))
        team.tap()
        let dialog = app.descendants(matching: .any)["orbis-dialog"].firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 3))
        XCTAssertTrue(dialog.staticTexts["启用供应商"].exists)
        dialog.buttons["取消"].tap()
        XCTAssertTrue(team.waitForExistence(timeout: 3))
        team.tap()
        XCTAssertTrue(dialog.waitForExistence(timeout: 3)); dialog.buttons["确认"].tap()
        XCTAssertTrue(app.buttons["provider-action-official"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["provider-action-team"].exists)
        capture("providers-switch-complete", app: app)
        app.buttons["Pi供应商"].tap()
        let remove = app.buttons["provider-action-official"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5)); remove.tap()
        XCTAssertTrue(dialog.waitForExistence(timeout: 3))
        XCTAssertTrue(dialog.staticTexts["移除供应商"].exists)
        XCTAssertTrue(dialog.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "全局默认供应商")).firstMatch.exists)
        dialog.buttons["确认"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "显式供应商已更新")).firstMatch.waitForExistence(timeout: 5))
        capture("providers-pi", app: app)
    }
    func testBasicConnectionStatusAndDirectoryProviderMismatch() {
        for dark in [false, true] {
            let app = launch("status", dark: dark)
            XCTAssertTrue(app.staticTexts["当前连接"].waitForExistence(timeout: 8))
            for label in ["已连接", "连接方式", "端到端加密", "电脑", "配对状态"] {
                XCTAssertTrue(app.staticTexts[label].firstMatch.isHittable)
            }
            for label in ["电脑端诊断记录", "电脑端会话目录", "电脑端供应商", "统一状态模型", "电脑 Agent 服务", "本机 deviceId", "Host hostId", "Host 公钥指纹", "配对根密钥"] {
                XCTAssertFalse(app.staticTexts[label].exists)
            }
            XCTAssertFalse(app.buttons["原始事件"].exists)
            capture(dark ? "status-basic-dark" : "status-basic-light", app: app)
            app.buttons["设置"].tap()
            XCTAssertTrue(app.buttons["供应商配置与切换"].waitForExistence(timeout: 3))
            app.buttons["供应商配置与切换"].tap()
            XCTAssertTrue(app.buttons["provider-action-team"].waitForExistence(timeout: 5))
            app.terminate()
        }
        let drawer = launch("drawer")
        let filter = drawer.buttons["筛选会话：全部"]
        XCTAssertTrue(filter.waitForExistence(timeout: 8)); filter.tap()
        drawer.buttons["Codex 终端"].tap()
        let codexFilter = drawer.buttons["筛选会话：Codex 终端"]
        XCTAssertTrue(codexFilter.waitForExistence(timeout: 3)); codexFilter.tap()
        drawer.buttons["team"].tap()
        let session = drawer.buttons.matching(NSPredicate(format: "label CONTAINS %@", "优化聊天滚动与输入体验")).firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 3))
        // History rows browse the local cache; provider compatibility is checked
        // only when explicitly continuing the session on the computer.
        session.press(forDuration: 0.8)
        drawer.buttons["在电脑继续会话"].tap()
        let dialog = drawer.descendants(matching: .any)["orbis-dialog"].firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 3))
        XCTAssertTrue(dialog.staticTexts["需要切换 provider"].exists)
        capture("provider-mismatch", app: drawer)
        dialog.buttons["供应商设置"].tap()
        XCTAssertTrue(drawer.staticTexts["供应商"].waitForExistence(timeout: 3))
    }
    func testDrawerLongPressArchivesAndRestoresOnlyCheckedSessions() {
        let app = launch("drawer")
        let first = app.buttons["drawer-session-session-4"]
        let second = app.buttons["drawer-session-session-5"]
        XCTAssertTrue(first.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["会话操作"].exists)
        let selectionFrame = first.frame
        first.press(forDuration: 0.8)
        XCTAssertTrue(app.staticTexts["已选择 1 项"].exists)
        XCTAssertEqual(first.frame, selectionFrame, "长按选择不能移动或改变卡片大小")
        second.tap()
        XCTAssertTrue(app.staticTexts["已选择 2 项"].exists)
        first.tap()
        XCTAssertTrue(app.staticTexts["已选择 1 项"].exists)
        first.tap()
        capture("drawer-multiselect", app: app)
        app.buttons["归档选中会话"].tap()
        XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3))
        XCTAssertFalse(first.exists)
        XCTAssertFalse(second.exists)
        XCTAssertTrue(app.buttons["drawer-session-session-1"].exists)

        app.buttons["筛选会话：全部"].tap()
        app.buttons["查看已归档会话"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 3))
        first.press(forDuration: 0.8)
        second.tap()
        XCTAssertTrue(app.staticTexts["已选择 2 项"].exists)
        app.buttons["恢复选中会话"].tap()
        XCTAssertTrue(app.staticTexts["没有已归档的会话"].waitForExistence(timeout: 3))
        app.buttons["筛选会话：全部"].tap()
        app.buttons["查看未归档会话"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 3))
        XCTAssertTrue(second.exists)
    }

    func testDrawerSelectionClearsOnCancelSearchAndClose() {
        let app = launch("drawer", dark: true)
        let session = app.buttons["drawer-session-session-4"]
        XCTAssertTrue(session.waitForExistence(timeout: 8))
        session.press(forDuration: 0.8)
        app.buttons["退出多选"].tap()
        XCTAssertTrue(app.staticTexts["会话目录"].exists)
        session.press(forDuration: 0.8)
        let search = app.textFields["搜索会话或目录"]
        search.tap(); search.typeText("优化")
        XCTAssertFalse(app.buttons["归档选中会话"].exists)
        app.buttons["清除搜索"].tap()
        session.press(forDuration: 0.8)
        capture("drawer-multiselect-dark", app: app)
        // Closing the drawer with a swipe also ends selection.
        let window = app.windows.firstMatch
        let start = window.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.45))
        start.press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.45)))
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
        app.buttons["打开会话目录"].tap()
        XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["退出多选"].exists)
    }

    func testDrawerFollowsEdgeDragAndShowsOneDirectory() {
        let app = launch("home")
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 8))
        let window = app.windows.firstMatch
        let edge = window.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        edge.press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
        XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3))
        // Only the most recent directory opens, and it lists the five latest sessions.
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "收起目录")).count == 1)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "再显示 1 个会话")).firstMatch.waitForExistence(timeout: 3))
        capture("drawer-edge-open", app: app)
        let inside = window.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.45))
        inside.press(forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.45)))
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["会话目录"].exists)
    }

    func testDrawerCollapseShrinksContentWithoutAnotherDrag() {
        let app = launch("drawer", arguments: ["--preview-long-directory"])
        let expanded = app.buttons["收起目录 /Projects/orbis，24 个会话"]
        let collapsed = app.buttons["展开目录 /Projects/orbis，24 个会话"]
        let nextDirectory = app.buttons["展开目录 /Projects/website，1 个会话"]
        XCTAssertTrue(expanded.waitForExistence(timeout: 8))

        for _ in 0..<2 {
            expanded.tap()
            XCTAssertTrue(collapsed.waitForExistence(timeout: 3))
            XCTAssertTrue(nextDirectory.isHittable)
            XCTAssertEqual(nextDirectory.frame.minY - collapsed.frame.maxY, 14, accuracy: 2)
            capture("drawer-directory-collapsed", app: app)
            collapsed.tap()
            XCTAssertTrue(expanded.waitForExistence(timeout: 3))
        }

        let scroll = app.scrollViews.firstMatch
        let showMore = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "再显示 19 个会话")).firstMatch
        for _ in 0..<4 where !showMore.isHittable { scroll.swipeUp() }
        XCTAssertTrue(showMore.isHittable)
        showMore.tap()
        let showLess = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "收起较早会话")).firstMatch
        for _ in 0..<12 where !showLess.isHittable { scroll.swipeUp() }
        XCTAssertTrue(showLess.isHittable)
        showLess.tap()
        // Shrinking the list must clamp the old offset without requiring a corrective drag.
        XCTAssertTrue(showMore.waitForExistence(timeout: 3))
        XCTAssertTrue(showMore.isHittable)
        XCTAssertTrue(nextDirectory.isHittable)
        capture("drawer-older-sessions-collapsed", app: app)
    }

    func testDownloadCardsPauseResumeAndSelectWithoutSideButtons() {
        let app = launch("downloads")
        let path = app.textFields["download-path"]
        XCTAssertTrue(path.waitForExistence(timeout: 8))
        path.tap(); path.typeText("/preview/report.zip")
        app.buttons["按路径下载"].tap()
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "download-card-")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["取消下载"].exists)
        let active = NSPredicate(format: "label CONTAINS %@", "轻点暂停")
        let paused = NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "已暂停", "轻点继续")
        XCTAssertTrue(active.evaluate(with: card))
        let cardWidth = card.frame.width
        card.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: paused, object: card)], timeout: 3), .completed)
        XCTAssertEqual(card.frame.width, cardWidth)
        capture("download-card-paused", app: app)
        card.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: active, object: card)], timeout: 3), .completed)
        let selectionFrame = card.frame
        card.press(forDuration: 0.8)
        XCTAssertTrue(app.staticTexts["已选择 1 项"].waitForExistence(timeout: 3))
        XCTAssertEqual(card.frame, selectionFrame, "长按选择不能移动或改变卡片大小")
        capture("download-card-selection", app: app)
        card.tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        XCTAssertTrue(active.evaluate(with: card), "选择和取消选择不能暂停下载")
        capture("download-card-active", app: app)
    }

    func testPageScreenshotsInBothAppearances() {
        for dark in [false, true] {
            for screen in ["pairing", "home", "drawer", "chat", "status", "settings", "providers", "downloads", "approval"] {
                let app = launch(screen, dark: dark)
                XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
                let expected = screen == "pairing" ? "连接你的电脑" : screen == "status" ? "连接状态" : screen == "settings" ? "设置" : screen == "providers" ? "供应商" : screen == "downloads" ? "下载" : screen == "drawer" ? "会话目录" : screen == "approval" ? "允许执行验证命令" : "Codex"
                XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", expected)).firstMatch.waitForExistence(timeout: 5))
                capture(screen + (dark ? "-dark" : "-light"), app: app)
                app.terminate()
            }
        }
    }
    func testQueueCancellationNotificationsAndRuntimeFacts() {
        let app = launch("queue")
        let cancel = app.buttons["queue-cancel-preview-queue"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 8)); cancel.tap()
        XCTAssertTrue(app.staticTexts["完成后发送，已撤回"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["通知状态待核对"].waitForExistence(timeout: 5))
        capture("queue-notification", app: app)
        app.buttons["关闭通知"].firstMatch.tap()
        XCTAssertFalse(app.staticTexts["模型服务等待恢复，电脑端会继续核对。"].waitForExistence(timeout: 2))
        app.buttons["chat-title"].tap()
        XCTAssertTrue(app.staticTexts["模型与上下文"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["high"].exists)
        XCTAssertTrue(app.staticTexts["本轮耗时"].exists)
        capture("runtime-facts", app: app)
    }

    func testToolExportAndInteractionDraftSwitching() {
        let tool = launch("tool")
        XCTAssertTrue(tool.buttons["展开read，已完成"].waitForExistence(timeout: 8)); tool.buttons["展开read，已完成"].tap()
        tool.buttons["查看输出"].tap()
        XCTAssertTrue(tool.buttons["tool-export"].waitForExistence(timeout: 5)); tool.buttons["tool-export"].tap()
        XCTAssertTrue(tool.buttons["tool-export-share"].waitForExistence(timeout: 8))
        XCTAssertTrue(tool.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Sources checked: 18")).firstMatch.exists)
        capture("tool-export-complete", app: tool)
        tool.terminate()
        let interactions = launch("interactions")
        // SwiftUI's vertical TextField becomes a TextView after its first value.
        let input = interactions.descendants(matching: .any)["interaction-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 8)); input.tap(); input.typeText("保留输入草稿")
        interactions.buttons["确认下一步"].firstMatch.tap()
        interactions.buttons["填写验证说明"].firstMatch.tap()
        XCTAssertTrue((input.value as? String)?.contains("保留输入草稿") == true)
        capture("interaction-draft-restored", app: interactions)
    }

    func testTruncatedContentAndToolArguments() {
        let app = launch("truncated")
        XCTAssertTrue(app.buttons["展开read，已完成"].waitForExistence(timeout: 8))
        app.buttons["展开read，已完成"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "/repo/source.swift")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["已完成工具参数验证。"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "有内容因超长被截断")).firstMatch.exists)
        capture("tool-arguments-truncated", app: app)
        app.buttons["full-entry-truncated-message"].tap()
        XCTAssertTrue(app.staticTexts["完整返回内容：这条消息已按需从电脑取回。"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["复制完整内容"].isEnabled)
        capture("full-entry", app: app)
        app.terminate()
    }

}
