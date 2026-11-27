import Foundation
import Testing
@testable import OrbisCore

struct ComputerPathMentionTests {
    // CHAT-PATH-01: only a newly inserted @ at the current caret opens the computer browser.
    @Test func recognizesCaretInsertionAndIgnoresPasteCompositionAndUnrelatedEdits() {
        #expect(ComputerPathMention.triggerRange(previous: "检查 ", current: "检查 @", caretUTF16: 4, markedText: false) == NSRange(location: 3, length: 1))
        #expect(ComputerPathMention.triggerRange(previous: "先后", current: "先@后", caretUTF16: 2, markedText: false) == NSRange(location: 1, length: 1))
        #expect(ComputerPathMention.triggerRange(previous: "", current: "@file", caretUTF16: 5, markedText: false) == nil)
        #expect(ComputerPathMention.triggerRange(previous: "x", current: "x@", caretUTF16: 2, markedText: true) == nil)
        #expect(ComputerPathMention.triggerRange(previous: "abc", current: "ab@c", caretUTF16: 4, markedText: false) == nil)
    }

    // CHAT-PATH-01: selection replaces only the trigger and preserves surrounding draft text/caret.
    @Test func insertsComputerPathAtTriggerAndQuotesPathsContainingSpaces() {
        let simple = ComputerPathMention.insertion(path: "/repo/Source.swift", into: "检查 @ 后续", replacing: NSRange(location: 3, length: 1))
        #expect(simple?.text == "检查 @/repo/Source.swift 后续")
        #expect(simple?.caretUTF16 == 22)

        let spaced = ComputerPathMention.insertion(path: "C:\\Users\\Ada Lovelace\\notes.md", into: "看@", replacing: NSRange(location: 1, length: 1))
        #expect(spaced?.text == "看 @\"C:\\Users\\Ada Lovelace\\notes.md\" ")
        #expect(spaced?.caretUTF16 == ("看 @\"C:\\Users\\Ada Lovelace\\notes.md\" ").utf16.count)
        #expect(ComputerPathMention.insertion(path: "/repo/file", into: "@", replacing: NSRange(location: 0, length: 1))?.text == "@/repo/file ")
        #expect(ComputerPathMention.insertion(path: "/repo/file", into: "x", replacing: NSRange(location: 0, length: 1)) == nil)
    }

    // CHAT-PATH-02: a selected directory is inserted as the same literal path reference as a file.
    @Test func insertsComputerDirectoryPathAtTrigger() {
        let folder = ComputerPathMention.insertion(path: "/repo/packages/shared", into: "检查 @ 后续",
                                                   replacing: NSRange(location: 3, length: 1))
        #expect(folder?.text == "检查 @/repo/packages/shared 后续")
        #expect(folder?.caretUTF16 == 25)
    }
}
