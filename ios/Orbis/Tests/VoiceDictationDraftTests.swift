import Testing
@testable import OrbisCore

@Suite("IOS-VOICE-01: dictation in the chat draft")
struct VoiceDictationDraftTests {
    // Each partial is the entire current utterance, including corrections, not a delta.
    @Test func partialsReplaceOnlyThisUtterance() {
        var draft = VoiceDictationDraft(original: "原来的草稿")
        #expect(draft.text == "原来的草稿")
        draft.update(" 周三 ")
        #expect(draft.text == "原来的草稿\n周三")
        draft.update("周四下午三点")
        #expect(draft.text == "原来的草稿\n周四下午三点")
        #expect(draft.replacingTranscript(with: "周四下午三点。") == "原来的草稿\n周四下午三点。")
    }

    // A blank final or unavailable final at stop must not erase the last usable partial.
    @Test func emptyResultsKeepTheLastUsableText() {
        var draft = VoiceDictationDraft(original: "已有草稿\n")
        draft.update(" ")
        #expect(draft.text == "已有草稿\n")
        draft.update("保留这句")
        let atStop = draft.text
        draft.update(" \n ")
        #expect(draft.text == atStop)
        #expect(draft.text == "已有草稿\n保留这句")
    }

    @Test func anEmptyDraftDoesNotGainALeadingNewline() {
        var draft = VoiceDictationDraft(original: "")
        draft.update("第一句")
        #expect(draft.text == "第一句")
    }
}
