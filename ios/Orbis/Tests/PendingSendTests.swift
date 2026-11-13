import Foundation
import Testing
@testable import OrbisCore

@Suite("Optimistic send reconciliation (ADR-0049)")
struct PendingSendTests {
    private let start = Date(timeIntervalSince1970: 1_000)

    private func send(_ id: String, session: String = "s1", delivery: String? = nil, anchor: String? = nil, at offset: TimeInterval = 0) -> PendingSend {
        PendingSend(messageId: id, commandId: "c-" + id, sessionId: session, text: "text " + id, attachments: [],
                    delivery: delivery, createdAt: start.addingTimeInterval(offset), anchorMessageId: anchor)
    }
    private func message(_ id: String, role: String = "assistant", client: String? = nil) -> ChatMessage {
        var value = ChatMessage(messageId: id, role: role, content: [ChatContent(type: "text", text: id, toolName: nil, artifact: nil)], timestamp: 1, isError: nil)
        value.clientMessageId = client
        return value
    }
    private func queued(_ id: String, state: String = "accepted", delivery: String = "followUp") -> QueuedMessage {
        QueuedMessage(queueId: id, text: "text", delivery: delivery, state: state, error: nil)
    }
    @discardableResult
    private func reconcile(_ outbox: inout PendingSendOutbox, status: String? = "idle", queue: [QueuedMessage] = [], revision: Int = 0,
                           connected: Bool = true, at offset: TimeInterval = 1, present: Set<String> = []) -> Bool {
        outbox.reconcile(sessionId: "s1", status: status, queue: queue, revision: revision, connected: connected,
                         now: start.addingTimeInterval(offset)) { present.contains($0) }
    }

    @Test func materializesByEitherBackendIdentityWithoutReturning() {
        var outbox = PendingSendOutbox()
        outbox.add(send("pi")); outbox.add(send("codex")); outbox.add(send("dsh"))
        // Pi: live id differs, clientMessageId declares it. Codex: live id is the App id. DSH ACP: Host alias.
        reconcile(&outbox, present: ["pi"])
        #expect(outbox.item("pi") == nil)
        reconcile(&outbox, present: ["codex", "dsh"])
        #expect(outbox.isEmpty)
        // A later replace snapshot without the live row does not bring the local row back.
        reconcile(&outbox, present: [])
        #expect(outbox.isEmpty)
    }

    @Test func anchoredRowsStayBeforeAReplyThatArrivedFirst() {
        let merged = PendingSendOutbox.merge([message("a0"), message("reply")],
                                             pending: [send("u1", anchor: "a0"), send("u2", anchor: "a0", at: 1), send("u3", anchor: "gone", at: 2)])
        #expect(merged.map(\.messageId) == ["a0", "u1", "u2", "reply", "u3"])
        #expect(merged[1].role == "user")
    }

    @Test func identicalTextIsNeverMatchedByContent() {
        var outbox = PendingSendOutbox()
        outbox.add(send("first")); outbox.add(send("second"))
        reconcile(&outbox, present: ["first"])
        #expect(outbox.items.map(\.messageId) == ["second"])
    }

    @Test func queueSendsHandOverToHostQueueAndChatSendsHideIt() {
        var outbox = PendingSendOutbox()
        outbox.add(send("busy", delivery: "followUp")); outbox.add(send("idle"))
        #expect(outbox.queueRows(sessionId: "s1").map(\.messageId) == ["busy"])
        #expect(outbox.chatRows(sessionId: "s1").map(\.messageId) == ["idle"])
        // DSH Web queues even idle sends: the chat row stays and hides the duplicate queue row.
        reconcile(&outbox, status: "running", queue: [queued("busy"), queued("idle")])
        #expect(outbox.item("busy")?.queueOwned == true)
        #expect(outbox.chatRows(sessionId: "s1").map(\.messageId) == ["idle"])
        #expect(outbox.item("idle")?.state == .queued)
        #expect(outbox.hidesQueueItem("idle"))
        reconcile(&outbox, status: "running", queue: [queued("idle", state: "rejected")])
        #expect(outbox.item("idle")?.state == .failed("电脑端拒绝了这条消息"))
    }

    // SC85: a permission-confirmation failure preserves retryable input and its real
    // reason, including follow-up and steer messages on an otherwise idle runtime.
    @Test func permissionFailuresKeepDraftsWithoutClaimingTheSessionIsRunning() {
        for reason in ["权限设置尚未确认，请稍后重试", "权限设置正在保存，请稍后重试"] {
            for delivery in [nil, "followUp", "steer"] as [String?] {
                var outbox = PendingSendOutbox(); outbox.add(send("permission", delivery: delivery))
                outbox.commandResult("c-permission", ok: false, status: "failure", error: reason, now: start)
                reconcile(&outbox, revision: 1)
                #expect(outbox.item("permission")?.state == .failed(L10n.tr(reason)))
                #expect(outbox.item("permission")?.text == "text permission")
                #expect(outbox.item("permission")?.delivery == delivery)
            }
        }
    }

    @Test func commandResultsDistinguishRejectionFromUnknownDelivery() {
        var outbox = PendingSendOutbox()
        outbox.add(send("ok")); outbox.add(send("busy")); outbox.add(send("lost")); outbox.add(send("sending"))
        let owned = outbox.commandResult("c-ok", ok: true, status: "pending", error: nil, now: start)
        #expect(owned)
        outbox.commandResult("c-busy", ok: false, status: "failure", error: "runtime_busy")
        outbox.commandResult("c-lost", ok: false, status: "cancelled", error: nil)
        let foreign = outbox.commandResult("other", ok: true, status: nil, error: nil)
        #expect(!foreign)
        #expect(outbox.item("ok")?.state == .accepted)
        #expect(outbox.item("busy")?.state == .failed("会话正在运行，请选择插入或完成后发送"))
        #expect(outbox.item("lost")?.state == .unconfirmed)
        outbox.connectionLost()
        #expect(outbox.item("sending")?.state == .unconfirmed)
        #expect(outbox.item("ok")?.state == .accepted)
        outbox.runtimeLost(sessionId: "s1")
        #expect(outbox.item("ok")?.state == .unconfirmed)
        #expect(outbox.item("busy")?.state == .failed("会话正在运行，请选择插入或完成后发送"))
    }

    @Test func acceptedRowWithoutIdentityLeavesAfterTheTurnAndOneNewAuthoritativeState() {
        var outbox = PendingSendOutbox()
        outbox.add(send("claude"))
        outbox.commandResult("c-claude", ok: true, status: "success", error: nil, now: start)
        // Still idle before the turn starts: no settlement inside the grace period.
        #expect(!reconcile(&outbox, status: "idle", revision: 1, at: 2))
        reconcile(&outbox, status: "running", revision: 1, at: 3)
        #expect(outbox.item("claude")?.sawBusy == true)
        // Back to idle: ask for one fresh authoritative state, then let the source decide.
        #expect(reconcile(&outbox, status: "idle", revision: 2, at: 4))
        #expect(!reconcile(&outbox, status: "idle", revision: 2, at: 5))
        #expect(outbox.item("claude") != nil)
        reconcile(&outbox, status: "idle", revision: 3, at: 6)
        #expect(outbox.isEmpty)
    }

    @Test func acceptedRowOnAnIdleRuntimeIsCheckedAfterTheGracePeriod() {
        var outbox = PendingSendOutbox()
        outbox.add(send("quiet"))
        outbox.commandResult("c-quiet", ok: true, status: "success", error: nil, now: start)
        #expect(!reconcile(&outbox, revision: 1, at: PendingSendOutbox.acceptedIdleGrace - 1))
        #expect(reconcile(&outbox, revision: 1, at: PendingSendOutbox.acceptedIdleGrace + 1))
        reconcile(&outbox, revision: 2, at: PendingSendOutbox.acceptedIdleGrace + 2)
        #expect(outbox.isEmpty)
    }

    @Test func disconnectedRowNeedsPositiveDeliveryEvidenceAfterAnIdleSourceRead() {
        var outbox = PendingSendOutbox()
        outbox.add(send("lost"))
        outbox.connectionLost()
        #expect(!reconcile(&outbox, status: "idle", connected: false))
        #expect(!reconcile(&outbox, status: "running", revision: 1))
        #expect(reconcile(&outbox, status: "idle", revision: 1))
        // The fresh state shows it was delivered after all.
        var delivered = outbox
        reconcile(&delivered, status: "idle", revision: 2, present: ["lost"])
        #expect(delivered.isEmpty)
        reconcile(&outbox, status: "idle", revision: 2)
        #expect(outbox.item("lost")?.state == .unconfirmed)
        outbox.commandResult("c-lost", ok: false, status: "failure", error: "not submitted")
        #expect(outbox.item("lost")?.state == .failed("not submitted"))
    }

    @Test func aConfirmedWithdrawalRemovesTheHiddenRecoveryCopy() {
        var outbox = PendingSendOutbox(); outbox.add(send("queued", delivery: "followUp"))
        reconcile(&outbox, status: "running", queue: [queued("queued")])
        #expect(outbox.item("queued")?.queueOwned == true)
        reconcile(&outbox, queue: [queued("queued", state: "cancelled")])
        #expect(outbox.isEmpty)
    }

    @Test func aMissingQueueRecordDoesNotProveNonDelivery() {
        var outbox = PendingSendOutbox(); outbox.add(send("queued", delivery: "followUp"))
        reconcile(&outbox, status: "running", queue: [queued("queued")])
        #expect(reconcile(&outbox, revision: 1))
        reconcile(&outbox, revision: 2)
        #expect(outbox.item("queued")?.state == .unconfirmed)
        #expect(outbox.chatRows(sessionId: "s1").map(\.messageId) == ["queued"])
    }

    @Test func nativeUnknownCannotBecomeRetryableFromAnUnrelatedIdleSnapshot() {
        var outbox = PendingSendOutbox(); outbox.add(send("lost"))
        outbox.commandResult("c-lost", ok: false, status: "unconfirmed", error: "lost native reply", now: start)
        #expect(reconcile(&outbox, revision: 1))
        #expect(!reconcile(&outbox, revision: 2))
        #expect(outbox.item("lost")?.state == .unconfirmed)
        outbox.commandResult("c-lost", ok: true, status: "pending", error: nil)
        #expect(outbox.item("lost")?.state == .unconfirmed)
        reconcile(&outbox, revision: 3, present: ["lost"])
        #expect(outbox.isEmpty)
    }

    @Test func pendingReceiptDoesNotDiscardInputWhileAnIdleCompactionIsStillRunning() {
        var outbox = PendingSendOutbox(); outbox.add(send("queued"))
        outbox.commandResult("c-queued", ok: true, status: "pending", error: nil, now: start)
        #expect(!reconcile(&outbox, revision: 1, at: 120))
        #expect(outbox.item("queued") != nil)
        outbox.commandResult("c-queued", ok: true, status: "success", error: nil, now: start)
        #expect(reconcile(&outbox, revision: 2, at: 121))
        reconcile(&outbox, revision: 3, at: 122, present: ["queued"])
        #expect(outbox.isEmpty)
    }

    @Test func aDeliveredQueueReceiptDoesNotPinTheOptimisticRowForever() {
        var outbox = PendingSendOutbox(); outbox.add(send("queued"))
        outbox.commandResult("c-queued", ok: true, status: "success", error: nil, now: start)
        #expect(reconcile(&outbox, queue: [queued("queued", state: "delivered")], revision: 1, at: 20))
        reconcile(&outbox, queue: [queued("queued", state: "delivered")], revision: 2, at: 21)
        #expect(outbox.isEmpty)
    }

    @Test func sessionsAreIsolated() {
        var outbox = PendingSendOutbox()
        outbox.add(send("mine")); outbox.add(send("other", session: "s2"))
        reconcile(&outbox, present: ["mine", "other"])
        #expect(outbox.items.map(\.messageId) == ["other"])
        #expect(outbox.chatRows(sessionId: "s1").isEmpty)
        #expect(outbox.chatRows(sessionId: "s2").map(\.messageId) == ["other"])
    }
}
