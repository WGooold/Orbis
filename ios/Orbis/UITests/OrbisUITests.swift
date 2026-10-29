import XCTest

final class OrbisUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func launch(_ screen: String, dark: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--preview-screen=" + screen]
        if dark { app.launchArguments.append("--preview-dark") }
        app.launch()
        return app
    }
    private func capture(_ name: String, app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways
        add(screenshot)
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
        XCTAssertTrue(app.staticTexts["不会改变电脑端会话"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["从这条回复后继续"].waitForExistence(timeout: 3))
        capture("history-preview", app: app)
        app.buttons["从这条回复后继续"].tap()
        XCTAssertTrue(app.buttons["历史与分支"].waitForExistence(timeout: 5))
    }
    func testToolDetailsLoadPagesAndClose() {
        let app = launch("tool")
        let disclosure = app.buttons["展开read · 完成"]
        XCTAssertTrue(disclosure.waitForExistence(timeout: 8)); disclosure.tap()
        XCTAssertTrue(app.buttons["查看输出"].waitForExistence(timeout: 3)); app.buttons["查看输出"].tap()
        XCTAssertTrue(app.buttons["读取下一页"].waitForExistence(timeout: 5))
        for _ in 0..<4 {
            if app.staticTexts["已到当前读取范围末尾"].exists { break }
            if app.buttons["读取下一页"].waitForExistence(timeout: 3) { app.buttons["读取下一页"].tap() }
        }
        XCTAssertTrue(app.staticTexts["已到当前读取范围末尾"].waitForExistence(timeout: 5))
        capture("tool-detail", app: app)
        app.buttons["返回"].firstMatch.tap()
        XCTAssertTrue(app.buttons["历史与分支"].waitForExistence(timeout: 3))
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
    func testDiagnosticPagesAndDirectoryProviderMismatch() {
        let app = launch("status")
        let read = app.buttons["重新读取"]
        XCTAssertTrue(read.waitForExistence(timeout: 8))
        app.swipeUp()
        if !read.isHittable { app.swipeUp() }
        read.tap()
        XCTAssertTrue(app.staticTexts["安全通道已建立"].waitForExistence(timeout: 5))
        let next = app.buttons["读取下一页"]
        if !next.isHittable { app.swipeUp() }
        XCTAssertTrue(next.waitForExistence(timeout: 3)); next.tap()
        XCTAssertTrue(app.staticTexts["供应商配置读取完成"].firstMatch.waitForExistence(timeout: 5))
        capture("diagnostic-page", app: app)
        app.terminate()
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
        drawer.buttons["session-actions-session-4"].tap()
        drawer.buttons["在电脑继续会话"].tap()
        let dialog = drawer.descendants(matching: .any)["orbis-dialog"].firstMatch
        XCTAssertTrue(dialog.waitForExistence(timeout: 3))
        XCTAssertTrue(dialog.staticTexts["需要切换 provider"].exists)
        capture("provider-mismatch", app: drawer)
        dialog.buttons["供应商设置"].tap()
        XCTAssertTrue(drawer.staticTexts["供应商"].waitForExistence(timeout: 3))
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

    func testPageScreenshotsInBothAppearances() {
        for dark in [false, true] {
            for screen in ["pairing", "home", "drawer", "chat", "status", "settings", "providers", "downloads", "approval"] {
                let app = launch(screen, dark: dark)
                XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
                let expected = screen == "pairing" ? "连接你的电脑" : screen == "status" ? "连接状态" : screen == "settings" ? "设置" : screen == "providers" ? "供应商" : screen == "downloads" ? "下载" : screen == "drawer" ? "会话目录" : screen == "approval" ? "远程交互" : "Codex"
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
        XCTAssertTrue(app.staticTexts["Follow-up · 已撤回"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["通知状态待核对"].waitForExistence(timeout: 5))
        capture("queue-notification", app: app)
        app.buttons["关闭通知"].firstMatch.tap()
        XCTAssertFalse(app.staticTexts["模型服务等待恢复，电脑端会继续核对。 · 状态待核对"].waitForExistence(timeout: 2))
        app.buttons["会话信息"].tap()
        XCTAssertTrue(app.staticTexts["模型与上下文"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["high"].exists)
        XCTAssertTrue(app.staticTexts["本轮耗时"].exists)
        capture("runtime-facts", app: app)
    }

    func testToolExportAndInteractionDraftSwitching() {
        let tool = launch("tool")
        XCTAssertTrue(tool.buttons["展开read · 完成"].waitForExistence(timeout: 8)); tool.buttons["展开read · 完成"].tap()
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

    func testTruncatedContentToolArgumentsAndDesktopAttachFacts() {
        let app = launch("truncated")
        XCTAssertTrue(app.buttons["展开read · 已完成"].waitForExistence(timeout: 8))
        app.buttons["展开read · 已完成"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "/repo/source.swift")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["已完成工具参数验证。"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "有内容因超长被截断")).firstMatch.exists)
        capture("tool-arguments-truncated", app: app)
        app.buttons["full-entry-truncated-message"].tap()
        XCTAssertTrue(app.staticTexts["完整返回内容：这条消息已按需从电脑取回。"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["复制完整内容"].isEnabled)
        capture("full-entry", app: app)
        app.terminate()
        let status = launch("status")
        let desktop = status.staticTexts["Codex 桌面版接入"]
        for _ in 0..<6 where !desktop.isHittable { status.swipeUp() }
        XCTAssertTrue(desktop.isHittable)
        XCTAssertTrue(status.staticTexts["未接入"].exists)
        XCTAssertTrue(status.staticTexts["Codex 桌面版未打开"].exists)
        capture("desktop-attach", app: status)
    }

}
