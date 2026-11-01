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
    private func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: element)
        return XCTWaiter().wait(for: [enabled], timeout: timeout) == .completed
    }
    /// Lets a short state transition (the capsule's 0.16 s fade) settle before a screenshot.
    private func settle() { _ = XCTWaiter().wait(for: [XCTestExpectation(description: "settle")], timeout: 0.5) }
    private func waitForY(_ element: XCUIElement, _ y: CGFloat, operation: String) {
        let position = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            element.exists && abs(element.frame.minY - y) <= 1
        }, object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [position], timeout: 5), .completed, operation)
        XCTAssertEqual(element.frame.minY, y, accuracy: 1, operation)
    }
    private func capture(_ name: String, app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways
        add(screenshot)
    }
    private func inkPixels(_ element: XCUIElement) -> Int {
        guard let image = element.screenshot().image.cgImage else { return -1 }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return -1 }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let background = Array(pixels.prefix(3))
        return stride(from: 0, to: pixels.count, by: 4).filter { offset in
            (0..<3).reduce(0) { $0 + abs(Int(pixels[offset + $1]) - Int(background[$1])) } > 90
        }.count
    }
    private func flightMetrics(_ button: XCUIElement) -> [String: String] {
        Dictionary(uniqueKeysWithValues: (button.value as? String ?? "").split(separator: ";").compactMap { part in
            let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
            return pair.count == 2 ? (pair[0], pair[1]) : nil
        })
    }

    func testClaudeNativeHandoffKeepsOneCopyAcrossConsecutiveTurns() {
        for dark in [false, true] {
            let app = launch("chat", dark: dark, arguments: ["--preview-claude-identity", "--preview-reduce-motion"])
            let reply = app.staticTexts["CLAUDE_IDENTITY_REPLY"]
            XCTAssertTrue(reply.waitForExistence(timeout: 10))
            XCTAssertEqual(app.staticTexts.matching(identifier: "CLAUDE_IDENTITY_REPLY").count, 1)
            let refresh = app.buttons["刷新"].firstMatch
            XCTAssertTrue(waitUntilEnabled(refresh, timeout: 10))
            refresh.tap()
            XCTAssertTrue(app.staticTexts["CLAUDE_IDENTITY_NEXT"].waitForExistence(timeout: 10))
            XCTAssertEqual(app.staticTexts.matching(identifier: "CLAUDE_IDENTITY_REPLY").count, 1)
            XCTAssertEqual(app.staticTexts.matching(identifier: "CLAUDE_IDENTITY_NEXT").count, 1)
            capture("claude-step-handoff-next-turn-\(dark)", app: app)
            XCTAssertTrue(waitUntilEnabled(refresh, timeout: 10))
            refresh.tap()
            settle()
            XCTAssertEqual(app.staticTexts.matching(identifier: "CLAUDE_IDENTITY_REPLY").count, 1)
            XCTAssertEqual(app.staticTexts.matching(identifier: "CLAUDE_IDENTITY_NEXT").count, 1)
            capture("claude-step-handoff-persisted-\(dark)", app: app)
            app.terminate()
        }
    }

    func testStreamingRevealAdvancesInOrderAcrossBlocks() {
        let app = launch("reveal")
        let next = app.buttons["reveal-next-frame"]
        XCTAssertTrue(next.waitForExistence(timeout: 8))
        next.tap(); next.tap(); next.tap()
        for label in ["SECOND", "THIRD", "FOURTH"] {
            let text = app.staticTexts[label]
            XCTAssertTrue(text.exists)
            XCTAssertEqual(inkPixels(text), 0, "\(label) painted before the preceding tail")
        }
        capture("streaming-one-cursor-before-second-block", app: app)
        next.tap() // Finishing the stream must let the queued tail drain.
        XCTAssertEqual(inkPixels(app.staticTexts["SECOND"]), 0)
        next.tap()
        for label in ["SECOND", "THIRD", "FOURTH"] { XCTAssertGreaterThan(inkPixels(app.staticTexts[label]), 10) }
        capture("streaming-one-cursor-finished", app: app)
    }

    func testStreamingRevealWithReducedMotionShowsEveryBlockImmediately() {
        let app = launch("reveal", arguments: ["--preview-reduce-motion"])
        let next = app.buttons["reveal-next-frame"]
        XCTAssertTrue(next.waitForExistence(timeout: 8))
        next.tap(); next.tap()
        for label in ["SECOND", "THIRD", "FOURTH"] { XCTAssertGreaterThan(inkPixels(app.staticTexts[label]), 10) }
        capture("streaming-reduced-motion-direct", app: app)
    }

    func testHomeTopShowsNewAndPromotedSessions() {
        let app = launch("home", arguments: ["--preview-home-long-list", "--preview-viewport-controls"])
        let first = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(first.waitForExistence(timeout: 8))
        let y = first.frame.minY
        app.buttons["preview-list-insert"].tap()
        let inserted = app.buttons["home-runtime-preview-new"]
        XCTAssertTrue(inserted.waitForExistence(timeout: 8))
        XCTAssertEqual(inserted.frame.minY, y, accuracy: 1)
        app.buttons["preview-list-promote"].tap()
        let promoted = app.buttons["home-runtime-preview-scroll-15"]
        XCTAssertTrue(promoted.waitForExistence(timeout: 8))
        XCTAssertEqual(promoted.frame.minY, y, accuracy: 1)
        capture("home-top-after-insert-and-promote", app: app)
    }

    func testHomeScrolledAnchorSurvivesInsertionAndReordering() {
        let app = launch("home", arguments: ["--preview-home-long-list", "--preview-viewport-controls"])
        XCTAssertTrue(app.buttons["home-runtime-preview-codex"].waitForExistence(timeout: 8))
        let list = app.scrollViews["home-session-list"]
        list.swipeUp()
        let cards = (4...14).map { app.buttons["home-runtime-preview-scroll-\($0)"] }
        guard let anchor = cards.first(where: { $0.exists && $0.isHittable && $0.frame.minY >= list.frame.minY && $0.frame.maxY <= list.frame.maxY }) else {
            return XCTFail("No complete reading anchor")
        }
        let y = anchor.frame.minY
        for operation in ["insert", "promote", "remove"] {
            app.buttons["preview-list-" + operation].tap()
            settle()
            XCTAssertEqual(anchor.frame.minY, y, accuracy: 1, operation)
        }
        capture("home-scrolled-anchor-after-updates", app: app)
    }

    func testDrawerScrolledSessionsKeepTheirPositionDuringCatalogUpdates() {
        let app = launch("drawer", arguments: ["--preview-long-directory", "--preview-viewport-controls"])
        let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "再显示")).firstMatch
        XCTAssertTrue(more.waitForExistence(timeout: 8))
        more.tap()
        let list = app.scrollViews["drawer-session-list"]
        list.swipeUp()
        let cards = (4...25).map { app.buttons["drawer-session-session-\($0)"] }
        capture("drawer-session-anchor-before-updates", app: app)
        guard let anchor = cards.first(where: { $0.exists && $0.frame.minY >= list.frame.minY && $0.frame.maxY <= list.frame.maxY }) else {
            return XCTFail("No complete directory session anchor: list=\(list.frame), cards=\(cards.filter(\.exists).map { $0.frame })")
        }
        let y = anchor.frame.minY
        for operation in ["insert", "promote", "remove"] {
            app.buttons["preview-list-" + operation].tap(); settle()
            waitForY(anchor, y, operation: operation)
        }
        capture("drawer-session-anchor-after-updates", app: app)
    }

    func testDrawerTopKeepsNewAndPromotedDirectoriesVisible() {
        let app = launch("drawer", arguments: ["--preview-long-directory", "--preview-many-directories", "--preview-viewport-controls"])
        let first = app.buttons["drawer-directory-/Projects/test-1"]
        XCTAssertTrue(first.waitForExistence(timeout: 8))
        let y = first.frame.minY
        app.buttons["preview-list-insert"].tap(); settle()
        let added = app.buttons["drawer-directory-/Projects/new"]
        XCTAssertTrue(added.waitForExistence(timeout: 8))
        waitForY(added, y, operation: "insert directory")
        app.buttons["preview-list-promote"].tap(); settle()
        waitForY(app.buttons["drawer-directory-/Projects/test-15"], y, operation: "promote directory")
        capture("drawer-top-after-directory-updates", app: app)
    }
    func testNativeTurnFileReviewShowsSourceAndReadsOnlySelectedDetail() {
        let app = launch("changes", arguments: ["--preview-native-file-changes"])
        let open = app.buttons["turn-changes-open-preview-review"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["仅记录 Codex 文件工具变更"].exists)
        XCTAssertEqual(app.staticTexts["change-detail-requests"].label, "reads=0,0,0")
        capture("native-turn-change-summary", app: app)
        open.tap()
        XCTAssertTrue(app.staticTexts["+CHANGE_FIRST"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["范围：Codex 文件工具"].exists)
        XCTAssertEqual(app.staticTexts.matching(identifier: "change-detail-requests").allElementsBoundByIndex.last?.label, "reads=1,0,0")
        capture("native-turn-change-detail", app: app)
    }
    func testTurnFileReviewLoadsOnlySelectedFilesAndRetainsCache() {
        let app = launch("changes")
        let open = app.buttons["turn-changes-open-preview-review"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["change-detail-requests"].label, "reads=0,0,0")
        // One compact block after the turn's last row, although the Host anchored it on the first of
        // five steps: the header opens the viewer, then one single-line row per file.
        XCTAssertTrue(open.label.contains("3 个文件已更改"))
        XCTAssertEqual(app.buttons.matching(identifier: "turn-changes-open-preview-review").count, 1)
        XCTAssertGreaterThanOrEqual(app.staticTexts["已完成本轮文件修改。"].frame.minY, app.staticTexts["测试通过。"].frame.maxY)
        XCTAssertGreaterThanOrEqual(open.frame.minY, app.staticTexts["已完成本轮文件修改。"].frame.maxY)
        let rows = ["change-1", "change-2", "change-3"].map { app.buttons["turn-change-file-" + $0].frame }
        XCTAssertGreaterThanOrEqual(rows[0].minY, open.frame.maxY)
        for (above, below) in zip(rows, rows.dropFirst()) { XCTAssertGreaterThanOrEqual(below.minY, above.maxY - 0.5) }
        for row in rows { XCTAssertLessThanOrEqual(row.height, 44) }
        XCTAssertTrue(app.staticTexts["二进制"].exists)
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
    func testTurnFileReviewOnlyHeaderPullCloses() {
        let app = launch("changes")
        let open = app.buttons["turn-changes-open-preview-review"]
        XCTAssertTrue(open.waitForExistence(timeout: 10)); open.tap()
        XCTAssertTrue(app.staticTexts["+CHANGE_FIRST"].waitForExistence(timeout: 5))
        let pager = app.otherElements["turn-change-pager"]
        // Reading back past the diff's top, repeatedly and fast, only bounces inside the diff.
        pager.swipeUp(velocity: .fast)
        for _ in 0..<3 { pager.swipeDown(velocity: .fast) }
        // So does a long pull on the non-scrolling footer.
        let footer = app.staticTexts["turn-change-page"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        footer.press(forDuration: 0.05, thenDragTo: footer.withOffset(CGVector(dx: 0, dy: 300)))
        XCTAssertFalse(pager.waitForNonExistence(timeout: 1))
        XCTAssertTrue(pager.exists)
        XCTAssertTrue(app.staticTexts["+CHANGE_FIRST"].isHittable)
        XCTAssertEqual(app.staticTexts["turn-change-page"].label, "1 / 3")
        capture("turn-change-body-pull-stays-open", app: app)
        let title = app.staticTexts["本轮文件差异"]
        let grip = title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        // A short header pull springs back.
        grip.press(forDuration: 0.05, thenDragTo: grip.withOffset(CGVector(dx: 0, dy: 60)), withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertFalse(pager.waitForNonExistence(timeout: 1))
        XCTAssertTrue(title.isHittable)
        // A long header pull closes the card.
        grip.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        XCTAssertTrue(pager.waitForNonExistence(timeout: 5))
        XCTAssertTrue(open.isHittable)
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
        // Large text and reduced motion keep the same close rules.
        let pager = app.otherElements["turn-change-pager"]
        pager.swipeDown(velocity: .fast)
        XCTAssertFalse(pager.waitForNonExistence(timeout: 1))
        let grip = app.staticTexts["本轮文件差异"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        grip.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        XCTAssertTrue(pager.waitForNonExistence(timeout: 5))
        XCTAssertTrue(open.isHittable)
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
    func testCompactionStatusInHomeChatAndDrawer() {
        for dark in [false, true] {
            let app = launch("home", dark: dark, arguments: ["--preview-compacting", "--preview-slow-sync"])
            let card = app.buttons["home-runtime-preview-codex"]
            XCTAssertTrue(card.waitForExistence(timeout: 10))
            XCTAssertTrue(card.staticTexts["压缩中"].exists)
            capture("compaction-home-\(dark ? "dark" : "light")", app: app)
            card.tap()
            let title = app.descendants(matching: .any)["chat-title"].firstMatch
            XCTAssertTrue(title.waitForExistence(timeout: 8))
            XCTAssertTrue(title.label.contains("压缩中"))
            let refresh = app.buttons["刷新"].firstMatch
            let ready = NSPredicate(format: "enabled == true")
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: refresh)], timeout: 15), .completed)
            let frame = title.frame
            refresh.tap()
            XCTAssertTrue(title.label.contains("压缩中"))
            XCTAssertEqual(frame, title.frame)
            capture("compaction-chat-\(dark ? "dark" : "light")", app: app)
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: refresh)], timeout: 15), .completed)
            XCTAssertEqual(frame, title.frame)
            app.buttons["返回"].firstMatch.tap()
            app.buttons["打开会话目录"].tap()
            XCTAssertTrue(app.staticTexts["压缩中"].firstMatch.waitForExistence(timeout: 5))
            capture("compaction-drawer-\(dark ? "dark" : "light")", app: app)
            app.terminate()
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

    /// V12 r27 / ADR-0049 §6.7：选择模型后立即显示所选值并带“切换中”，确认前不声称已生效；顶栏不位移（V05）。
    func testModelSwitchShowsTheChoiceWithItsMarkWithoutMovingTheHeader() {
        let app = launch("chat", arguments: ["--preview-model-switch"])
        let title = app.descendants(matching: .any)["chat-title"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        let before = title.frame
        // 夹具在聊天页出现约 3 秒后发起切换；电脑端只回执、不改模型，选择停在“切换中”。
        RunLoop.current.run(until: Date().addingTimeInterval(4.5))
        XCTAssertEqual(title.frame.minY, before.minY, accuracy: 1)
        XCTAssertEqual(title.frame.height, before.height, accuracy: 1)
        capture("model-switching-header", app: app)
        // V10 r27 / §6.2：切换中发送的消息立即出现并清空输入，标明在等模型切换。
        let text = "等模型切好再发"
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        composer.tap(); composer.typeText(text)
        app.buttons["发送消息"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1))
        XCTAssertTrue(app.staticTexts["等待模型切换"].waitForExistence(timeout: 1))
        XCTAssertEqual((composer.value as? String)?.contains(text), false)
        capture("model-switching-waiting-send", app: app)
        title.tap()
        let fact = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "默认模型（切换中）")).firstMatch
        XCTAssertTrue(fact.waitForExistence(timeout: 3))
        capture("model-switching-facts", app: app)
    }

    /// V10 r27 / ADR-0049 §6.1–§6.2：附件还在上传时发送，气泡立即出现并带着附件（缩略图、文件名、进度），
    /// 输入框清空；上传完成后正文与附件一起提交，权威行替换本地行。
    func testSendingWhileUploadingShowsTheAttachmentInTheBubbleAndSubmitsTogether() {
        let app = launch("chat", arguments: ["--preview-upload-waiting"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        // 夹具在输入框挂上一个上传中的图片。
        XCTAssertTrue(app.buttons["移除附件 截图.png"].waitForExistence(timeout: 5))
        let text = "看看这张截图"
        composer.tap(); composer.typeText(text)
        let send = app.buttons["发送消息"].firstMatch
        XCTAssertTrue(waitUntilEnabled(send, timeout: 2), "附件上传中也可以发送")
        send.tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1))
        // 气泡的标识会覆盖子元素的标识，附件按合并后的辅助功能标签查找（“文件名, 状态”）。
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "截图.png, ")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 1))
        XCTAssertTrue(chip.label.contains("截图.png"), chip.label)
        XCTAssertTrue(chip.label.contains("上传中"), chip.label)
        XCTAssertFalse(app.buttons["移除附件 截图.png"].exists, "附件随消息离开输入框")
        XCTAssertEqual((composer.value as? String)?.contains(text), false)
        let waiting = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "上传中：截图.png")).firstMatch
        XCTAssertTrue(waiting.exists)
        capture("upload-waiting-bubble", app: app)
        let progressed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "90%"), object: chip)
        XCTAssertEqual(XCTWaiter().wait(for: [progressed], timeout: 5), .completed, "气泡内进度随上传推进")
        capture("upload-waiting-progress", app: app)
        let committed = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "orbis-uploads/aaaa/截图.png")).firstMatch
        XCTAssertTrue(committed.waitForExistence(timeout: 6), "上传完成后正文与附件一起提交")
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: waiting)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 3), .completed)
        // 权威行的正文带上了附件路径；本地行已被替换，这句话只出现一次。
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", text)).count, 1, "权威行替换本地行，只出现一次")
        capture("upload-waiting-committed", app: app)
    }

    /// V10 r27 / ADR-0049 §6.2：上传失败只让所属消息转失败并写明附件，后面的纯文本按顺序继续提交；
    /// “放回输入框”让正文与附件一起回到输入框。
    func testFailedUploadFailsOnlyItsMessageAndRestoreReturnsTextAndAttachment() {
        let app = launch("chat", arguments: ["--preview-upload-waiting=fail"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["移除附件 截图.png"].waitForExistence(timeout: 5))
        let first = "带附件的消息", second = "后面这条纯文本"
        let send = app.buttons["发送消息"].firstMatch
        composer.tap(); composer.typeText(first)
        XCTAssertTrue(waitUntilEnabled(send, timeout: 2)); send.tap()
        XCTAssertTrue(app.staticTexts[first].waitForExistence(timeout: 1))
        composer.typeText(second)
        XCTAssertTrue(waitUntilEnabled(send, timeout: 2)); send.tap()
        XCTAssertTrue(app.staticTexts[second].waitForExistence(timeout: 1))
        XCTAssertTrue(app.staticTexts["等待前一条发送"].waitForExistence(timeout: 1), "后一条不越过前一条")
        capture("upload-fail-ordered", app: app)
        let failure = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "附件上传失败：截图.png")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 8))
        let ordered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["等待前一条发送"])
        XCTAssertEqual(XCTWaiter().wait(for: [ordered], timeout: 3), .completed, "附件失败只影响所属消息，后面的继续提交")
        capture("upload-fail-only-its-message", app: app)
        let restore = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "pending-restore-")).firstMatch
        XCTAssertTrue(restore.waitForExistence(timeout: 2))
        restore.tap()
        XCTAssertTrue(app.buttons["移除附件 截图.png"].waitForExistence(timeout: 2), "附件回到输入框")
        XCTAssertEqual((composer.value as? String)?.contains(first), true, "正文回到输入框")
        XCTAssertFalse(failure.exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", second)).count, 1)
        capture("upload-fail-restored", app: app)
    }

    /// A1–A4（V07、V12、V22）：回答摘要、启动中与启动失败原位在浅 / 深色、XXXL、减少动画下语义一致，截图供 L4 审阅。
    func testOptimisticStatesAcrossAppearances() {
        let appearances: [(String, Bool, [String])] = [
            ("light", false, []),
            ("dark", true, []),
            ("xxxl", false, ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]),
            ("reduce-motion", false, ["--preview-reduce-motion"]),
        ]
        for (name, dark, options) in appearances {
            let approval = launch("approval", dark: dark, arguments: options)
            let allow = approval.buttons["允许"]
            XCTAssertTrue(allow.waitForExistence(timeout: 8), name)
            let composer = approval.descendants(matching: .any)["chat-composer"].firstMatch
            let before = composer.frame
            allow.tap()
            let status = approval.descendants(matching: .any)["interaction-status"].firstMatch
            XCTAssertTrue(status.waitForExistence(timeout: 2), name)
            XCTAssertTrue(status.label.contains("已允许"), name)
            XCTAssertEqual(composer.frame.minY, before.minY, accuracy: 1, name)
            capture("optimistic-respond-" + name, app: approval)
            approval.terminate()

            let home = launch("home", dark: dark, arguments: ["--preview-launch-fail"] + options)
            XCTAssertTrue(home.buttons["打开会话目录"].waitForExistence(timeout: 8), name)
            home.buttons["打开会话目录"].tap()
            XCTAssertTrue(home.staticTexts["会话目录"].waitForExistence(timeout: 3), name)
            home.buttons["新会话"].tap()
            let create = home.buttons["在这里新建 Pi 会话"]
            XCTAssertTrue(create.waitForExistence(timeout: 3), name)
            create.tap()
            let starting = home.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "启动中")).firstMatch
            XCTAssertTrue(starting.waitForExistence(timeout: 2), name)
            capture("optimistic-launch-starting-" + name, app: home)
            let failure = home.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "启动失败")).firstMatch
            XCTAssertTrue(failure.waitForExistence(timeout: 5), name)
            XCTAssertTrue(home.buttons["launch-retry"].isHittable, name)
            XCTAssertTrue(home.buttons["launch-back"].isHittable, name)
            capture("optimistic-launch-failed-" + name, app: home)
            home.terminate()

            // 上传中发送：气泡内的缩略图、文件名与进度在各外观下完整显示（V10 r27）。
            let chat = launch("chat", dark: dark, arguments: ["--preview-upload-waiting"] + options)
            let chatComposer = chat.descendants(matching: .any)["chat-composer"].firstMatch
            XCTAssertTrue(chatComposer.waitForExistence(timeout: 8), name)
            XCTAssertTrue(chat.buttons["移除附件 截图.png"].waitForExistence(timeout: 5), name)
            chatComposer.tap(); chatComposer.typeText("看图")
            let send = chat.buttons["发送消息"].firstMatch
            XCTAssertTrue(waitUntilEnabled(send, timeout: 2), name)
            send.tap()
            let chip = chat.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "截图.png, ")).firstMatch
            XCTAssertTrue(chip.waitForExistence(timeout: 2), name)
            XCTAssertTrue(chip.frame.width > 0 && chip.frame.maxX <= chat.frame.maxX + 1, name)
            capture("optimistic-upload-waiting-" + name, app: chat)
            chat.terminate()
        }
    }

    /// V12 r27 / ADR-0049 §6.8：确认新建后立即进入聊天页并显示“启动中”，输入框可用；Host 拒绝时在原位说明，
    /// “重试”用同一目标发起新请求，“返回”回到首页。
    func testNewSessionEntersChatAtOnceAndFailureOffersRetryInPlace() {
        let app = launch("home", arguments: ["--preview-launch-fail"])
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 8))
        app.buttons["打开会话目录"].tap()
        XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3))
        app.buttons["新会话"].tap()
        let create = app.buttons["在这里新建 Pi 会话"]
        XCTAssertTrue(create.waitForExistence(timeout: 3))
        create.tap()
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 2), "The chat page must open before the Host answers")
        let starting = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "启动中")).firstMatch
        XCTAssertTrue(starting.waitForExistence(timeout: 1))
        let title = app.descendants(matching: .any)["chat-title"].firstMatch
        XCTAssertTrue(title.label.contains("Projects"), title.label)
        XCTAssertFalse(title.label.contains("launch:"), title.label)
        capture("launch-starting", app: app)
        // OrbisNotice 把图标和文字合成一个辅助功能元素，按任意类型查找。
        let failure = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "启动失败：对应的 agent 后端未就绪")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["launch-retry"].isHittable)
        XCTAssertTrue(app.buttons["launch-back"].isHittable)
        capture("launch-failed", app: app)
        app.buttons["launch-retry"].tap()
        XCTAssertTrue(starting.waitForExistence(timeout: 1))
        XCTAssertFalse(failure.exists, "Retrying starts a new request in place")
        XCTAssertTrue(failure.waitForExistence(timeout: 5))
        app.buttons["launch-back"].tap()
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
        XCTAssertFalse(composer.exists)
    }
    /// V10 / V12 r27（ADR-0049 §6.2、§6.8）：启动中写的消息立即出现并标明“等待会话启动”，输入框清空；
    /// 会话上线后切到真实会话，消息按 Host 身份落地且只出现一次。
    func testSendingWhileTheSessionStartsWaitsAndSubmitsOnceItIsOnline() {
        let app = launch("home", arguments: ["--preview-launch-slow"])
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 8))
        app.buttons["打开会话目录"].tap()
        XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3))
        app.buttons["新会话"].tap()
        let create = app.buttons["在这里新建 Pi 会话"]
        XCTAssertTrue(create.waitForExistence(timeout: 3))
        create.tap()
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 2))
        let starting = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "启动中")).firstMatch
        XCTAssertTrue(starting.waitForExistence(timeout: 1))
        let text = "启动中就发出的消息"
        composer.tap(); composer.typeText(text)
        let send = app.buttons["发送消息"].firstMatch
        XCTAssertTrue(waitUntilEnabled(send, timeout: 2), "启动中也可以发送")
        send.tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1))
        XCTAssertTrue(app.staticTexts["等待会话启动"].waitForExistence(timeout: 1))
        XCTAssertEqual((composer.value as? String)?.contains(text), false)
        capture("launch-waiting-send", app: app)
        // 夹具在出现等待中的消息 3 秒后让会话上线；输入框保持焦点，上线后直接接着输入。
        let online = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["等待会话启动"])
        XCTAssertEqual(XCTWaiter().wait(for: [online], timeout: 8), .completed, "会话上线后写入通道")
        let title = app.descendants(matching: .any)["chat-title"].firstMatch
        let switched = XCTNSPredicateExpectation(predicate: NSPredicate(format: "NOT (label CONTAINS %@)", "启动中"), object: title)
        XCTAssertEqual(XCTWaiter().wait(for: [switched], timeout: 3), .completed, title.label)
        let field = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 2))
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertEqual(field.value(forKey: "hasKeyboardFocus") as? Bool, true, "会话上线后输入框保持焦点")
        field.typeText("继续输入")
        XCTAssertEqual((field.value as? String)?.contains("继续输入"), true, "上线后不用重新点输入框就能继续输入")
        let landed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 1"), object: app.staticTexts.matching(NSPredicate(format: "label == %@", text)))
        XCTAssertEqual(XCTWaiter().wait(for: [landed], timeout: 3), .completed)
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 0"),
                                                object: app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "pending-status-")))
        XCTAssertEqual(XCTWaiter().wait(for: [settled], timeout: 5), .completed, "权威行替换本地行")
        capture("launch-waiting-landed", app: app)
    }
    func testNewSessionOffersLaunchableDeepSeekBeforeBackendIsReady() {
        let appearances: [(String, Bool, [String])] = [
            ("light", false, []),
            ("dark", true, []),
            ("xxxl", false, ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]),
            ("reduce-motion", false, ["--preview-reduce-motion"]),
        ]
        for (name, dark, options) in appearances {
            let app = launch("home", dark: dark, arguments: ["--preview-launchable-dsh"] + options)
            XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 8), name)
            app.buttons["打开会话目录"].tap()
            XCTAssertTrue(app.staticTexts["会话目录"].waitForExistence(timeout: 3), name)
            app.buttons["新会话"].tap()
            let deepSeek = app.buttons.matching(NSPredicate(format: "label == %@", "DeepSeek, DeepSeek")).firstMatch
            XCTAssertTrue(deepSeek.waitForExistence(timeout: 3), name)
            XCTAssertTrue(deepSeek.isEnabled, name)
            deepSeek.tap()
            XCTAssertTrue(app.buttons["在这里新建 DeepSeek 会话"].waitForExistence(timeout: 3), name)
            capture("new-session-launchable-deepseek-\(name)", app: app)
            app.terminate()
        }
    }
    func testHomeKeepsCardsAfterDirectoryReplay() {
        let app = launch("home", arguments: ["--preview-home-replay"])
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["局域网"].waitForExistence(timeout: 8))
        XCTAssertTrue(card.exists)
        XCTAssertTrue(app.buttons["home-runtime-preview-pi"].exists)
        XCTAssertFalse(app.staticTexts["正在加载会话…"].exists)
        capture("home-after-directory-replay", app: app)
    }
    func testHomePublishesCompleteSnapshotsWithoutReturningToLoading() {
        let app = launch("home", arguments: ["--preview-home-staged"])
        let preparing = app.staticTexts["正在加载会话…"]
        let syncing = app.staticTexts["正在同步"]
        let pill = app.descendants(matching: .any)["home-connection-pill"].firstMatch
        let list = app.scrollViews["home-session-list"]
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(preparing.waitForExistence(timeout: 3))
        XCTAssertTrue(list.exists)
        // No status row between the computer row and the list: first-load status lives in the list area.
        XCTAssertLessThanOrEqual(list.frame.minY - pill.frame.maxY, 10)
        XCTAssertGreaterThanOrEqual(preparing.frame.minY, list.frame.minY)
        XCTAssertFalse(syncing.exists)
        let listFrame = list.frame
        XCTAssertFalse(app.descendants(matching: .any)["home-session-preparing"].exists)
        XCTAssertFalse(app.staticTexts["暂无在线会话"].exists)
        XCTAssertFalse(card.exists)
        capture("home-list-initial-loading", app: app)
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["home-runtime-preview-pi"].exists)
        XCTAssertTrue(app.buttons["home-runtime-preview-dsh"].exists)
        XCTAssertFalse(preparing.exists)
        XCTAssertEqual(list.frame, listFrame)
        XCTAssertLessThanOrEqual(card.frame.minY - list.frame.minY, 16)
        let cardFrame = card.frame
        // Background sync after publication stays in the connection capsule; cards keep their place.
        XCTAssertTrue(syncing.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["对齐移动端的使用体验"].exists)
        XCTAssertFalse(preparing.exists)
        XCTAssertEqual(list.frame, listFrame)
        XCTAssertEqual(card.frame.minY, cardFrame.minY, accuracy: 0.5)
        XCTAssertFalse(app.staticTexts["暂无在线会话"].exists)
        XCTAssertFalse(app.staticTexts["状态待核对"].exists)
        settle(); capture("home-pill-background-sync", app: app)
        XCTAssertTrue(app.staticTexts["已完整切换的会话"].waitForExistence(timeout: 12))
        XCTAssertTrue(card.isEnabled)
        XCTAssertFalse(preparing.exists)
        XCTAssertFalse(syncing.exists)
        XCTAssertTrue(app.staticTexts["局域网"].exists)
        XCTAssertEqual(list.frame, listFrame)
        // The replaced session may re-sort; the list itself still starts at the same place.
        let topCard = ["preview-codex", "preview-pi", "preview-dsh"].map { app.buttons["home-runtime-\($0)"].frame.minY }.min()
        XCTAssertEqual(topCard ?? 0, cardFrame.minY, accuracy: 0.5)
        settle(); capture("home-pill-sync-completed", app: app)
    }
    func testHomeRetriesFailedBackgroundRuntime() {
        let app = launch("home", arguments: ["--preview-home-read-failure"])
        let retry = app.buttons["重新加载会话"]
        XCTAssertTrue(retry.waitForExistence(timeout: 8))
        let list = app.scrollViews["home-session-list"]
        XCTAssertTrue(list.exists)
        let listFrame = list.frame
        // Nothing is published yet, so the failure takes the empty list's place, not a row above it.
        let message = app.staticTexts["会话状态读取失败，请重试"]
        XCTAssertTrue(message.exists)
        XCTAssertGreaterThanOrEqual(message.frame.minY, list.frame.minY)
        XCTAssertFalse(app.staticTexts["同步失败"].exists)
        XCTAssertFalse(app.staticTexts["暂无在线会话"].exists)
        capture("home-session-read-failure", app: app)
        retry.tap()
        XCTAssertTrue(app.buttons["home-runtime-preview-codex"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["home-runtime-preview-pi"].exists)
        XCTAssertFalse(retry.exists)
        XCTAssertFalse(message.exists)
        XCTAssertEqual(list.frame, listFrame)
        capture("home-session-read-recovered", app: app)
    }
    func testHomeBackgroundSyncFailureStaysInConnectionPill() {
        let app = launch("home", arguments: ["--preview-home-background-failure"])
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 8))
        let list = app.scrollViews["home-session-list"]
        let listFrame = list.frame, cardFrame = card.frame
        let failed = app.staticTexts["同步失败"]
        XCTAssertTrue(failed.waitForExistence(timeout: 8))
        let retry = app.buttons["重新加载会话"]
        XCTAssertTrue(retry.exists)
        XCTAssertTrue(retry.isHittable)
        XCTAssertGreaterThanOrEqual(retry.frame.height, 48)
        XCTAssertGreaterThanOrEqual(retry.frame.width, 48)
        XCTAssertLessThanOrEqual(retry.frame.maxY, list.frame.minY + 1)
        XCTAssertFalse(app.staticTexts["会话状态读取失败，请重试"].exists)
        XCTAssertEqual(list.frame, listFrame)
        XCTAssertEqual(card.frame.minY, cardFrame.minY, accuracy: 0.5)
        XCTAssertFalse(app.buttons["home-runtime-preview-pi"].isEnabled)
        settle(); capture("home-pill-sync-failed", app: app)
        retry.tap()
        XCTAssertTrue(waitUntilEnabled(app.buttons["home-runtime-preview-pi"], timeout: 8))
        XCTAssertFalse(failed.exists)
        XCTAssertFalse(retry.exists)
        XCTAssertEqual(list.frame, listFrame)
        XCTAssertEqual(card.frame.minY, cardFrame.minY, accuracy: 0.5)
        settle(); capture("home-pill-sync-recovered", app: app)
    }
    func testHomeInlineStatusInDarkAndLargeText() {
        for (name, dark, category) in [("dark", true, "UICTContentSizeCategoryL"),
                                       ("large", false, "UICTContentSizeCategoryXXXL")] {
            let textSize = ["-UIPreferredContentSizeCategoryName", category]
            let app = launch("home", dark: dark, arguments: ["--preview-home-staged"] + textSize)
            let loading = app.staticTexts["正在加载会话…"]
            let list = app.scrollViews["home-session-list"]
            XCTAssertTrue(loading.waitForExistence(timeout: 3))
            XCTAssertTrue(loading.isHittable)
            XCTAssertTrue(list.exists)
            let listFrame = list.frame
            XCTAssertGreaterThanOrEqual(loading.frame.minY, listFrame.minY)
            capture("home-list-loading-\(name)", app: app)
            XCTAssertTrue(app.buttons["home-runtime-preview-codex"].waitForExistence(timeout: 15))
            XCTAssertTrue(app.staticTexts["正在同步"].waitForExistence(timeout: 4))
            settle(); capture("home-pill-syncing-\(name)", app: app)
            XCTAssertEqual(list.frame, listFrame)
            app.terminate()

            let failed = launch("home", dark: dark, arguments: ["--preview-home-read-failure"] + textSize)
            let retry = failed.buttons["重新加载会话"]
            XCTAssertTrue(retry.waitForExistence(timeout: 8))
            XCTAssertTrue(retry.isHittable)
            XCTAssertGreaterThanOrEqual(retry.frame.height, 48)
            XCTAssertGreaterThanOrEqual(retry.frame.width, 48)
            capture("home-list-error-\(name)", app: failed)
            retry.tap()
            XCTAssertTrue(failed.buttons["home-runtime-preview-codex"].waitForExistence(timeout: 8))
            XCTAssertEqual(failed.scrollViews["home-session-list"].frame, listFrame)
            failed.terminate()

            let background = launch("home", dark: dark, arguments: ["--preview-home-background-failure"] + textSize)
            let pillRetry = background.buttons["重新加载会话"]
            XCTAssertTrue(background.staticTexts["同步失败"].waitForExistence(timeout: 10))
            XCTAssertTrue(pillRetry.isHittable)
            XCTAssertGreaterThanOrEqual(pillRetry.frame.height, 48)
            XCTAssertGreaterThanOrEqual(pillRetry.frame.width, 48)
            XCTAssertEqual(background.scrollViews["home-session-list"].frame, listFrame)
            settle(); capture("home-pill-error-\(name)", app: background)
            background.terminate()
        }
    }
    func testHomeVerticalDragsScrollFromCardsAndKeepSelection() {
        let app = launch("home", arguments: ["--preview-home-long-list"])
        let list = app.scrollViews["home-session-list"]
        let codex = app.buttons["home-runtime-preview-codex"]
        let pi = app.buttons["home-runtime-preview-pi"]
        XCTAssertTrue(codex.waitForExistence(timeout: 8))
        XCTAssertTrue(pi.isHittable)
        let original = codex.frame
        let piY = pi.frame.minY
        let start = pi.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -12, dy: -140)))
        XCTAssertLessThan(pi.frame.minY, piY - 60, "从卡片起手的竖向拖动必须滚动会话列表")
        XCTAssertFalse(app.staticTexts["会话目录"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["chat-composer"].firstMatch.exists)
        XCTAssertEqual(pi.frame.minX, original.minX, accuracy: 1, "竖拖不能显露关闭区")
        let movedY = pi.frame.minY
        let down = list.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.45))
        down.press(forDuration: 0.05, thenDragTo: down.withOffset(CGVector(dx: 12, dy: 140)))
        XCTAssertGreaterThan(pi.frame.minY, movedY + 60, "向下拖动必须返回较早的会话")
        XCTAssertTrue(codex.isHittable)
        capture("home-list-scrolled-back", app: app)

        codex.press(forDuration: 0.8)
        XCTAssertTrue(app.staticTexts["已选择 1 项"].waitForExistence(timeout: 3))
        let selectingY = pi.frame.minY
        let selectingStart = pi.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        selectingStart.press(forDuration: 0.05, thenDragTo: selectingStart.withOffset(CGVector(dx: 0, dy: -140)))
        XCTAssertLessThan(pi.frame.minY, selectingY - 60, "多选时仍可上下滚动")
        XCTAssertTrue(app.staticTexts["已选择 1 项"].exists)
        XCTAssertFalse(app.staticTexts["会话目录"].exists)
        capture("home-list-selection-scrolled", app: app)
    }
    func testHomeLongListScrollsToEndInBothAppearances() {
        for dark in [false, true] {
            let textSize = dark ? ["-UIPreferredContentSizeCategoryName", UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue] : []
            let app = launch("home", dark: dark, arguments: ["--preview-home-long-list"] + textSize)
            let list = app.scrollViews["home-session-list"]
            XCTAssertTrue(app.buttons["home-runtime-preview-codex"].waitForExistence(timeout: 8))
            let last = app.buttons["home-runtime-preview-scroll-15"]
            for _ in 0..<8 where !last.isHittable { list.swipeUp() }
            XCTAssertTrue(last.isHittable, "会话列表必须能够滚到最后一项")
            XCTAssertFalse(app.staticTexts["会话目录"].exists)
            capture("home-list-bottom-\(dark ? "dark-xxxl" : "light")", app: app)
            let closeStart = last.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
            closeStart.press(forDuration: 0.05, thenDragTo: closeStart.withOffset(CGVector(dx: -last.frame.width * 0.6, dy: 0)))
            XCTAssertTrue(last.waitForNonExistence(timeout: 5), "滚动后左滑仍应命中起手卡片")
            app.buttons["home-runtime-preview-scroll-14"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 5),
                          "滚动停止后卡片仍可正常打开")
            app.terminate()
        }
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
    /// ADR-0049 §5: the card leaves as soon as the close is sent and returns if the computer rejects it.
    func testSwipeCloseHidesBeforeConfirmationAndRestoresOnRejection() {
        let app = launch("home", arguments: ["--preview-close=slow"])
        let codex = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(codex.waitForExistence(timeout: 8))
        let start = codex.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -codex.frame.width * 0.6, dy: 0)))
        // The preview confirms after 3 s and goes offline 1 s later; the card is already gone.
        XCTAssertTrue(codex.waitForNonExistence(timeout: 1.5))
        capture("home-close-optimistic", app: app)
        XCTAssertFalse(codex.waitForExistence(timeout: 6))
        app.terminate()

        let rejected = launch("home", arguments: ["--preview-close=fail"])
        let card = rejected.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 8))
        let originalFrame = card.frame
        let origin = card.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        origin.press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: -originalFrame.width * 0.6, dy: 0)))
        XCTAssertTrue(card.waitForNonExistence(timeout: 1.5))
        XCTAssertTrue(card.waitForExistence(timeout: 6))
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(card.frame.minX - originalFrame.minX) <= 1 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 3), .completed)
        XCTAssertTrue(rejected.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "关闭会话未完成")).firstMatch.waitForExistence(timeout: 3))
        capture("home-close-restored", app: rejected)
    }
    /// V11 r27（ADR-0049 §7.4 L4）：关闭后断线，卡片在断线期间保持隐藏；重连后的首个在线列表里会话仍在，
    /// 卡片回到原位置并提示“关闭会话未确认”，不自动再关闭。
    func testCloseKeepsTheCardHiddenThroughADisconnectAndRestoresItWhenStillOnline() {
        let app = launch("home", arguments: ["--preview-close=drop"])
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 8))
        let originalFrame = card.frame
        let origin = card.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        origin.press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: -originalFrame.width * 0.6, dy: 0)))
        XCTAssertTrue(card.waitForNonExistence(timeout: 1.5))
        // 夹具 1 秒后断线、3 秒后重连：断线期间卡片不回来。
        RunLoop.current.run(until: Date().addingTimeInterval(2.5))
        XCTAssertFalse(card.exists, "断线时列表类操作保持呈现")
        capture("home-close-disconnected", app: app)
        XCTAssertTrue(card.waitForExistence(timeout: 6), "重连后的在线列表仍有该会话")
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(card.frame.minX - originalFrame.minX) <= 1 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 3), .completed)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "关闭会话未确认")).firstMatch.waitForExistence(timeout: 3))
        capture("home-close-reconnected-restored", app: app)
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
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        let closeStart = card.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        closeStart.press(forDuration: 0.05, thenDragTo: closeStart.withOffset(CGVector(dx: -card.frame.width * 0.6, dy: 0)))
        XCTAssertTrue(card.waitForNonExistence(timeout: 5), "目录取消横拖后仍须能够左滑关闭会话")
        XCTAssertTrue(app.buttons["打开会话目录"].exists)
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
    // ADR-0053 §3 / V21: a session closing above the viewport does not move the cards being read.
    func testHomeViewportStaysWhenSessionsChangeAboveIt() {
        let app = launch("home", arguments: ["--preview-home-long-list", "--preview-home-remove-later"])
        let list = app.scrollViews["home-session-list"]
        let top = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(top.waitForExistence(timeout: 8))
        list.swipeUp()
        settle()
        let candidates = (4...15).map { app.buttons["home-runtime-preview-scroll-\($0)"] }
        guard let card = candidates.first(where: { $0.exists && $0.isHittable && $0.frame.minY > list.frame.minY + 40 }) else {
            return XCTFail("no fully visible card after scrolling")
        }
        let before = card.frame
        XCTAssertFalse(top.isHittable)
        XCTAssertTrue(top.waitForNonExistence(timeout: 12))
        settle()
        XCTAssertEqual(card.frame.minY, before.minY, accuracy: 1)
        capture("home-viewport-after-removal", app: app)
    }

    // ADR-0053 §7 / M16: a queued download flies from the tap toward the chat's download button.
    func testDownloadFlightStartsAtTapAndEndsAtButton() {
        let app = launch("chat", arguments: ["--preview-chat-artifact", "--preview-slow-flight", "--preview-flight-probe"])
        let file = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "report")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 8))
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        let composerFrame = composer.frame
        let origin = file.frame
        file.tap()
        let target = app.buttons["chat-downloads"]
        let metrics = flightMetrics(target)
        XCTAssertEqual(metrics["mode"], "flight")
        XCTAssertEqual(Double(metrics["fromX"] ?? "") ?? -1, Double(origin.midX), accuracy: 4)
        XCTAssertEqual(Double(metrics["fromY"] ?? "") ?? -1, Double(origin.midY), accuracy: 4)
        XCTAssertEqual(Double(metrics["toX"] ?? "") ?? -1, Double(target.frame.midX), accuracy: 4)
        XCTAssertEqual(Double(metrics["toY"] ?? "") ?? -1, Double(target.frame.midY), accuracy: 4)
        capture("download-flight-midway", app: app)
        // The flight takes no taps and moves nothing beneath it.
        XCTAssertEqual(composer.frame, composerFrame)
        XCTAssertTrue(app.buttons["chat-downloads"].isHittable)
        app.buttons["chat-downloads"].tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "report")).firstMatch.waitForExistence(timeout: 3))
        capture("download-flight-task-listed", app: app)
    }

    func testDownloadFlightWithReducedMotionHighlightsWithoutFlying() {
        let app = launch("chat", arguments: ["--preview-chat-artifact", "--preview-reduce-motion", "--preview-flight-probe"])
        let file = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "report")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 8)); file.tap()
        let metrics = flightMetrics(app.buttons["chat-downloads"])
        XCTAssertEqual(metrics["mode"], "highlight")
        XCTAssertEqual(metrics["count"], "0")
        capture("download-reduced-motion-no-flight", app: app)
        app.buttons["chat-downloads"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "report")).firstMatch.waitForExistence(timeout: 3))
    }

    func testHistoryDownloadButtonAndFlight() {
        let app = launch("history", arguments: ["--preview-chat-artifact", "--preview-history-artifact", "--preview-slow-flight", "--preview-flight-probe"])
        let node = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "梳理页面和交互")).firstMatch
        XCTAssertTrue(node.waitForExistence(timeout: 8)); node.tap()
        let file = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "report")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 5))
        let origin = file.frame
        file.tap()
        let target = app.buttons["history-downloads"]
        let metrics = flightMetrics(target)
        XCTAssertEqual(metrics["mode"], "flight")
        XCTAssertEqual(Double(metrics["fromX"] ?? "") ?? -1, Double(origin.midX), accuracy: 4)
        XCTAssertEqual(Double(metrics["fromY"] ?? "") ?? -1, Double(origin.midY), accuracy: 4)
        XCTAssertEqual(Double(metrics["toX"] ?? "") ?? -1, Double(target.frame.midX), accuracy: 4)
        XCTAssertEqual(Double(metrics["toY"] ?? "") ?? -1, Double(target.frame.midY), accuracy: 4)
        capture("history-download-flight-midway", app: app)
    }

    // ADR-0053 §4 / S22: the header keeps only downloads and settings, the capsule only reports state,
    // and computers are added or unpaired only from the drawer's computer menu.
    func testSettingsPageOrderAndSingleHostMenu() {
        let app = launch("home", arguments: ["--preview-hosts=2"])
        let settings = app.buttons["home-settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["home-downloads"].exists)
        XCTAssertFalse(app.buttons["更多操作"].exists)
        XCTAssertFalse(app.buttons["home-connection-pill"].exists)
        let pill = app.descendants(matching: .any)["home-connection-pill"].firstMatch
        XCTAssertTrue(pill.exists)
        pill.tap()
        XCTAssertFalse(app.descendants(matching: .any)["settings-page"].waitForExistence(timeout: 1.5))
        let switcher = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "切换电脑")).firstMatch
        XCTAssertTrue(switcher.waitForExistence(timeout: 3))
        switcher.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "工作电脑")).firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["添加电脑"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "取消配对")).firstMatch.exists)
        capture("home-switcher-switch-only", app: app)
        app.terminate()

        for dark in [false, true] {
            let page = launch("status", dark: dark, arguments: ["--preview-hosts=2"])
            XCTAssertTrue(page.descendants(matching: .any)["settings-page"].waitForExistence(timeout: 8))
            let providers = page.staticTexts["Agent 供应商"], connection = page.staticTexts["当前连接"], pairing = page.staticTexts["配对信息"]
            XCTAssertTrue(providers.exists && connection.exists && pairing.exists)
            XCTAssertLessThan(providers.frame.minY, connection.frame.minY)
            XCTAssertLessThan(connection.frame.minY, pairing.frame.minY)
            XCTAssertFalse(page.staticTexts["已配对电脑"].exists)
            XCTAssertFalse(page.buttons["添加电脑"].exists)
            capture("settings-order" + (dark ? "-dark" : "-light"), app: page)
            page.terminate()
        }

        let drawer = launch("drawer", arguments: ["--preview-hosts=2"])
        let computer = drawer.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "电脑，当前")).firstMatch
        XCTAssertTrue(computer.waitForExistence(timeout: 8))
        XCTAssertFalse(drawer.buttons["当前电脑操作"].exists)
        computer.tap()
        XCTAssertTrue(drawer.buttons["添加电脑"].waitForExistence(timeout: 3))
        XCTAssertTrue(drawer.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "取消配对")).firstMatch.exists)
        capture("drawer-computer-menu", app: drawer)
    }

    // M14: every full page participates, including adding a computer; sheets keep their own gestures.
    func testAddComputerPageReboundsAndSwipesBack() {
        for (dark, arguments) in [(false, [String]()), (true, ["--preview-reduce-motion"])] {
            let app = launch("drawer", dark: dark, arguments: arguments)
            let computer = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "电脑，当前")).firstMatch
            XCTAssertTrue(computer.waitForExistence(timeout: 8))
            computer.tap()
            app.buttons["添加电脑"].tap()
            let title = app.staticTexts["连接你的电脑"]
            XCTAssertTrue(title.waitForExistence(timeout: 3))
            settle()
            let originalX = title.frame.minX
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.30, dy: 0.6)),
                        withVelocity: .slow, thenHoldForDuration: 0.3)
            XCTAssertTrue(title.exists)
            let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                title.exists && abs(title.frame.minX - originalX) <= 1
            }, object: title)
            XCTAssertEqual(XCTWaiter().wait(for: [returned], timeout: 5), .completed)
            XCTAssertEqual(title.frame.minX, originalX, accuracy: 1)
            capture("pairing-short-drag-" + (dark ? "dark-reduced" : "light"), app: app)
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                        withVelocity: .slow, thenHoldForDuration: 0.1)
            XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
            XCTAssertFalse(app.buttons["取消添加电脑"].exists)
            XCTAssertTrue(app.buttons["home-settings"].isHittable)
            capture("pairing-returned-home-" + (dark ? "dark-reduced" : "light"), app: app)
            app.terminate()
        }
    }

    func testNestedPagesSwipeBackOneLevelAtATime() {
        let app = launch("chat")
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("nested page draft")
        app.buttons["历史与分支"].tap()
        XCTAssertTrue(app.buttons["history-downloads"].waitForExistence(timeout: 3))
        let search = app.textFields["搜索历史与分支"]
        search.tap(); search.typeText("保留")
        app.buttons["history-downloads"].tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        func swipeBack() {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                       withVelocity: .slow, thenHoldForDuration: 0.1)
        }
        swipeBack()
        XCTAssertTrue(app.buttons["history-downloads"].waitForExistence(timeout: 3))
        XCTAssertEqual(search.value as? String, "保留")
        XCTAssertFalse(composer.exists)
        capture("nested-downloads-return-history", app: app)
        swipeBack()
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertTrue((composer.value as? String)?.contains("nested page draft") == true)
        XCTAssertFalse(app.buttons["打开会话目录"].exists)
        capture("nested-history-return-chat", app: app)
    }

    // ADR-0053 §5 / M14: settings and the home downloads page slide back to home like the chat.
    func testSettingsAndDownloadsSwipeBack() {
        let app = launch("home")
        let directory = app.buttons["打开会话目录"]
        XCTAssertTrue(app.buttons["home-settings"].waitForExistence(timeout: 8))
        for (entry, page) in [("home-settings", "settings-page"), ("home-downloads", "")] {
            app.buttons[entry].tap()
            let opened = page.isEmpty ? app.staticTexts["下载"] : app.descendants(matching: .any)[page].firstMatch
            XCTAssertTrue(opened.waitForExistence(timeout: 3))
            XCTAssertTrue(directory.waitForNonExistence(timeout: 3))
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
            // A short drag rebounds and stays on the page.
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.32, dy: 0.6)),
                        withVelocity: .slow, thenHoldForDuration: 0.3)
            XCTAssertTrue(opened.exists)
            // The rebounding page may still show the home preview beneath it, which takes no taps.
            XCTAssertFalse(directory.exists && directory.isHittable)
            // Past a third of the width it returns home, and home takes taps at once.
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                        withVelocity: .slow, thenHoldForDuration: 0.1)
            XCTAssertTrue(directory.waitForExistence(timeout: 3))
            XCTAssertTrue(app.buttons[entry].isHittable)
            capture("swipe-back-from-" + entry, app: app)
        }
    }

    // The optional two-edge enhancement is deferred. A right-edge inward drag must
    // not invent Android navigation; the existing rightward page gesture remains.
    func testOptionalEdgeBackKeepsExistingIOSNavigation() {
        for reduced in [false, true] {
            let app = launch("home", arguments: reduced ? ["--preview-reduce-motion"] : [])
            let entry = app.buttons["home-settings"]
            XCTAssertTrue(entry.waitForExistence(timeout: 8)); entry.tap()
            let page = app.descendants(matching: .any)["settings-page"].firstMatch
            XCTAssertTrue(page.waitForExistence(timeout: 3))
            let before = page.frame
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.6))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.6)),
                       withVelocity: .slow, thenHoldForDuration: 0.1)
            XCTAssertTrue(page.exists)
            XCTAssertEqual(page.frame, before)
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.28, dy: 0.6)),
                        withVelocity: .slow, thenHoldForDuration: 0.3)
            XCTAssertTrue(page.exists)
            waitForY(page, before.minY, operation: "取消返回必须恢复原页")
            XCTAssertEqual(page.frame.width, before.width, accuracy: 1)
            capture("motion-ios-existing-return", app: app)
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                        withVelocity: .slow, thenHoldForDuration: 0.1)
            XCTAssertTrue(entry.waitForExistence(timeout: 3))
            XCTAssertTrue(entry.isHittable)
            XCTAssertFalse(page.exists)
            app.terminate()
        }
    }

    func testComputerSubmenuReturnsWithinOneAnchoredPanel() {
        let app = launch("drawer", arguments: ["--preview-hosts=2"])
        let computer = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "电脑，当前")).firstMatch
        XCTAssertTrue(computer.waitForExistence(timeout: 8)); computer.tap()
        let add = app.buttons["添加电脑"]
        XCTAssertTrue(add.waitForExistence(timeout: 3))
        XCTAssertTrue(add.isHittable)
        let anchor = computer.frame
        app.buttons["切换电脑"].tap()
        let target = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "工作电脑")).firstMatch
        XCTAssertTrue(target.waitForExistence(timeout: 3))
        XCTAssertTrue(target.isHittable)
        XCTAssertFalse(add.exists)
        XCTAssertEqual(computer.frame, anchor)
        capture("motion-menu-child", app: app)
        app.buttons["切换电脑"].tap()
        XCTAssertTrue(add.waitForExistence(timeout: 3))
        XCTAssertTrue(add.isHittable)
        XCTAssertEqual(computer.frame, anchor)
        capture("motion-menu-parent", app: app)
    }

    // ADR-0053 §5: the chat's downloads page returns to that same chat, draft and all.
    func testChatDownloadsReturnToSameChat() {
        let app = launch("chat")
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("下载前的草稿")
        app.buttons["chat-downloads"].tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        XCTAssertFalse(composer.exists)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["打开会话目录"].exists)
        XCTAssertTrue((composer.value as? String)?.contains("下载前的草稿") == true)
        capture("chat-downloads-returned", app: app)
    }

    // ADR-0053 §5 / §7: the history page has the chat's download button and its page returns there.
    func testHistoryDownloadsReturnToHistory() {
        let app = launch("history")
        let button = app.buttons["history-downloads"]
        XCTAssertTrue(button.waitForExistence(timeout: 8))
        let search = app.textFields["搜索历史与分支"]
        XCTAssertTrue(search.exists)
        button.tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(button.waitForExistence(timeout: 3))
        XCTAssertTrue(search.exists)
        XCTAssertFalse(app.descendants(matching: .any)["chat-composer"].exists)
        capture("history-downloads-returned", app: app)
    }

    // M14: history and branch browsing is a page above the same chat, so a right swipe returns there.
    func testHistorySwipeBackReturnsToChat() {
        let app = launch("chat")
        let historyButton = app.buttons["历史与分支"]
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(historyButton.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("历史前的草稿")
        historyButton.tap()
        XCTAssertTrue(app.buttons["history-downloads"].waitForExistence(timeout: 3))
        XCTAssertFalse(composer.exists)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.30, dy: 0.6)),
                    withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(app.buttons["history-downloads"].exists)
        capture("history-swipe-cancelled", app: app)
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertTrue(historyButton.exists)
        XCTAssertFalse(app.buttons["打开会话目录"].exists)
        XCTAssertTrue((composer.value as? String)?.contains("历史前的草稿") == true)
        capture("history-swipe-back-to-chat", app: app)
        historyButton.tap()
        XCTAssertTrue(app.buttons["history-downloads"].waitForExistence(timeout: 3))
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
    /// ADR-0049: the bubble appears before the Host answers and is replaced, not duplicated, by the
    /// canonical row that only declares the App id; a rejected send stays and can return to the composer.
    func testSendFlightMovesRightThenUpAndHandsOffTheSameMessage() {
        let text = "逐帧检查发送动效"
        for progress in [0.25, 0.65, 1.0] {
            let app = launch("chat", arguments: ["--preview-send=pi", "--preview-send-probe", "--preview-send-progress=\(progress)"])
            let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
            XCTAssertTrue(composer.waitForExistence(timeout: 8))
            composer.tap(); composer.typeText(text)
            // XCTest may insert CJK through a hardware input session. Re-tap to show
            // the software keyboard before capturing the actual submission geometry.
            composer.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
            let submittedFrom = composer.frame
            capture("send-before-submit", app: app)
            app.buttons["发送消息"].firstMatch.tap()
            let probe = app.descendants(matching: .any)["send-flight-probe"].firstMatch
            let ready = NSPredicate(format: "value CONTAINS %@", "lands=true")
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: ready, object: probe)], timeout: 4), .completed)
            let metrics = flightMetrics(probe)
            let metricsAttachment = XCTAttachment(string: String(describing: metrics))
            metricsAttachment.name = "send-geometry"; metricsAttachment.lifetime = .keepAlways; add(metricsAttachment)
            func number(_ key: String) -> Double { Double(metrics[key] ?? "") ?? -1 }
            XCTAssertEqual(metrics["count"], "1")
            XCTAssertEqual(number("p"), progress, accuracy: 0.001)
            XCTAssertEqual(number("fromY"), submittedFrom.midY, accuracy: 20,
                           "Flight starts at the visible composer, including with the keyboard open")
            if progress == 0.25 {
                XCTAssertGreaterThanOrEqual(number("x"), number("fromX") + 23.99)
                XCTAssertEqual(number("y"), number("fromY"), accuracy: 1)
            } else {
                XCTAssertLessThan(number("y"), number("fromY"))
            }
            if progress == 1 {
                XCTAssertEqual(number("x"), number("toX"), accuracy: 1)
                XCTAssertEqual(number("y"), number("toY"), accuracy: 1)
            }
            capture("send-phase-\(progress)", app: app)
            let semantics = XCTAttachment(string: app.debugDescription)
            semantics.name = "send-phase-semantics-\(progress)"; semantics.lifetime = .keepAlways
            add(semantics)
            XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count, 1)
            app.terminate()
        }
    }

    func testSendFlightWithReducedMotionKeepsTheMessageAndNoOverlay() {
        let app = launch("chat", arguments: ["--preview-send=pi", "--preview-send-probe", "--preview-send-progress=0.65", "--preview-reduce-motion"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("减少动画发送")
        app.buttons["发送消息"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["减少动画发送"].waitForExistence(timeout: 3))
        let probe = app.descendants(matching: .any)["send-flight-probe"].firstMatch
        XCTAssertEqual(flightMetrics(probe)["count"], "0")
        capture("send-reduced-motion", app: app)
    }

    func testOptimisticSendReconcilesAndRejectedSendRestores() {
        let text = "乐观显示的这条消息"
        let app = launch("chat", arguments: ["--preview-send=pi"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText(text)
        app.buttons["发送消息"].firstMatch.tap()
        let bubble = app.staticTexts[text]
        XCTAssertTrue(bubble.waitForExistence(timeout: 1))
        let sending = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "pending-status-")).firstMatch
        XCTAssertTrue(sending.waitForExistence(timeout: 1))
        XCTAssertTrue(app.staticTexts["发送中"].exists)
        XCTAssertEqual((composer.value as? String)?.contains(text), false)
        capture("optimistic-send-pending", app: app)
        let settled = NSPredicate(format: "exists == false")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: sending)], timeout: 8), .completed)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count, 1)
        // The remaining bubble is the canonical row, whose id is the Host entry id rather than the App id.
        bubble.press(forDuration: 0.6)
        capture("optimistic-source-actions", app: app)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "copy-message-node-")).firstMatch.waitForExistence(timeout: 3))
        capture("optimistic-send-settled", app: app)
        app.terminate()

        let rejected = launch("chat", arguments: ["--preview-send=fail"])
        let input = rejected.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap(); input.typeText("会被拒绝的消息")
        rejected.buttons["发送消息"].firstMatch.tap()
        XCTAssertTrue(rejected.staticTexts["会话正在运行，请选择插入或完成后发送"].waitForExistence(timeout: 4))
        capture("optimistic-send-rejected", app: rejected)
        rejected.buttons["放回输入框"].firstMatch.tap()
        let restored = NSPredicate(format: "value CONTAINS %@", "会被拒绝的消息")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: restored, object: input)], timeout: 4), .completed)
        XCTAssertFalse(rejected.staticTexts["会话正在运行，请选择插入或完成后发送"].exists)
    }
    func testUnconfirmedSendCanBeCheckedWithoutResending() {
        let app = launch("chat", arguments: ["--preview-send=unknown"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("需要核对的输入")
        app.buttons["发送消息"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["未确认是否送达"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.staticTexts["发送中"].exists)
        XCTAssertFalse(app.buttons["重新发送"].exists)
        let check = app.buttons["核对送达状态"].firstMatch
        XCTAssertTrue(check.exists); check.tap()
        XCTAssertTrue(app.staticTexts["未确认是否送达"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "需要核对的输入")).count, 1)
        capture("send-unconfirmed-with-check", app: app)
    }

    func testCompactionQueuedSendCanBeWithdrawn() {
        let app = launch("chat", arguments: ["--preview-send=queue", "--preview-compacting"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("等待压缩后发送")
        app.buttons["发送消息"].firstMatch.tap()
        let withdraw = app.buttons["撤回排队消息"].firstMatch
        XCTAssertTrue(withdraw.waitForExistence(timeout: 4))
        XCTAssertFalse(app.staticTexts["发送中"].exists)
        capture("send-queued-during-compaction", app: app)
        withdraw.tap()
        let removed = NSPredicate(format: "exists == false")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: removed, object: app.staticTexts["等待压缩后发送"])], timeout: 4), .completed)
        capture("send-queue-withdrawn", app: app)
    }

    func testUserMessageCopyAndRewind() {
        let app = launch("chat")
        let message = app.descendants(matching: .any)["user-message-m3"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 8))
        if !message.isHittable { app.swipeDown() }
        let before = message.frame
        XCTAssertFalse(app.buttons["copy-message-m3"].exists)
        message.press(forDuration: 0.6)
        let copy = app.buttons["copy-message-m3"]
        XCTAssertTrue(copy.waitForExistence(timeout: 3))
        XCTAssertEqual(message.frame.minY, before.minY, accuracy: 1)
        XCTAssertLessThanOrEqual(copy.frame.maxY, message.frame.minY)
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

    func testQuestionReminderAppearsWhileReadingAndLocatesTheOriginalWithoutFollowing() {
        for dark in [false, true] {
            let app = launch("viewport", dark: dark, arguments: ["--preview-question-reminder"])
            XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
            let reminder = app.buttons["chat-question-reminder"]
            XCTAssertFalse(reminder.exists, "Following a long reply must not show the question automatically")
            let transcript = app.scrollViews.firstMatch
            let viewport = transcript.frame
            transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).press(forDuration: 0.05,
                thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)), withVelocity: .slow, thenHoldForDuration: 0.3)
            XCTAssertTrue(reminder.waitForExistence(timeout: 3), String(describing: app.buttons["chat-title"].value))
            XCTAssertTrue(reminder.label.contains("帮我比较这两种实现"))
            XCTAssertTrue(reminder.label.contains("👩🏽‍💻"), "Accessibility keeps the complete question")
            XCTAssertGreaterThanOrEqual(reminder.frame.height, 48)
            XCTAssertLessThan(reminder.frame.height, 110)
            XCTAssertEqual(transcript.frame, viewport, "The reminder must not resize the transcript")
            let anchor = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 "))
                .allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > viewport.minY + 120 && $0.frame.maxY < viewport.maxY - 20 }
            XCTAssertNotNil(anchor)
            let before = anchor?.frame.minY
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "刷新 Git 工作分支")).firstMatch.tap()
            settle()
            if let anchor, let before { XCTAssertEqual(anchor.frame.minY, before, accuracy: 1) }
            capture("question-reminder-reading-\(dark)", app: app)
            reminder.tap()
            XCTAssertTrue(reminder.waitForNonExistence(timeout: 5))
            let original = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "帮我比较这两种实现")).firstMatch
            XCTAssertTrue(original.isHittable)
            XCTAssertTrue(app.buttons["跳到最新消息"].exists, "Locating the question leaves following disabled")
            capture("question-reminder-original-\(dark)", app: app)
            transcript.swipeUp()
            XCTAssertTrue(reminder.waitForExistence(timeout: 3))
            app.buttons["跳到最新消息"].tap()
            XCTAssertTrue(reminder.waitForNonExistence(timeout: 5))
            app.terminate()
        }
    }

    func testQuestionReminderTracksNewSourceQuestionsWithoutMovingTheReader() {
        let app = launch("viewport", arguments: ["--preview-viewport-rows", "--preview-reduce-motion"])
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = app.scrollViews.firstMatch
        let reminder = app.buttons["chat-question-reminder"]
        for _ in 0..<8 where !reminder.exists {
            transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).press(forDuration: 0.05,
                thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)), withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        XCTAssertTrue(reminder.waitForExistence(timeout: 3))
        XCTAssertTrue(reminder.label.contains("新增消息 0"))
        let anchor = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 "))
            .allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > transcript.frame.minY + 120 && $0.frame.maxY < transcript.frame.maxY - 20 }
        XCTAssertNotNil(anchor)
        let before = anchor?.frame.minY
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "刷新 Git 工作分支")).firstMatch.tap()
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "新增消息 1"), object: reminder)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed)
        if let anchor, let before { XCTAssertEqual(anchor.frame.minY, before, accuracy: 1) }
        capture("question-reminder-new-source-reduced", app: app)
        app.buttons["跳到最新消息"].tap()
        XCTAssertTrue(reminder.waitForNonExistence(timeout: 5))
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
        // V07 r27 / V22：写入后面板立即收起，原位以覆盖式短状态显示摘要（回执前带处理中标记）。
        let status = app.descendants(matching: .any)["interaction-status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 2))
        XCTAssertTrue(status.label.contains("已允许"), status.label)
        XCTAssertFalse(app.staticTexts["允许执行验证命令？"].exists)
        XCTAssertEqual(before.minY, composer.frame.minY, accuracy: 1)
        capture("approval-submitting", app: app)
    }

    /// V22：Host 明确拒绝回答时，面板在原位置恢复并就近说明，不留下“已允许”摘要。
    func testApprovalRejectionBringsThePanelBackInPlace() {
        let app = launch("approval", arguments: ["--preview-respond-reject"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let allow = app.buttons["允许"]
        XCTAssertTrue(allow.waitForExistence(timeout: 3))
        let panelTop = allow.frame.minY
        let before = composer.frame
        allow.tap()
        let status = app.descendants(matching: .any)["interaction-status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["允许"].waitForExistence(timeout: 5), "A rejected answer must bring the request back")
        XCTAssertEqual(app.buttons["允许"].frame.minY, panelTop, accuracy: 1)
        XCTAssertFalse(status.exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "回答未提交")).firstMatch.waitForExistence(timeout: 2))
        XCTAssertEqual(before.minY, composer.frame.minY, accuracy: 1)
        capture("approval-rejected-restored", app: app)
    }
    func testCompactQuotaCardsAndTransparentSwitch() {
        for dark in [false, true] {
            let app = launch("status", dark: dark)
            let codex = app.buttons["provider-quota-codex"]
            XCTAssertTrue(codex.waitForExistence(timeout: 8))
            let drag = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
            drag.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)))
            let before = codex.frame
            XCTAssertLessThan(before.height, 130)
            // Before data exists, the icon also queries. Afterwards it only flips.
            let coin = app.buttons["quota-coin-codex"]
            coin.tap()
            let loaded = NSPredicate(format: "value CONTAINS %@", "82%")
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: loaded, object: codex)], timeout: 8), .completed)
            XCTAssertEqual(codex.frame.height, before.height, accuracy: 1)
            RunLoop.current.run(until: Date().addingTimeInterval(3))
            XCTAssertTrue((coin.value as? String)?.contains("5 小时配额") == true)
            coin.tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "35%"), object: coin)], timeout: 4), .completed)
            XCTAssertTrue((coin.value as? String)?.contains("周配额") == true)
            XCTAssertGreaterThanOrEqual(coin.frame.height, 48)
            XCTAssertLessThanOrEqual(coin.frame.width, 64)
            // Refreshing the rest of the card retains the weekly face.
            codex.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: loaded, object: codex)], timeout: 8), .completed)
            XCTAssertTrue((coin.value as? String)?.contains("周配额") == true)
            let claude = app.buttons["provider-quota-claude"]
            app.buttons["quota-coin-claude"].tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "64%"), object: claude)], timeout: 8), .completed)
            XCTAssertTrue((codex.value as? String)?.contains("82%") == true)
            XCTAssertFalse(app.staticTexts["轻点卡片查询配额"].exists)
            RunLoop.current.run(until: Date().addingTimeInterval(3))
            app.buttons["quota-coin-claude"].tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "18%"), object: app.buttons["quota-coin-claude"])], timeout: 4), .completed)
            capture(dark ? "compact-quota-dark" : "compact-quota-light", app: app)
            app.buttons["provider-switch-codex"].tap()
            let team = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "团队供应商")).firstMatch
            XCTAssertTrue(team.waitForExistence(timeout: 3))
            XCTAssertTrue(team.isHittable)
            team.tap()
            XCTAssertTrue(app.staticTexts["团队供应商"].waitForExistence(timeout: 3))
            app.terminate()
        }
    }

    func testFixedRoutingAndStatusProviderSwitch() {
        let status = launch("status")
        XCTAssertFalse(status.buttons["设置"].exists)
        XCTAssertFalse(status.staticTexts["连接优先级"].exists)
        XCTAssertFalse(status.buttons["上移中继"].exists)
        let switchButton = status.buttons["provider-switch-codex"]
        XCTAssertTrue(switchButton.waitForExistence(timeout: 8))
        switchButton.tap()
        let team = status.buttons.matching(NSPredicate(format: "label CONTAINS %@", "团队供应商")).firstMatch
        XCTAssertTrue(team.waitForExistence(timeout: 3))
        team.tap()
        XCTAssertTrue(status.staticTexts["团队供应商"].waitForExistence(timeout: 5))
        XCTAssertTrue(status.buttons["provider-switch-claude"].exists)
        capture("status-provider-switch", app: status)
    }
    func testBasicConnectionStatusAndDirectoryProviderMismatch() {
        for dark in [false, true] {
            let app = launch("status", dark: dark)
            XCTAssertTrue(app.staticTexts["当前连接"].waitForExistence(timeout: 8))
            // Providers now come first (ADR-0053 §4); the connection and pairing facts follow below them.
            let page = app.descendants(matching: .any)["settings-page"].firstMatch
            for _ in 0..<4 where !app.staticTexts["配对状态"].firstMatch.isHittable { page.swipeUp() }
            for label in ["已连接", "连接方式", "连接延迟", "42 ms", "端到端加密", "电脑", "配对状态"] {
                XCTAssertTrue(app.staticTexts[label].firstMatch.isHittable)
            }
            for label in ["电脑端诊断记录", "电脑端会话目录", "电脑端供应商", "统一状态模型", "电脑 Agent 服务", "本机 deviceId", "Host hostId", "Host 公钥指纹", "配对根密钥"] {
                XCTAssertFalse(app.staticTexts[label].exists)
            }
            XCTAssertFalse(app.buttons["原始事件"].exists)
            capture(dark ? "status-basic-dark" : "status-basic-light", app: app)
            XCTAssertTrue(app.buttons["provider-switch-codex"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["provider-switch-claude"].exists)
            app.terminate()

            let noSample = launch("status", dark: dark, arguments: ["--preview-no-rtt"])
            let noSamplePage = noSample.descendants(matching: .any)["settings-page"].firstMatch
            XCTAssertTrue(noSamplePage.waitForExistence(timeout: 8))
            for _ in 0..<4 where !noSample.staticTexts["连接延迟"].firstMatch.isHittable { noSamplePage.swipeUp() }
            XCTAssertTrue(noSample.staticTexts["连接延迟"].firstMatch.isHittable)
            XCTAssertTrue(noSample.staticTexts["暂不可用"].firstMatch.isHittable)
            capture(dark ? "status-no-rtt-dark" : "status-no-rtt-light", app: noSample)
            noSample.terminate()
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
        dialog.buttons["设置"].tap()
        XCTAssertTrue(drawer.descendants(matching: .any)["settings-page"].waitForExistence(timeout: 3))
        XCTAssertTrue(drawer.buttons["provider-switch-codex"].exists)
    }
    func testDrawerCardsKeepUniformGeometryForShortAndLongTitles() {
        for (name, dark, category) in [("light", false, "UICTContentSizeCategoryL"),
                                       ("dark", true, "UICTContentSizeCategoryL"),
                                       ("large", false, "UICTContentSizeCategoryXXXL")] {
            let app = launch("drawer", dark: dark, arguments: ["--preview-drawer-layout",
                "-UIPreferredContentSizeCategoryName", category])
            let long = app.buttons["drawer-session-session-4"]
            let short = app.buttons["drawer-session-session-5"]
            XCTAssertTrue(long.waitForExistence(timeout: 8))
            XCTAssertTrue(short.waitForExistence(timeout: 3))
            let longFrame = long.frame
            let shortFrame = short.frame
            XCTAssertEqual(longFrame.width, shortFrame.width, accuracy: 0.5)
            XCTAssertEqual(longFrame.height, shortFrame.height, accuracy: 0.5)
            short.press(forDuration: 0.8)
            XCTAssertTrue(app.staticTexts["已选择 1 项"].exists)
            XCTAssertEqual(longFrame, long.frame)
            XCTAssertEqual(shortFrame, short.frame)
            app.buttons["退出多选"].tap()
            capture("drawer-uniform-\(name)", app: app)
            app.terminate()
        }
    }
    func testDrawerLongPressArchivesAndRestoresOnlyCheckedSessions() {
        // Keep both target rows visible so XCTest does not scroll while synthesizing long press.
        let app = launch("drawer", arguments: ["--preview-drawer-layout"])
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
            for screen in ["pairing", "home", "drawer", "chat", "status", "providers", "downloads", "approval"] {
                let app = launch(screen, dark: dark)
                XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
                let expected = screen == "pairing" ? "连接你的电脑" : screen == "status" ? "设置" : screen == "providers" ? "供应商" : screen == "downloads" ? "下载" : screen == "drawer" ? "会话目录" : screen == "approval" ? "允许执行验证命令" : "Codex"
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
        // ADR-0049 §6.3：撤回后队列项立即退场；cancelled 不再显示，也不会闪回。
        XCTAssertTrue(cancel.waitForNonExistence(timeout: 1.5))
        XCTAssertFalse(app.staticTexts["完成后发送，已撤回"].waitForExistence(timeout: 2))
        XCTAssertFalse(cancel.exists)
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
