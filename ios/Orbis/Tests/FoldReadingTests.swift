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
}
