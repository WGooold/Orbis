// Orbis 测试用途（场景与判定见本文件断言）：
// - 首页下拉刷新（M15、S18、V21）
import CoreGraphics
import Testing
@testable import OrbisCore

struct HomePullRefreshTests {
    @Test func aTopPullRefreshesOnceOnReleaseAndCanBeRepeated() {
        var gesture = HomePullRefreshGesture()
        gesture.begin(atTop: true, enabled: true)
        gesture.update(translation: CGPoint(x: 2, y: 100))
        let first = gesture.end(distance: 100)
        let duplicate = gesture.end(distance: 100)
        #expect(first)
        #expect(!duplicate)
        gesture.begin(atTop: true, enabled: true)
        gesture.update(translation: CGPoint(x: 0, y: 120))
        let repeated = gesture.end(distance: 120)
        #expect(repeated)
    }

    @Test func shortReversedNonTopAndDisabledPullsDoNotRefresh() {
        for (atTop, enabled, distance) in [(true, true, CGFloat(79)), (false, true, CGFloat(120)), (true, false, CGFloat(120))] {
            var gesture = HomePullRefreshGesture()
            gesture.begin(atTop: atTop, enabled: enabled)
            gesture.update(translation: CGPoint(x: 0, y: 120))
            let refreshed = gesture.end(distance: distance)
            #expect(!refreshed)
        }
        var reversed = HomePullRefreshGesture()
        reversed.begin(atTop: true, enabled: true)
        reversed.update(translation: CGPoint(x: 0, y: 160))
        let reversedRefresh = reversed.end(distance: 20)
        #expect(!reversedRefresh)
    }

    @Test func horizontalStartsAndCancelledDragsNeverBecomeRefreshes() {
        for first in [CGPoint(x: 30, y: 2), CGPoint(x: -30, y: 2), CGPoint(x: 0, y: -30)] {
            var gesture = HomePullRefreshGesture()
            gesture.begin(atTop: true, enabled: true)
            gesture.update(translation: first)
            gesture.update(translation: CGPoint(x: 0, y: 200))
            let refreshed = gesture.end(distance: 120)
            #expect(!refreshed)
        }
        var cancelled = HomePullRefreshGesture()
        cancelled.begin(atTop: true, enabled: true)
        cancelled.update(translation: CGPoint(x: 0, y: 120))
        cancelled.cancel()
        let cancelledRefresh = cancelled.end(distance: 120)
        #expect(!cancelledRefresh)
    }
}
