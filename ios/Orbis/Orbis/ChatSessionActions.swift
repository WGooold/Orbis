import Foundation

/// IOS-CHAT-08: deferred callbacks retain the original session capability.
struct ChatSessionActions: Equatable {
    let store: OrbisStore
    let target: ChatActionContext
    let canRead: Bool
    private let fallbackRuntime: RuntimeSummary?

    @MainActor init(store: OrbisStore, target: ChatActionContext, canRead: Bool = true, preservingRuntime: RuntimeSummary? = nil) {
        self.store = store; self.target = target; self.canRead = canRead
        // A retained panel can reconstruct its capability after selection changed.
        // Its fallback must still belong to that panel's original session.
        func matches(_ runtime: RuntimeSummary) -> Bool {
            runtime.runtimeId == target.runtimeId && runtime.sessionId == target.sessionId
        }
        if let preservingRuntime, matches(preservingRuntime) { fallbackRuntime = preservingRuntime }
        else if let selected = target.owner.selectedRuntime, matches(selected) { fallbackRuntime = selected }
        else { fallbackRuntime = target.owner.runtimes.first(where: matches) }
    }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.store === rhs.store && lhs.target == rhs.target && lhs.canRead == rhs.canRead
    }
    var connection: HostConnection { target.owner }
    var runtimeId: String { target.runtimeId ?? "" }
    var sessionId: String? { target.sessionId }
    @MainActor var runtime: RuntimeSummary? {
        if let current = connection.selectedRuntime, current.runtimeId == runtimeId, current.sessionId == sessionId { return current }
        return fallbackRuntime
    }
    @MainActor var isCurrent: Bool {
        guard store.activeConnection === connection else { return false }
        return target.identity == (store.selectedRuntime.map { localSessionKey(host: store.selectedHost, runtime: $0) } ?? "")
    }
    /// Cleanup stays with its original owner; a replacement session cannot inherit it.
    @MainActor var ownsRuntime: Bool {
        guard let id = target.runtimeId else { return false }
        if let current = connection.selectedRuntime, current.runtimeId == id { return current.sessionId == sessionId }
        return connection.runtimes.contains { $0.runtimeId == id && $0.sessionId == sessionId }
    }
    @MainActor var admitsRead: Bool { canRead && connection.canSend && isCurrent }
    @MainActor func reading(_ ready: Bool) -> Self { Self(store: store, target: target, canRead: ready, preservingRuntime: fallbackRuntime) }
    @MainActor var pendingSends: PendingSendOutbox { connection.pendingSends }
    @MainActor var draft: String { runtime.map(connection.draft) ?? "" }
    @MainActor func editDraft(_ text: String) { if isCurrent, let runtime { connection.editDraft(text, for: runtime) } }
    @MainActor func saveDraft(_ text: String) { if isCurrent, let runtime { connection.saveDraft(text, for: runtime) } }
    @MainActor func noteComposerFocus(_ focused: Bool) { if isCurrent { connection.noteComposerFocus(focused) } }
    @MainActor func takeComposerFocus() -> Bool { isCurrent && connection.takeComposerFocus(runtimeId) }
    @MainActor func refreshWorkingBranch() { if isCurrent { connection.refreshWorkingBranch() } }
    @MainActor func refresh() { if isCurrent { connection.refresh() } }
    @MainActor func retryLaunch() { if isCurrent { connection.retryLaunch() } }
    @MainActor func activate(_ session: SessionSummary) { if isCurrent { connection.activate(session) } }
    @MainActor func loadOlderHistory() -> Bool { isCurrent && connection.loadOlderHistory() }
    @MainActor func moveHistory(to option: RuntimeOption, fallbackText: String? = nil) -> Bool {
        isCurrent && connection.moveHistory(to: option, fallbackText: fallbackText)
    }
    @MainActor func selectCachedBranch(_ entryId: String) { if isCurrent { connection.selectCachedBranch(entryId) } }
    @MainActor func sendMessage(_ text: String, delivery: String? = nil, attachmentIds: Set<String> = []) -> Bool {
        isCurrent && connection.sendMessage(text, delivery: delivery, attachmentIds: attachmentIds)
    }
    @MainActor func producesMessage(_ command: SlashCommand) -> Bool { runtime.map { connection.producesMessage(command, runtime: $0) } ?? false }
    @MainActor func executeSlash(_ name: String, args: String = "", composerDraft: String? = nil) -> Bool {
        isCurrent && connection.executeSlash(name, args: args, composerDraft: composerDraft)
    }
    @MainActor func stopRuntime() -> Bool { isCurrent && connection.stopRuntime() }
    @MainActor func resendPendingSend(_ id: String) -> Bool { isCurrent && connection.resendPendingSend(id) }
    @MainActor func restorePendingSend(_ id: String) -> String? { isCurrent ? connection.restorePendingSend(id) : nil }
    @MainActor func discardPendingSend(_ id: String) { if isCurrent { connection.discardPendingSend(id) } }
    @MainActor func cancelQueuedMessage(_ id: String) -> Bool { isCurrent && connection.cancelQueuedMessage(id) }
    @MainActor func updatePermission(settingId: String, value: String) -> Bool {
        isCurrent && connection.updatePermission(settingId: settingId, value: value)
    }
    @MainActor func respond(_ request: InteractionRequest, response: [String: Any]) -> Bool {
        isCurrent && connection.respond(request, response: response)
    }
    @MainActor func loadMenuOptions(_ name: String) { if isCurrent { connection.loadMenuOptions(runtimeId: runtimeId, name: name) } }
    @MainActor func cancelMenuOptions(_ name: String) { if ownsRuntime { connection.cancelMenuOptions(runtimeId: runtimeId, name: name) } }
    @MainActor func refreshAgent() { if isCurrent, let runtime { connection.agentState.subscribe(runtime: runtime, force: true) } }
    @MainActor func dismissNotification(_ id: String) { if isCurrent { connection.dismissNotification(runtimeId: runtimeId, notificationId: id) } }
    @MainActor func syncNotifications() { if isCurrent { connection.notifications.sync(runtimeId: runtimeId) } }
    @MainActor func acquireInterest() -> AgentInterestLease? {
        isCurrent ? connection.acquireChatInterest(runtimeId: runtimeId, sessionId: sessionId) : nil
    }
    @MainActor func releaseInterest(_ lease: AgentInterestLease) { connection.releaseChatInterest(lease) }
    @MainActor func upload(_ urls: [URL], capacity: Int) {
        if isCurrent, let runtime { connection.transfers.upload(urls: Array(urls.prefix(capacity)), runtime: runtime) }
    }
    @MainActor func uploadFailed(_ message: String) { if isCurrent { connection.transfers.error = message } }
    @MainActor func restartUpload(_ id: String) { if isCurrent { connection.transfers.restart(id) } }
    @MainActor func detachUploads(_ ids: Set<String>) { if isCurrent { connection.transfers.detach(ids) } }
    @MainActor func releaseUploads(_ ids: Set<String>) { if isCurrent { connection.transfers.release(ids) } }
    @MainActor func openTool(_ locator: ToolLocator) -> ToolContentReader.PresentationToken? {
        guard admitsRead else { return nil }; return connection.toolContent.open(runtimeId: runtimeId, locator: locator)
    }
    @MainActor func previewHistoryEntry(_ entryId: String) -> EntryPreviewHandle? {
        guard isCurrent else { return nil }; return connection.previewEntry(entryId)
    }
    @MainActor func retryHistoryEntry(_ expected: EntryPreviewHandle) -> EntryPreviewHandle? {
        guard isCurrent else { return nil }; return connection.retryPreview(expected: expected)
    }
    @MainActor func openEntry(_ entryId: String) -> EntryPreviewHandle? {
        guard admitsRead else { return nil }; return connection.previewEntry(entryId)
    }
    @MainActor func retryEntry(_ expected: EntryPreviewHandle) -> EntryPreviewHandle? {
        guard admitsRead else { return nil }; return connection.retryPreview(expected: expected)
    }
}

// Existing detail presenters use the read portion of the same capability.
typealias ChatReadContext = ChatSessionActions
