import CoreGraphics
import Foundation
import Testing
@testable import OrbisCore

struct FoldReadingTests {
    // FOLD-04/07: only a horizontal hinge enables upper reading/lower grip;
    // partial and full landscape postures share the same directory and page frames.
    @Test func postureSeparatesGripReadingFromOrdinaryWideLayouts() {
        let size = CGSize(width: 669, height: 951)
        let horizontal = CGRect(x: 0, y: 475, width: 669, height: 1)
        let vertical = CGRect(x: 475, y: 0, width: 1, height: 669)
        #expect(usesFoldReadingLayout(partiallyOpen: true, containerSize: size, divisionFrame: horizontal))
        #expect(!usesFoldReadingLayout(partiallyOpen: false, containerSize: size, divisionFrame: horizontal))
        #expect(!usesFoldReadingLayout(partiallyOpen: true, containerSize: size, divisionFrame: nil))
        #expect(!usesFoldReadingLayout(partiallyOpen: true, containerSize: size, divisionFrame: vertical))
        let landscape = CGSize(width: 951, height: 669)
        let partial = SessionShellGeometry(size: landscape, divisionFrame: vertical,
            hasHost: true, compactHeight: false, partiallyOpen: true)
        let full = SessionShellGeometry(size: landscape, divisionFrame: vertical,
            hasHost: true, compactHeight: false, partiallyOpen: false)
        #expect(partial == full)
        #expect(partial.showsDirectory && !partial.reading)
    }

    // FOLD-08: replay the resize before size class, posture and division settle.
    // Every expanded frame keeps the existing page on the right, including reopen.
    @Test func openingLandscapeReservesRightPaneBeforeLateHingeAndSizeClassUpdates() {
        let closedSize = CGSize(width: 678, height: 466)
        let expandedSize = CGSize(width: 951, height: 669)
        let hinge = CGRect(x: 475, y: 0, width: 1, height: 669)
        let closed = SessionShellGeometry(size: closedSize, divisionFrame: nil,
            hasHost: true, compactHeight: true, partiallyOpen: false, hasHinge: true)
        #expect(!closed.showsDirectory && closed.content == CGRect(origin: .zero, size: closedSize))
        for partiallyOpen in [true, false] {
            for compactHeight in [true, false] {
                for division: CGRect? in [nil, .zero, hinge] {
                    let layout = SessionShellGeometry(size: expandedSize, divisionFrame: division,
                        hasHost: true, compactHeight: compactHeight, partiallyOpen: partiallyOpen, hasHinge: true)
                    #expect(layout.showsDirectory && !layout.reading)
                    #expect(layout.content.minX >= 475 && layout.content.minX <= 476)
                    #expect(layout.content.width <= 476)
                    #expect(layout.content.maxX == expandedSize.width)
                    #expect(layout.directory.maxX <= layout.content.minX)
                }
            }
        }
    }

    // The shell keeps physical hinge clearance, portrait reading and ordinary
    // tablet widths while using a single layout source for the page and directory.
    @Test func shellPreservesHingeGapPortraitReadingAndTabletSidebar() {
        let landscape = SessionShellGeometry(size: CGSize(width: 951, height: 669),
            divisionFrame: CGRect(x: 471, y: 0, width: 9, height: 669),
            hasHost: true, compactHeight: false, partiallyOpen: true)
        #expect(landscape.directory.width == 471 && landscape.content.minX == 480)
        let portraitSize = CGSize(width: 669, height: 951)
        let portrait = SessionShellGeometry(size: portraitSize,
            divisionFrame: CGRect(x: 0, y: 475, width: 669, height: 1),
            hasHost: true, compactHeight: false, partiallyOpen: true)
        #expect(!portrait.showsDirectory && portrait.reading)
        #expect(portrait.content == CGRect(origin: .zero, size: portraitSize))
        let tablet = SessionShellGeometry(size: CGSize(width: 1180, height: 420), divisionFrame: nil,
            hasHost: true, compactHeight: false, partiallyOpen: false)
        #expect(tablet.directory.width == 320 && tablet.content.minX == 320 && !tablet.reading)
        let unpaired = SessionShellGeometry(size: CGSize(width: 951, height: 669), divisionFrame: nil,
            hasHost: false, compactHeight: false, partiallyOpen: false, hasHinge: true)
        #expect(!unpaired.showsDirectory && unpaired.content.minX == 0)
    }

    // FOLD-05: every blank pixel between navigation and input belongs to the
    // lower scroll surface, without letting it cover either control or the hinge.
    @Test func readingSurfaceFillsTheLowerBlankArea() {
        let hinge = CGRect(x: 0, y: 420, width: 669, height: 8)
        let layout = FoldReadingGeometry(size: CGSize(width: 669, height: 920), division: hinge,
            headerHeight: 80, composerHeight: 116, editing: false)
        #expect(layout.showsSurface)
        #expect(layout.transcript.maxY < hinge.minY)
        #expect(layout.header.minY > hinge.maxY)
        #expect(layout.surface.minY == layout.header.maxY)
        #expect(layout.surface.maxY == layout.composer.minY)
        #expect(layout.surface.width == 669 && layout.surface.height == 284)
        #expect(layout.composer.maxY == 920)
    }

    // FOLD-04 keyboard/multiline regression: resize by actual available height;
    // drop optional actions before allowing the input to overlap the transcript.
    @Test func keyboardAndGrowingDraftReserveEditorWithoutOverlappingReading() {
        for height: CGFloat in [650, 500, 360] {
            for editorHeight: CGFloat in [116, 200, 280] {
                let layout = FoldReadingGeometry(size: CGSize(width: 669, height: height),
                    division: CGRect(x: 0, y: 420, width: 669, height: 1),
                    headerHeight: 80, composerHeight: editorHeight, editing: true)
                #expect(!layout.showsSurface)
                #expect(layout.header.height == 0 && layout.surface.height == 0)
                #expect(layout.composer.maxY == height)
                #expect(layout.composer.height == editorHeight)
                #expect(layout.transcript.maxY <= layout.composer.minY)
                #expect(layout.transcript.height >= 0)
            }
        }
        let cramped = FoldReadingGeometry(size: CGSize(width: 669, height: 650),
            division: CGRect(x: 0, y: 420, width: 669, height: 1),
            headerHeight: 80, composerHeight: 116, editing: false)
        #expect(!cramped.showsSurface)
    }

    // VoiceOver retains an explicit page action without visible paging buttons;
    // native idle and new streamed text cannot resume following after that action.
    @Test func accessiblePagingRetainsReadingAndUsesExistingRequestOwnership() throws {
        var policy = ChatViewportPolicy()
        policy.turnPage(towardEarlier: true, viewportHeight: 400, bottomDistance: 0)
        let first = try #require(policy.request)
        #expect(first.target == .page(-340))
        #expect(!policy.following && policy.hasBrowsed && policy.lastScrollTowardEarlier)
        policy.interactionChanged(false, bottomDistance: 0)
        #expect(policy.owns(first) && !policy.following)
        policy.turnPage(towardEarlier: false, viewportHeight: 400, bottomDistance: 600)
        let next = try #require(policy.request)
        #expect(next.target == .page(340) && next.sequence > first.sequence)
        #expect(!policy.owns(first) && policy.owns(next))
        policy.turnPage(towardEarlier: true, viewportHeight: .nan, bottomDistance: 600)
        #expect(policy.owns(next))
        policy.interactionChanged(true, bottomDistance: 600)
        #expect(!policy.owns(next))
        policy.jumpToLatest()
        #expect(policy.following && policy.request?.target == .latest)
    }

    // A new lower-surface drag cancels old inertia; delayed deltas or idle from
    // that old gesture must not move or finish the new reader's gesture.
    @MainActor @Test func newSurfaceGestureRejectsOldMomentum() throws {
        let channel = ChatReadingSurface()
        var events: [ChatReadingSurface.Event] = []
        _ = channel.attach { events.append($0); return true }
        var cancelled = 0
        let old = try #require(channel.begin { cancelled += 1 })
        channel.move(old, by: -80)
        channel.release(old)
        channel.move(old, by: -20)
        let next = try #require(channel.begin { cancelled += 1 })
        channel.move(old, by: 900)
        channel.end(old)
        channel.move(next, by: 40)
        channel.move(next, by: .nan)
        channel.move(next, by: .infinity)
        channel.end(next)
        #expect(cancelled == 1)
        #expect(events == [.began, .moved(-80), .released, .moved(-20), .ended, .began, .moved(40), .ended])
    }

    // An old transcript's deferred teardown cannot detach the new mount, and
    // gesture callbacks from the old screen cannot reach the new transcript.
    @MainActor @Test func transcriptHandoffRejectsOldSurfaceCallbacks() throws {
        let channel = ChatReadingSurface()
        var oldEvents: [ChatReadingSurface.Event] = []
        let oldReceiver = channel.attach { oldEvents.append($0); return true }
        var cancelled = false
        let old = try #require(channel.begin { cancelled = true })
        var nextEvents: [ChatReadingSurface.Event] = []
        let nextReceiver = channel.attach { nextEvents.append($0); return true }
        channel.detach(oldReceiver)
        channel.move(old, by: 100)
        let next = try #require(channel.begin {})
        channel.move(next, by: -60)
        channel.detach(nextReceiver)
        channel.move(next, by: 100)
        #expect(cancelled)
        #expect(oldEvents == [.began, .ended])
        #expect(nextEvents == [.began, .moved(-60), .ended])
        #expect(channel.begin {} == nil)
    }

    // A boundary rejection retires inertia once, including a reentrant UIKit
    // cancellation callback; subsequent deltas must never restart scrolling.
    @MainActor @Test func rejectedMovementStopsTheSurfaceOnce() throws {
        let channel = ChatReadingSurface()
        var events: [ChatReadingSurface.Event] = []
        _ = channel.attach { event in events.append(event); return event != .moved(60) }
        var cancelled = 0
        let gesture = try #require(channel.begin { cancelled += 1; channel.cancel() })
        channel.release(gesture)
        channel.move(gesture, by: 60)
        channel.move(gesture, by: 20)
        channel.end(gesture)
        #expect(cancelled == 1)
        #expect(events == [.began, .released, .moved(60), .ended])
    }

    // Context switches, opening a disclosure and backgrounding cancel a native
    // reader without a SwiftUI body publication or waiting for the finger to lift.
    @MainActor @Test func contextAndVisibilityCancelTheSurface() throws {
        let viewport = ChatViewportController()
        var events: [ChatReadingSurface.Event] = []
        _ = viewport.readingSurface.attach { events.append($0); return true }
        var cancelled = 0
        let old = try #require(viewport.readingSurface.begin { cancelled += 1 })
        viewport.resetForMount()
        viewport.readingSurface.move(old, by: 100)
        let next = try #require(viewport.readingSurface.begin { cancelled += 1 })
        viewport.disclosureBegan()
        viewport.readingSurface.move(next, by: 100)
        let last = try #require(viewport.readingSurface.begin { cancelled += 1 })
        viewport.setVisualActive(false)
        viewport.readingSurface.move(last, by: 100)
        #expect(cancelled == 3)
        #expect(events == [.began, .ended, .began, .ended, .began, .ended])
    }
}
