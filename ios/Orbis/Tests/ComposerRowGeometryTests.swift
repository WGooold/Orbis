import Foundation
import CoreGraphics
import Testing
@testable import OrbisCore

struct ComposerRowGeometryTests {
    // IOS-CHAT-03: reserve the real 48pt touch targets, not their 40pt visible discs.
    @Test func fixedWidthLeavesExactlyTheRemainingWidthAndBottomAlignsTheActions() {
        let button = CGSize(width: 48, height: 48)
        #expect(ChatComposerRowGeometry.editorWidth(in: 396, leading: button, trailing: button) == 280)
        let row = ChatComposerRowGeometry(proposedWidth: 396, leading: button,
                                         editor: CGSize(width: 280, height: 56), trailing: button)
        #expect(row.size == CGSize(width: 396, height: 56))
        #expect(row.leading == CGRect(x: 0, y: 8, width: 48, height: 48))
        #expect(row.editor == CGRect(x: 58, y: 0, width: 280, height: 56))
        #expect(row.trailing == CGRect(x: 348, y: 8, width: 48, height: 48))
    }

    // A growing multiline editor and differently sized actions use actual child metrics.
    @Test func multilineHeightAndMeasuredButtonSizesDoNotChangeTheSpacing() {
        let row = ChatComposerRowGeometry(proposedWidth: 396, leading: CGSize(width: 64, height: 52),
                                         editor: CGSize(width: 264, height: 148), trailing: CGSize(width: 48, height: 48))
        #expect(row.size == CGSize(width: 396, height: 148))
        #expect(row.editor.width == 264)
        #expect(row.editor.minX - row.leading.maxX == 10)
        #expect(row.trailing.minX - row.editor.maxX == 10)
        #expect([row.leading.maxY, row.editor.maxY, row.trailing.maxY] == [148, 148, 148])
    }

    // SwiftUI may ask minimum/ideal/infinite probes; none may invent a screen width
    // or return a nonfinite size. The final finite allocation supplies the editor width.
    @Test func idealAndMinimumProbesKeepNativeIdealWidthAndFiniteGeometry() {
        let button = CGSize(width: 48, height: 48)
        let idealProposals: [CGFloat?] = [nil, CGFloat.infinity, CGFloat.nan]
        for proposal in idealProposals {
            #expect(ChatComposerRowGeometry.editorWidth(in: proposal, leading: button, trailing: button) == nil)
            let row = ChatComposerRowGeometry(proposedWidth: proposal, leading: button,
                                             editor: CGSize(width: 205, height: 56), trailing: button)
            #expect(row.size == CGSize(width: 321, height: 56))
        }
        let minimumProposals: [CGFloat] = [0, -20, 80]
        for width in minimumProposals {
            #expect(ChatComposerRowGeometry.editorWidth(in: width, leading: button, trailing: button) == 0)
            let row = ChatComposerRowGeometry(proposedWidth: width, leading: button,
                                             editor: CGSize(width: 0, height: 56), trailing: button)
            #expect(row.size == CGSize(width: 116, height: 56))
            #expect(row.editor.width == 0)
        }
    }

    // Same-width probes can reuse derived geometry only during one Layout validity.
    // Marked text, child metrics and environment invalidation must discard both slots.
    @Test func cacheKeepsOnlyIdealAndLatestFiniteWidthAndInvalidationDiscardsBoth() {
        var cache = ChatComposerRowCache<String>()
        #expect(cache.value(for: 396) == nil)
        cache.store("ideal", for: nil)
        cache.store("portrait", for: 396)
        #expect(cache.value(for: nil) == "ideal")
        #expect(cache.value(for: 396) == "portrait")
        #expect(cache.value(for: 720) == nil)
        cache.store("landscape", for: 720)
        #expect(cache.value(for: 396) == nil)
        #expect(cache.value(for: 720) == "landscape")
        #expect(cache.value(for: nil) == "ideal")
        cache.invalidate()
        #expect(cache.value(for: 720) == nil)
        #expect(cache.value(for: nil) == nil)
    }
}
