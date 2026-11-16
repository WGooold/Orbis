import Foundation
import Testing
@testable import OrbisCore

// SC92/SC93: competing conditions, dismissal, repeated arrivals and stale timers must not revive feedback.
struct FeedbackTests {
    @Test func bannersRespectPriorityAndDismissalUntilConditionClears() {
        var state = FeedbackState()
        state.present(.banner, text: "other", condition: .other, action: .reconnect)
        state.present(.banner, text: "update", condition: .version, action: .settings)
        state.present(.banner, text: "pair", condition: .pairing, action: .pair)
        #expect(state.banner?.text == "pair")
        let id = state.banner?.id
        state.present(.banner, text: "pair", condition: .pairing, action: .pair)
        #expect(state.banner?.id == id)
        state.dismissBanner()
        #expect(state.banner?.text == "update")
        state.present(.banner, text: "pair", condition: .pairing, action: .pair)
        #expect(state.banner?.text == "update")
        state.resolve(.pairing)
        state.present(.banner, text: "pair", condition: .pairing, action: .pair)
        #expect(state.banner?.text == "pair")
    }
    @Test func toastsDeduplicateReplaceAndDoNotAccumulateInBackground() {
        var state = FeedbackState()
        state.present(.toast, text: "saved")
        let old = state.toast!.id
        state.present(.toast, text: "saved")
        #expect(state.toast?.id == old)
        state.present(.toast, text: "new", action: .restoreDraft)
        state.dismissToast(old)
        #expect(state.toast?.text == "new")
        state.setForeground(false)
        #expect(state.toast == nil)
        state.present(.toast, text: "background")
        state.setForeground(true)
        #expect(state.toast == nil)
        state.present(.banner, text: "pair", condition: .pairing, action: .pair)
        state.clear()
        #expect(state.banner == nil)
    }
    @Test func independentSameCategoryConditionsAndSameTextOperationsKeepTheirIdentity() {
        var state = FeedbackState()
        state.present(.banner, text: "first", condition: .other, key: "a", action: .reconnect)
        state.present(.banner, text: "second", condition: .other, key: "b", action: .reconnect)
        state.dismissBanner()
        #expect(state.banner?.text == "second")
        state.resolve(key: "b")
        #expect(state.banner == nil)
        state.resolve(key: "a")
        state.present(.toast, text: "saved", key: "operation-1")
        let previous = state.toast!.id
        state.present(.toast, text: "saved", key: "operation-2")
        #expect(state.toast?.id != previous)
        state.dismissToast(previous)
        #expect(state.toast?.key == "operation-2")
    }

    // A duplicate completion after expiry/background is consumed, while another operation may reuse its wording.
    @Test func consumedOperationKeysDoNotReplayAfterDismissalOrBackground() {
        var state = FeedbackState()
        state.present(.toast, text: "done", key: "operation-1")
        state.dismissToast()
        state.present(.toast, text: "done", key: "operation-1")
        #expect(state.toast == nil)
        state.setForeground(false)
        state.present(.toast, text: "done", key: "operation-2")
        state.setForeground(true)
        state.present(.toast, text: "done", key: "operation-2")
        #expect(state.toast == nil)
        state.present(.toast, text: "done", key: "operation-3")
        #expect(state.toast?.key == "operation-3")
    }

    // SC94: internal protocol details stay diagnostic-only even when embedded in a human-readable sentence.
    @Test func embeddedProtocolCodesAndInternalConnectionTermsAreNotPresented() {
        for raw in ["Request rejected (invalid_request)", "请求失败（session_sync_backend_failed）", "Host runtime relay failed"] {
            let display = FeedbackText.reason(raw)
            #expect(!display.contains("invalid_request"))
            #expect(!display.contains("session_sync_backend_failed"))
            #expect(!display.contains("Host"))
            #expect(!display.contains("runtime"))
            #expect(!display.contains("relay"))
        }
    }

    // SC98: presentation cleanup must not rewrite filenames and user paths.
    @Test func failureReasonsPreserveUserFilenamesAndPaths() {
        for reason in ["无法打开 my_notes.txt", "无法读取 /home/host/my_notes.txt", "找不到 /runtime/relay/protocol/file.txt"] {
            #expect(FeedbackText.reason(reason) == reason)
        }
    }

}
