// Orbis 测试用途（场景与判定见本文件断言）：
// - 验证隔离预览中的真实手势、布局、阅读和输入状态，防止返回、取消或更新破坏视口与草稿；不替代用户 / 真机验收。
// - Claude 后台子任务（S26、S17、S20、V05、V12、V16、V18、M03、M06、M10、M20）
// - Claude 模型回复身份（V09、V17、V18）
// - MOT-04 / SC06–10（MOT-04、SC06、C11、C12、C18、R35、M18）
// - MOT-06 / SC14–16（MOT-06、SC14、C05、C06、R37、M17、V09、V10）
// - MOT-11 / SC33（MOT-11、SC33、R45、M08、M14）
// - MOT-13 / SC35、MOT-15 / SC37（MOT-13、SC35、MOT-15、SC37、R47、R49、M20、M12、V13）
// - MOT-14 / SC36（MOT-14、SC36、R48、M22、V21）
// - MOT-19 / SC41（MOT-19、SC41、R53、M19、S10、S17）
// - MOT-21 / SC43（MOT-21、SC43、R55、S18、V13、V18）
// - r15 流式、首页 / 目录视口与飞入（M04、V21、M16）
import XCTest
import UIKit

final class OrbisUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testActionFeedbackKeepsTargetsAndCancelsWithoutDispatchInAllAppearances() {
        for dark in [false, true] {
            for reduced in [false, true] {
                let app = launch("feedback", dark: dark, arguments: reduced ? ["--preview-reduce-motion"] : [])
                let count = app.staticTexts["feedback-count"]
                XCTAssertTrue(count.waitForExistence(timeout: 5))
                let gear = app.buttons["设置"]
                let frame = gear.frame
                let origin = gear.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                origin.press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: 0, dy: 140)))
                XCTAssertEqual(count.label, "0")
                XCTAssertEqual(frame, gear.frame)
                for (index, label) in ["设置", "历史", "刷新", "下载"].enumerated() {
                    app.buttons[label].tap()
                    XCTAssertEqual(count.label, String(index + 1))
                }
                gear.tap(); gear.tap()
                XCTAssertEqual(count.label, "6")
                XCTAssertEqual(frame, gear.frame)
                app.buttons["禁用按钮"].tap()
                XCTAssertFalse(gear.isEnabled)
                capture("quiet-feedback-\(dark ? "dark" : "light")-\(reduced ? "reduced" : "normal")", app: app)
                app.terminate()
            }
        }
    }

    func testBackgroundTasksStayVisibleWhileMainComposerIsIdleAndCannotBeClosed() {
        for dark in [false, true] {
            let app = launch("home", dark: dark, arguments: ["--preview-background-tasks", "--preview-reduce-motion"])
            let card = app.buttons["home-runtime-preview-codex"]
            XCTAssertTrue(card.waitForExistence(timeout: 8))
            XCTAssertTrue(app.staticTexts["2 个子代理运行中"].exists)
            card.swipeLeft()
            XCTAssertTrue(card.exists)
            XCTAssertFalse(app.buttons["关闭选中会话"].exists)
            XCTAssertTrue(app.staticTexts["后台任务尚未结束，暂不能关闭会话。"].waitForExistence(timeout: 3))
            app.buttons["关闭错误提示"].tap()
            XCTAssertTrue(app.buttons["关闭错误提示"].waitForNonExistence(timeout: 3))
            card.tap()
            let toggle = app.buttons["background-tasks-toggle"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 5))
            // S33 / SC52: native-independent subagent labels reuse the same disclosure and rows.
            XCTAssertTrue(toggle.label.contains("子代理 2 项"))
            toggle.tap()
            XCTAssertTrue(app.staticTexts["工作中"].firstMatch.exists)
            XCTAssertTrue(app.descendants(matching: .any)["background-task-review"].exists)
            XCTAssertTrue(app.descendants(matching: .any)["background-task-tests"].exists)
            XCTAssertFalse(app.buttons["停止生成"].exists)
            let input = app.descendants(matching: .any)["chat-composer"].firstMatch
            XCTAssertTrue(input.waitForExistence(timeout: 3))
            input.tap(); input.typeText("background draft")
            toggle.tap(); toggle.tap()
            XCTAssertEqual(input.value as? String, "background draft")
            capture("background-tasks-\(dark ? "dark" : "light")", app: app)
            app.terminate()
        }
    }

    // SC82: a partial inventory of completed tasks must still allow selection and
    // swipe feedback; mixed close leaves the blocked card selected and closes only Pi.
    func testHomeSubagentCardsRemainSelectableAndBlockedSwipesExplainWhy() {
        let app = launch("home", arguments: ["--preview-background-tasks", "--preview-background-incomplete", "--preview-reduce-motion"])
        let card = app.buttons["home-runtime-preview-codex"]
        let pi = app.buttons["home-runtime-preview-pi"]
        XCTAssertTrue(card.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["子代理 2 项，清单不完整"].waitForExistence(timeout: 3))
        let originalFrame = card.frame
        let start = card.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -originalFrame.width * 0.30, dy: 0)))
        XCTAssertFalse(app.staticTexts["后台任务清单不完整，暂不能关闭会话。"].exists)
        waitForX(card, originalFrame.minX, operation: "short blocked swipe")
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -originalFrame.width * 0.6, dy: 0)))
        XCTAssertTrue(app.staticTexts["后台任务清单不完整，暂不能关闭会话。"].waitForExistence(timeout: 3))
        XCTAssertTrue(card.exists)
        waitForX(card, originalFrame.minX, operation: "blocked swipe rebound")
        XCTAssertFalse(app.descendants(matching: .any)["chat-composer"].firstMatch.exists)
        capture("home-subagent-blocked-swipe", app: app)
        app.buttons["关闭错误提示"].tap()
        XCTAssertTrue(app.buttons["关闭错误提示"].waitForNonExistence(timeout: 3))

        card.press(forDuration: 0.8)
        XCTAssertTrue(app.staticTexts["已选择 1 项"].waitForExistence(timeout: 3))
        XCTAssertTrue(card.isSelected)
        XCTAssertEqual(card.frame, originalFrame)
        // Accessibility text can remain present underneath an opaque selection fill.
        // Check rendered title pixels so an empty-looking selected card cannot pass.
        XCTAssertGreaterThan(inkPixels(app.staticTexts["对齐移动端的使用体验"].firstMatch), 100)
        pi.tap()
        XCTAssertTrue(app.staticTexts["已选择 2 项"].waitForExistence(timeout: 3))
        app.buttons["关闭选中会话"].tap()
        XCTAssertTrue(pi.waitForNonExistence(timeout: 5))
        XCTAssertTrue(card.exists)
        XCTAssertTrue(card.isSelected)
        XCTAssertTrue(app.staticTexts["已选择 1 项"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["后台任务清单不完整，暂不能关闭会话。"].exists)
        XCTAssertGreaterThan(inkPixels(app.staticTexts["对齐移动端的使用体验"].firstMatch), 100)
        capture("home-subagent-mixed-close-retains-selection", app: app)
        app.buttons["关闭错误提示"].tap()
        XCTAssertTrue(app.buttons["关闭错误提示"].waitForNonExistence(timeout: 3))
        app.buttons["退出多选"].tap()
        card.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 5))
    }

    private func waitForX(_ element: XCUIElement, _ x: CGFloat, operation: String) {
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in abs(element.frame.minX - x) <= 1 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 3), .completed, operation)
    }

    // S34–38 / SC54–59: exercise the production root controls and local-only
    // choices in a synthetic computer fixture. A selection alone must not apply a protocol.
    func testDesignAlignmentRootDraftAndExplicitProtocolChoice() {
        let app = launch("home", arguments: ["--preview-reduce-motion", "--preview-reset-design"])
        let newSession = app.buttons["home-new-session"]
        XCTAssertTrue(newSession.waitForExistence(timeout: 8))
        capture("design-home-mist", app: app)
        for tab in ["chat", "providers", "settings"] {
            XCTAssertGreaterThanOrEqual(app.buttons["root-tab-" + tab].frame.height, 48)
        }
        newSession.tap()
        let draft = app.descendants(matching: .any)["draft-message"].firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 4))
        draft.tap(); draft.typeText("核对设计草稿")
        capture("design-local-draft", app: app)
        // Mounted dial/settings roots must not push the home header out of the
        // keyboard-reduced viewport while a local draft is being edited.
        XCTAssertTrue(newSession.isHittable)
        XCTAssertGreaterThanOrEqual(newSession.frame.minY, 0)
        newSession.tap()
        XCTAssertTrue(draft.waitForNonExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["草稿已保留"].waitForExistence(timeout: 3))
        newSession.tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 3))
        XCTAssertEqual(draft.value as? String, "核对设计草稿")
        newSession.tap()
        XCTAssertTrue(draft.waitForNonExistence(timeout: 3))
        app.buttons["root-tab-providers"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "provider-action-")).firstMatch.waitForExistence(timeout: 5))
        capture("design-provider-dial", app: app)
        app.buttons["root-tab-settings"].tap()
        let protocolRow = app.buttons["settings-protocol"]
        XCTAssertTrue(protocolRow.waitForExistence(timeout: 4))
        let original = protocolRow.label
        protocolRow.tap()
        XCTAssertTrue(app.buttons["relay-mode-quic"].waitForExistence(timeout: 3))
        app.buttons["relay-mode-quic"].tap()
        XCTAssertTrue(app.buttons["relay-mode-apply"].isEnabled)
        capture("design-protocol-staged-choice", app: app)
        app.buttons["关闭"].tap()
        XCTAssertTrue(protocolRow.waitForExistence(timeout: 3))
        XCTAssertEqual(protocolRow.label, original)
        capture("design-settings-connection", app: app)
        let settings = app.descendants(matching: .any)["settings-page"].firstMatch
        let sage = app.buttons["appearance-sage"]
        for _ in 0..<6 where !sage.isHittable { settings.swipeUp() }
        XCTAssertTrue(sage.isHittable); sage.tap()
        let dark = app.buttons["appearance-dark"]
        XCTAssertTrue(dark.isHittable); dark.tap()
        XCTAssertTrue(dark.isSelected)
        capture("design-settings-sage-dark", app: app)
        app.buttons["root-tab-chat"].tap()
        XCTAssertTrue(newSession.waitForExistence(timeout: 3))
        capture("design-home-sage-dark", app: app)
        app.buttons["打开会话目录"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["drawer-session-list"].waitForExistence(timeout: 3))
        capture("design-directory-tree-sage-dark", app: app)
    }

    // SC54 / SC59: tablet keeps a 320pt directory and limits the reading surface
    // to 720pt in a wide window; the same roots remain usable with a draft keyboard.
    func testDesignAlignmentTabletPersistentDirectoryAndReadingWidth() {
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launch("home", arguments: ["--preview-reduce-motion", "--preview-reset-design"])
        XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8))
        XCUIDevice.shared.orientation = .landscapeLeft
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height
        }, object: nil)
        XCTAssertEqual(XCTWaiter().wait(for: [landscape], timeout: 5), .completed)
        let directory = app.descendants(matching: .any)["persistent-session-directory"].firstMatch
        XCTAssertTrue(directory.waitForExistence(timeout: 8))
        XCTAssertEqual(directory.frame.width, 320, accuracy: 1)
        let list = app.scrollViews["home-session-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(list.frame.width, 720.5)
        capture("design-tablet-home-landscape", app: app)
        let newSession = app.buttons["home-new-session"]
        newSession.tap()
        let draft = app.descendants(matching: .any)["draft-message"].firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 4))
        draft.tap(); draft.typeText("平板草稿")
        XCTAssertTrue(newSession.isHittable)
        XCTAssertTrue(directory.exists)
        capture("design-tablet-draft-keyboard", app: app)
        newSession.tap()
        XCTAssertTrue(draft.waitForNonExistence(timeout: 4))
        app.buttons["root-tab-settings"].tap()
        XCTAssertTrue(app.buttons["settings-protocol"].waitForExistence(timeout: 4))
        XCTAssertTrue(directory.exists)
        capture("design-tablet-settings-landscape", app: app)
        app.buttons["root-tab-chat"].tap()
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 3)); card.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 4))
        directory.buttons["新建会话"].firstMatch.tap()
        XCTAssertTrue(draft.waitForExistence(timeout: 4))
        XCTAssertTrue(newSession.isHittable)
        XCTAssertTrue(app.buttons["draft-directory"].label.contains("/Projects/orbis"))
        newSession.tap()
        XCTAssertTrue(draft.waitForNonExistence(timeout: 3)); card.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 4))
        directory.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "筛选会话：")).firstMatch.tap()
        app.buttons["设置"].firstMatch.tap()
        XCTAssertTrue(app.buttons["provider-action-official"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["root-tab-providers"].isSelected)
        capture("design-tablet-detail-to-provider-root", app: app)
    }

    // FOLD-01: the session directory and primary surface must stay on opposite
    // sides of the active Duo division in landscape, and the draft input must remain usable.
    func testIPhoneDuoFoldDivisionKeepsDirectoryAndDraftUsable() {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launch("home", arguments: ["--preview-reduce-motion", "--preview-reset-design"])
        let window = app.windows.firstMatch
        let directory = app.descendants(matching: .any)["persistent-session-directory"].firstMatch
        let list = app.scrollViews["home-session-list"]
        XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8))
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            window.frame.width > window.frame.height
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 5), .completed)
        XCTAssertGreaterThan(window.frame.width, 600, "Duo must be testing its inner dual-screen canvas")
        XCTAssertTrue(directory.waitForExistence(timeout: 5))
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        let horizontalGap = list.frame.minX - directory.frame.maxX
        let verticalGap = list.frame.minY - directory.frame.maxY
        XCTAssertTrue(horizontalGap > 0 || verticalGap > 0,
                      "The system split arrangement must keep the panes clear of the Duo division")

        let newSession = app.buttons["home-new-session"]
        XCTAssertTrue(newSession.isHittable)
        newSession.tap()
        let draft = app.descendants(matching: .any)["draft-message"].firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 4))
        XCTAssertTrue(draft.isHittable)
        draft.tap(); draft.typeText("折叠屏草稿")
        XCTAssertEqual(draft.value as? String, "折叠屏草稿")
        XCTAssertTrue(directory.exists)
        capture("iphone-duo-fold-division-draft", app: app)
    }

    // FOLD-02: unfolded Duo in portrait must not mount a top persistent directory panel,
    // leaving the directory in the slide-over drawer and restoring the side panel in landscape.
    func testIPhoneDuoExpandedPortraitOmitsPersistentDirectoryAndUsesDrawer() {
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launch("home", arguments: ["--preview-reduce-motion", "--preview-reset-design"])
        let window = app.windows.firstMatch
        let directory = app.descendants(matching: .any)["persistent-session-directory"].firstMatch
        let list = app.scrollViews["home-session-list"]
        XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8))
        let portrait = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            window.frame.height > window.frame.width
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [portrait], timeout: 5), .completed)
        XCTAssertGreaterThan(window.frame.width, 600, "Duo must be testing its inner dual-screen canvas")
        XCTAssertFalse(directory.exists, "Expanded Duo portrait must not show the top directory panel")
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        XCTAssertLessThan(list.frame.minY, window.frame.height * 0.35)

        app.buttons["打开会话目录"].tap()
        let drawerList = app.descendants(matching: .any)["drawer-session-list"].firstMatch
        XCTAssertTrue(drawerList.waitForExistence(timeout: 4))
        app.buttons["关闭会话目录"].tap()
        XCTAssertTrue(drawerList.waitForNonExistence(timeout: 4))

        XCUIDevice.shared.orientation = .landscapeLeft
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            window.frame.width > window.frame.height
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 5), .completed)
        XCTAssertTrue(directory.waitForExistence(timeout: 5))

        XCUIDevice.shared.orientation = .portrait
        XCTAssertEqual(XCTWaiter.wait(for: [portrait], timeout: 5), .completed)
        XCTAssertTrue(directory.waitForNonExistence(timeout: 5))
        capture("iphone-duo-expanded-portrait", app: app)
    }

    // FOLD-07: synthetic posture keeps this independent of the simulator hinge
    // menu. Run on the inner Duo canvas; landscape must retain both side panes.
    func testIPhoneDuoPartialLandscapeKeepsDirectoryAndDraftOnRight() {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launch("home", arguments: ["--preview-partially-open", "--preview-reset-design"])
        let window = app.windows.firstMatch
        let directory = app.descendants(matching: .any)["persistent-session-directory"].firstMatch
        let list = app.scrollViews["home-session-list"]
        XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8))
        XCTAssertGreaterThan(window.frame.width, window.frame.height)
        XCTAssertGreaterThan(window.frame.height, 600, "Run on Duo's expanded inner canvas")
        XCTAssertTrue(directory.waitForExistence(timeout: 5))
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(directory.frame.maxX, window.frame.midX)
        XCTAssertGreaterThanOrEqual(list.frame.minX, window.frame.midX)
        app.buttons["home-new-session"].tap()
        let draft = app.descendants(matching: .any)["draft-message"].firstMatch
        XCTAssertTrue(draft.waitForExistence(timeout: 4))
        draft.tap(); draft.typeText("横屏展开草稿")
        XCTAssertEqual(draft.value as? String, "横屏展开草稿")
        XCTAssertTrue(directory.exists)
        capture("iphone-duo-partial-landscape-right-draft", app: app)
    }

    // FOLD-05: synthetic horizontal hinge isolates surface/keyboard behavior from
    // simulator posture controls; real Duo hinge transitions remain a device QA case.
    func testFoldReadingSurfaceAndKeyboardKeepDraftAndViewport() {
        let app = launch("viewport", arguments: ["--preview-fold-reading", "--preview-reduce-motion"])
        defer { app.terminate() }
        let editor = app.descendants(matching: .any)["chat-composer"].firstMatch
        let surface = app.descendants(matching: .any)["fold-reading-surface"].firstMatch
        let directory = app.buttons["fold-reading-directory"]
        XCTAssertTrue(editor.waitForExistence(timeout: 8))
        XCTAssertTrue(surface.waitForExistence(timeout: 5))
        XCTAssertTrue(surface.isHittable)
        XCTAssertFalse(app.descendants(matching: .any)["persistent-session-directory"].firstMatch.exists)
        let transcript = chatTranscript(app)
        XCTAssertLessThan(transcript.frame.maxY, surface.frame.minY)
        func visibleAnchors() -> [String: CGFloat] {
            let rows = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 "))
                .allElementsBoundByIndex.filter {
                    $0.isHittable && $0.frame.intersects(transcript.frame)
                }
            return Dictionary(rows.map { ($0.label, $0.frame.minY) }, uniquingKeysWith: { first, _ in first })
        }
        func dragSurface(down: Bool) {
            let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.2 : 0.8))
            let end = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.8 : 0.2))
            start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        let initial = visibleAnchors()
        XCTAssertFalse(initial.isEmpty)
        surface.tap()
        XCTAssertEqual(visibleAnchors(), initial, "A resting grip or tap must not page the transcript")
        dragSurface(down: true)
        let pageChanged = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !visibleAnchors().isEmpty && visibleAnchors() != initial
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [pageChanged], timeout: 4), .completed)
        let earlier = visibleAnchors()
        dragSurface(down: false)
        let reversed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !visibleAnchors().isEmpty && visibleAnchors() != earlier
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [reversed], timeout: 4), .completed)
        capture("fold-reading-surface", app: app)

        editor.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "Requires the software keyboard")
        let draft = String(repeating: "折叠屏多行草稿，不发送。\n", count: 6)
        editor.typeText(draft)
        XCTAssertTrue((editor.value as? String)?.contains("折叠屏多行草稿") == true)
        XCTAssertFalse(surface.isHittable)
        XCTAssertLessThanOrEqual(editor.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        XCTAssertLessThanOrEqual(app.buttons["发送消息"].frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        XCTAssertLessThanOrEqual(transcript.frame.maxY, editor.frame.minY)
        let dismiss = app.buttons["收起键盘"]
        XCTAssertTrue(dismiss.isHittable)
        capture("fold-reading-multiline-keyboard", app: app)
        dismiss.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        XCTAssertTrue(surface.isHittable)
        XCTAssertTrue(directory.isHittable)
        directory.tap()
        XCTAssertTrue(app.buttons["关闭会话目录"].waitForExistence(timeout: 4))
        app.buttons["关闭会话目录"].tap()
        XCTAssertTrue((editor.value as? String)?.contains("折叠屏多行草稿") == true)
        capture("fold-reading-restored-draft", app: app)
    }

    // FOLD-05: the operation area fills the gap below navigation, and the three
    // replaced buttons must not survive in either the header or the lower area.
    func testFoldReadingBlankSurfaceReplacesPagingButtons() {
        let app = launch("viewport", arguments: ["--preview-fold-reading", "--preview-reduce-motion"])
        defer { app.terminate() }
        let surface = app.descendants(matching: .any)["fold-reading-surface"].firstMatch
        XCTAssertTrue(surface.waitForExistence(timeout: 8))
        let directory = app.buttons["fold-reading-directory"]
        let downloads = app.buttons["chat-downloads"]
        XCTAssertTrue(directory.isHittable)
        XCTAssertTrue(downloads.isHittable)
        for identifier in ["fold-reading-previous", "fold-reading-latest", "fold-reading-next"] {
            XCTAssertFalse(app.buttons[identifier].exists)
        }
        XCTAssertGreaterThanOrEqual(surface.frame.minY, directory.frame.maxY)
        XCTAssertGreaterThanOrEqual(surface.frame.minY, downloads.frame.maxY)
        XCTAssertGreaterThan(surface.frame.height, 100)
        XCTAssertGreaterThan(surface.frame.width, 300)
        XCTAssertLessThanOrEqual(surface.frame.maxY, app.descendants(matching: .any)["chat-composer"].firstMatch.frame.minY)
        XCTAssertLessThan(chatTranscript(app).frame.maxY, directory.frame.minY)
        capture("fold-reading-blank-operation-area", app: app)
    }

    // FOLD-06: the closed fixture must expose a system tab bar, not a custom
    // header row. Actual Duo vertical placement remains a device posture check.
    func testClosedFoldUsesSystemTabBarAndKeepsPageActions() {
        let app = launch("home", arguments: ["--preview-fold-closed", "--preview-reduce-motion"])
        defer { app.terminate(); XCUIDevice.shared.orientation = .portrait }
        for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            let tabBar = app.tabBars.firstMatch
            XCTAssertTrue(tabBar.waitForExistence(timeout: 8))
            XCTAssertFalse(app.descendants(matching: .any)["root-header-navigation"].firstMatch.exists)
            XCTAssertFalse(app.descendants(matching: .any)["root-bottom-navigation"].firstMatch.exists)
            for tab in ["聊天", "供应商", "设置"] {
                let button = tabBar.buttons[tab]
                XCTAssertTrue(button.isHittable)
                XCTAssertTrue(tabBar.frame.contains(button.frame))
            }
            for action in ["home-downloads", "home-new-session"] {
                let button = app.buttons[action]
                XCTAssertTrue(button.isHittable)
            }
            tabBar.buttons["供应商"].tap()
            XCTAssertTrue(tabBar.buttons["供应商"].isSelected)
            XCTAssertTrue(app.buttons["刷新供应商"].isHittable)
            tabBar.buttons["设置"].tap()
            XCTAssertTrue(app.buttons["settings-connection"].waitForExistence(timeout: 4))
            XCTAssertTrue(tabBar.buttons["设置"].isSelected)
            tabBar.buttons["聊天"].tap()
            XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 4))
            capture(orientation == .portrait ? "closed-fold-root-navigation-portrait" : "closed-fold-root-navigation-landscape", app: app)
        }
    }

    // The desktop Codex backend remains reachable from the four-Agent draft.
    func testDraftCodexLongPressRetainsDesktopBackend() {
        let app = launch("home", arguments: ["--preview-reduce-motion", "--preview-reset-design", "--preview-draft-desktop"])
        let newSession = app.buttons["home-new-session"]
        XCTAssertTrue(newSession.waitForExistence(timeout: 8)); newSession.tap()
        let codex = app.buttons["draft-agent-codex"]
        XCTAssertTrue(codex.waitForExistence(timeout: 4)); codex.press(forDuration: 1)
        let desktop = app.buttons["Codex 桌面版"]
        XCTAssertTrue(desktop.waitForExistence(timeout: 3)); desktop.tap()
        let version = app.buttons["draft-codex-version"]
        XCTAssertTrue(version.waitForExistence(timeout: 3))
        XCTAssertEqual(version.label, "Codex")
        XCTAssertEqual(version.value as? String, "Codex 桌面版")
        // S48 / SC69: the compact trailing label opens the same version menu.
        version.tap()
        let terminal = app.buttons["Codex 终端版"]
        XCTAssertTrue(terminal.waitForExistence(timeout: 3)); terminal.tap()
        XCTAssertEqual(version.value as? String, "Codex 终端版")
        version.tap(); desktop.tap()
        XCTAssertEqual(version.value as? String, "Codex 桌面版")
        capture("design-draft-codex-desktop", app: app)
    }

    // S42 / SC63: a real inner-ring drag must leave the outer ring movable across
    // repeated Agent changes. Check label positions as well as the selected value
    // so a stale rendering state cannot pass merely by updating the selection.
    func testProviderOuterRingMovesAfterRepeatedAgentDrags() {
        for reduced in [false, true] {
            let arguments = ["--preview-reset-design"] + (reduced ? ["--preview-reduce-motion"] : [])
            let app = launch("providers", arguments: arguments)
            let agent = app.descendants(matching: .any)["provider-agent-keyboard"].firstMatch
            let profile = app.descendants(matching: .any)["provider-profile-keyboard"].firstMatch
            XCTAssertTrue(agent.waitForExistence(timeout: 8))
            XCTAssertTrue(profile.waitForExistence(timeout: 4))
            func waitValue(_ element: XCUIElement, _ value: String) {
                let expected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
                XCTAssertEqual(XCTWaiter().wait(for: [expected], timeout: 4), .completed)
            }
            func drag(_ ring: XCUIElement, inset: CGFloat, dy: CGFloat) {
                let frame = ring.frame
                let start = app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: frame.maxX - inset, dy: frame.midY))
                start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: dy)),
                    withVelocity: .slow, thenHoldForDuration: 0.15)
            }
            for (name, travel) in [("Claude Code", CGFloat(-84)), ("DeepSeek", -84), ("Pi", -84), ("Codex", 252)] {
                drag(agent, inset: 30, dy: travel)
                waitValue(agent, name)
                waitValue(profile, "官方服务")
                let official = app.staticTexts["官方服务"].firstMatch
                let team = app.staticTexts["团队供应商"].firstMatch
                XCTAssertTrue(official.waitForExistence(timeout: 3))
                XCTAssertTrue(team.waitForExistence(timeout: 3))
                let officialY = official.frame.midY, teamY = team.frame.midY
                drag(profile, inset: 16, dy: -110)
                waitValue(profile, "团队供应商")
                XCTAssertLessThan(team.frame.midY, teamY - 40, "The drawn outer ring must rotate after changing Agent")
                XCTAssertLessThan(official.frame.midY, officialY - 40)
                XCTAssertTrue(waitUntilEnabled(app.buttons["provider-action-team"], timeout: 3))
                capture("provider-outer-after-\(name)-\(reduced ? "reduced" : "normal")", app: app)
                drag(profile, inset: 16, dy: 110)
                waitValue(profile, "官方服务")
                XCTAssertEqual(official.frame.midY, officialY, accuracy: 2)
                XCTAssertEqual(team.frame.midY, teamY, accuracy: 2)
                if name != "Pi" { XCTAssertFalse(app.buttons["provider-action-official"].isEnabled) }
            }
            app.terminate()
        }
    }

    // SC57: each circle receives physical keys independently; browsing never applies.
    func testProviderDialHardwareKeysOnlyBrowse() {
        let app = launch("providers", arguments: ["--preview-reduce-motion", "--preview-provider-keyboard", "--preview-reset-design"])
        let profile = app.descendants(matching: .any)["provider-profile-keyboard"].firstMatch
        XCTAssertTrue(profile.waitForExistence(timeout: 6))
        profile.typeKey(.end, modifierFlags: [])
        let selectedTeam = NSPredicate(format: "value == %@", "团队供应商")
        XCTAssertTrue(profile.waitForExistence(timeout: 3))
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: selectedTeam, object: profile)], timeout: 3), .completed)
        XCTAssertTrue(app.buttons["provider-action-team"].isEnabled)
        profile.typeKey(.home, modifierFlags: [])
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "官方服务"), object: profile)], timeout: 3), .completed)
        XCTAssertFalse(app.buttons["provider-action-official"].isEnabled)
        profile.typeKey(.tab, modifierFlags: [])
        let agent = app.descendants(matching: .any)["provider-agent-keyboard"].firstMatch
        agent.typeKey(.end, modifierFlags: [])
        XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Pi"), object: agent)], timeout: 3), .completed)
        agent.typeKey(.home, modifierFlags: [])
        capture("design-provider-keyboard-focus", app: app)
    }
    // SC55: native text submission must preserve Shift+Return as a newline.
    func testDraftHardwareReturnAndDesktopOnlySelection() {
        let app = launch("home", arguments: ["--preview-reduce-motion", "--preview-reset-design", "--preview-draft-desktop-only"])
        let newSession = app.buttons["home-new-session"]
        XCTAssertTrue(newSession.waitForExistence(timeout: 8)); newSession.tap()
        let codex = app.buttons["draft-agent-codex"]
        XCTAssertTrue(codex.waitForExistence(timeout: 4)); codex.tap()
        let version = app.buttons["draft-codex-version"]
        XCTAssertTrue(version.waitForExistence(timeout: 3))
        XCTAssertEqual(version.label, "Codex")
        XCTAssertEqual(version.value as? String, "Codex 桌面版")
        let draft = app.descendants(matching: .any)["draft-message"].firstMatch
        draft.tap(); draft.typeText("first ")
        // Commit the current Pinyin candidate before exercising editing commands.
        draft.typeText(XCUIKeyboardKey.delete.rawValue)
        draft.typeKey(.return, modifierFlags: .shift)
        draft.typeText("second")
        XCTAssertEqual(draft.value as? String, "first\nsecond")
        draft.typeKey(.return, modifierFlags: [])
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 4))
    }

    // S53/S54: info is independent of selection, categories retain the draft, and Apply never scrolls away.
    func testQuietPermissionDraftKeepsApplyVisibleAndInfoDoesNotSelect() {
        let app = launch("home", arguments: ["--preview-permission-options", "--preview-reset-design", "--preview-reduce-motion"])
        XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8))
        app.buttons["home-new-session"].tap()
        let entry = app.buttons["draft-config-permissions"]
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        XCTAssertTrue(waitUntilEnabled(entry, timeout: 5)); entry.tap()
        let apply = app.buttons["draft-permissions-apply"]
        XCTAssertTrue(apply.waitForExistence(timeout: 4)); XCTAssertTrue(apply.isHittable); XCTAssertFalse(apply.isEnabled)
        let explanation = "允许读取文件；写入需要额外授权。"
        XCTAssertFalse(app.staticTexts[explanation].exists)
        app.buttons["permission-option-sandbox-readOnly"].tap()
        app.buttons["查看只读说明"].tap()
        XCTAssertTrue(app.staticTexts[explanation].waitForExistence(timeout: 3))
        app.buttons["知道了"].tap()
        XCTAssertTrue(apply.isEnabled)
        app.buttons["permission-tab-network"].tap()
        app.buttons["permission-option-network-enabled"].tap()
        app.buttons["permission-tab-sandbox"].tap()
        XCTAssertTrue(app.buttons["permission-option-sandbox-readOnly"].isSelected)
        XCTAssertTrue(apply.isHittable)
        XCTAssertLessThanOrEqual(apply.frame.maxY, app.frame.maxY)
        capture("quiet-draft-permissions", app: app)
        apply.tap()
        XCTAssertTrue(apply.waitForNonExistence(timeout: 4))
        XCTAssertEqual(entry.label, "权限")
        XCTAssertTrue((entry.value as? String ?? "").contains("只读"))
        XCTAssertTrue((entry.value as? String ?? "").contains("允许联网"))
        entry.tap()
        XCTAssertTrue(apply.waitForExistence(timeout: 4)); XCTAssertFalse(apply.isEnabled)
    }

    // S55 / SC79: all Codex permission values stay outside the card's layout allocation.
    func testDraftConfigurationKeepsModelAndThinkingVisibleWithLongPermissions() {
        let app = launch("home", arguments: ["--preview-permission-options", "--preview-reset-design", "--preview-reduce-motion"])
        XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8))
        app.buttons["home-new-session"].tap()
        let model = app.buttons["draft-config-model"]
        let thinking = app.buttons["draft-config-thinking"]
        let permissions = app.buttons["draft-config-permissions"]
        XCTAssertTrue(model.waitForExistence(timeout: 5)); XCTAssertTrue(waitUntilEnabled(model, timeout: 5))
        XCTAssertTrue(model.isHittable); XCTAssertTrue(thinking.isHittable); XCTAssertTrue(permissions.isHittable)
        XCTAssertEqual(model.value as? String, "GPT-5.4")
        XCTAssertEqual(thinking.value as? String, "高")
        XCTAssertEqual(permissions.label, "权限")
        XCTAssertGreaterThan((permissions.value as? String ?? "").count, 12)
        XCTAssertLessThanOrEqual(model.frame.maxY, thinking.frame.minY)
        XCTAssertLessThan(thinking.frame.maxX, permissions.frame.minX)
        XCTAssertEqual(thinking.frame.width, permissions.frame.width, accuracy: 1)
        XCTAssertEqual(model.frame.minX, thinking.frame.minX, accuracy: 1)
        XCTAssertEqual(model.frame.maxX, permissions.frame.maxX, accuracy: 1)
        capture("draft-config-full-model-and-thinking", app: app)
        thinking.tap()
        XCTAssertTrue(app.staticTexts["思考深度"].waitForExistence(timeout: 3))
    }

    func testPairingExplanationOnlyOpensFromTitleInfo() {
        let app = launch("pairing", arguments: ["--preview-reduce-motion"])
        let info = app.buttons["pairing-info"]
        XCTAssertTrue(info.waitForExistence(timeout: 5))
        let explanation = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "电脑端请前往")).firstMatch
        XCTAssertFalse(explanation.exists)
        capture("quiet-pairing-entry", app: app)
        info.tap()
        XCTAssertTrue(explanation.waitForExistence(timeout: 3))
        app.buttons["知道了"].tap()
        XCTAssertTrue(app.buttons["扫码配对"].isHittable)
    }

    private func launch(_ screen: String, dark: Bool = false, arguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--preview-screen=" + screen] + arguments
        // IOS-CHAT-06: rerun the original assertions with exactly one diagnostic candidate.
        let environment = ProcessInfo.processInfo.environment
        if environment["ORBIS_CHAT_TRANSCRIPT_BACKEND"] == "swiftui" {
            app.launchArguments.append("--preview-swiftui-transcript")
        }
        if environment["ORBIS_CHAT_ANCHOR_DIAGNOSTICS"] == "1" {
            app.launchArguments.append("--preview-anchor-diagnostics")
            if let candidate = environment["ORBIS_CHAT_ANCHOR_CANDIDATE"],
               ["reading-top", "unbound-reading", "below-only"].contains(candidate) {
                app.launchArguments.append("--preview-anchor-candidate=" + candidate)
            }
        }
        if !arguments.contains(where: { $0.hasPrefix("--preview-language=") }) {
            app.launchArguments.append("--preview-language=zh-Hans")
        }
        if dark { app.launchArguments.append("--preview-dark") }
        app.launch()
        return app
    }

    // MATH-01: native paragraph/table hosts must size real offline math and survive completion.
    func testMathRenderingUsesOfflineFragmentsAndKeepsStreamFallback() {
        for dark in [false, true] {
            let app = launch("math", dark: dark, arguments: ["--preview-reduce-motion"])
            XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
            let all = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                app.webViews.count >= 4 && app.webViews.allElementsBoundByIndex.allSatisfy { $0.frame.height > 10 }
            }, object: nil)
            XCTAssertEqual(XCTWaiter().wait(for: [all], timeout: 15), .completed)
            capture(dark ? "math-dark" : "math-light", app: app)
            app.buttons["math-complete"].tap()
            let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.webViews.count >= 5 }, object: nil)
            XCTAssertEqual(XCTWaiter().wait(for: [completed], timeout: 15), .completed)
            capture(dark ? "math-completed-dark" : "math-completed-light", app: app)
            app.terminate()
        }
    }
    private func waitUntilEnabled(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: element)
        return XCTWaiter().wait(for: [enabled], timeout: timeout) == .completed
    }
    /// Lets a short state transition (the capsule's 0.16 s fade) settle before a screenshot.
    private func settle() { _ = XCTWaiter().wait(for: [XCTestExpectation(description: "settle")], timeout: 0.5) }
    /// M14: a covered page stays mounted under the top page, and XCUITest's snapshot lists it
    /// even though SwiftUI hides it from accessibility. These read what assistive technologies
    /// reach instead (`--probe-accessibility-reach`); `key` is "identifier|" or "|label".
    private func reachable(_ app: XCUIApplication, _ key: String) -> Bool {
        let lines = ((app.staticTexts["accessibility-reach"].value as? String) ?? "").split(separator: "\n")
        return lines.contains { key.hasSuffix("|") ? $0.hasPrefix(key) : $0.hasSuffix(key) }
    }
    private func waitReachable(_ app: XCUIApplication, _ key: String, _ expected: Bool,
                               file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(3)
        while reachable(app, key) != expected && Date() < deadline { settle() }
        let report = (app.staticTexts["accessibility-reach"].value as? String) ?? "<no probe>"
        XCTAssertEqual(reachable(app, key), expected, "\(key) reachable in:\n\(report.prefix(1500))", file: file, line: line)
    }
    private func waitForY(_ element: XCUIElement, _ y: CGFloat, operation: String) {
        let position = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            element.exists && abs(element.frame.minY - y) <= 1
        }, object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [position], timeout: 5), .completed, operation)
        XCTAssertEqual(element.frame.minY, y, accuracy: 1, operation)
    }
    private func capture(_ name: String, app: XCUIApplication) {
        // App-cropped screenshots use portrait bounds for a landscape iPad.
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways
        add(screenshot)
    }
    private func changedPixels(_ first: UIImage, _ second: UIImage) -> Int {
        guard let left = first.cgImage, let right = second.cgImage,
              left.width == right.width, left.height == right.height else { return -1 }
        let width = left.width, height = left.height
        var firstPixels = [UInt8](repeating: 0, count: width * height * 4)
        var secondPixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let firstContext = CGContext(data: &firstPixels, width: width, height: height, bitsPerComponent: 8,
                                           bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                           bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let secondContext = CGContext(data: &secondPixels, width: width, height: height, bitsPerComponent: 8,
                                            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return -1 }
        firstContext.draw(left, in: CGRect(x: 0, y: 0, width: width, height: height))
        secondContext.draw(right, in: CGRect(x: 0, y: 0, width: width, height: height))
        return stride(from: 0, to: firstPixels.count, by: 4).filter { offset in
            (0..<3).contains { abs(Int(firstPixels[offset + $0]) - Int(secondPixels[offset + $0])) > 2 }
        }.count
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

    func testReplyCardGrowthAndNewCardKeepExistingTextGeometry() {
        let variants: [(String, Bool, [String])] = [
            ("light", false, []), ("dark", true, []), ("reduced", false, ["--preview-reduce-motion"]),
            ("large", false, ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        ]
        for (name, dark, arguments) in variants {
            let app = launch("reply-motion", dark: dark, arguments: arguments)
            let card = app.otherElements["reply-card"]
            XCTAssertTrue(card.waitForExistence(timeout: 8))
            let anchor = app.staticTexts["reply-anchor"].frame
            let anchorOffset = anchor.minY - card.frame.minY
            let initial = card.frame.height
            app.buttons["reply-append"].tap()
            settle()
            XCTAssertGreaterThan(card.frame.height, initial)
            XCTAssertEqual(app.staticTexts["reply-anchor"].frame.minY - card.frame.minY, anchorOffset, accuracy: 1)
            capture("reply-growth-\(name)", app: app)
            app.buttons["reply-new"].tap()
            let newCard = app.otherElements["reply-new-card"]
            XCTAssertTrue(newCard.waitForExistence(timeout: 4))
            settle()
            XCTAssertGreaterThan(newCard.frame.height, 40)
            XCTAssertEqual(app.staticTexts["reply-anchor"].frame.minY - card.frame.minY, anchorOffset, accuracy: 1)
            capture("reply-arrival-\(name)", app: app)
            app.buttons["reply-rewrite"].tap()
            settle()
            XCTAssertEqual(card.frame.height, initial, accuracy: 1)
            app.terminate()
        }
    }

    func testStreamingRevealWithReducedMotionShowsEveryBlockImmediately() {
        let app = launch("reveal", arguments: ["--preview-reduce-motion"])
        let next = app.buttons["reveal-next-frame"]
        XCTAssertTrue(next.waitForExistence(timeout: 8))
        next.tap(); next.tap()
        for label in ["SECOND", "THIRD", "FOURTH"] { XCTAssertGreaterThan(inkPixels(app.staticTexts[label]), 10) }
        capture("streaming-reduced-motion-direct", app: app)
    }

    // SC89 / M03: a tool disclosure must carry the surrounding reply surface through
    // intermediate heights, without moving its header, overshooting or snapping on first open.
    func testToolDisclosureAnimatesReplyLayoutContinuously() throws {
        for reduced in [false, true] {
            let app = launch("reply-motion", arguments: ["--preview-reply-disclosure"] + (reduced ? ["--preview-reduce-motion"] : []))
            let toggle = app.buttons["reply-disclosure-toggle"]
            XCTAssertTrue(toggle.waitForExistence(timeout: 8))
            for opening in [true, false, true] {
                toggle.tap()
                let samples = try replyDisclosureFrames(app)
                let first = try XCTUnwrap(samples.first), last = try XCTUnwrap(samples.last)
                XCTAssertGreaterThan(samples.count, 3)
                XCTAssertGreaterThan((last[2] - first[2]) * (opening ? 1 : -1), 100)
                for sample in samples {
                    XCTAssertEqual(sample[0], first[0], accuracy: 1, "Reply header moved during disclosure")
                    XCTAssertEqual(sample[1], first[1], accuracy: 1, "Reply width changed during disclosure")
                }
                for (before, after) in zip(samples, samples.dropFirst()) {
                    XCTAssertGreaterThanOrEqual((after[2] - before[2]) * (opening ? 1 : -1), -1,
                                                "Disclosure reversed direction")
                }
                if !reduced {
                    let low = min(first[2], last[2]), high = max(first[2], last[2])
                    XCTAssertGreaterThan(samples.filter { $0[2] > low + 1 && $0[2] < high - 1 }.count, 2,
                                         "Reply snapped instead of following the disclosure animation")
                }
            }
            app.terminate()
        }
    }

    // Keep the independent streaming-height animation when a disclosure uses natural layout.
    func testReplyGrowthRemainsContinuousWithExpandedTool() throws {
        let app = launch("reply-motion", arguments: ["--preview-reply-disclosure"])
        let toggle = app.buttons["reply-disclosure-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 8))
        toggle.tap()
        _ = try replyDisclosureFrames(app)
        app.buttons["reply-append"].tap()
        let samples = try replyDisclosureFrames(app)
        let first = try XCTUnwrap(samples.first), last = try XCTUnwrap(samples.last)
        XCTAssertGreaterThan(last[2] - first[2], 30)
        XCTAssertGreaterThan(samples.filter { $0[2] > first[2] + 1 && $0[2] < last[2] - 1 }.count, 2)
        for (before, after) in zip(samples, samples.dropFirst()) {
            XCTAssertGreaterThanOrEqual(after[2] - before[2], -1, "Streaming growth jumped then reversed")
            XCTAssertEqual(after[0], first[0], accuracy: 1)
            XCTAssertEqual(after[1], first[1], accuracy: 1)
        }
        app.terminate()
    }

    private func replyDisclosureFrames(_ app: XCUIApplication) throws -> [[Double]] {
        let report = app.staticTexts["reply-disclosure-frames"]
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH '['"), object: report)
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 3), .completed)
        print("DISCLOSURE_FRAMES \(report.label)")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(report.label.utf8)) as? [[Double]])
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

    func testHomePullRefreshReturnsListToItsStartingPosition() {
        checkHomePullRefresh(name: "light")
    }

    func testHomePullRefreshInDarkLargeTextAndReducedMotion() {
        checkHomePullRefresh(name: "dark", dark: true)
        checkHomePullRefresh(name: "large", arguments: ["-UIPreferredContentSizeCategoryName",
                                                     UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue])
        checkHomePullRefresh(name: "reduced", arguments: ["--preview-reduce-motion"])
    }

    func testHomePullRefreshIgnoresShortPullsAndSelection() {
        let app = launch("home", arguments: ["--preview-home-long-list", "--preview-home-refresh-probe"])
        let list = app.scrollViews["home-session-list"]
        let first = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(first.waitForExistence(timeout: 8))
        let reads = app.staticTexts["preview-home-model-reads"]
        XCTAssertTrue(reads.waitForExistence(timeout: 5))
        let originalReads = reads.label, originalY = first.frame.minY
        let pull = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
        pull.press(forDuration: 0.05, thenDragTo: pull.withOffset(CGVector(dx: 0, dy: 60)),
                   withVelocity: .slow, thenHoldForDuration: 0.1)
        waitForY(first, originalY, operation: "short pull")
        XCTAssertEqual(reads.label, originalReads, "A short pull must not refresh")
        first.press(forDuration: 0.8)
        XCTAssertTrue(app.staticTexts["已选择 1 项"].waitForExistence(timeout: 3))
        pull.press(forDuration: 0.05, thenDragTo: pull.withOffset(CGVector(dx: 0, dy: 360)),
                   withVelocity: .slow, thenHoldForDuration: 0.25)
        waitForY(first, originalY, operation: "selection pull")
        XCTAssertEqual(reads.label, originalReads, "Selection mode must not refresh")
        XCTAssertTrue(app.staticTexts["已选择 1 项"].exists)
        capture("home-pull-refresh-selection-kept", app: app)
    }

    private func checkHomePullRefresh(name: String, dark: Bool = false, arguments: [String] = []) {
        let app = launch("home", dark: dark, arguments: ["--preview-home-long-list", "--preview-home-refresh-probe"] + arguments)
        let list = app.scrollViews["home-session-list"]
        let first = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(first.waitForExistence(timeout: 8))
        let reads = app.staticTexts["preview-home-model-reads"]
        XCTAssertTrue(reads.waitForExistence(timeout: 5))
        let readsBeforePull = Int(reads.label) ?? -1
        XCTAssertGreaterThanOrEqual(readsBeforePull, 1)
        let firstY = first.frame.minY

        let pull = list.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12))
        pull.press(forDuration: 0.05,
                   thenDragTo: pull.withOffset(CGVector(dx: 0, dy: 360)),
                   withVelocity: .slow,
                   thenHoldForDuration: 0.25)
        let oneMoreRead = NSPredicate(format: "label == %@", String(readsBeforePull + 1))
        _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: oneMoreRead, object: reads)], timeout: 5)
        XCTAssertEqual(reads.label, String(readsBeforePull + 1),
                       "A single pull must request the runtime model exactly once")
        waitForY(first, firstY, operation: "pull-to-refresh must return the list to its starting position")
        XCTAssertTrue(app.buttons["home-runtime-preview-pi"].isHittable,
                      "Cards must remain interactive after the refresh rebound")
        XCTAssertEqual(reads.label, String(readsBeforePull + 1), "The rebound must not issue a second refresh")
        capture("home-pull-refresh-restored-" + name, app: app)
        app.terminate()
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
        // The scope caveat is a low-interference info disclosure (583dcdbb), not inline copy.
        XCTAssertTrue(app.staticTexts["记录不完整"].exists)
        XCTAssertFalse(app.staticTexts["仅记录 Codex 文件工具变更"].exists)
        app.buttons["查看记录不完整说明"].tap()
        XCTAssertTrue(app.staticTexts["仅记录 Codex 文件工具变更"].waitForExistence(timeout: 3))
        app.buttons["知道了"].tap()
        XCTAssertTrue(app.staticTexts["仅记录 Codex 文件工具变更"].waitForNonExistence(timeout: 3))
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
        // One compact block after the card holding the anchored message (91953f11, both apps).
        // A current Host anchors the turn's last agent message; this fixture keeps an older
        // Host's mid-turn anchor on the first of five steps, so the block follows the first card
        // (steps 1–4) and precedes the final step. The header opens the viewer, then one row per file.
        XCTAssertTrue(open.label.contains("3 个文件已更改"))
        XCTAssertEqual(app.buttons.matching(identifier: "turn-changes-open-preview-review").count, 1)
        let anchoredCardEnd = app.staticTexts["测试通过。"].frame, nextCard = app.staticTexts["已完成本轮文件修改。"].frame
        XCTAssertGreaterThanOrEqual(nextCard.minY, anchoredCardEnd.maxY)
        XCTAssertGreaterThanOrEqual(open.frame.minY, anchoredCardEnd.maxY)
        let rows = ["change-1", "change-2", "change-3"].map { app.buttons["turn-change-file-" + $0].frame }
        XCTAssertLessThanOrEqual(rows[2].maxY, nextCard.minY)
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
            // Keep content and sync assertions in every run; measure time only on an explicit device baseline.
            if ProcessInfo.processInfo.environment["ORBIS_PERFORMANCE_REGRESSION"] == "1" {
                XCTAssertLessThan(drawMs, entry == 1 ? 1200 : 500)
            }
            XCTAssertTrue(app.staticTexts["ENTRY_LATEST"].isHittable)
            XCTAssertEqual(Int(app.staticTexts["chat-entry-sync-count"].label), syncsBefore + 1)
            if entry == 3 { capture("long-turn-entry-segments", app: app) }
            app.buttons["返回"].firstMatch.tap()
            XCTAssertTrue(card.waitForExistence(timeout: 5))
        }
    }

    // PERF-10: a push builds the long chat before its slide starts, then neither the slide nor a
    // return (back control or swipe) loses frames to main-thread work. Records always print;
    // frame budgets apply only on an explicit device baseline, like the entry timing above.
    func testPageMotionKeepsFramesDuringChatEntryAndReturn() {
        assertPageMotionKeepsFramesDuringChatEntryAndReturn()
    }

    // IOS-CHAT-18: sample in-process from the start of the entry slide, since
    // XCUI's idle wait hides transient reflow. The preview flag selects the real
    // system TabView path; only a Duo device can verify its vertical placement.
    func testSystemTabChatReentryKeepsMessageGeometryStable() throws {
        let app = launch("entry", arguments: ["--preview-fold-closed", "--preview-entry-long-turn",
                                              "--preview-scroll-frames", "--preview-entry-frames"])
        defer { app.terminate() }
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        for entry in 1...3 {
            card.tap()
            let samples = try chatScrollFrames(app)
            XCTAssertGreaterThan(samples.count, 6)
            XCTAssertLessThan(try XCTUnwrap(samples.first).time, 0.05,
                              "Sampling must start with the slide, not after XCUI becomes idle")
            var comparisons = 0
            for (before, after) in zip(samples, samples.dropFirst()) {
                for (id, frame) in after.cells ?? [:] {
                    guard let previous = before.cells?[id] else { continue }
                    comparisons += 1
                    XCTAssertEqual(frame[0], previous[0], accuracy: 1,
                                   "Entry \(entry): message moved vertically: \(id)")
                    XCTAssertEqual(frame[1], previous[1], accuracy: 1,
                                   "Entry \(entry): message width changed: \(id)")
                    XCTAssertEqual(frame[2], previous[2], accuracy: 1,
                                   "Entry \(entry): message height changed: \(id)")
                }
            }
            XCTAssertGreaterThan(comparisons, 6, "Compare actual native cells throughout entry")
            XCTAssertTrue(app.staticTexts["ENTRY_LATEST"].isHittable)
            let attachment = XCTAttachment(string: (app.buttons["chat-title"].value as? String) ?? "")
            attachment.name = "SYSTEM_TAB_ENTRY_\(entry)"
            attachment.lifetime = .keepAlways
            add(attachment)
            app.buttons["返回"].firstMatch.tap()
            XCTAssertTrue(card.waitForExistence(timeout: 5))
        }
    }

    // IOS-CHAT-10-R1: two appearance callbacks for one prepared token must retain
    // the complete entry slide and both existing return paths.
    func testRepeatedPageAppearanceDoesNotRestartTheEntryAnimation() {
        assertPageMotionKeepsFramesDuringChatEntryAndReturn(arguments: ["--preview-repeat-page-appearance"])
    }

    private func assertPageMotionKeepsFramesDuringChatEntryAndReturn(arguments: [String] = []) {
        let app = launch("entry", arguments: ["--measure-page-motion", "--preview-entry-long-turn"] + arguments)
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        let report = app.staticTexts["page-motion-metrics"]
        let budget = ProcessInfo.processInfo.environment["ORBIS_PERFORMANCE_REGRESSION"] == "1"
        var count = 0
        func record(_ kind: String) -> [String: Double] {
            count += 1
            let done = NSPredicate(format: "label BEGINSWITH %@", "count=\(count);")
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: done, object: report)], timeout: 10), .completed)
            print("OrbisPageMotion \(kind) \(report.label)")
            let values = Dictionary(uniqueKeysWithValues: report.label.split(separator: ";").compactMap { part -> (String, Double)? in
                let pair = part.split(separator: "=", maxSplits: 1)
                guard pair.count == 2, let number = Double(pair[1]) else { return nil }
                return (String(pair[0]), number)
            })
            XCTAssertGreaterThan(values["frames"] ?? 0, 3, "the motion must be measured over its own frames")
            if budget {
                XCTAssertEqual(values["long"], 0, kind + " dropped frames")
                XCTAssertLessThan(values["maxGapMs"] ?? .infinity, 34, kind)
            }
            return values
        }
        for entry in 1...2 {
            card.tap()
            let push = record("push-\(entry)")
            XCTAssertGreaterThan(push["startMs"] ?? 0, 0, "the slide starts after the page is built")
            XCTAssertTrue(app.staticTexts["ENTRY_LATEST"].waitForExistence(timeout: 5))
            if entry == 1 {
                app.buttons["返回"].firstMatch.tap()
            } else {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                           withVelocity: .slow, thenHoldForDuration: 0.1)
            }
            _ = record(entry == 1 ? "return-control" : "return-swipe")
            XCTAssertTrue(card.waitForExistence(timeout: 5))
            XCTAssertTrue(card.isHittable)
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
    func testChatHeaderKeepsNavigationActionsWithoutManualRefresh() throws {
        let app = launch("chat", arguments: ["--preview-slow-sync"])
        let title = app.descendants(matching: .any)["chat-title"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["历史与分支"].exists)
        XCTAssertTrue(app.buttons["下载"].exists)
        XCTAssertFalse(app.buttons["刷新"].exists)
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
            let frame = title.frame
            XCTAssertFalse(app.buttons["刷新"].exists)
            XCTAssertTrue(title.label.contains("压缩中"))
            XCTAssertEqual(frame, title.frame)
            capture("compaction-chat-\(dark ? "dark" : "light")", app: app)
            XCTAssertEqual(frame, title.frame)
            app.buttons["返回"].firstMatch.tap()
            app.buttons["打开会话目录"].tap()
            XCTAssertTrue(app.staticTexts["压缩中"].firstMatch.waitForExistence(timeout: 5))
            capture("compaction-drawer-\(dark ? "dark" : "light")", app: app)
            app.terminate()
        }
    }
    // S49 / SC70: the raised card offers a start action while empty and enters
    // the existing launch page without fabricating a first user message.
    func testEmptyDraftStartsWithoutAFirstMessage() {
        let app = launch("home", arguments: ["--preview-reset-design", "--preview-launch-slow"])
        XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8))
        app.buttons["home-new-session"].tap()
        let start = app.buttons["draft-send"]
        XCTAssertTrue(start.waitForExistence(timeout: 4))
        XCTAssertTrue(waitUntilEnabled(start, timeout: 3))
        XCTAssertEqual(start.label, "启动")
        XCTAssertFalse(app.staticTexts["发出第一句话，才会在电脑上创建这个会话"].exists)
        let input = app.descendants(matching: .any)["draft-message"].firstMatch
        input.tap(); input.typeText("a")
        XCTAssertEqual(start.label, "发送")
        input.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertEqual(start.label, "启动")
        capture("draft-empty-start", app: app)
        start.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["等待会话启动"].exists)
        XCTAssertTrue(input.waitForNonExistence(timeout: 3))
        capture("draft-empty-launched", app: app)
    }

    func testHomeDirectorySearchAndNewSession() {
        let app = launch("home")
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 8))
        app.buttons["打开会话目录"].tap()
        let search = app.textFields["搜索目录或会话"]
        XCTAssertTrue(search.waitForExistence(timeout: 3)); search.tap(); search.typeText("no-matching-session")
        XCTAssertTrue(app.staticTexts["没有匹配的会话"].waitForExistence(timeout: 3))
        app.buttons["清除搜索"].tap()
        app.buttons["新建会话"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["session-draft"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["draft-send"].exists)
        XCTAssertTrue(app.buttons["draft-send"].isEnabled)
        XCTAssertEqual(app.buttons["draft-send"].label, "启动")
        capture("new-session-local-draft", app: app)
    }

    /// SC84: saving keeps the confirmed model and a separate progress mark; header geometry and send prerequisites remain stable.
    func testModelSwitchShowsTheChoiceWithItsMarkWithoutMovingTheHeader() {
        let app = launch("chat", arguments: ["--preview-reduce-motion"])
        let title = app.descendants(matching: .any)["chat-title"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        let before = title.frame
        // V10 r27 / §6.2：切换中发送的消息立即出现并清空输入，标明在等模型切换。
        let text = "等模型切好再发"
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        composer.tap(); composer.typeText(text)
        // Start the real operation after keyboard setup, so slow device automation
        // cannot exhaust its unchanged 15-second confirmation deadline beforehand.
        title.tap(); app.buttons["session-config-model"].tap()
        let choice = app.buttons["session-config-option-model-a"]
        if !choice.isHittable { app.scrollViews["session-model-configuration"].swipeUp() }
        choice.tap()
        XCTAssertTrue(app.staticTexts["模型与深度"].waitForNonExistence(timeout: 3))
        XCTAssertEqual(title.frame.minY, before.minY, accuracy: 1)
        XCTAssertEqual(title.frame.height, before.height, accuracy: 1)
        capture("model-switching-header", app: app)
        app.buttons["发送消息"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 1))
        XCTAssertTrue(app.staticTexts["等待模型切换"].waitForExistence(timeout: 1))
        XCTAssertEqual((composer.value as? String)?.contains(text), false)
        capture("model-switching-waiting-send", app: app)
        title.tap()
        let fact = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "默认模型，保存中")).firstMatch
        XCTAssertTrue(fact.waitForExistence(timeout: 3))
        capture("model-switching-facts", app: app)
    }

    // SC84: real header/sheet interaction preserves unsent input, separates this
    // turn from the next choice, and safely falls back with an older Host.
    func testSessionModelPanelSeparatesTurnsAndPreservesDraft() {
        for legacy in [false, true] {
            let args = ["--preview-current-turn", "--preview-reduce-motion"] + (legacy ? ["--preview-old-turn-host"] : [])
            let app = launch("chat", arguments: args)
            let title = app.descendants(matching: .any)["chat-title"].firstMatch
            let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
            XCTAssertTrue(composer.waitForExistence(timeout: 8))
            composer.tap(); composer.typeText("keep config draft")
            title.tap()
            XCTAssertTrue(app.staticTexts["模型与深度"].waitForExistence(timeout: 5))
            XCTAssertEqual(app.staticTexts["session-current-model"].label, legacy ? "模型未确认" : "GPT-5.3")
            XCTAssertEqual(app.staticTexts["session-selected-model"].label, "GPT-5.4")
            XCTAssertTrue(app.staticTexts["本轮使用"].exists)
            XCTAssertTrue(app.staticTexts[legacy ? "当前所选" : "下轮使用"].exists)
            capture(legacy ? "session-config-old-host" : "session-config-current-next", app: app)
            app.buttons["session-config-model"].tap()
            let option = app.buttons["session-config-option-model-a"]
            if !option.isHittable { app.scrollViews["session-model-configuration"].swipeUp() }
            XCTAssertTrue(option.waitForExistence(timeout: 5)); option.tap()
            XCTAssertTrue(app.staticTexts["模型与深度"].waitForNonExistence(timeout: 3))
            XCTAssertEqual(composer.value as? String, "keep config draft")
            XCTAssertTrue((title.value as? String)?.contains(legacy ? "模型未确认" : "GPT-5.3") == true)
            XCTAssertTrue((title.value as? String)?.contains("保存中") == true)
            app.terminate()
        }
    }

    // SC86: an unchanged running selection must not create a next-turn section.
    func testUnchangedSessionModelPanelShowsOneConfiguration() {
        let app = launch("chat", arguments: ["--preview-current-turn", "--preview-unchanged-turn", "--preview-reduce-motion"])
        let title = app.descendants(matching: .any)["chat-title"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 8)); title.tap()
        XCTAssertTrue(app.staticTexts["模型与深度"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["session-current-model"].label, "GPT-5.4")
        XCTAssertFalse(app.staticTexts["session-selected-model"].exists)
        XCTAssertFalse(app.staticTexts["下轮使用"].exists)
        XCTAssertFalse(app.staticTexts["后续选择"].exists)
        capture("session-config-unchanged", app: app)
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
        // 气泡的标识会覆盖子元素的标识；简体中文下系统以顿号合并“文件名、状态”。
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "截图.png、")).firstMatch
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

            // The dedicated launch/retry regression covers the default light appearance.
            if name != "light" {
                let home = openNewPiSession(dark: dark, arguments: ["--preview-launch-fail"] + options)
                let starting = home.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "启动中")).firstMatch
                XCTAssertTrue(starting.waitForExistence(timeout: 2), name)
                capture("optimistic-launch-starting-" + name, app: home)
                _ = waitForSessionLaunchFailure(home)
                capture("optimistic-launch-failed-" + name, app: home)
                home.terminate()
            }

            // 上传中发送：气泡内的缩略图、文件名与进度在各外观下完整显示（V10 r27）。
            let chat = launch("chat", dark: dark, arguments: ["--preview-upload-waiting"] + options)
            let chatComposer = chat.descendants(matching: .any)["chat-composer"].firstMatch
            XCTAssertTrue(chatComposer.waitForExistence(timeout: 8), name)
            XCTAssertTrue(chat.buttons["移除附件 截图.png"].waitForExistence(timeout: 5), name)
            chatComposer.tap(); chatComposer.typeText("看图")
            let send = chat.buttons["发送消息"].firstMatch
            XCTAssertTrue(waitUntilEnabled(send, timeout: 2), name)
            send.tap()
            let chip = chat.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "截图.png、")).firstMatch
            XCTAssertTrue(chip.waitForExistence(timeout: 2), name)
            XCTAssertTrue(chip.frame.width > 0 && chip.frame.maxX <= chat.frame.maxX + 1, name)
            capture("optimistic-upload-waiting-" + name, app: chat)
            chat.terminate()
        }
    }

    // Shared navigation for launch failure, appearance and startup-message regressions.
    private func openNewPiSession(dark: Bool = false, arguments: [String]) -> XCUIApplication {
        let app = launch("home", dark: dark, arguments: arguments)
        XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8))
        app.buttons["home-new-session"].tap()
        let pi = app.buttons["draft-agent-pi"]
        XCTAssertTrue(pi.waitForExistence(timeout: 3)); pi.tap()
        let input = app.descendants(matching: .any)["draft-message"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 3)); input.tap(); input.typeText("开始测试会话")
        let send = app.buttons["draft-send"]
        XCTAssertTrue(waitUntilEnabled(send, timeout: 3)); send.tap()
        return app
    }

    private func waitForSessionLaunchFailure(_ app: XCUIApplication) -> XCUIElement {
        let failure = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "启动失败：对应的 agent 后端未就绪")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["launch-retry"].isHittable)
        XCTAssertTrue(app.buttons["launch-back"].isHittable)
        return failure
    }

    /// V12 r27 / ADR-0049 §6.8：确认新建后立即进入聊天页并显示“启动中”，输入框可用；Host 拒绝时在原位说明，
    /// “重试”用同一目标发起新请求，“返回”回到首页。
    func testNewSessionEntersChatAtOnceAndFailureOffersRetryInPlace() {
        let app = openNewPiSession(arguments: ["--preview-launch-fail"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 2), "The chat page must open before the Host answers")
        let starting = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "启动中")).firstMatch
        XCTAssertTrue(starting.waitForExistence(timeout: 1))
        let title = app.descendants(matching: .any)["chat-title"].firstMatch
        XCTAssertTrue(title.label.contains("开始测试会话"), title.label)
        XCTAssertFalse(title.label.contains("launch:"), title.label)
        capture("launch-starting", app: app)
        let failure = waitForSessionLaunchFailure(app)
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
        let app = openNewPiSession(arguments: ["--preview-launch-slow"])
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
            XCTAssertTrue(app.buttons["home-new-session"].waitForExistence(timeout: 8), name)
            app.buttons["home-new-session"].tap()
            let deepSeek = app.buttons["draft-agent-dsh"]
            XCTAssertTrue(deepSeek.waitForExistence(timeout: 3), name)
            XCTAssertTrue(deepSeek.isEnabled, name)
            deepSeek.tap()
            XCTAssertTrue(deepSeek.isSelected)
            XCTAssertTrue(app.descendants(matching: .any)["draft-message"].exists, name)
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
        XCTAssertTrue(card.isEnabled)
        card.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 3))
        app.buttons["返回"].firstMatch.tap()
        XCTAssertTrue(card.waitForExistence(timeout: 3))
        capture("home-after-directory-replay", app: app)
    }
    func testHomePublishesCompleteSnapshotsWithoutReturningToLoading() {
        let app = launch("home", arguments: ["--preview-home-staged"])
        let preparing = app.descendants(matching: .any)["home-loading-skeleton"].firstMatch
        let syncing = app.descendants(matching: .any).matching(identifier: "home-connection-indicator")
            .matching(NSPredicate(format: "value == %@", "正在同步")).firstMatch
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
        // SC53: background sync changes the raised dot's accessible value, keeping text and cards still.
        let pillFrame = pill.frame
        XCTAssertTrue(syncing.waitForExistence(timeout: 8))
        XCTAssertFalse(app.staticTexts["正在同步"].exists)
        XCTAssertTrue(app.staticTexts["局域网"].exists)
        XCTAssertEqual(pill.frame, pillFrame)
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
            let syncing = app.descendants(matching: .any).matching(identifier: "home-connection-indicator")
                .matching(NSPredicate(format: "value == %@", "正在同步")).firstMatch
            XCTAssertTrue(syncing.waitForExistence(timeout: 4))
            XCTAssertFalse(app.staticTexts["正在同步"].exists)
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
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -originalFrame.width * 0.30, dy: 0)))
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
        let app = launch("chat", arguments: ["--probe-accessibility-reach"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.55))
        start.press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.32, dy: 0.55)),
                    withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(composer.isHittable)
        waitReachable(app, "chat-composer|", true)
        waitReachable(app, "|打开会话目录", false)
        capture("chat-swipe-rebounded", app: app)
        start.press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.55)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
        XCTAssertFalse(composer.exists)
        capture("chat-swipe-home", app: app)
    }
    // V21 / M14: returning from chat keeps the previously scrolled home card stationary.
    func testScrolledHomeKeepsCardPositionAfterChatReturn() {
        XCUIDevice.shared.orientation = .portrait
        let app = launch("home", arguments: ["--preview-home-long-list", "--preview-viewport-controls"])
        let list = app.scrollViews["home-session-list"]
        XCTAssertTrue(app.buttons["home-runtime-preview-codex"].waitForExistence(timeout: 8))
        settle()
        list.swipeUp()
        settle()
        let candidates = (9...12).map { app.buttons["home-runtime-preview-scroll-\($0)"] }
        let card = candidates.first(where: {
            let frame = $0.frame
            return $0.exists && frame.minY >= list.frame.minY && frame.maxY <= list.frame.maxY
        })
        guard let card else {
            return XCTFail("no fully visible card after scrolling; list=\(list.frame); app=\(app.frame)")
        }
        let before = card.frame
        // XCTest's hit-test snapshot can mark a visible SwiftUI button as non-hittable
        // on the iPad split layout. Tap the visible point and still require chat to open.
        app.coordinate(withNormalizedOffset: CGVector(dx: before.midX / app.frame.width,
                                                       dy: before.midY / app.frame.height)).tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 3))
        // The root stays live under chat; its updated sessions must be present on return.
        let insert = app.buttons["preview-list-insert"]
        insert.tap()
        XCTAssertEqual(insert.value as? String, "1", "the synthetic update must actually be dispatched underneath chat")
        settle()
        // On iPad the persistent session directory occupies the left side; begin
        // the back gesture inside the chat surface rather than in that sidebar.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: app.frame.width > 600 ? 0.42 : 0.15, dy: 0.55))
        start.press(forDuration: 0.05,
                    thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.55)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(card.waitForExistence(timeout: 3))
        XCTAssertEqual(card.frame.minY, before.minY, accuracy: 1)
        settle()
        XCTAssertEqual(card.frame.minY, before.minY, accuracy: 1)
        let inserted = app.buttons["home-runtime-preview-new"]
        let listAfterReturn = app.scrollViews["home-session-list"]
        // The synthetic session has the newest modifiedAt, so it is above the retained viewport.
        for _ in 0..<8 where !inserted.exists { listAfterReturn.swipeDown() }
        XCTAssertTrue(inserted.exists, "a home session added underneath chat must appear when returning")
        capture("scrolled-home-after-chat-return", app: app)
    }
    // ADR-0046 §6 / V21: a session closing above the viewport does not move the cards being read.
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

    // ADR-0058 M16: a queued download flies from the tap toward the chat's download button.
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

    // S45 / SC66: history offers no downloads entry; a file in its preview still queues a task,
    // which the chat's downloads page lists.
    func testHistoryFileDownloadQueuesWithoutADownloadsEntry() {
        let app = launch("history", arguments: ["--preview-chat-artifact", "--preview-history-artifact"])
        XCTAssertTrue(app.buttons["筛选历史"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["history-downloads"].exists)
        let node = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "梳理页面和交互")).firstMatch
        XCTAssertTrue(node.waitForExistence(timeout: 8)); node.tap()
        let file = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "report")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 5))
        file.tap()
        capture("history-file-download-without-entry", app: app)
        app.buttons["返回"].firstMatch.tap()
        let downloads = app.buttons["chat-downloads"]
        XCTAssertTrue(downloads.waitForExistence(timeout: 3))
        downloads.tap()
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "download-card-")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 3), "The history file download must be queued")
    }

    // ADR-0070 / S37: the header keeps downloads and local draft creation; settings is a root,
    // and computers are added or unpaired only from the drawer's computer menu.
    func testSettingsPageOrderAndSingleHostMenu() {
        let app = launch("home", arguments: ["--preview-hosts=2"])
        let settings = app.buttons["root-tab-settings"]
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
            let connection = page.staticTexts["连接"], appearance = page.staticTexts["外观"]
            XCTAssertTrue(connection.exists && appearance.exists)
            XCTAssertLessThan(connection.frame.minY, appearance.frame.minY)
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

    func testLanguageSwitchIsImmediateAndPersistsAcrossLaunches() {
        let app = launch("status")
        let page = app.descendants(matching: .any)["settings-page"].firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 8))
        app.buttons["settings-language"].tap()
        let english = app.buttons["language-en"]
        for _ in 0..<10 where !english.isHittable { page.swipeUp() }
        XCTAssertTrue(english.isHittable)
        english.tap()
        XCTAssertTrue(english.isSelected)
        XCTAssertTrue(app.staticTexts["Settings"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["language-system"].label.contains("Follow system"))
        capture("language-settings-english", app: app)
        app.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["root-tab-settings"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["root-tab-settings"].label, "Settings")
        app.terminate()

        let reopened = launch("status", arguments: ["--preview-language=preserve"])
        XCTAssertTrue(reopened.staticTexts["Settings"].waitForExistence(timeout: 8))
        let reopenedPage = reopened.descendants(matching: .any)["settings-page"].firstMatch
        let chinese = reopened.buttons["language-zh-Hans"]
        for _ in 0..<10 where !chinese.isHittable { reopenedPage.swipeUp() }
        chinese.tap()
        XCTAssertTrue(chinese.isSelected)
        XCTAssertTrue(reopened.staticTexts["设置"].waitForExistence(timeout: 3))
        capture("language-settings-chinese", app: reopened)
    }

    func testLanguageFollowsSystemAndEnglishFallback() {
        for (tag, expected) in [("zh-Hant", "设置"), ("en-GB", "Settings"), ("ja-JP", "Settings")] {
            let app = launch("status", arguments: ["--preview-language=system", "-AppleLanguages", "(\(tag))"])
            XCTAssertTrue(app.staticTexts[expected].waitForExistence(timeout: 8), tag)
            app.terminate()
        }
    }

    func testEnglishChatKeepsOriginalContentAndDraft() {
        let app = launch("chat", arguments: ["--preview-language=en"])
        let input = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "草稿按电脑和会话隔离")).firstMatch.exists)
        input.tap()
        input.typeText("Draft {1} /repo/file.swift")
        XCTAssertTrue((input.value as? String)?.contains("Draft {1} /repo/file.swift") == true)
        XCTAssertTrue(app.buttons["Send message"].exists)
        XCTAssertTrue(app.staticTexts["Workspace write"].exists)
        XCTAssertFalse(app.staticTexts["工作区写入"].exists)
        capture("language-chat-english-original-draft", app: app)
        app.terminate()

        let history = launch("history", arguments: ["--preview-language=en"])
        let title = history.staticTexts["History and branches"]
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        // S45 leaves one header action, so the title fits on a phone; its two-line limit still
        // prevents truncation on narrower widths. The capture is the truncation review.
        let filter = history.buttons["Filter history"]
        XCTAssertTrue(filter.isHittable)
        XCTAssertLessThanOrEqual(title.frame.maxX, filter.frame.minX, "The title must not run under the action")
        XCTAssertFalse(history.buttons["history-downloads"].exists)
        capture("language-history-english-full-title", app: history)
    }

    func testMaterialAppearanceSwitchPersistsAcrossLaunches() {
        let app = launch("status")
        let page = app.descendants(matching: .any)["settings-page"].firstMatch
        let focus = app.buttons["appearance-sage"]
        XCTAssertTrue(page.waitForExistence(timeout: 8))
        for _ in 0..<8 where !focus.isHittable { page.swipeUp() }
        XCTAssertTrue(focus.isHittable)
        XCTAssertTrue(focus.label.contains("灰绿"))
        focus.tap()
        XCTAssertTrue(focus.isSelected)
        capture("sage-settings-light", app: app)
        app.terminate()

        let dark = launch("status", dark: true)
        let darkPage = dark.descendants(matching: .any)["settings-page"].firstMatch
        let darkChoice = dark.buttons["appearance-sage"]
        for _ in 0..<8 where !darkChoice.isHittable { darkPage.swipeUp() }
        XCTAssertTrue(darkChoice.isSelected)
        capture("sage-settings-dark", app: dark)
        dark.terminate()

        let reopened = launch("status")
        let reopenedPage = reopened.descendants(matching: .any)["settings-page"].firstMatch
        let selected = reopened.buttons["appearance-sage"]
        for _ in 0..<8 where !selected.isHittable { reopenedPage.swipeUp() }
        XCTAssertTrue(selected.isSelected)
        reopened.buttons["appearance-mist"].tap()
        XCTAssertTrue(reopened.buttons["appearance-mist"].isSelected)
        reopened.terminate()
    }

    func testMaterialAppearanceRefreshesMountedHomeCard() {
        let app = launch("home", arguments: ["--preview-reset-design", "--preview-reduce-motion"])
        let card = app.buttons["home-runtime-preview-codex"]
        XCTAssertTrue(card.waitForExistence(timeout: 8))
        let mistImage = card.screenshot().image

        app.buttons["root-tab-settings"].tap()
        let settings = app.descendants(matching: .any)["settings-page"].firstMatch
        let sage = app.buttons["appearance-sage"]
        for _ in 0..<8 where !sage.isHittable { settings.swipeUp() }
        XCTAssertTrue(sage.isHittable)
        sage.tap()
        XCTAssertTrue(sage.isSelected)

        // Home remains mounted behind Settings; its Equatable views must include
        // the material preference so theme-dependent text is rebuilt on return.
        app.buttons["root-tab-chat"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 4))
        let sageImage = card.screenshot().image
        XCTAssertGreaterThan(changedPixels(mistImage, sageImage), 0,
                             "The mounted home card must repaint its material-dependent text after switching themes")
        capture("material-home-card-updated", app: app)
    }

    private func returnWithoutSettling(_ app: XCUIApplication, count: Int, reduced: Bool = false) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                   withVelocity: .slow, thenHoldForDuration: 0.1)
        let report = app.staticTexts["page-return-metrics"]
        XCTAssertTrue(report.waitForExistence(timeout: 3))
        let values = Dictionary(uniqueKeysWithValues: report.label.split(separator: ";").compactMap { part -> (String, Double)? in
            let pair = part.split(separator: "=", maxSplits: 1)
            guard pair.count == 2, let number = Double(pair[1]) else { return nil }
            return (String(pair[0]), number)
        })
        XCTAssertEqual(values["count"], Double(count), "一次手势只能弹出一层")
        XCTAssertLessThan(values["commitMs"] ?? .infinity, reduced ? 50 : 300,
                          "松手后不能等待屏外弹簧尾巴；记录应用内时钟，不含 XCTest 等待空闲")
    }

    func testChatReturnImmediatelyAcceptsRepeatedCardEntry() {
        for (name, dark, options) in [("light", false, [String]()), ("dark", true, []),
            ("xxxl", false, ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]),
            ("reduced", false, ["--preview-reduce-motion"])] {
            let app = launch("home", dark: dark, arguments: ["--measure-page-return"] + options)
            let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "home-runtime-")).firstMatch
            XCTAssertTrue(card.waitForExistence(timeout: 8))
            for count in 1...3 {
                card.tap()
                XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 3))
                returnWithoutSettling(app, count: count, reduced: name == "reduced")
                XCTAssertTrue(card.isHittable)
                XCTAssertFalse(app.descendants(matching: .any)["chat-composer"].exists)
            }
            // A different destination must also accept the very next action.
            app.buttons["root-tab-settings"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["settings-page"].firstMatch.waitForExistence(timeout: 3))
            capture("immediate-return-" + name, app: app)
            app.terminate()
        }
    }

    func testFullPageReturnBudgetAndNestedSourceReentry() {
        let app = launch("home", arguments: ["--measure-page-return", "--probe-accessibility-reach"])
        XCTAssertTrue(app.buttons["root-tab-settings"].waitForExistence(timeout: 8))
        // Settings is a root tab (S37) and leaves through the tab bar, not a page return.
        app.buttons["home-downloads"].tap()
        returnWithoutSettling(app, count: 1)
        XCTAssertTrue(app.buttons["home-downloads"].isHittable)
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "home-runtime-")).firstMatch
        card.tap()
        let history = app.buttons["历史与分支"]
        XCTAssertTrue(history.waitForExistence(timeout: 3))
        // The chat is itself a pushed source; each page above it returns there.
        for count in 2...4 {
            history.tap()
            returnWithoutSettling(app, count: count)
            XCTAssertTrue(history.isHittable)
            waitReachable(app, "|打开会话目录", false)
        }
        app.buttons["chat-downloads"].tap()
        returnWithoutSettling(app, count: 5)
        XCTAssertTrue(app.buttons["chat-downloads"].isHittable)
        capture("immediate-return-nested-chat", app: app)
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
            // Start on an actual control on both compact and standard phones.
            let y = app.buttons["扫码配对"].frame.midY - app.frame.minY
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(CGVector(dx: app.frame.width * 0.15, dy: y))
            start.press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.30, dy: y)),
                        withVelocity: .slow, thenHoldForDuration: 0.3)
            XCTAssertTrue(title.exists)
            XCTAssertFalse(app.staticTexts["扫描配对二维码"].exists, "从扫码按钮开始右滑不能同时触发按钮")
            let returned = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                title.exists && abs(title.frame.minX - originalX) <= 1
            }, object: title)
            XCTAssertEqual(XCTWaiter().wait(for: [returned], timeout: 5), .completed)
            XCTAssertEqual(title.frame.minX, originalX, accuracy: 1)
            capture("pairing-short-drag-" + (dark ? "dark-reduced" : "light"), app: app)
            app.buttons["扫码配对"].tap()
            XCTAssertTrue(app.staticTexts["扫描配对二维码"].waitForExistence(timeout: 3), "取消右滑后正常点按立即恢复")
            app.buttons["取消"].tap()
            XCTAssertTrue(app.staticTexts["扫描配对二维码"].waitForNonExistence(timeout: 3))
            start.press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.88, dy: y)),
                        withVelocity: .slow, thenHoldForDuration: 0.1)
            XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
            XCTAssertFalse(app.buttons["取消添加电脑"].exists)
            XCTAssertTrue(app.buttons["root-tab-settings"].isHittable)
            capture("pairing-returned-home-" + (dark ? "dark-reduced" : "light"), app: app)
            app.terminate()
        }
    }

    // M14: nested full pages return one level at a time; each source keeps its state.
    func testNestedPagesSwipeBackOneLevelAtATime() {
        let app = launch("chat", arguments: ["--probe-accessibility-reach"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("nested page draft")
        app.buttons["chat-downloads"].tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        func swipeBack() {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                       withVelocity: .slow, thenHoldForDuration: 0.1)
        }
        swipeBack()
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertTrue((composer.value as? String)?.contains("nested page draft") == true)
        waitReachable(app, "chat-composer|", true)
        waitReachable(app, "|打开会话目录", false)
        capture("nested-downloads-return-chat", app: app)
        swipeBack()
        waitReachable(app, "|打开会话目录", true)
        waitReachable(app, "chat-composer|", false)
        capture("nested-chat-return-home", app: app)
    }

    // ADR-0054 / M14: settings and the home downloads page slide back to home like the chat.
    func testSettingsAndDownloadsSwipeBack() {
        let app = launch("home", arguments: ["--probe-accessibility-reach"])
        let directory = app.buttons["打开会话目录"]
        XCTAssertTrue(app.buttons["root-tab-settings"].waitForExistence(timeout: 8))
        for (entry, page) in [("home-downloads", "")] {
            app.buttons[entry].tap()
            let opened = page.isEmpty ? app.staticTexts["下载"] : app.descendants(matching: .any)[page].firstMatch
            XCTAssertTrue(opened.waitForExistence(timeout: 3))
            waitReachable(app, "download-path|", true)
            waitReachable(app, "|打开会话目录", false)
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
            // A short drag rebounds and stays on the page.
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.32, dy: 0.6)),
                        withVelocity: .slow, thenHoldForDuration: 0.3)
            XCTAssertTrue(opened.exists)
            // The rebounding page still covers the live home beneath it, which stays unreachable.
            waitReachable(app, "|打开会话目录", false)
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
            let entry = app.buttons["home-downloads"]
            XCTAssertTrue(entry.waitForExistence(timeout: 8)); entry.tap()
            let page = app.staticTexts["下载"].firstMatch
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

    // ADR-0054: the chat's downloads page returns to that same chat, draft and all.
    func testChatDownloadsReturnToSameChat() {
        let app = launch("chat", arguments: ["--probe-accessibility-reach"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("下载前的草稿")
        app.buttons["chat-downloads"].tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        // XCUI still finds the retained native text view; reachability is the covered contract.
        waitReachable(app, "chat-composer|", false)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        waitReachable(app, "chat-composer|", true)
        waitReachable(app, "|打开会话目录", false)
        XCTAssertTrue((composer.value as? String)?.contains("下载前的草稿") == true)
        capture("chat-downloads-returned", app: app)
    }

    // IOS-CHAT-05: use the real page cover/return and real source patches. The
    // mounted chat keeps its lease/draft while only top-stationary Git polls run.
    func testCoveredChatKeepsSourceLeaseAndDraftWhileGitPollingPauses() {
        let app = launch("viewport", arguments: ["--probe-chat-lifecycle", "--preview-fast-git-poll", "--preview-source-controls", "--preview-viewport-rows", "--probe-accessibility-reach"])
        let report = app.staticTexts["chat-lifecycle-report"]
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(report.waitForExistence(timeout: 8))
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        func counts() -> [String: Int] {
            Dictionary(uniqueKeysWithValues: report.label.split(separator: ";").compactMap { field -> (String, Int)? in
                let pair = field.split(separator: "=", maxSplits: 1)
                guard pair.count == 2, let value = Int(pair[1]) else { return nil }
                return (String(pair[0]), value)
            })
        }
        let polling = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in counts()["git", default: 0] >= 3 }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [polling], timeout: 5), .completed)
        composer.tap(); composer.typeText("覆盖页面期间保留的草稿")
        waitReachable(app, "nativeTextInputFocused|true", true)
        let composerFrame = composer.frame
        let composerCenter = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: composerFrame.midX - app.frame.minX, dy: composerFrame.midY - app.frame.minY))
        let before = counts()
        app.buttons["preview-chat-source-batch"].tap()
        app.buttons["chat-downloads"].tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        waitReachable(app, "chat-composer|", false)
        waitReachable(app, "nativeTextInputFocused|false", true)
        // A mounted hidden TextField may remain exists/isHittable in XCTest's
        // snapshot. Send an actual coordinate tap and inspect the native responder.
        func nativeInputSample() -> Int {
            let lines = ((app.staticTexts["accessibility-reach"].value as? String) ?? "").split(separator: "\n")
            return lines.first { $0.hasPrefix("nativeTextInputSample|") }
                .flatMap { Int($0.split(separator: "|").last ?? "") } ?? -1
        }
        composerCenter.tap()
        let tapCompletedSample = nativeInputSample()
        let observedTap = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in nativeInputSample() > tapCompletedSample }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [observedTap], timeout: 3), .completed)
        waitReachable(app, "nativeTextInputFocused|false", true)
        waitReachable(app, "|下载", true)
        waitReachable(app, "chat-composer|", false)
        // The fixture waits two seconds, then applies six real source patches.
        Thread.sleep(forTimeInterval: 3)
        // Use the pushed page's horizontal bounds: on iPad, 15% of the whole
        // window is inside the persistent directory sidebar and cannot go back.
        let pageLeft = app.textFields["download-path"].frame.minX - 24
        let pageWidth = app.frame.maxX - pageLeft
        let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: pageLeft - app.frame.minX + pageWidth * 0.15, dy: app.frame.height * 0.6))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: pageLeft - app.frame.minX + pageWidth * 0.88, dy: app.frame.height * 0.6)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        waitReachable(app, "chat-composer|", true)
        XCTAssertTrue(report.waitForExistence(timeout: 3))
        XCTAssertEqual(composer.value as? String, "覆盖页面期间保留的草稿")
        let resumed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let current = counts()
            return current["git", default: 0] > before["git", default: 0] &&
                current["hiddenSource", default: 0] >= before["hiddenSource", default: 0] + 6
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [resumed], timeout: 5), .completed)
        let after = counts()
        XCTAssertEqual(after["acquired"], 1)
        XCTAssertEqual(after["released"], 0)
        XCTAssertEqual(after["coveredGit"], before["coveredGit"])
        XCTAssertEqual(after["arrivals"], before["arrivals"], "Returning must not replay arrivals for covered source rows")
        XCTAssertTrue(app.staticTexts["新增消息 6"].waitForExistence(timeout: 5))
        capture("covered-chat-source-returned", app: app)
    }

    // IOS-CHAT-05: a replacement read gets a new overlay owner. Retiring A must
    // leave B usable; this exercises the real overlay and its disappearance cleanup.
    func testReplacingToolDetailRetiresOnlyTheOldOverlayOwner() {
        let app = launch("tool", arguments: ["--preview-replace-detail"])
        let summary = app.buttons["展开read，已完成"]
        XCTAssertTrue(summary.waitForExistence(timeout: 8)); summary.tap()
        app.buttons["查看输出"].tap()
        let replace = app.buttons["preview-detail-replace"]
        XCTAssertTrue(replace.waitForExistence(timeout: 5))
        let first = replace.value as? String
        replace.tap()
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            replace.exists && replace.value as? String != first
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed)
        let export = app.buttons["tool-export"]
        XCTAssertTrue(export.waitForExistence(timeout: 3)); XCTAssertTrue(export.isEnabled)
        export.tap()
        XCTAssertTrue(app.buttons["tool-export-share"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Sources checked: 18")).firstMatch.exists)
        capture("detail-replacement-retained-new-owner", app: app)
    }

    // M14: history and branch browsing is a page above the same chat, so a right swipe returns there.
    func testHistorySwipeBackReturnsToChat() {
        let app = launch("chat", arguments: ["--probe-accessibility-reach"])
        let historyButton = app.buttons["历史与分支"]
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(historyButton.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("历史前的草稿")
        historyButton.tap()
        XCTAssertTrue(app.buttons["筛选历史"].waitForExistence(timeout: 3))
        waitReachable(app, "|筛选历史", true)
        waitReachable(app, "chat-composer|", false)
        // The covered chat must not keep the keyboard.
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.6))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.30, dy: 0.6)),
                    withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(app.buttons["筛选历史"].exists)
        XCTAssertFalse(app.buttons["退出预览"].exists, "取消右滑不能同时打开手指下的历史卡片")
        capture("history-swipe-cancelled", app: app)
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.6)),
                    withVelocity: .slow, thenHoldForDuration: 0.1)
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertTrue(historyButton.exists)
        waitReachable(app, "chat-composer|", true)
        waitReachable(app, "|打开会话目录", false)
        XCTAssertTrue((composer.value as? String)?.contains("历史前的草稿") == true)
        capture("history-swipe-back-to-chat", app: app)
        historyButton.tap()
        XCTAssertTrue(app.buttons["筛选历史"].waitForExistence(timeout: 3))
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
    // S17 / IOS-CHAT-01: replacing a slash prefix must move the native caret
    // after the selected command so its next argument cannot split the name.
    func testSlashSelectionAppendsArgumentsAfterReplacement() {
        let app = launch("chat")
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("/mo")
        XCTAssertEqual(composer.value as? String, "/mo")
        let command = app.buttons.matching(NSPredicate(format: "label == %@", "/model")).firstMatch
        XCTAssertTrue(command.waitForExistence(timeout: 3)); command.tap()
        let replaced = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "/model "), object: composer)
        XCTAssertEqual(XCTWaiter.wait(for: [replaced], timeout: 3), .completed)
        composer.typeText("x")
        XCTAssertEqual(composer.value as? String, "/model x")
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
        // Also exercise the real clock with a settled software keyboard, so recordings
        // cover the live handoff rather than only deterministic frozen projections.
        let live = launch("chat", arguments: ["--preview-send=pi", "--preview-send-probe"])
        let liveComposer = live.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(liveComposer.waitForExistence(timeout: 8))
        liveComposer.tap(); liveComposer.typeText(text); liveComposer.tap()
        XCTAssertTrue(live.keyboards.firstMatch.waitForExistence(timeout: 3))
        capture("send-live-before", app: live)
        live.buttons["发送消息"].firstMatch.tap()
        let liveProbe = live.descendants(matching: .any)["send-flight-probe"].firstMatch
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "count=0"), object: liveProbe)], timeout: 4), .completed)
        XCTAssertEqual(live.staticTexts.matching(NSPredicate(format: "label == %@", text)).count, 1)
        capture("send-live-handed-off", app: live)
        live.terminate()
        for progress in [70.0 / 440, 280.0 / 440, 0.82, 1.0] {
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
            if progress == 70.0 / 440 {
                XCTAssertGreaterThanOrEqual(number("x"), number("fromX") + 23.99)
                XCTAssertEqual(number("y"), number("fromY"), accuracy: 1)
            } else {
                XCTAssertLessThan(number("y"), number("fromY"))
            }
            if progress == 1 {
                XCTAssertEqual(number("x"), number("toX"), accuracy: 1)
                XCTAssertEqual(number("y"), number("toY"), accuracy: 1)
                XCTAssertEqual(number("width"), number("toWidth"), accuracy: 1)
                XCTAssertEqual(number("height"), number("toHeight"), accuracy: 1)
            } else if progress >= 280.0 / 440 {
                XCTAssertLessThan(number("width"), number("toWidth"))
                XCTAssertLessThan(number("height"), number("toHeight"))
                XCTAssertEqual(number("right"), number("toRight"), accuracy: 1)
                XCTAssertEqual(number("bottom"), number("toBottom"), accuracy: 1)
            }
            capture("send-phase-\(progress)", app: app)
            let semantics = XCTAttachment(string: app.debugDescription)
            semantics.name = "send-phase-semantics-\(progress)"; semantics.lifetime = .keepAlways
            add(semantics)
            XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count, 1)
            app.terminate()
        }
    }

    func testSendFlightUnfoldsLongTextToItsFullHeight() {
        let text = (1...8).map { "第\($0)行：这条消息从输入框上移，再完整展开。" }.joined(separator: "\n")
        for (progress, dark, large) in [(280.0 / 440, false, false), (0.82, false, false), (1.0, false, false),
                                        (0.82, true, false), (1.0, false, true)] {
            let extra = large ? ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] : []
            let app = launch("chat", dark: dark, arguments: ["--preview-send=pi", "--preview-send-probe", "--preview-send-progress=\(progress)"] + extra)
            let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
            XCTAssertTrue(composer.waitForExistence(timeout: 8))
            composer.tap(); composer.typeText(text); composer.tap()
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
            app.buttons["发送消息"].firstMatch.tap()
            let probe = app.descendants(matching: .any)["send-flight-probe"].firstMatch
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "value CONTAINS %@", "lands=true"), object: probe)], timeout: 4), .completed)
            let values = flightMetrics(probe)
            let height = Double(values["height"] ?? "") ?? 0
            let targetHeight = Double(values["toHeight"] ?? "") ?? 0
            XCTAssertGreaterThan(targetHeight, 96)
            if progress == 1 { XCTAssertEqual(height, targetHeight, accuracy: 1) }
            else { XCTAssertLessThan(height, targetHeight) }
            XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", text)).count, 1)
            // Semantics remain on the hidden row; check pixels as well, so an empty Canvas
            // symbol cannot pass merely because the message exists in the accessibility tree.
            func number(_ key: String) -> CGFloat { CGFloat(Double(values[key] ?? "") ?? 0) }
            let visible = CGRect(x: number("x") - number("width") / 2 + 8,
                                 y: max(number("clipTop") + 4, number("y") - number("height") / 2 + 8),
                                 width: max(1, number("width") - 16),
                                 height: max(1, number("bottom") - max(number("clipTop") + 4, number("y") - number("height") / 2 + 8) - 8))
            let shot = app.screenshot().image
            let image = shot.cgImage!
            let scale = CGFloat(image.width) / app.frame.width
            let crop = image.cropping(to: CGRect(x: visible.minX * scale, y: visible.minY * scale,
                                                width: visible.width * scale, height: visible.height * scale))!
            var pixels = [UInt8](repeating: 0, count: crop.width * crop.height * 4)
            let context = CGContext(data: &pixels, width: crop.width, height: crop.height, bitsPerComponent: 8,
                                    bytesPerRow: crop.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(crop, in: CGRect(x: 0, y: 0, width: crop.width, height: crop.height))
            let ink = stride(from: 0, to: pixels.count, by: 4).filter { index in
                let brightness = (Int(pixels[index]) + Int(pixels[index + 1]) + Int(pixels[index + 2])) / 3
                return dark ? brightness > 180 : brightness < 100
            }.count
            XCTAssertGreaterThan(ink, 30, "The unfolding message must actually draw its text")
            capture("send-long-unfold-\(progress)-dark-\(dark)-large-\(large)", app: app)
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
        // The fixture returns native success before committing the source row. The local
        // bubble must survive that interval without continuing to claim it is waiting.
        let localId = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "user-message-")).allElementsBoundByIndex
            .first { $0.label.contains(text) }?.identifier
        let local = localId.map { app.descendants(matching: .any)[$0].firstMatch }
        XCTAssertNotNil(local)
        let settled = NSPredicate(format: "exists == false")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: sending)], timeout: 2), .completed)
        XCTAssertFalse(app.staticTexts["电脑已接收，等待处理"].exists)
        XCTAssertTrue(local?.exists == true)
        XCTAssertFalse(app.buttons["重新发送"].exists)
        XCTAssertEqual((composer.value as? String)?.contains(text), false)
        capture("optimistic-send-submitted", app: app)
        if let local {
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: local)], timeout: 8), .completed)
        }
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
    func testClaudeBusySendShowsHostAcceptanceWithoutClaimingDelivery() {
        let app = launch("chat", arguments: ["--preview-send=claude-busy"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("等待 CC 空闲的消息")
        app.buttons["发送消息"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["电脑已接收，等待处理"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["发送中"].exists)
        XCTAssertFalse(app.staticTexts["已送达"].exists)
        XCTAssertFalse(app.buttons["重新发送"].exists)
        XCTAssertFalse(app.buttons["撤回排队消息"].exists)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "等待 CC 空闲的消息")).count, 1)
        capture("claude-busy-host-accepted", app: app)
    }

    func testAttachmentChooserSeparatesPhotosAndFilesAndKeepsTheDraft() {
        let app = launch("chat")
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap(); composer.typeText("选择附件前的草稿")
        app.buttons["发送文件到电脑"].firstMatch.tap()
        XCTAssertTrue(app.buttons["照片"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["文件"].exists)
        capture("attachment-source-choices", app: app)
        let systemCancel = app.buttons.matching(NSPredicate(format: "label IN %@", ["取消", "Cancel"])).firstMatch
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.16)).tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertEqual(composer.value as? String, "选择附件前的草稿")
        app.buttons["发送文件到电脑"].firstMatch.tap()
        app.buttons["照片"].firstMatch.tap()
        XCTAssertTrue(app.buttons["文件"].waitForNonExistence(timeout: 3))
        XCTAssertTrue(systemCancel.waitForExistence(timeout: 8))
        capture("attachment-native-photos-picker", app: app)
        systemCancel.tap()
        app.buttons["发送文件到电脑"].firstMatch.tap()
        app.buttons["文件"].firstMatch.tap()
        XCTAssertTrue(app.buttons["照片"].waitForNonExistence(timeout: 3))
        XCTAssertTrue(systemCancel.waitForExistence(timeout: 8))
        capture("attachment-native-files-picker", app: app)
        systemCancel.tap()
        XCTAssertEqual(composer.value as? String, "选择附件前的草稿")
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

    /// Touch the visible portion as a person would; element.press may auto-scroll a clipped lazy row.
    private func visibleMessagePressPoint(_ message: XCUIElement, app: XCUIApplication) -> XCUICoordinate {
        var visible = CGRect.zero
        for _ in 0..<5 {
            let top = app.buttons["历史与分支"].frame.maxY + 8
            let bottom = app.descendants(matching: .any)["chat-composer"].firstMatch.frame.minY - 12
            let viewport = CGRect(x: 0, y: top, width: app.frame.width, height: max(0, bottom - top))
            visible = message.frame.intersection(viewport)
            if !visible.isNull && visible.height >= 20 { break }
            if message.frame.minY >= bottom { app.swipeUp() } else { app.swipeDown() }
        }
        XCTAssertFalse(visible.isNull)
        XCTAssertGreaterThanOrEqual(visible.height, 20)
        return app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: visible.midX, dy: visible.midY))
    }

    private func captureMessage(_ name: String, app: XCUIApplication) {
        XCTAssertEqual(app.state, .runningForeground)
        // App-cropped screenshots can clip a landscape iPad window using portrait bounds.
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func nativeEditAction(_ labels: [String], app: XCUIApplication) -> XCUIElement {
        let predicate = NSPredicate(format: "label IN %@", labels)
        let menuItem = app.menuItems.matching(predicate).firstMatch
        if menuItem.waitForExistence(timeout: 1) { return menuItem }
        let button = app.buttons.matching(predicate).firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 3))
        return button
    }

    func testUserMessageCopyAndRewind() {
        let app = launch("chat")
        let message = app.staticTexts["聊天输入和滚动也要保持一致。"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 8))
        let pressPoint = visibleMessagePressPoint(message, app: app)
        let before = message.frame
        let headerBefore = app.buttons["历史与分支"].frame
        XCTAssertFalse(app.buttons["copy-message-m3"].exists)
        pressPoint.press(forDuration: 0.6)
        let copy = app.buttons["copy-message-m3"]
        XCTAssertTrue(copy.waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["message-action-header"].firstMatch.exists)
        XCTAssertTrue(app.buttons["历史与分支"].exists)
        XCTAssertEqual(app.buttons["历史与分支"].frame, headerBefore)
        XCTAssertEqual(app.menuItems.count, 0)
        XCTAssertFalse(app.buttons["关闭文字选择"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["message-selection-text"].firstMatch.exists)
        XCTAssertLessThanOrEqual(copy.frame.maxY, before.minY)
        copy.tap()
        XCTAssertEqual(copy.label, "已复制")
        let copyFrame = copy.frame
        Thread.sleep(forTimeInterval: 1.3)
        copy.tap()
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertEqual(copy.label, "已复制", "The first deadline must not clear a later copy")
        let restoredCopy = NSPredicate(format: "label == %@", "复制消息")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: restoredCopy, object: copy)], timeout: 3), .completed)
        XCTAssertEqual(copy.frame, copyFrame)
        copy.tap()
        XCTAssertEqual(copy.label, "已复制")
        // The first outside tap dismisses without activating the covered header button.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: headerBefore.midX, dy: headerBefore.midY)).tap()
        XCTAssertFalse(copy.exists)
        XCTAssertTrue(app.buttons["历史与分支"].exists)
        XCTAssertEqual(app.buttons["历史与分支"].frame, headerBefore)
        XCTAssertEqual(message.frame.minY, before.minY, accuracy: 1)
        visibleMessagePressPoint(message, app: app).press(forDuration: 0.6)
        XCTAssertTrue(copy.waitForExistence(timeout: 3))
        XCTAssertEqual(copy.label, "复制消息", "Reopening actions must not restore a stale checkmark")
        let rewind = app.buttons["rewind-message-m3"]
        XCTAssertTrue(rewind.isEnabled)
        captureMessage("user-message-actions", app: app)
        rewind.tap()
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        let restored = NSPredicate(format: "value CONTAINS %@", "聊天输入和滚动也要保持一致。")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: restored, object: composer)], timeout: 8), .completed)
    }
    func testMessageTextSelectionIsExplicitAndReturnsToTheSameBubble() {
        verifyMessageTextSelection()
    }

    func testMessageTextSelectionInDarkLargeTextAndReducedMotion() {
        verifyMessageTextSelection(dark: true)
        verifyMessageTextSelection(arguments: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
        verifyMessageTextSelection(arguments: ["--preview-reduce-motion"])
    }

    private func verifyMessageTextSelection(dark: Bool = false, arguments: [String] = []) {
        let app = launch("chat", dark: dark, arguments: arguments)
        let message = app.staticTexts["聊天输入和滚动也要保持一致。"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 8))
        let pressPoint = visibleMessagePressPoint(message, app: app)
        let before = message.frame
        pressPoint.press(forDuration: 0.6)
        let select = app.buttons["select-message-text-m3"]
        XCTAssertTrue(select.waitForExistence(timeout: 3))
        XCTAssertEqual(app.menuItems.count, 0)
        select.tap()
        let body = app.descendants(matching: .any)["message-selection-text"].firstMatch
        XCTAssertTrue(body.waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["rewind-message-m3"].exists)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        body.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 70, dy: 28)).press(forDuration: 0.7)
        let nativeCopy = nativeEditAction(["拷贝", "复制", "Copy"], app: app)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        captureMessage("message-native-text-selection", app: app)
        nativeCopy.tap()
        app.buttons["关闭文字选择"].tap()
        XCTAssertFalse(body.exists)
        XCTAssertTrue(app.buttons["历史与分支"].exists)
        XCTAssertEqual(message.frame.minY, before.minY, accuracy: 1)
        visibleMessagePressPoint(message, app: app).press(forDuration: 0.6)
        XCTAssertTrue(app.buttons["copy-message-m3"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["copy-message-m3"].label, "复制消息")
        let header = app.buttons["历史与分支"].frame
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: header.midX, dy: header.midY)).tap()
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        composer.tap(); composer.press(forDuration: 0.7)
        let paste = nativeEditAction(["粘贴", "貼上", "Paste"], app: app)
        paste.tap()
        let copiedRange = composer.value as? String ?? ""
        XCTAssertFalse(copiedRange.isEmpty)
        XCTAssertTrue("聊天输入和滚动也要保持一致。".contains(copiedRange))
        XCTAssertLessThan(copiedRange.count, "聊天输入和滚动也要保持一致。".count,
                          "Explicit selection must copy a range, not only the whole paragraph")
        app.terminate()
    }

    func testMessageMenuDismissesOnOutsideDragWithoutScrollingThroughIt() {
        let app = launch("chat")
        let message = app.staticTexts["聊天输入和滚动也要保持一致。"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 8))
        let point = visibleMessagePressPoint(message, app: app)
        point.press(forDuration: 0.6)
        let copy = app.buttons["copy-message-m3"]
        XCTAssertTrue(copy.waitForExistence(timeout: 3))
        let before = message.frame
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.7))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -100)))
        XCTAssertFalse(copy.exists)
        XCTAssertEqual(message.frame.minY, before.minY, accuracy: 1,
                       "The dismissing gesture must not scroll the page underneath")
        let press = visibleMessagePressPoint(message, app: app)
        press.press(forDuration: 0.05, thenDragTo: press.withOffset(CGVector(dx: 0, dy: -80)))
        XCTAssertFalse(copy.exists, "A scrolling gesture must cancel the pending long press")
        XCTAssertTrue(app.buttons["历史与分支"].exists)
        app.terminate()
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

    func testToolDetailSheetScrollsAndDismissesBySwipeAndInfoDialogWorksInsideSheet() {
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

        let scroller = app.scrollViews.firstMatch
        XCTAssertTrue(scroller.waitForExistence(timeout: 3))
        scroller.swipeLeft()
        scroller.swipeUp()
        XCTAssertTrue(app.buttons["关闭"].firstMatch.exists, "Scrolling inside the detail well must not dismiss the sheet")

        let header = app.staticTexts["read"].firstMatch
        XCTAssertTrue(header.exists)
        let start = header.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.92)),
                    withVelocity: .fast, thenHoldForDuration: 0.05)
        XCTAssertTrue(app.buttons["关闭"].firstMatch.waitForNonExistence(timeout: 5))
        let history = app.buttons["历史与分支"]
        XCTAssertTrue(history.waitForExistence(timeout: 3))
        XCTAssertTrue(history.isHittable)
        app.terminate()

        let status = launch("status")
        let row = status.buttons["settings-protocol"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        let page = status.descendants(matching: .any)["settings-page"].firstMatch
        for _ in 0..<4 where !row.isHittable && page.exists { page.swipeUp() }
        row.tap()
        let info = status.buttons["查看QUIC说明"]
        XCTAssertTrue(info.waitForExistence(timeout: 3)); info.tap()
        XCTAssertTrue(status.staticTexts["当前网络不支持 QUIC 时无法连接"].waitForExistence(timeout: 3))
        status.buttons["知道了"].tap()
        XCTAssertTrue(status.staticTexts["当前网络不支持 QUIC 时无法连接"].waitForNonExistence(timeout: 3))
        XCTAssertTrue(status.buttons["relay-mode-apply"].exists)
        status.terminate()
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

    // PERF-12: one uninterrupted typing burst over a long transcript, between idle gaps, so a Time
    // Profiler run can isolate what a keystroke re-renders (iPad: drawer and root pages stay mounted;
    // drafts persist to UserDefaults.standard as in the shipping app).
    // The value is read only after the burst to keep XCTest snapshots out of the measured window.
    func testTypingOverLongTranscriptKeepsTheDraft() {
        let app = launch("tool", arguments: ["--preview-long-transcript", "--preview-standard-preferences"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap()
        Thread.sleep(forTimeInterval: 2)
        composer.typeText(String(repeating: "typing keeps the page still ", count: 4))
        Thread.sleep(forTimeInterval: 2)
        XCTAssertTrue((composer.value as? String)?.lowercased().contains("still typing keeps the page still") == true,
                      "Composer value: \(String(describing: composer.value))")
    }

    // IOS-CHAT-01: typing is editor-local even with retained pages, a long transcript and
    // production preferences. Counters poll from their own subtree so they cannot mask a rebuild.
    func testComposerEditsDoNotRebuildTranscriptOwner() {
        let app = launch("tool", arguments: ["--preview-long-transcript", "--preview-standard-preferences", "--probe-chat-updates"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        let report = app.staticTexts["chat-update-report"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        composer.tap()
        XCTAssertTrue(report.waitForExistence(timeout: 2))
        // Background Markdown preparation must settle before attributing any new work to typing.
        var previousReport = ""
        var stableSince = Date()
        let stable = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let current = report.label
            if current != previousReport { previousReport = current; stableSince = Date() }
            return Date().timeIntervalSince(stableSince) >= 1
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [stable], timeout: 12), .completed)
        func counts() -> [String: Int] {
            Dictionary(uniqueKeysWithValues: report.label.split(separator: ";").compactMap { field -> (String, Int)? in
                let pair = field.split(separator: "=", maxSplits: 1)
                guard pair.count == 2, let value = Int(pair[1]) else { return nil }
                return (String(pair[0]), value)
            })
        }
        let before = counts()
        XCTAssertGreaterThan(before["page", default: 0], 0)
        composer.typeText("local editor update\nsecond line\nthird line")
        Thread.sleep(forTimeInterval: 0.3)
        let after = counts()
        XCTAssertTrue((composer.value as? String)?.contains("local editor update") == true)
        XCTAssertGreaterThan(after["composer", default: 0], before["composer", default: 0])
        for region in ["navigation", "page", "header", "transcript", "notices", "workspace", "row", "markdown", "nativeInputs"] {
            XCTAssertEqual(after[region], before[region], "Typing rebuilt \(region): \(before) -> \(after)")
        }
    }

    private struct ComposerLayoutReport: Decodable {
        struct Sample: Decodable {
            let rowSize: CGSize
            let leading: CGRect
            let editor: CGRect
            let trailing: CGRect
            let editorProposalWidth: CGFloat?
        }
        let requests: Int
        let parentHeightProposals: [String]
        let measurements: Int
        let placements: Int
        let invalidHeightProposals: Int
        let invalidSizes: Int
        let samples: [Sample]
    }

    // IOS-CHAT-03: record the actual launch-through-input proposals while a long
    // Chinese draft is installed. Export after typing without publishing during layout.
    // Callback counts describe the LayoutSubview boundary, not physical keystrokes.
    func testComposerRowMeasuresLongChineseDraftAtRemainingWidthAndNaturalHeight() throws {
        let app = launch("tool", arguments: ["--preview-long-transcript", "--preview-standard-preferences",
                                             "--preview-long-composer-draft", "--probe-composer-layout"])
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        let seededDraft = String(repeating: "跨平台会话输入保持稳定，", count: 24)
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let seeded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            composer.value as? String == seededDraft
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [seeded], timeout: 8), .completed)
        composer.tap()
        Thread.sleep(forTimeInterval: 1)
        let longHeight = composer.frame.height
        composer.typeKey(XCUIKeyboardKey(rawValue: "a"), modifierFlags: .command)
        composer.typeText("短")
        let shrunk = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            composer.value as? String == "短" && composer.frame.height < longHeight - 20
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [shrunk], timeout: 5), .completed)
        let shortHeight = composer.frame.height
        // Native replacement/typing must invalidate cached intrinsic metrics; the
        // editor remains mounted while shrinking from, then growing back to six lines.
        composer.typeText(seededDraft)
        let grown = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            composer.value as? String == "短" + seededDraft && composer.frame.height > shortHeight + 20
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [grown], timeout: 5), .completed)
        composer.typeText(" layout")
        Thread.sleep(forTimeInterval: 0.3)
        app.buttons["preview-composer-layout-capture"].tap()
        let json = app.staticTexts["composer-layout-report"].label
        let report = try JSONDecoder().decode(ComposerLayoutReport.self, from: Data(json.utf8))
        let proposals = XCTAttachment(string: json)
        proposals.name = "composer-layout-proposals"; proposals.lifetime = .keepAlways; add(proposals)
        XCTAssertGreaterThan(report.requests, 0)
        XCTAssertFalse(report.parentHeightProposals.isEmpty)
        XCTAssertGreaterThan(report.measurements, 0)
        XCTAssertGreaterThan(report.placements, 0)
        XCTAssertEqual(report.invalidHeightProposals, 0)
        XCTAssertEqual(report.invalidSizes, 0)
        XCTAssertFalse(report.samples.isEmpty)
        XCTAssertTrue(report.samples.contains { $0.editor.height > 56 }, "The seeded draft must exercise multiline growth")
        for sample in report.samples {
            XCTAssertEqual(sample.leading.width, 48, accuracy: 0.5)
            XCTAssertEqual(sample.leading.height, 48, accuracy: 0.5)
            XCTAssertEqual(sample.trailing.width, 48, accuracy: 0.5)
            XCTAssertEqual(sample.trailing.height, 48, accuracy: 0.5)
            let remaining = max(0, sample.rowSize.width - sample.leading.width - sample.trailing.width - 20)
            XCTAssertEqual(try XCTUnwrap(sample.editorProposalWidth), remaining, accuracy: 0.5)
            XCTAssertEqual(sample.editor.width, remaining, accuracy: 0.5)
            XCTAssertEqual(sample.editor.minX - sample.leading.maxX, 10, accuracy: 0.5)
            XCTAssertEqual(sample.trailing.minX - sample.editor.maxX, 10, accuracy: 0.5)
            XCTAssertEqual(sample.leading.maxY, sample.rowSize.height, accuracy: 0.5)
            XCTAssertEqual(sample.editor.maxY, sample.rowSize.height, accuracy: 0.5)
            XCTAssertEqual(sample.trailing.maxY, sample.rowSize.height, accuracy: 0.5)
        }
        XCTAssertEqual(app.buttons["发送文件到电脑"].firstMatch.frame.width, 48, accuracy: 0.5)
        XCTAssertEqual(app.buttons["发送消息"].firstMatch.frame.width, 48, accuracy: 0.5)
        // No extra tap: Capture must retain the real editor and its focus.
        composer.typeText("!")
        XCTAssertEqual(composer.value as? String, "短" + seededDraft + " layout!")
    }

    // IOS-CHAT-02: actual source patches update the transcript subtree while the stable
    // navigation, header, editor and independent panels retain their body evaluations.
    func testSourcePatchesOnlyRebuildTranscriptRegion() {
        let app = launch("viewport", arguments: ["--probe-chat-updates", "--preview-source-controls", "--preview-reduce-motion"])
        let report = app.staticTexts["chat-update-report"], trigger = app.buttons["preview-chat-source-update"]
        XCTAssertTrue(report.waitForExistence(timeout: 8))
        XCTAssertTrue(trigger.waitForExistence(timeout: 3))
        var previousReport = "", stableSince = Date()
        let stable = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let current = report.label
            if current != previousReport { previousReport = current; stableSince = Date() }
            return Date().timeIntervalSince(stableSince) >= 1
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [stable], timeout: 12), .completed)
        func counts() -> [String: Int] {
            Dictionary(uniqueKeysWithValues: report.label.split(separator: ";").compactMap { field -> (String, Int)? in
                let pair = field.split(separator: "=", maxSplits: 1)
                guard pair.count == 2, let value = Int(pair[1]) else { return nil }
                return (String(pair[0]), value)
            })
        }
        let before = counts()
        XCTAssertGreaterThan(before["transcript", default: 0], 0)
        for _ in 0..<3 {
            let previous = counts()["transcript", default: 0]
            trigger.tap()
            let applied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                counts()["transcript", default: 0] > previous
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [applied], timeout: 5), .completed)
        }
        Thread.sleep(forTimeInterval: 0.3)
        let after = counts()
        XCTAssertEqual(trigger.value as? String, "3")
        XCTAssertGreaterThan(after["transcript", default: 0], before["transcript", default: 0])
        for region in ["navigation", "page", "header", "composer", "notices", "workspace"] {
            XCTAssertEqual(after[region], before[region], "Source patches rebuilt \(region): \(before) -> \(after)")
        }
        if before["nativeRow", default: 0] > 0 {
            XCTAssertEqual(after["nativeRow", default: 0] - before["nativeRow", default: 0], 3)
            XCTAssertEqual(after["nativeReconfigure", default: 0] - before["nativeReconfigure", default: 0], 3)
            XCTAssertEqual(after["nativeAuxiliary"], before["nativeAuxiliary"], "Content-only patches rebuilt auxiliary rows")
        }
    }

    // IOS-CHAT-07-R1: each source commit following a locally persisted keystroke
    // must preserve composer equality; the next keystroke is still editor-local.
    func testTypedComposerStaysIsolatedAcrossSourcePatches() {
        let app = launch("viewport", arguments: ["--probe-chat-updates", "--preview-source-controls", "--preview-reduce-motion"])
        let report = app.staticTexts["chat-update-report"], trigger = app.buttons["preview-chat-source-update"]
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertTrue(report.waitForExistence(timeout: 3))
        for character in ["t", "y", "p"] {
            composer.tap(); composer.typeText(character)
            waitForStableChatRegions(report)
            let before = chatRegionCounts(report)
            trigger.tap()
            let committed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                self.chatRegionCounts(report)["transcript", default: 0] > before["transcript", default: 0]
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [committed], timeout: 5), .completed)
            waitForStableChatRegions(report)
            let after = chatRegionCounts(report)
            XCTAssertEqual(after["composer"], before["composer"], "Source commit republished the typed draft")
        }
        XCTAssertEqual(composer.value as? String, "typ")
    }

    // SC89 / S31: nested tool-group expansion keeps both reading anchors and retained state.
    func testToolGroupAndNestedCallKeepTheirReadingPosition() {
        let app = launch("tool", arguments: ["--preview-long-transcript", "--preview-tool-group"])
        let group = app.buttons["展开3 次工具调用，已完成"]
        XCTAssertTrue(group.waitForExistence(timeout: 8))
        let before = group.frame
        // The group's accessibility frame includes expanded descendants. Touch the
        // original header, not the center of that growing union (which can be tool text).
        let groupHeader = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: before.midX, dy: before.midY))
        group.tap()
        let expandedGroup = app.buttons["收起3 次工具调用，已完成"]
        XCTAssertTrue(expandedGroup.waitForExistence(timeout: 3))
        XCTAssertEqual(expandedGroup.frame.minY, before.minY, accuracy: 1)
        XCTAssertEqual(expandedGroup.frame.width, before.width, accuracy: 1)
        let call = app.buttons["展开read，已完成"]
        XCTAssertTrue(call.isHittable)
        let callBefore = call.frame
        call.tap()
        let expandedCall = app.buttons["收起read，已完成"]
        XCTAssertTrue(expandedCall.waitForExistence(timeout: 3))
        XCTAssertEqual(expandedCall.frame.minY, callBefore.minY, accuracy: 1)
        XCTAssertEqual(expandedGroup.frame.minY, before.minY, accuracy: 1)
        capture("tool-group-nested-expanded", app: app)
        groupHeader.tap()
        XCTAssertTrue(group.isHittable)
        XCTAssertEqual(group.frame.minY, before.minY, accuracy: 1)
        groupHeader.tap()
        XCTAssertTrue(expandedCall.waitForExistence(timeout: 3), "Nested tool state was lost on group collapse")
        XCTAssertEqual(expandedCall.frame.minY, callBefore.minY, accuracy: 1)
        app.terminate()
    }

    // IOS-CHAT-13: independent hosts must resize their actual native cells through
    // the disclosure's intermediate heights and retain state after cell recycling.
    func testHostedToolDisclosureKeepsTheReplyAndCellInContinuousLayout() throws {
        let app = launch("tool", arguments: ["--preview-long-transcript", "--preview-tool-group", "--preview-scroll-frames"])
        defer { app.terminate() }
        let group = app.buttons["展开3 次工具调用，已完成"]
        XCTAssertTrue(group.waitForExistence(timeout: 8))
        let transcript = app.collectionViews["chat-transcript-native"].firstMatch
        XCTAssertTrue(transcript.exists)
        func assertContinuousLayout(_ samples: [ChatScrollFrame], opening: Bool) throws {
            let values = try samples.compactMap { sample -> ([Double], [Double], [Double])? in
                guard let row = sample.rows["tool-card:preview-tool"],
                      let cell = sample.cells?["tool-card:preview-tool"] else { return nil }
                let presented = try XCTUnwrap(sample.cells?["#presentation:tool-card:preview-tool"])
                return (row, cell, presented)
            }
            let first = try XCTUnwrap(values.first), last = try XCTUnwrap(values.last)
            let direction = opening ? 1.0 : -1.0
            XCTAssertGreaterThan(values.count, 3)
            XCTAssertGreaterThan((last.0[2] - first.0[2]) * direction, 100)
            XCTAssertGreaterThan((last.1[2] - first.1[2]) * direction, 100)
            XCTAssertGreaterThan((last.2[2] - first.2[2]) * direction, 100)
            for (row, cell, presented) in values {
                XCTAssertEqual(row[0], first.0[0], accuracy: 1)
                XCTAssertEqual(row[1], first.0[1], accuracy: 1)
                XCTAssertEqual(cell[0], first.1[0], accuracy: 1)
                XCTAssertEqual(cell[1], first.1[1], accuracy: 1)
                XCTAssertEqual(presented[0], first.2[0], accuracy: 1)
                XCTAssertEqual(presented[1], first.2[1], accuracy: 1)
                XCTAssertEqual(cell[2], row[2], accuracy: 1, "The native cell must follow the hosted reply's measured height")
                XCTAssertEqual(presented[2], row[2], accuracy: 1, "The presented native cell must follow the hosted reply without UIKit self-sizing lag")
            }
            for (before, after) in zip(values, values.dropFirst()) {
                XCTAssertGreaterThanOrEqual((after.1[2] - before.1[2]) * direction, -1)
                XCTAssertGreaterThanOrEqual((after.2[2] - before.2[2]) * direction, -1)
            }
            let low = min(first.1[2], last.1[2]), high = max(first.1[2], last.1[2])
            XCTAssertGreaterThan(values.filter { $0.1[2] > low + 1 && $0.1[2] < high - 1 }.count, 2)
            XCTAssertGreaterThan(values.filter { $0.2[2] > low + 1 && $0.2[2] < high - 1 }.count, 2)
        }
        for opening in [true, false, true] {
            let button = app.buttons[opening ? "展开3 次工具调用，已完成" : "收起3 次工具调用，已完成"]
            let header = button.frame
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: header.midX, dy: header.minY + 20)).tap()
            try assertContinuousLayout(try chatScrollFrames(app), opening: opening)
        }
        app.buttons["展开read，已完成"].tap()
        try assertContinuousLayout(try chatScrollFrames(app), opening: true)
        let expandedCall = app.buttons["收起read，已完成"]
        XCTAssertTrue(expandedCall.exists)
        for _ in 0..<8 { transcript.swipeDown() }
        XCTAssertFalse(app.buttons["收起3 次工具调用，已完成"].exists, "The source cell must leave the native reuse window")
        app.buttons["跳到最新消息"].tap()
        XCTAssertTrue(expandedCall.waitForExistence(timeout: 5), "Cell recycling must retain the nested disclosure state")
        capture("chat-native-tool-disclosure-recycled", app: app)
    }

    // IOS-CHAT-13-R4: sampling after idle misses a one-frame anchor jump. Keep a
    // downstream row fixed on every display tick while the preceding row resizes.
    func testDisclosureAboveViewportPreservesEveryReadingFrame() throws {
        let app = launch("tool", arguments: ["--preview-tool-group", "--preview-above-viewport-disclosure", "--preview-scroll-frames"])
        defer { app.terminate() }
        let transcript = chatTranscript(app)
        let group = app.buttons["展开3 次工具调用，已完成"]
        XCTAssertTrue(app.buttons["preview-above-disclosure"].waitForExistence(timeout: 8))
        for _ in 0..<6 where !group.isHittable { transcript.swipeDown() }
        XCTAssertTrue(group.isHittable)
        let viewport = transcript.frame
        let displacement = max(0, group.frame.maxY - viewport.minY + 5)
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)).press(forDuration: 0.05,
            thenDragTo: app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: viewport.minX + viewport.width * 0.8,
                dy: viewport.minY + viewport.height * 0.7 - displacement)), withVelocity: .slow, thenHoldForDuration: 0.3)
        let anchor = app.staticTexts["上方展开阅读锚点"]
        XCTAssertTrue(anchor.isHittable)
        XCTAssertLessThan(group.frame.midY, viewport.minY, "The disclosure header must start above the viewport")
        let before = anchor.frame
        for _ in 0..<2 {
            app.buttons["preview-above-disclosure"].tap()
            let samples = try chatScrollFrames(app)
            for id in ["native-reader-user", "#presentation:native-reader-user"] {
                let cells = samples.compactMap { $0.cells?[id] }
                XCTAssertGreaterThan(cells.count, 3)
                XCTAssertEqual(cells.count, samples.count, "The same reading row must be present on every frame")
                let first = try XCTUnwrap(cells.first)
                for frame in cells { XCTAssertEqual(frame[0], first[0], accuracy: 1, id) }
            }
            let heights = samples.compactMap { $0.cells?["tool-card:preview-tool"]?[2] }
            XCTAssertGreaterThan(try XCTUnwrap(heights.max()) - XCTUnwrap(heights.min()), 50,
                "The preceding hosted cell must actually change height during measurement")
            XCTAssertEqual(anchor.frame.minY, before.minY, accuracy: 1)
        }
        capture("above-viewport-disclosure-reading-anchor", app: app)
    }

    // IOS-CHAT-13-R3: a real file-summary cell must retain its disclosure after
    // leaving the reuse window, without borrowing another summary's state.
    func testHostedFileSummaryRetainsExpansionAfterCellReuse() throws {
        let app = launch("changes", arguments: ["--preview-many-files", "--preview-long-transcript"])
        defer { app.terminate() }
        let expand = app.buttons["turn-changes-expand-preview-review"]
        let found = expand.waitForExistence(timeout: 10)
        if !found {
            capture("chat-file-summary-missing", app: app)
            print("FILE_SUMMARY_INPUTS " + String(describing: app.staticTexts["change-detail-requests"].value))
            print("FILE_SUMMARY_MISSING " + app.debugDescription)
        }
        XCTAssertTrue(found)
        expand.tap()
        let sixth = app.buttons["turn-change-file-change-6"]
        XCTAssertTrue(sixth.waitForExistence(timeout: 5))
        XCTAssertTrue(expand.label.contains("收起"))
        let transcript = app.collectionViews["chat-transcript-native"].firstMatch
        for _ in 0..<8 { transcript.swipeDown() }
        XCTAssertFalse(expand.exists, "The source must leave the reuse window")
        app.buttons["跳到最新消息"].tap()
        XCTAssertTrue(sixth.waitForExistence(timeout: 5))
        XCTAssertTrue(expand.label.contains("收起"), "Recycling must retain the file-summary expansion")
        capture("chat-native-file-summary-recycled", app: app)
    }

    // IOS-CHAT-13-R5: prose after a tool call splits the final reply, and the new card
    // takes over the turn anchors. The original row must drop its retained summary.
    func testFileSummaryFollowsAnchorsWhenTheReplySplits() throws {
        let app = launch("changes", arguments: ["--preview-long-transcript", "--preview-source-controls",
                                                "--preview-change-anchor-handoff"])
        defer { app.terminate() }
        let summaries = app.buttons.matching(identifier: "turn-changes-open-preview-review")
        XCTAssertTrue(summaries.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(summaries.count, 1)
        app.buttons["preview-chat-source-update"].tap()
        let continuation = app.staticTexts["工具调用后的补充说明。"]
        XCTAssertTrue(continuation.waitForExistence(timeout: 5))
        // Wait for the new card's asynchronous match before counting the old row's cards.
        func followed() -> Bool {
            summaries.allElementsBoundByIndex.contains { $0.frame.minY > continuation.frame.minY }
        }
        let deadline = Date().addingTimeInterval(5)
        while !followed() && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        XCTAssertTrue(followed(), "The summary follows the new final card")
        XCTAssertEqual(summaries.count, 1, "Only the row that owns the anchors shows the summary")
        capture("chat-file-summary-anchor-handoff", app: app)
    }

    // IOS-CHAT-13-R3: capture the first native frames on return, before WebKit
    // finishes loading; a final settled screenshot alone misses the height flash.
    func testHostedMathRetainsMeasuredHeightAfterCellReuse() throws {
        let app = launch("tool", arguments: ["--preview-math-row", "--preview-scroll-frames"])
        defer { app.terminate() }
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
        func waitForRenderedFormula() {
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let web = app.webViews.firstMatch
                return web.isHittable && web.frame.height > 20 &&
                    web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "公式复用锚点")).firstMatch.exists &&
                    !web.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "\\frac")).firstMatch.exists
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed,
                           "A sized web view must contain rendered math, not the raw-source fallback: " + app.webViews.firstMatch.debugDescription)
        }
        waitForRenderedFormula()
        let transcript = app.collectionViews["chat-transcript-native"].firstMatch
        let original = app.webViews.firstMatch.frame.height
        XCTAssertGreaterThan(original, 20)
        for _ in 0..<8 { transcript.swipeDown() }
        XCTAssertFalse(app.webViews.firstMatch.exists, "The math host must leave the reuse window")
        app.buttons["跳到最新消息"].tap()
        let samples = try chatScrollFrames(app)
        let heights = samples.compactMap { $0.cells?["math-recycled"]?[2] }
        XCTAssertGreaterThan(heights.count, 3)
        let first = try XCTUnwrap(heights.first)
        for height in heights { XCTAssertEqual(height, first, accuracy: 1, "A recycled formula must reserve its measured height immediately") }
        waitForRenderedFormula()
        XCTAssertEqual(app.webViews.firstMatch.frame.height, original, accuracy: 1)
        capture("chat-native-math-recycled", app: app)
    }

    // PERF-11: traverse many lazily mounted history cards in both directions; the
    // same gesture sequence is also the Time Profiler baseline/candidate workload.
    func testLongTranscriptScrollsBothWaysAndReturnsToLatest() {
        let app = launch("tool", arguments: ["--preview-long-transcript"])
        let latest = app.staticTexts["源文件检查完成。展开工具可查看摘要和按需读取完整输出。"]
        XCTAssertTrue(latest.waitForExistence(timeout: 8))
        XCTAssertTrue(latest.isHittable)
        let transcript = chatTranscript(app)
        let header = app.buttons["chat-title"].frame
        for direction in [1.0, -1.0, 1.0] {
            print("SCROLL_PROBE direction=\(direction) start=\(Date().timeIntervalSince1970)")
            for _ in 0..<5 {
                let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: direction > 0 ? 0.25 : 0.75))
                let end = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: direction > 0 ? 0.75 : 0.25))
                start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.05)
            }
            print("SCROLL_PROBE direction=\(direction) end=\(Date().timeIntervalSince1970)")
            XCTAssertEqual(app.buttons["chat-title"].frame, header)
        }
        XCTAssertFalse(latest.isHittable)
        let jump = app.buttons["跳到最新消息"]
        XCTAssertTrue(jump.waitForExistence(timeout: 3))
        capture("long-transcript-reading", app: app)
        jump.tap()
        XCTAssertTrue(latest.isHittable)
        XCTAssertFalse(jump.exists)
        capture("long-transcript-back-at-latest", app: app)
    }

    // SC90: endpoints miss scroll reversals. Sample the actual viewport across a
    // long lazy jump, including the button's disappearance and settling frames.
    func testJumpToLatestMovesContinuouslyWithoutReversing() throws {
        try verifyJumpToLatest(reduced: false, distances: [5, 2, 9])
    }

    // SC90: the same tail target must settle immediately under reduced motion.
    func testJumpToLatestRespectsReducedMotion() throws {
        try verifyJumpToLatest(reduced: true, distances: [5])
    }

    private func verifyJumpToLatest(reduced: Bool, distances: [Int]) throws {
        let app = launch("tool", arguments: ["--preview-long-transcript", "--preview-scroll-frames"]
            + (reduced ? ["--preview-reduce-motion"] : []))
        defer { app.terminate() }
        let latest = app.staticTexts["源文件检查完成。展开工具可查看摘要和按需读取完整输出。"]
        XCTAssertTrue(latest.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        for distance in distances {
            for _ in 0..<distance {
                let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.25))
                let end = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.75))
                start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.05)
            }
            XCTAssertFalse(latest.isHittable)
            let jump = app.buttons["跳到最新消息"]
            XCTAssertTrue(jump.waitForExistence(timeout: 3))
            jump.tap()
            let samples = try chatScrollFrames(app)
            try assertChatScrollMotion(samples, reduced: reduced)
            XCTAssertTrue(latest.isHittable)
            XCTAssertFalse(jump.exists)
        }
    }

    // SC90 / V03: source patches arriving during the jump must still land at the
    // newest content; a later user drag must cancel that explicit tail target.
    func testJumpToLatestFollowsUpdatesAndAllowsReadingAgain() throws {
        let app = launch("viewport", arguments: ["--preview-scroll-frames", "--preview-jump-updates"])
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        transcript.swipeDown(); transcript.swipeDown()
        app.buttons["跳到最新消息"].tap()
        let samples = try chatScrollFrames(app)
        try assertChatScrollMotion(samples, stableRowSizes: false)
        let newest = app.staticTexts["新增尾部 4"]
        XCTAssertTrue(newest.isHittable, "The initial tail plus three patches must all be followed")
        XCTAssertFalse(app.buttons["跳到最新消息"].exists)
        transcript.swipeDown(); transcript.swipeDown()
        let anchor = try XCTUnwrap(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 "))
            .allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > transcript.frame.minY + 10 && $0.frame.maxY < transcript.frame.maxY - 10 })
        let before = anchor.frame
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "刷新 Git 工作分支")).firstMatch.tap()
        XCTAssertEqual(anchor.frame.minY, before.minY, accuracy: 1)
        XCTAssertTrue(app.buttons["跳到最新消息"].exists)
    }

    // IOS-CHAT-13: a second explicit action must interrupt the old native scroll
    // immediately. Endpoints alone pass even if the old question jump runs first.
    func testJumpToLatestInterruptsTheInFlightQuestionLocation() throws {
        let app = launch("viewport", arguments: ["--preview-question-reminder", "--preview-scroll-frames", "--preview-question-preemption"])
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).press(forDuration: 0.05,
            thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        let reminder = app.buttons["chat-question-reminder"]
        XCTAssertTrue(reminder.waitForExistence(timeout: 3))
        reminder.tap()
        let samples = try chatScrollFrames(app)
        let command = try XCTUnwrap(samples.compactMap(\.requestPreemption).first)
        XCTAssertTrue(command.oldAnimating, "The replacement must be issued during the original native animation")
        XCTAssertGreaterThan(command.latestSequence, command.questionSequence)
        XCTAssertEqual(command.latestContextGeneration, command.contextGeneration)
        let after = samples.filter { $0.time >= command.issuedAt + 0.05 }
        XCTAssertGreaterThan(after.count, 3)
        XCTAssertTrue(after.allSatisfy { $0.offset >= command.issuedOffset - 2 }, "The old question animator must stop when the new latest action is accepted")
        let last = try XCTUnwrap(after.last)
        XCTAssertEqual(last.bottom - last.offset, 0, accuracy: 2)
        XCTAssertFalse(app.buttons["跳到最新消息"].exists)
        transcript.swipeDown()
        XCTAssertTrue(app.buttons["跳到最新消息"].waitForExistence(timeout: 3), "A later real gesture must still cancel following")
    }

    private func assertChatScrollMotion(_ samples: [ChatScrollFrame], reduced: Bool = false, stableRowSizes: Bool = true) throws {
        let first = try XCTUnwrap(samples.first), last = try XCTUnwrap(samples.last)
        XCTAssertGreaterThan(first.bottom - first.offset, 300)
        XCTAssertEqual(last.bottom - last.offset, 0, accuracy: 2)
        let distance = samples.map { $0.bottom - $0.offset }
        if reduced {
            XCTAssertTrue(samples.filter { $0.time > 0.25 }.allSatisfy { abs($0.bottom - $0.offset) <= 2 })
        } else {
            XCTAssertGreaterThan(distance.filter { $0 > 2 && $0 < distance[0] - 2 }.count, 2)
        }
        var comparedRows = 0
        for (before, after) in zip(samples, samples.dropFirst()) {
            // Lazy estimates can change the total height without moving visible
            // content. Compare the same rendered rows, not estimated bottom distance.
            for (id, frame) in after.rows {
                guard let previous = before.rows[id] else { continue }
                comparedRows += 1
                XCTAssertLessThanOrEqual(frame[0] - previous[0], 2, "Visible row reversed: \(id), \(previous) -> \(frame)")
                XCTAssertEqual(frame[1], previous[1], accuracy: 1, "Visible row width changed: \(id)")
                if stableRowSizes { XCTAssertEqual(frame[2], previous[2], accuracy: 1, "Visible row height changed: \(id)") }
            }
            XCTAssertEqual(after.width, first.width, accuracy: 1)
            XCTAssertEqual(after.height, first.height, accuracy: 1)
        }
        XCTAssertGreaterThan(comparedRows, 3)
    }

    private struct ChatScrollFrame: Decodable {
        struct RequestPreemption: Decodable {
            let issuedAt: Double
            let issuedOffset: Double
            let oldAnimating: Bool
            let questionSequence: Int
            let latestSequence: Int
            let contextGeneration: Int
            let latestContextGeneration: Int
        }
        let time: Double
        let offset: Double
        let bottom: Double
        let width: Double
        let height: Double
        let rows: [String: [Double]]
        let cells: [String: [Double]]?
        let requestPreemption: RequestPreemption?
    }

    private func chatScrollFrames(_ app: XCUIApplication) throws -> [ChatScrollFrame] {
        let report = app.buttons["chat-title"]
        let finished = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value BEGINSWITH '['"), object: report)
        XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 4), .completed)
        let json = try XCTUnwrap(report.value as? String)
        print("CHAT_SCROLL_FRAMES \(json)")
        return try JSONDecoder().decode([ChatScrollFrame].self, from: Data(json.utf8))
    }

    func testLongFinalReplyKeepsReadingPositionAndOnlyFollowsAfterJump() {
        let app = launch("viewport")
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
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

    // IOS-CHAT-13: a real remote history page must prepend through SQLite and
    // receive an applied acknowledgement without moving the same native text.
    func testHistoryPrependPreservesTheVisibleReadingAnchor() throws {
        let app = launch("tool", arguments: ["--preview-history-prepend", "--preview-reduce-motion", "--preview-scroll-frames"])
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        let delivery = app.buttons["preview-history-deliver"]
        XCTAssertTrue(delivery.waitForExistence(timeout: 3))
        func protocolFields() -> [String: String] {
            Dictionary(uniqueKeysWithValues: ((delivery.value as? String) ?? "").split(separator: ";").compactMap { field in
                let pair = field.split(separator: "=", maxSplits: 1)
                return pair.count == 2 ? (String(pair[0]), String(pair[1])) : nil
            })
        }
        let tail = app.staticTexts["历史分页阅读锚点 32"]
        let initialTail = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in tail.isHittable }, object: tail)
        XCTAssertEqual(XCTWaiter.wait(for: [initialTail], timeout: 5), .completed)
        XCTAssertEqual(protocolFields()["requests"], "0", "Paging starts only after the reader scrolls toward older content")
        XCTAssertEqual(protocolFields()["publishedMessages"], "12")
        XCTAssertEqual(protocolFields()["publishedHistory20"], "false")
        for _ in 0..<12 where !delivery.isEnabled {
            transcript.swipeDown()
            settle()
        }
        XCTAssertTrue(waitUntilEnabled(delivery, timeout: 3), (delivery.value as? String) ?? "Missing history request")
        guard delivery.isEnabled else { return }
        let pending = protocolFields()
        XCTAssertEqual(pending["requests"], "1")
        XCTAssertEqual(pending["responses"], "0")
        XCTAssertEqual(pending["before"], "history-entry-21")
        XCTAssertEqual(pending["target"], "history-entry-32")
        XCTAssertEqual(pending["ack"], "none")
        XCTAssertEqual(pending["error"], "none")
        let syncId = try XCTUnwrap(pending["sync"])
        XCTAssertNotEqual(syncId, "none")
        settle()
        let viewport = transcript.frame
        let anchor = try XCTUnwrap(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "历史分页阅读锚点 "))
            .allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > viewport.minY + 10 && $0.frame.maxY < viewport.maxY - 10 })
        let anchorLabel = anchor.label
        let before = anchor.frame
        settle()
        XCTAssertEqual(anchor.frame.minY, before.minY, accuracy: 1, "The pending-page measurement must be stationary")
        delivery.tap()
        let applied = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in protocolFields()["ack"] == "applied" }, object: delivery)
        XCTAssertEqual(XCTWaiter.wait(for: [applied], timeout: 5), .completed, (delivery.value as? String) ?? "Missing applied acknowledgement")
        let published = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let fields = protocolFields()
            return fields["publishedMessages"] == "32" && fields["publishedHistory20"] == "true"
        }, object: delivery)
        XCTAssertEqual(XCTWaiter.wait(for: [published], timeout: 5), .completed,
            "Measure only after the chat's observed transcript contains the prepended history: \((delivery.value as? String) ?? "missing")")
        settle()
        let after = app.staticTexts.matching(NSPredicate(format: "label == %@", anchorLabel)).firstMatch
        XCTAssertTrue(after.isHittable, "The same reading text must remain in the viewport after prepend")
        XCTAssertEqual(after.frame.minY, before.minY, accuracy: 1)
        XCTAssertEqual(after.frame.width, before.width, accuracy: 1)
        XCTAssertEqual(after.frame.height, before.height, accuracy: 1)
        XCTAssertEqual(transcript.frame, viewport)
        let frames = try chatScrollFrames(app)
        let firstSample = try XCTUnwrap(frames.first)
        let anchorID = try XCTUnwrap(firstSample.cells?.filter { id, frame in
            id.hasPrefix("history-message-") && frame[0] > viewport.minY + 10 &&
                frame[0] + frame[2] < viewport.maxY - 10
        }.min { $0.value[0] < $1.value[0] }?.key)
        for id in [anchorID, "#presentation:" + anchorID] {
            let cellFrames = frames.compactMap { $0.cells?[id] }
            XCTAssertGreaterThan(cellFrames.count, 3)
            XCTAssertEqual(cellFrames.count, frames.count, "The original row must remain visible in every sampled frame")
            let firstFrame = try XCTUnwrap(cellFrames.first)
            for frame in cellFrames {
                XCTAssertEqual(frame[0], firstFrame[0], accuracy: 1, "History prepend moved the reading anchor for one frame: " + id)
            }
        }
        let completed = protocolFields()
        XCTAssertEqual(completed["requests"], "1")
        XCTAssertEqual(completed["responses"], "1")
        XCTAssertEqual(completed["sync"], syncId)
        XCTAssertEqual(completed["ackSync"], syncId)
        XCTAssertEqual(completed["ack"], "applied")
        XCTAssertEqual(completed["range"], "history")
        XCTAssertEqual(completed["mode"], "prepend")
        XCTAssertEqual(completed["selection"], "absent")
        XCTAssertEqual(completed["entries"], "20")
        XCTAssertEqual(completed["publishedMessages"], "32")
        XCTAssertEqual(completed["publishedHistory20"], "true")
        XCTAssertEqual(completed["error"], "none")
        capture("history-prepend-reading-anchor", app: app)
        let jump = app.buttons["跳到最新消息"]
        XCTAssertTrue(jump.waitForExistence(timeout: 3))
        jump.tap()
        let latest = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in tail.isHittable }, object: tail)
        XCTAssertEqual(XCTWaiter.wait(for: [latest], timeout: 5), .completed)
        let older = app.staticTexts["历史分页阅读锚点 20"]
        for _ in 0..<20 where !older.isHittable {
            transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.4)).press(forDuration: 0.05,
                thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.75)), withVelocity: .slow, thenHoldForDuration: 0.2)
            settle()
        }
        XCTAssertTrue(older.isHittable, "The applied response must expose real older messages above the original page")
        XCTAssertEqual(protocolFields()["requests"], "1", "The completed history range must not request a second page")
    }

    func testQuestionReminderKeepsTheHistoryHeaderAccessible() {
        let app = launch("tool", arguments: ["--preview-history-prepend", "--preview-reduce-motion"])
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        let viewport = transcript.frame
        let reminder = app.buttons["chat-question-reminder"]
        for _ in 0..<12 where !reminder.exists {
            transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).press(forDuration: 0.05,
                thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)),
                withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        XCTAssertTrue(reminder.waitForExistence(timeout: 3), "The latest question is below the reader before reaching history controls")
        let older = app.buttons["chat-history-older"]
        for _ in 0..<20 where !older.isHittable {
            transcript.swipeDown()
            settle()
        }
        XCTAssertTrue(older.isHittable, "The reminder must leave the older-history control reachable")
        XCTAssertTrue(reminder.waitForNonExistence(timeout: 3), "History controls take precedence while their row is visible")
        XCTAssertEqual(transcript.frame, viewport, "Giving the history control priority must not resize or reposition the transcript")
        capture("question-reminder-history-control", app: app)
        let delivery = app.buttons["preview-history-deliver"]
        XCTAssertTrue(waitUntilEnabled(delivery, timeout: 3), "Reaching the header must still request actual older history")
        XCTAssertTrue((delivery.value as? String ?? "").contains("requests=1;responses=0"))
    }

    func testQuestionReminderAppearsWhileReadingAndLocatesTheOriginalWithoutFollowing() {
        for dark in [false, true] {
            let app = launch("viewport", dark: dark, arguments: ["--preview-question-reminder"])
            XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
            let reminder = app.buttons["chat-question-reminder"]
            XCTAssertFalse(reminder.exists, "Following a long reply must not show the question automatically")
            let transcript = chatTranscript(app)
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
            recordAnchorDiagnostics(app)
            if let anchor, let before { XCTAssertEqual(anchor.frame.minY, before, accuracy: 1) }
            capture("question-reminder-reading-\(dark)", app: app)
            reminder.tap()
            XCTAssertTrue(reminder.waitForNonExistence(timeout: 5))
            let original = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "帮我比较这两种实现")).firstMatch
            XCTAssertTrue(original.isHittable)
            XCTAssertTrue(app.buttons["跳到最新消息"].exists, "Locating the question leaves following disabled")
            capture("question-reminder-original-\(dark)", app: app)
            transcript.swipeUp()
            XCTAssertTrue(reminder.waitForNonExistence(timeout: 3), "Scrolling toward newer content clears the earlier-reading intent")
            transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).press(forDuration: 0.05,
                thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.6)), withVelocity: .slow, thenHoldForDuration: 0.2)
            recordAnchorDiagnostics(app)
            XCTAssertTrue(reminder.waitForExistence(timeout: 3))
            app.buttons["跳到最新消息"].tap()
            XCTAssertTrue(reminder.waitForNonExistence(timeout: 5))
            app.terminate()
        }
    }

    // IOS-CHAT-13: a hosted message must constrain both horizontal readers to the
    // chat width; their native pans must move content without moving the vertical anchor.
    func testChatCodeAndTableScrollHorizontallyWithoutMovingTheReadingAnchor() {
        let app = launch("viewport", arguments: ["--preview-viewport-rich-content", "--preview-reduce-motion"])
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        let anchor = app.staticTexts["原生行横向阅读锚点"]
        XCTAssertTrue(anchor.waitForExistence(timeout: 5))
        XCTAssertTrue(anchor.isHittable)
        let viewport = transcript.frame
        let before = anchor.frame
        for identifier in ["chat-code-horizontal", "chat-table-horizontal"] {
            let horizontal = app.scrollViews[identifier].firstMatch
            XCTAssertTrue(horizontal.isHittable)
            XCTAssertGreaterThanOrEqual(horizontal.frame.minX, viewport.minX)
            XCTAssertLessThanOrEqual(horizontal.frame.maxX, viewport.maxX)
            let text = identifier == "chat-code-horizontal"
                ? app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "native_horizontal_code_start_")).firstMatch
                : app.staticTexts["横向表格起点"]
            let x = text.frame.minX
            horizontal.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.5)).press(forDuration: 0.05,
                thenDragTo: horizontal.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5)),
                withVelocity: .slow, thenHoldForDuration: 0.2)
            XCTAssertLessThan(text.frame.minX, x - 80, "The horizontal gesture must move actual content")
            XCTAssertEqual(anchor.frame.minY, before.minY, accuracy: 1)
            XCTAssertEqual(transcript.frame, viewport)
        }
        XCTAssertTrue(app.staticTexts["横向表格终点"].isHittable)
        capture("chat-native-horizontal-code-table", app: app)
    }

    // IOS-CHAT-04: after explicit question positioning, native idle and a later source
    // publication cannot resume following. This reaches the command independently of
    // the existing stationary-reading/source assertion in the broader reminder case.
    func testQuestionLocationRemainsReadingAfterNativeIdleAndSourcePublication() {
        let app = launch("viewport", arguments: ["--preview-question-reminder"])
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        let reminder = app.buttons["chat-question-reminder"]
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).press(forDuration: 0.05,
            thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)), withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(reminder.waitForExistence(timeout: 3))
        reminder.tap()
        XCTAssertTrue(reminder.waitForNonExistence(timeout: 5))
        let original = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "帮我比较这两种实现")).firstMatch
        XCTAssertTrue(original.isHittable)
        XCTAssertTrue(app.buttons["跳到最新消息"].exists)
        settle()
        let locatedY = original.frame.minY
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "刷新 Git 工作分支")).firstMatch.tap()
        settle()
        XCTAssertEqual(original.frame.minY, locatedY, accuracy: 1)
        XCTAssertFalse(reminder.exists)
        XCTAssertTrue(app.buttons["跳到最新消息"].exists)
    }

    func testQuestionReminderTracksNewSourceQuestionsWithoutMovingTheReader() {
        let app = launch("viewport", arguments: ["--preview-viewport-rows", "--preview-reduce-motion"])
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        let reminder = app.buttons["chat-question-reminder"]
        for _ in 0..<8 where !reminder.exists {
            transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).press(forDuration: 0.05,
                thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)), withVelocity: .slow, thenHoldForDuration: 0.3)
        }
        recordAnchorDiagnostics(app)
        XCTAssertTrue(reminder.waitForExistence(timeout: 3))
        XCTAssertTrue(reminder.label.contains("新增消息 0"))
        let anchor = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 "))
            .allElementsBoundByIndex.first { $0.isHittable && $0.frame.minY > transcript.frame.minY + 120 && $0.frame.maxY < transcript.frame.maxY - 20 }
        if anchor == nil {
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "E3 missing reading anchor accessibility hierarchy"; hierarchy.lifetime = .keepAlways
            add(hierarchy)
            let anchors = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 ")).allElementsBoundByIndex
            let details = anchors.enumerated().map { index, candidate in
                "\(index): label=\(candidate.label); frame=\(candidate.frame); isHittable=\(candidate.isHittable)"
            }
            let query = XCTAttachment(string: "count=\(anchors.count); viewport=\(transcript.frame)\n" + details.joined(separator: "\n"))
            query.name = "E3 missing reading anchor accessibility query"; query.lifetime = .keepAlways
            add(query)
            // Diagnose a delayed AX snapshot without repairing the original nil or
            // changing the assertion. Successful runs never perform these reads.
            let recoveryStarted = Date()
            var polls = 0, finalCount = anchors.count
            var recoveredAfter: TimeInterval?
            var recoveredElement = "none"
            let recovery = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                polls += 1
                let candidates = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 ")).allElementsBoundByIndex
                finalCount = candidates.count
                guard let candidate = candidates.first(where: {
                    $0.isHittable && $0.frame.minY > transcript.frame.minY + 120 && $0.frame.maxY < transcript.frame.maxY - 20
                }) else { return false }
                recoveredAfter = Date().timeIntervalSince(recoveryStarted)
                recoveredElement = "label=\(candidate.label); frame=\(candidate.frame)"
                return true
            }, object: nil)
            let recoveryResult = XCTWaiter.wait(for: [recovery], timeout: 10)
            let recoveryTime = recoveredAfter.map { String(format: "%.3f", $0) } ?? "none"
            let recoveryReport = XCTAttachment(string: "originalAnchor=nil; recovered=\(recoveryResult == .completed); recoveredAfter=\(recoveryTime); elapsed=\(Date().timeIntervalSince(recoveryStarted)); polls=\(polls); finalCount=\(finalCount); \(recoveredElement)")
            recoveryReport.name = "E3 missing reading anchor recovery diagnostic"; recoveryReport.lifetime = .keepAlways
            add(recoveryReport)
            let scopedAnchors = transcript.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 ")).allElementsBoundByIndex
            let scopedFirst = scopedAnchors.first.map { "label=\($0.label); frame=\($0.frame)" } ?? "none"
            let scopedHierarchy = XCTAttachment(string: transcript.debugDescription)
            scopedHierarchy.name = "E3 missing reading anchor transcript hierarchy"; scopedHierarchy.lifetime = .keepAlways
            add(scopedHierarchy)
            let globalAfter = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 ")).allElementsBoundByIndex.count
            let scopedReport = XCTAttachment(string: "originalAnchor=nil; scopedCount=\(scopedAnchors.count); scopedFirst=\(scopedFirst); globalAfterCount=\(globalAfter)")
            scopedReport.name = "E3 missing reading anchor scoped query diagnostic"; scopedReport.lifetime = .keepAlways
            add(scopedReport)
        }
        XCTAssertNotNil(anchor)
        let before = anchor?.frame.minY
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "刷新 Git 工作分支")).firstMatch.tap()
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", "新增消息 1"), object: reminder)
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed)
        recordAnchorDiagnostics(app)
        if let anchor, let before { XCTAssertEqual(anchor.frame.minY, before, accuracy: 1) }
        capture("question-reminder-new-source-reduced", app: app)
        app.buttons["跳到最新消息"].tap()
        XCTAssertTrue(reminder.waitForNonExistence(timeout: 5))
    }

    // Select the actual backend container without traversing row accessibility first.
    // Original Text, hittability, viewport and position assertions remain unchanged.
    private func chatTranscript(_ app: XCUIApplication) -> XCUIElement {
        ProcessInfo.processInfo.environment["ORBIS_CHAT_TRANSCRIPT_BACKEND"] != "swiftui"
            ? app.collectionViews["chat-transcript-native"].firstMatch : app.scrollViews.firstMatch
    }

    private func recordAnchorDiagnostics(_ app: XCUIApplication) {
        guard ProcessInfo.processInfo.environment["ORBIS_CHAT_ANCHOR_DIAGNOSTICS"] == "1" else { return }
        let report = app.staticTexts["preview-anchor-diagnostics"]
        let attachment = XCTAttachment(string: (report.value as? String) ?? report.label)
        attachment.name = "Chat anchor native samples"; attachment.lifetime = .keepAlways
        add(attachment)
        // Keep the native AX tree and the exact anchor-query results beside geometry:
        // rendered reading text can otherwise disappear from the accessibility query.
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "Chat anchor accessibility hierarchy"; hierarchy.lifetime = .keepAlways
        add(hierarchy)
        let anchors = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "阅读锚点 ")).allElementsBoundByIndex
        let details = anchors.enumerated().map { index, anchor in
            "\(index): label=\(anchor.label); frame=\(anchor.frame); isHittable=\(anchor.isHittable)"
        }
        let query = XCTAttachment(string: "count=\(anchors.count)\n" + details.joined(separator: "\n"))
        query.name = "Chat anchor accessibility query"; query.lifetime = .keepAlways
        add(query)
    }

    private func chatRegionCounts(_ report: XCUIElement) -> [String: Int] {
        Dictionary(uniqueKeysWithValues: report.label.split(separator: ";").compactMap { field -> (String, Int)? in
            let pair = field.split(separator: "=", maxSplits: 1)
            guard pair.count == 2, let value = Int(pair[1]) else { return nil }
            return (String(pair[0]), value)
        })
    }

    private func waitForStableChatRegions(_ report: XCUIElement) {
        var previous = "", since = Date()
        let stable = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            if report.label != previous { previous = report.label; since = Date() }
            return Date().timeIntervalSince(since) >= 1
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [stable], timeout: 12), .completed)
    }

    // IOS-CHAT-10: visibility alone must not rebuild completed rows/Markdown.
    func testStaticChatRowsDoNotRebuildAcrossCoverAndReturn() {
        let app = launch("viewport", arguments: ["--probe-chat-updates"])
        let report = app.staticTexts["chat-update-report"]
        XCTAssertTrue(report.waitForExistence(timeout: 8))
        waitForStableChatRegions(report)
        let before = chatRegionCounts(report)
        app.buttons["chat-downloads"].tap()
        XCTAssertTrue(app.staticTexts["下载"].waitForExistence(timeout: 3))
        app.buttons["返回"].firstMatch.tap()
        XCTAssertTrue(report.waitForExistence(timeout: 3))
        waitForStableChatRegions(report)
        let after = chatRegionCounts(report)
        for region in ["transcript", "row", "markdown", "nativeRow", "nativeAuxiliary", "nativeReconfigure", "nativeSnapshot"] {
            XCTAssertEqual(after[region], before[region], "Visibility rebuilt " + region)
        }
    }

    // IOS-CHAT-11: a short drag stays within the same long reply. Viewport facts
    // must not rebuild its ForEach owner, mounted row, or prepared Markdown.
    func testDraggingDoesNotRebuildTranscriptRegion() {
        let app = launch("viewport", arguments: ["--probe-chat-updates", "--preview-question-reminder"])
        let report = app.staticTexts["chat-update-report"]
        XCTAssertTrue(report.waitForExistence(timeout: 8))
        waitForStableChatRegions(report)
        let reminder = app.buttons["chat-question-reminder"]
        XCTAssertFalse(reminder.exists)
        let before = chatRegionCounts(report)
        for region in ["transcript", "row", "markdown"] {
            XCTAssertGreaterThan(before[region] ?? 0, 0, "Missing render count for " + region)
        }
        let transcript = chatTranscript(app)
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.45)).press(forDuration: 0.05,
            thenDragTo: transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)), withVelocity: .slow, thenHoldForDuration: 0.3)
        XCTAssertTrue(reminder.waitForExistence(timeout: 3))
        waitForStableChatRegions(report)
        let after = chatRegionCounts(report)
        for region in ["transcript", "row", "markdown", "nativeRow", "nativeAuxiliary", "nativeReconfigure", "nativeSnapshot"] {
            XCTAssertEqual(after[region], before[region], "Dragging rebuilt " + region)
        }
    }

    // Exercise the native keyboard resize while source patches keep replacing a long reply.
    // Input and navigation must remain responsive, with the header fixed and the draft retained.
    func testKeyboardRemainsResponsiveWhileLongReplyIsPublished() throws {
        try verifyInputDuringReplyPublication(resizeFixture: false)
    }

    // The same responsive-input and fixed-header assertions also run with a deterministic
    // viewport reduction on headless runners that do not display a software keyboard.
    func testViewportSqueezeRemainsResponsiveWhileLongReplyIsPublished() throws {
        try verifyInputDuringReplyPublication(resizeFixture: true)
    }

    private func verifyInputDuringReplyPublication(resizeFixture: Bool) throws {
        let app = launch("viewport", arguments: ["--preview-keyboard-stream"] + (resizeFixture ? ["--preview-keyboard-resize"] : []))
        defer { app.terminate() }
        let composer = app.descendants(matching: .any)["chat-composer"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
        let height = transcript.frame.height
        let title = app.buttons["chat-title"]
        let header = title.frame
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "刷新 Git 工作分支")).firstMatch.tap()
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        capture("keyboard-source-publication-open", app: app)
        let keyboard = app.keyboards.firstMatch.frame
        if !resizeFixture {
            try XCTSkipIf(!keyboard.intersects(app.frame) || keyboard.minY >= app.frame.maxY - 1,
                          "Headless Device Hub exposes an offscreen hardware-keyboard frame; native software-keyboard validation requires a visible keyboard")
            XCTAssertGreaterThan(keyboard.height, 100, "This regression requires the software keyboard to be visible")
        }
        composer.typeText("typing while generating")
        XCTAssertEqual(composer.value as? String, "typing while generating")
        XCTAssertLessThan(transcript.frame.height, height - 100)
        XCTAssertEqual(title.frame, header)
        if !resizeFixture { XCTAssertLessThanOrEqual(composer.frame.maxY, app.keyboards.firstMatch.frame.minY + 1) }
        transcript.swipeDown()
        app.buttons["返回"].firstMatch.tap()
        XCTAssertTrue(app.buttons["home-runtime-preview-codex"].waitForExistence(timeout: 5))
        capture("keyboard-during-source-publication", app: app)
    }

    func testNewMessagesAndToolsPreserveTheMovingReadingAnchor() {
        let app = launch("viewport", arguments: ["--preview-viewport-rows", "--preview-viewport-drag"])
        XCTAssertTrue(app.descendants(matching: .any)["chat-composer"].firstMatch.waitForExistence(timeout: 8))
        let transcript = chatTranscript(app)
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
    // S36 / SC57: both subscription windows stay visible together, refreshing
    // quota does not change the browsed profile or apply a configuration.
    func testProviderQuotaShowsBothWindowsAndRefreshIsIndependent() {
        let app = launch("providers", dark: true, arguments: ["--preview-reduce-motion"])
        let refresh = app.buttons["provider-quota-refresh"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 8))
        let action = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "provider-action-")).firstMatch
        let before = action.label
        XCTAssertTrue(waitUntilEnabled(refresh, timeout: 8))
        refresh.tap()
        XCTAssertTrue(app.staticTexts["82"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["35"].exists)
        XCTAssertEqual(action.label, before)
        XCTAssertTrue(app.descendants(matching: .any)["provider-quota-five_hour"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["provider-quota-seven_day"].exists)
        capture("provider-two-quota-windows-dark", app: app)
        // A reading never retires the refresh: the next tap reaches a new read (the preview reports one point less).
        XCTAssertTrue(waitUntilEnabled(refresh, timeout: 8))
        refresh.tap()
        XCTAssertTrue(app.staticTexts["81"].waitForExistence(timeout: 8))
        XCTAssertTrue(waitUntilEnabled(refresh, timeout: 8))
    }

    // FOLD-03: the closed landscape screen keeps quota beside the dial and makes
    // the lower action/count reachable by scrolling without moving either dial.
    func testProviderClosedLandscapePlacesQuotaOnRightAndScrollsToBottom() {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = launch("providers", arguments: ["--preview-reduce-motion", "--preview-reset-design"])
        let window = app.windows.firstMatch
        let controls = app.scrollViews["provider-controls-scroll"]
        XCTAssertTrue(controls.waitForExistence(timeout: 8))
        XCTAssertLessThan(window.frame.height, 600, "Run this case on the closed Duo or a phone in landscape")
        let quota = app.descendants(matching: .any)["provider-quota-five_hour"].firstMatch
        let refresh = app.buttons["provider-quota-refresh"]
        XCTAssertTrue(quota.waitForExistence(timeout: 4))
        XCTAssertGreaterThan(quota.frame.minX, window.frame.midX)
        XCTAssertFalse(app.descendants(matching: .any)["persistent-session-directory"].firstMatch.exists)
        XCTAssertTrue(waitUntilEnabled(refresh, timeout: 8))
        refresh.tap()
        XCTAssertTrue(app.staticTexts["82"].waitForExistence(timeout: 8))

        let action = app.buttons["provider-action-official"]
        let position = app.staticTexts["provider-position"]
        let profile = app.descendants(matching: .any)["provider-profile-keyboard"].firstMatch
        let selected = profile.value as? String
        for _ in 0..<4 where !position.isHittable { controls.swipeUp() }
        XCTAssertTrue(position.isHittable, "The bottom count must be reachable inside the right column")
        XCTAssertGreaterThanOrEqual(position.frame.minY, controls.frame.minY)
        XCTAssertLessThanOrEqual(position.frame.maxY, controls.frame.maxY)
        XCTAssertTrue(action.exists)
        XCTAssertFalse(action.isEnabled)
        XCTAssertEqual(profile.value as? String, selected, "Scrolling controls must not browse the dial")
        capture("provider-closed-landscape-right-controls", app: app)

        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(controls.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["provider-quota-refresh"].isHittable)
        XCTAssertEqual(app.descendants(matching: .any)["provider-profile-keyboard"].firstMatch.value as? String, selected)
    }

    // S28 / SC48 and S29 / SC49: verify active protocol reporting and all three saved modes.
    func testCurrentConnectionProtocol() {
        for (dark, value, arguments) in [(false, "WS", [String]()), (true, "QUIC", ["--preview-relay-quic"])] {
            let app = launch("status", dark: dark, arguments: arguments)
            let row = app.buttons["settings-protocol"]
            XCTAssertTrue(row.waitForExistence(timeout: 8))
            XCTAssertTrue(row.label.contains(value))
            row.tap()
            let automatic = app.buttons["relay-mode-auto"], ws = app.buttons["relay-mode-ws"], quic = app.buttons["relay-mode-quic"]
            XCTAssertTrue(automatic.waitForExistence(timeout: 3)); XCTAssertTrue(ws.exists); XCTAssertTrue(quic.exists)
            automatic.tap(); XCTAssertTrue(automatic.isSelected)
            quic.tap(); XCTAssertTrue(quic.isSelected)
            XCTAssertTrue(app.buttons["relay-mode-apply"].isEnabled)
            capture("status-protocol-staged-" + value, app: app)
            app.terminate()
        }
    }

    func testBasicConnectionStatusAndDirectoryProviderMismatch() {
        for dark in [false, true] {
            let app = launch("status", dark: dark)
            XCTAssertTrue(app.staticTexts["当前连接"].waitForExistence(timeout: 8))
            // Providers now come first (ADR-0046 §5); the connection and pairing facts follow below them.
            let page = app.descendants(matching: .any)["settings-page"].firstMatch
            for label in ["已连接", "连接方式", "连接协议", "WS", "连接延迟", "42 ms", "端到端加密", "电脑", "配对状态"] {
                let fact = app.staticTexts[label].firstMatch
                // The language section extends the page; a full swipe can pass the connection facts.
                for _ in 0..<8 where !fact.isHittable {
                    let upwards = fact.frame.midY > page.frame.midY
                    page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: upwards ? 0.65 : 0.35))
                        .press(forDuration: 0.05, thenDragTo: page.coordinate(withNormalizedOffset:
                            CGVector(dx: 0.5, dy: upwards ? 0.35 : 0.65)))
                }
                XCTAssertTrue(fact.isHittable, label)
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
            let latency = noSample.staticTexts["连接延迟"].firstMatch
            for _ in 0..<8 where !latency.isHittable {
                let upwards = latency.frame.midY > noSamplePage.frame.midY
                noSamplePage.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: upwards ? 0.65 : 0.35))
                    .press(forDuration: 0.05, thenDragTo: noSamplePage.coordinate(withNormalizedOffset:
                        CGVector(dx: 0.5, dy: upwards ? 0.35 : 0.65)))
            }
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
    // S50 / SC71: match Android's preview, nested filters and fixed selection toolbar.
    // Searching must reach a directory outside the three-row preview without expanding it first.
    func testDrawerControlsOpenTheirMenusFromHome() {
        let app = launch("home")
        let open = app.buttons["打开会话目录"]
        XCTAssertTrue(open.waitForExistence(timeout: 8))
        print("DRAWER_HIT_TARGET home=\(open.isHittable) frame=\(open.frame)")
        open.tap()
        let host = app.buttons["drawer-host-switcher"]
        XCTAssertTrue(host.waitForExistence(timeout: 3))
        print("DRAWER_HIT_TARGET host=\(host.isHittable) enabled=\(host.isEnabled) frame=\(host.frame)")
        XCTAssertTrue(host.isHittable)
        let close = app.buttons["关闭会话目录"]
        XCTAssertTrue(close.isHittable)
        XCTAssertGreaterThanOrEqual(close.frame.minX, host.frame.maxX)
        close.tap()
        XCTAssertTrue(open.waitForExistence(timeout: 3))
        open.tap()
        XCTAssertTrue(host.waitForExistence(timeout: 3))
        XCTAssertTrue(host.isHittable)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "drawer-hit-hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
        host.tap()
        XCTAssertTrue(app.buttons["添加电脑"].waitForExistence(timeout: 3))
        capture("drawer-computer-menu-hit", app: app)
    }

    func testDrawerDirectoryPreviewAndSearchReachAllDirectories() {
        let app = launch("drawer", arguments: ["--preview-many-directories", "--preview-hosts=2"])
        let directories = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "drawer-directory-/"))
        XCTAssertTrue(app.buttons["drawer-directory-/Projects/test-1"].waitForExistence(timeout: 8))
        XCTAssertEqual(directories.count, 3)
        XCTAssertTrue(app.staticTexts["7 个目录"].exists)
        let more = app.buttons["drawer-directory-preview-more"]
        more.tap()
        XCTAssertEqual(directories.count, 7)
        let list = app.scrollViews["drawer-session-list"]
        for _ in 0..<4 where !more.isHittable { list.swipeUp() }
        more.tap()
        XCTAssertEqual(directories.count, 3)
        let search = app.textFields["搜索目录或会话"]
        search.tap(); search.typeText("test-7\n")
        XCTAssertTrue(app.buttons["drawer-directory-/Projects/test-7"].waitForExistence(timeout: 3))
        XCTAssertEqual(directories.count, 1)
        XCTAssertFalse(more.exists)
        capture("drawer-search-outside-preview", app: app)
        app.buttons["清除搜索"].tap()
        XCTAssertTrue(app.buttons["drawer-directory-/Projects/test-1"].waitForExistence(timeout: 3))
        XCTAssertEqual(directories.count, 3)
        XCTAssertTrue(app.buttons["drawer-host-switcher"].isHittable)
        XCTAssertTrue(app.staticTexts["drawer-host-status"].label == "已连接")
        XCTAssertTrue(app.staticTexts["2 台"].exists)
        capture("drawer-three-directories-and-host", app: app)
    }

    func testDrawerSessionPreviewExpandsAndCollapsesAtThreeRows() {
        let app = launch("drawer", arguments: ["--preview-long-directory"])
        XCTAssertTrue(app.buttons["drawer-session-session-4"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["drawer-session-session-5"].exists)
        let more = app.buttons["drawer-session-preview-more"]
        XCTAssertTrue(more.label.contains("查看全部 24 条"))
        XCTAssertLessThanOrEqual(more.frame.maxY, app.buttons["在此目录新建会话"].frame.minY)
        more.tap()
        XCTAssertTrue(app.buttons["drawer-session-session-25"].exists)
        let list = app.scrollViews["drawer-session-list"]
        for _ in 0..<12 where !more.isHittable { list.swipeUp() }
        XCTAssertTrue(more.isHittable)
        more.tap()
        XCTAssertTrue(more.waitForExistence(timeout: 3))
        XCTAssertTrue(more.isHittable, "收起后原生滚动范围应立即回到预览范围")
        XCTAssertFalse(app.buttons["drawer-session-session-5"].exists)
        capture("drawer-three-session-preview", app: app)
    }

    func testDrawerSelectionToolbarKeepsGeometryThroughArchiveAndRestore() {
        for (dark, appearance, reduced) in [(false, "mist", false), (true, "sage", true)] {
            let app = launch("drawer", dark: dark, arguments: ["--preview-drawer-layout", "-orbis.appearance", appearance]
                + (reduced ? ["--preview-reduce-motion"] : []))
            let first = app.buttons["drawer-session-session-4"]
            let second = app.buttons["drawer-session-session-5"]
            XCTAssertTrue(first.waitForExistence(timeout: 8))
            let firstFrame = first.frame, secondFrame = second.frame
            first.press(forDuration: 0.8)
            XCTAssertTrue(app.staticTexts["已选择 1 项"].waitForExistence(timeout: 3))
            XCTAssertEqual(first.frame, firstFrame)
            XCTAssertEqual(second.frame, secondFrame)
            second.tap()
            XCTAssertTrue(app.staticTexts["已选择 2 项"].exists)
            XCTAssertTrue(first.isSelected)
            XCTAssertTrue(second.isSelected)
            XCTAssertEqual(first.frame, firstFrame)
            XCTAssertEqual(second.frame, secondFrame)
            capture("drawer-fixed-selection-\(appearance)", app: app)
            app.buttons["归档选中会话"].tap()
            XCTAssertFalse(first.exists)
            XCTAssertFalse(second.exists)
            let archive = app.buttons["drawer-archive-toggle"]
            archive.tap()
            XCTAssertTrue(first.waitForExistence(timeout: 3))
            XCTAssertTrue(archive.isSelected)
            first.press(forDuration: 0.8); second.tap()
            app.buttons["恢复选中会话"].tap()
            XCTAssertTrue(app.staticTexts["没有已归档的会话"].waitForExistence(timeout: 3))
            archive.tap()
            XCTAssertTrue(first.waitForExistence(timeout: 3))
            XCTAssertTrue(second.exists)
            XCTAssertFalse(archive.isSelected)
            capture("drawer-restored-\(appearance)", app: app)
            app.terminate()
        }
    }

    func testDrawerProviderSubmenuPreservesSearchAndArchiveFilters() {
        let app = launch("drawer")
        let search = app.textFields["搜索目录或会话"]
        XCTAssertTrue(search.waitForExistence(timeout: 8))
        search.tap(); search.typeText("优化\n")
        let filter = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "筛选会话：")).firstMatch
        filter.tap()
        let menu = app.descendants(matching: .any)["orbis-menu-panel"].firstMatch
        capture("drawer-agent-filter-open", app: app)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "drawer-filter-hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
        XCTAssertTrue(menu.waitForExistence(timeout: 3))
        XCTAssertFalse(menu.buttons["设置"].exists)
        app.buttons["Codex 终端"].tap()
        XCTAssertTrue(app.buttons["team"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Pi"].exists)
        capture("drawer-provider-submenu", app: app)
        app.buttons["team"].tap()
        XCTAssertTrue(app.buttons["drawer-session-session-4"].waitForExistence(timeout: 3))
        XCTAssertTrue(filter.label.contains("Codex 终端，team"))
        app.buttons["drawer-archive-toggle"].tap()
        XCTAssertEqual(search.value as? String, "优化")
        XCTAssertTrue(filter.label.contains("Codex 终端，team"))
        app.buttons["drawer-archive-toggle"].tap()
        XCTAssertTrue(app.buttons["drawer-session-session-4"].waitForExistence(timeout: 3))
        filter.tap(); app.buttons["全部"].tap()
        XCTAssertEqual(search.value as? String, "优化")
        XCTAssertEqual(filter.label, "筛选会话：全部")
        capture("drawer-provider-search-preserved", app: app)
    }

    func testDrawerCardsKeepUniformGeometryForShortAndLongTitles() {
        for (name, dark, category, style, reduced) in [("light", false, "UICTContentSizeCategoryL", "classic", false),
                                       ("dark", true, "UICTContentSizeCategoryL", "classic", false),
                                       ("fog-light", false, "UICTContentSizeCategoryL", "insetFocus", false),
                                       ("fog-dark", true, "UICTContentSizeCategoryL", "insetFocus", false),
                                       ("large", false, "UICTContentSizeCategoryXXXL", "classic", false),
                                       ("reduced", false, "UICTContentSizeCategoryL", "classic", true)] {
            let app = launch("drawer", dark: dark, arguments: ["--preview-drawer-layout",
                "-orbis.visualStyle", style, "-UIPreferredContentSizeCategoryName", category]
                + (reduced ? ["--preview-reduce-motion"] : []))
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
        // S47 / SC68: archive visibility has its own selected button left of the Agent filter.
        // Keep both target rows visible so XCTest does not scroll while synthesizing long press.
        let app = launch("drawer", arguments: ["--preview-drawer-layout"])
        let first = app.buttons["drawer-session-session-4"]
        let second = app.buttons["drawer-session-session-5"]
        XCTAssertTrue(first.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["会话操作"].exists)
        let archiveToggle = app.buttons["drawer-archive-toggle"]
        XCTAssertTrue(archiveToggle.isHittable)
        XCTAssertFalse(archiveToggle.isSelected)
        XCTAssertLessThanOrEqual(archiveToggle.frame.maxX, app.buttons["筛选会话：全部"].frame.minX)
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

        app.buttons["查看已归档会话"].tap()
        XCTAssertTrue(archiveToggle.isSelected)
        XCTAssertTrue(first.waitForExistence(timeout: 3))
        first.press(forDuration: 0.8)
        second.tap()
        XCTAssertTrue(app.staticTexts["已选择 2 项"].exists)
        app.buttons["恢复选中会话"].tap()
        XCTAssertTrue(app.staticTexts["没有已归档的会话"].waitForExistence(timeout: 3))
        app.buttons["查看未归档会话"].tap()
        XCTAssertFalse(archiveToggle.isSelected)
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
        let active = NSPredicate(format: "label CONTAINS %@", "暂停")
        let paused = NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "已暂停", "继续")
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

    // M14 / PERF-10: a selection on a full page consumes the back swipe; the next swipe returns.
    func testDownloadSelectionConsumesBackSwipeBeforeReturning() {
        let app = launch("downloads")
        let path = app.textFields["download-path"]
        XCTAssertTrue(path.waitForExistence(timeout: 8))
        path.tap(); path.typeText("/preview/report.zip")
        app.buttons["按路径下载"].tap()
        let card = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "download-card-")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        card.press(forDuration: 0.8)
        let selection = app.staticTexts["已选择 1 项"]
        XCTAssertTrue(selection.waitForExistence(timeout: 3))
        let y = card.frame.midY - app.frame.minY
        let origin = app.coordinate(withNormalizedOffset: .zero)
        func swipeBack() {
            origin.withOffset(CGVector(dx: app.frame.width * 0.15, dy: y))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.88, dy: y)),
                       withVelocity: .slow, thenHoldForDuration: 0.1)
        }
        swipeBack()
        XCTAssertTrue(selection.waitForNonExistence(timeout: 3), "the swipe clears the selection")
        XCTAssertTrue(path.exists, "the page stays while a selection consumes the swipe")
        swipeBack()
        XCTAssertTrue(app.buttons["打开会话目录"].waitForExistence(timeout: 3))
        XCTAssertTrue(path.waitForNonExistence(timeout: 3))
    }

    /// Optional visual evidence; enable ORBIS_CAPTURE_UI=1 in the test runner environment.
    func testPageScreenshotsInBothAppearances() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ORBIS_CAPTURE_UI"] == "1",
                          "Page screenshot collection is opt-in (ORBIS_CAPTURE_UI=1)")
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
        XCTAssertTrue(app.staticTexts["模型与深度"].waitForExistence(timeout: 5))
        app.buttons["会话信息"].tap()
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

    // IOS-CHAT-05: this enters the full-content flow directly so the independent
    // read/retry/attribution assertions do not depend on the supplement-info copy.
    func testFullEntryRetryKeepsCanonicalContentAndCurrentRequest() {
        let app = launch("truncated", arguments: ["--preview-full-entry-retry"])
        let open = app.buttons["full-entry-truncated-message"]
        XCTAssertTrue(open.waitForExistence(timeout: 8)); open.tap()
        let retry = app.buttons["full-entry-retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["完整内容读取失败，请重试。"].exists)
        retry.tap()
        XCTAssertTrue(app.staticTexts["完整返回内容：这条消息已按需从电脑取回。"].waitForExistence(timeout: 5))
        let copy = app.buttons["copy-full-entry-node-1"]
        XCTAssertTrue(copy.waitForExistence(timeout: 3)); XCTAssertTrue(copy.isEnabled)
        XCTAssertFalse(retry.exists)
        capture("full-entry-retry-canonical-owner", app: app)
    }

    func testTruncatedContentAndToolArguments() {
        let appearances: [(String, Bool, [String])] = [
            ("light", false, []),
            ("dark", true, []),
            ("large", false, ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]),
            ("reduced", false, ["--preview-reduce-motion"]),
        ]
        for (name, dark, arguments) in appearances {
        let app = launch("truncated", dark: dark, arguments: arguments)
        XCTAssertTrue(app.buttons["展开read，已完成"].waitForExistence(timeout: 8))
        app.buttons["展开read，已完成"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "/repo/source.swift")).firstMatch.exists)
        XCTAssertTrue(app.staticTexts["已完成工具参数验证。"].exists)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "有内容因超长被截断")).firstMatch.exists)
        capture("tool-arguments-truncated-" + name, app: app)
        app.buttons["full-entry-truncated-message"].tap()
        XCTAssertTrue(app.staticTexts["完整返回内容：这条消息已按需从电脑取回。"].waitForExistence(timeout: 5))
        // previewEntry resolves the display message ID to its authoritative entry (node-1 here).
        let copy = app.buttons["copy-full-entry-node-1"]
        XCTAssertTrue(copy.waitForExistence(timeout: 3))
        XCTAssertTrue(copy.isEnabled)
        let before = copy.frame
        copy.tap()
        XCTAssertEqual(copy.label, "已复制")
        capture("full-entry-copied-" + name, app: app)
        let restored = NSPredicate(format: "label == %@", "复制完整内容")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: restored, object: copy)], timeout: 4), .completed)
        XCTAssertEqual(copy.frame, before)
        capture("full-entry-" + name, app: app)
        app.terminate()
        }
    }

}
