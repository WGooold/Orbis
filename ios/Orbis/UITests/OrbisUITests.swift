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
        XCTAssertTrue(app.alerts["启用供应商"].waitForExistence(timeout: 3))
        app.alerts.buttons["取消"].tap()
        XCTAssertTrue(team.exists)
        team.tap(); app.alerts.buttons["确认"].tap()
        XCTAssertTrue(app.buttons["provider-action-official"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["provider-action-team"].exists)
        capture("providers-switch-complete", app: app)
        app.buttons["Pi供应商"].tap()
        let remove = app.buttons["provider-action-official"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5)); remove.tap()
        XCTAssertTrue(app.alerts["移除供应商"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.alerts.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "全局默认供应商")).firstMatch.exists)
        app.alerts.buttons["确认"].tap()
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
        XCTAssertTrue(session.waitForExistence(timeout: 3)); session.tap()
        XCTAssertTrue(drawer.alerts["需要切换 provider"].waitForExistence(timeout: 3))
        capture("provider-mismatch", app: drawer)
        drawer.alerts.buttons["供应商设置"].tap()
        XCTAssertTrue(drawer.staticTexts["供应商"].waitForExistence(timeout: 3))
    }
    func testPageScreenshotsInBothAppearances() {
        for dark in [false, true] {
            for screen in ["pairing", "home", "drawer", "chat", "status", "settings", "providers", "downloads", "approval"] {
                let app = launch(screen, dark: dark)
                XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
                let expected = screen == "pairing" ? "连接你的电脑" : screen == "status" ? "连接状态" : screen == "settings" ? "设置" : screen == "providers" ? "供应商" : screen == "downloads" ? "下载" : screen == "drawer" ? "会话目录" : "Codex"
                XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", expected)).firstMatch.waitForExistence(timeout: 5))
                capture(screen + (dark ? "-dark" : "-light"), app: app)
                app.terminate()
            }
        }
    }
}
