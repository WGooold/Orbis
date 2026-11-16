import SwiftUI
import Observation

/// Native cells borrow these references; the page owns them across cell reuse.
/// Only the presentation host observes the list. Rows observe their own small state.
@MainActor @Observable
final class ChatTranscriptInteractionState {
    struct Source: Hashable {
        let rowID: String
        let contentID: String
    }

    struct Presentation: Identifiable {
        enum Detail {
            case tool(ChatToolPresentation, title: String)
            case entry(ChatEntryPresentation)
            case selection(String)
        }
        let id = UUID()
        let source: Source
        let detail: Detail
    }

    @MainActor @Observable
    final class Disclosure {
        var expanded = false
    }

    @MainActor @Observable
    final class Row {
        let rowID: String
        var visibleTools = chatToolPageSize
        let fileChanges = TurnChangeSummaryState()
        @ObservationIgnored private var disclosures: [String: Disclosure] = [:]

        init(rowID: String) { self.rowID = rowID }

        func disclosure(_ contentID: String) -> Disclosure {
            if let state = disclosures[contentID] { return state }
            let state = Disclosure()
            disclosures[contentID] = state
            return state
        }
    }

    @ObservationIgnored private var rows: [String: Row] = [:]
    private var rowGeneration = 0
    private(set) var presentations: [Presentation] = []

    func row(_ rowID: String) -> Row {
        // A page reset invalidates mounted rows without observing the shared dictionary.
        _ = rowGeneration
        if let state = rows[rowID] { return state }
        let state = Row(rowID: rowID)
        rows[rowID] = state
        return state
    }

    /// Source reconciliation only. Cell visibility/reuse must not call this method.
    /// Removing a host leaves its original token/handle cleanup with that host.
    func reconcile(rowIDs: Set<String>) {
        rows = rows.filter { rowIDs.contains($0.key) }
        presentations.removeAll { !rowIDs.contains($0.source.rowID) }
    }

    /// A new history/target owns fresh row state even when it reuses a visual row ID.
    /// Existing presentation hosts retire with their immutable expected cleanup values.
    func reset() {
        rows.removeAll()
        presentations.removeAll()
        rowGeneration &+= 1
    }

    func presentTool(_ value: ChatToolPresentation, title: String, source: Source) {
        present(Presentation(source: source, detail: .tool(value, title: title)))
    }

    func presentEntry(_ value: ChatEntryPresentation, source: Source) {
        present(Presentation(source: source, detail: .entry(value)))
    }

    func presentSelection(text: String, source: Source) {
        present(Presentation(source: source, detail: .selection(text)))
    }

    func dismiss(_ expected: Presentation) {
        guard presentations.contains(where: { $0.id == expected.id }) else { return }
        presentations.removeAll { $0.id == expected.id }
    }

    func replaceTool(_ expected: Presentation) {
        guard presentations.contains(where: { $0.id == expected.id }),
              case .tool(let value, let title) = expected.detail else { return }
        let reader = value.context.connection.toolContent
        guard reader.isCurrent(value.token), let locator = reader.locator,
              let token = value.context.openTool(locator) else { return }
        presentTool(ChatToolPresentation(context: value.context, token: token),
                    title: title, source: expected.source)
    }

    private func present(_ value: Presentation) {
        presentations.removeAll { $0.source == value.source }
        presentations.append(value)
    }
}

private struct ChatTranscriptInteractionStateKey: EnvironmentKey {
    static let defaultValue: ChatTranscriptInteractionState? = nil
}
private struct ChatTranscriptRowInteractionKey: EnvironmentKey {
    static let defaultValue: ChatTranscriptInteractionState.Row? = nil
}

extension EnvironmentValues {
    var chatTranscriptInteractionState: ChatTranscriptInteractionState? {
        get { self[ChatTranscriptInteractionStateKey.self] }
        set { self[ChatTranscriptInteractionStateKey.self] = newValue }
    }
    var chatTranscriptRowInteraction: ChatTranscriptInteractionState.Row? {
        get { self[ChatTranscriptRowInteractionKey.self] }
        set { self[ChatTranscriptRowInteractionKey.self] = newValue }
    }
}
