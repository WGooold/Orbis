import Foundation
import Combine
import CoreFoundation

struct AgentSnapshot {
    let runtimeId: String
    let sessionId: String
    var modelEpoch: String?
    var domains: [String: HostDomain] = [:]
    var missing: [String: String] = [:]
    var pending: Set<String> = []
    var truncated = false
    var error: String?
}

/// Mirrors the same committed per-domain model as Android. Chat ranges remain owned by session.sync.
@MainActor
final class AgentState: ObservableObject {
    nonisolated static let domainNames = ["identity", "availability", "execution", "delivery", "interactions", "permissions",
        "model", "context", "capabilities", "resources", "providerBinding", "workspaceRef", "artifacts", "records"]
    @Published private(set) var snapshots: [String: AgentSnapshot] = [:]
    var send: (([String: Any]) -> Bool)?
    var didProject: ((String, String, [String: HostDomain]) -> Bool)?
    private var hostKey: String?
    private var connected = false
    private var epoch: String?
    private var retiredEpochs: Set<String> = []
    private var reads: [String: Read] = [:]
    private var timeouts: [String: Task<Void, Never>] = [:]
    private struct Read {
        let id: String
        let runtimeId: String
        let sessionId: String
        let agentKind: String?
    }

    func setConnection(_ pairing: HostPairing?, connected: Bool) {
        let key = pairing.map(FileTransfers.pairingKey)
        guard hostKey != key || self.connected != connected else { return }
        timeouts.values.forEach { $0.cancel() }; timeouts = [:]; reads = [:]
        if key != hostKey { snapshots = [:]; retiredEpochs = [] }
        for id in snapshots.keys { snapshots[id]?.pending = [] }
        hostKey = key; self.connected = connected; epoch = nil
    }

    /// Only an authenticated device.ready may establish a replacement Host model generation.
    @discardableResult
    func beginEpoch(_ value: String?) -> Bool {
        guard let value, !value.isEmpty else { return true }
        guard !retiredEpochs.contains(value) else { return false }
        let previous = epoch ?? snapshots.values.compactMap(\.modelEpoch).first
        if let previous, previous != value {
            retiredEpochs.insert(previous)
            timeouts.values.forEach { $0.cancel() }; timeouts = [:]; reads = [:]
            snapshots = [:]
        }
        epoch = value
        return true
    }

    func subscribe(runtime: RuntimeSummary, force: Bool = false) {
        guard connected, let session = runtime.sessionId, !session.isEmpty else { return }
        if !force, reads.values.contains(where: { $0.runtimeId == runtime.runtimeId && $0.sessionId == session && $0.agentKind == runtime.agentKind }) { return }
        removeRead(runtime.runtimeId)
        var snapshot = snapshots[runtime.runtimeId].flatMap { $0.sessionId == session ? $0 : nil }
            ?? AgentSnapshot(runtimeId: runtime.runtimeId, sessionId: session)
        snapshot.pending = Set(Self.domainNames); snapshot.error = nil
        snapshots[runtime.runtimeId] = snapshot
        let id = UUID().uuidString
        let read = Read(id: id, runtimeId: runtime.runtimeId, sessionId: session, agentKind: runtime.agentKind)
        reads[id] = read
        let known: [[String: Any]] = force ? [] : snapshot.domains.values.map {
            ["domain": $0.domain, "modelEpoch": $0.modelEpoch, "revision": $0.revision]
        }
        var payload: [String: Any] = ["type": "agent.state.request", "protocolVersion": orbisProtocolVersion,
            "requestId": id, "scope": "agent", "runtimeId": runtime.runtimeId, "sessionId": session,
            "subscribe": true, "domains": Self.domainNames, "known": known]
        if let kind = runtime.agentKind { payload["agentKind"] = kind }
        guard send?(payload) == true else { reject(read, "状态读取未发送，请重新连接"); reads[id] = nil; return }
        timeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.reads[id] != nil, self.snapshots[runtime.runtimeId]?.pending.isEmpty == false else { return }
            self.reject(read, "状态读取超时，请重新读取")
            self.reads[id] = nil
        }
    }

    func remove(runtimeId: String) { removeRead(runtimeId); snapshots[runtimeId] = nil }
    func owns(_ domain: String, runtimeId: String) -> Bool { snapshots[runtimeId]?.domains[domain] != nil }

    @discardableResult
    func consume(_ message: [String: Any]) -> Bool {
        guard connected, let type = message["type"] as? String else { return false }
        if type == "protocol.error", let id = message["requestId"] as? String, let read = reads[id] {
            reject(read, message["message"] as? String ?? "电脑端无法完成读取"); reads[id] = nil; return true
        }
        guard type == "agent.state.snapshot", message["scope"] as? String == "agent" else { return false }
        guard let id = message["requestId"] as? String, let read = reads[id],
              message["runtimeId"] as? String == read.runtimeId, message["sessionId"] as? String == read.sessionId,
              read.agentKind == nil || message["agentKind"] as? String == read.agentKind else { return true }
        if let error = message["error"] as? String { reject(read, error); return true }
        guard let newEpoch = message["modelEpoch"] as? String, !newEpoch.isEmpty else { reject(read); return true }
        if retiredEpochs.contains(newEpoch) || epoch.map({ $0 != newEpoch }) == true { return true }
        guard let rawDomains = message["domains"] as? [[String: Any]], rawDomains.count <= 64,
              let rawMissing = message["missing"] as? [[String: Any]], rawMissing.count <= 64,
              let truncated = message["truncated"] as? Bool,
              message["unchanged"] == nil || message["unchanged"] is [String] else { reject(read); return true }
        var snapshot = snapshots[read.runtimeId] ?? AgentSnapshot(runtimeId: read.runtimeId, sessionId: read.sessionId)
        if snapshot.modelEpoch != newEpoch { snapshot.domains = [:]; snapshot.missing = [:] }
        var incoming: [String: HostDomain] = [:]
        for raw in rawDomains {
            guard let data = try? JSONSerialization.data(withJSONObject: raw),
                  let domain = try? JSONDecoder().decode(HostDomain.self, from: data), domain.valid,
                  domain.modelEpoch == newEpoch, Self.domainNames.contains(domain.domain), incoming[domain.domain] == nil else { reject(read); return true }
            incoming[domain.domain] = domain
        }
        var missing: [String: String] = [:]
        for raw in rawMissing {
            guard let name = raw["domain"] as? String, Self.domainNames.contains(name), incoming[name] == nil, missing[name] == nil,
                  let reason = raw["reason"] as? String, ["unknown_domain", "no_state"].contains(reason) else { reject(read); return true }
            missing[name] = reason
        }
        let unchanged = message["unchanged"] as? [String] ?? []
        guard Set(unchanged).count == unchanged.count, unchanged.allSatisfy({ Self.domainNames.contains($0) && incoming[$0] == nil && missing[$0] == nil && snapshot.domains[$0] != nil }) else { reject(read); return true }
        var accepted: [String: HostDomain] = [:]
        for (name, domain) in incoming {
            if let old = snapshot.domains[name], domain.revision < old.revision || domain.revision == old.revision &&
                (!domain.sameFacts(as: old) || domain.checkedAt < old.checkedAt) { continue }
            accepted[name] = domain; snapshot.domains[name] = domain; snapshot.missing[name] = nil
        }
        for name in unchanged { accepted[name] = snapshot.domains[name] }
        guard didProject?(read.runtimeId, read.sessionId, accepted) != false else { reject(read); return true }
        snapshot.modelEpoch = newEpoch; snapshot.error = nil; snapshot.truncated = truncated
        snapshot.missing.merge(missing) { _, incoming in incoming }
        snapshot.pending.subtract(incoming.keys); snapshot.pending.subtract(missing.keys); snapshot.pending.subtract(unchanged)
        // Establish the connection epoch only after a complete envelope and atomic projection validate.
        epoch = newEpoch; snapshots[read.runtimeId] = snapshot
        if snapshot.pending.isEmpty { timeouts.removeValue(forKey: id)?.cancel() }
        return true
    }

    private func removeRead(_ runtimeId: String) {
        for id in reads.filter({ $0.value.runtimeId == runtimeId }).map(\.key) {
            reads[id] = nil; timeouts.removeValue(forKey: id)?.cancel()
        }
    }
    private func reject(_ read: Read, _ reason: String = "电脑端状态格式无法识别，请重新读取") {
        snapshots[read.runtimeId]?.error = reason; snapshots[read.runtimeId]?.pending = []
        timeouts.removeValue(forKey: read.id)?.cancel()
    }
}

struct QueuedMessage: Codable, Hashable, Identifiable {
    let queueId: String
    let text: String
    let delivery: String
    let state: String
    let error: String?
    var id: String { queueId }
}

struct AgentProjection {
    var runtime: RuntimeSummary
    var commands: [SlashCommand]
    var interactions: [InteractionRequest]
    var queuedMessages: [QueuedMessage]

    /// Build in temporary values; a malformed domain must not partially change another one.
    static func make(runtime: RuntimeSummary, hostId: String?, domains: [String: HostDomain],
                     commands: [SlashCommand], interactions: [InteractionRequest], queuedMessages: [QueuedMessage]) -> AgentProjection? {
        var result = AgentProjection(runtime: runtime, commands: commands, interactions: interactions, queuedMessages: queuedMessages)
        for (name, domain) in domains {
            guard domain.availability == "ready" else {
                if name == "execution" { result.runtime.status = "unknown"; result.runtime.compactionPhase = nil }
                continue
            }
            let value = domain.value, complete = domain.completeness == "complete" || domain.projectionComplete == true
            switch name {
            case "identity":
                guard var object = value.object else { return nil }
                object["status"] = object["status"] ?? .string(runtime.status)
                guard let identity: RuntimeSummary = HostJSON.object(object).decoded(), identity.runtimeId == runtime.runtimeId,
                      identity.sessionId == runtime.sessionId, value["hostId"] == .null || value["hostId"].string == hostId else { return nil }
                result.runtime.name = identity.name; result.runtime.cwd = identity.cwd; result.runtime.hostname = identity.hostname
                result.runtime.sessionName = identity.sessionName; result.runtime.agentKind = identity.agentKind
            case "execution":
                guard let phase = value["phase"].string, ["idle", "running", "waiting_local_interaction"].contains(phase) else { return nil }
                result.runtime.status = phase
                result.runtime.compactionPhase = value["compaction"]["phase"].string
            case "model":
                if value == .null { if complete { result.runtime.model = nil; result.runtime.thinkingLevel = nil } }
                else {
                    guard let model: RuntimeModelInfo = value.decoded(), !model.provider.isEmpty, !model.id.isEmpty else { return nil }
                    result.runtime.model = model; result.runtime.thinkingLevel = value["thinkingLevel"].string
                }
            case "context":
                if value == .null { if complete { result.runtime.contextUsage = nil } }
                else {
                    guard let context: RuntimeContextUsage = value.decoded(), context.tokens.map({ $0 >= 0 }) != false,
                          context.contextWindow.map({ $0 > 0 }) != false, context.percent.map({ $0.isFinite && (0...100).contains($0) }) != false else { return nil }
                    result.runtime.contextUsage = context
                }
            case "permissions":
                if value == .null { if complete { result.runtime.permissionManagement = nil } }
                else {
                    guard value.object != nil else { return nil }
                    if value["management"] == .null { result.runtime.permissionManagement = nil }
                    else {
                        guard let management: PermissionManagement = value["management"].decoded() else { return nil }
                        result.runtime.permissionManagement = management
                    }
                }
            case "capabilities", "interactions", "delivery":
                guard let rows = value.object ?? (value == .null && complete ? [:] : nil) else {
                    if value == .null { continue }; return nil
                }
                if name == "capabilities" {
                    var parsed: [SlashCommand] = []
                    for (key, row) in rows {
                        guard let command: SlashCommand = row.decoded(), command.name == key, !key.isEmpty else { return nil }
                        parsed.append(command)
                    }
                    result.commands = complete ? parsed : merge(commands, parsed, key: \.name)
                    result.commands.sort { $0.name < $1.name }
                } else if name == "interactions" {
                    var parsed: [InteractionRequest] = []
                    for (key, row) in rows {
                        guard var object = row.object, row["requestId"].string == key, !key.isEmpty,
                              ["confirm", "select", "multi-select", "input", "questionnaire"].contains(row["kind"].string ?? "") else { return nil }
                        object["runtimeId"] = object["runtimeId"] ?? .string(runtime.runtimeId)
                        guard var request: InteractionRequest = HostJSON.object(object).decoded(), request.runtimeId == runtime.runtimeId,
                              request.validForModel else { return nil }
                        if interactions.first(where: { $0.requestId == key })?.submitted == true { request.submitted = true }
                        parsed.append(request)
                    }
                    result.interactions = complete ? parsed : merge(interactions, parsed, key: \.requestId)
                    result.interactions.sort { $0.requestId < $1.requestId }
                } else {
                    var parsed: [QueuedMessage] = []
                    for (key, row) in rows {
                        guard let item: QueuedMessage = row.decoded(), item.queueId == key, !key.isEmpty, !item.text.isEmpty,
                              ["steer", "followUp"].contains(item.delivery),
                              ["accepted", "delivered", "cancelled", "rejected", "not_cancelable"].contains(item.state) else { return nil }
                        parsed.append(item)
                    }
                    result.queuedMessages = (complete ? parsed : merge(queuedMessages, parsed, key: \.queueId)).filter { $0.state != "delivered" }
                    result.queuedMessages.sort { $0.queueId < $1.queueId }
                }
            default: break // Availability/resources/references remain accessible as typed domain envelopes.
            }
        }
        return result
    }

    private static func merge<T>(_ old: [T], _ incoming: [T], key: KeyPath<T, String>) -> [T] {
        var result = Dictionary(old.map { ($0[keyPath: key], $0) }, uniquingKeysWith: { _, last in last })
        for item in incoming { result[item[keyPath: key]] = item }
        return Array(result.values)
    }
}

extension InteractionRequest {
    var validForModel: Bool {
        guard !requestId.isEmpty, !extensionId.isEmpty, !title.isEmpty, expiresAt > 0 else { return false }
        let options = options ?? []
        guard options.count <= 64, Set(options.map(\.value)).count == options.count,
              options.allSatisfy({ !$0.value.isEmpty }),
              minLength.map({ $0 >= 0 }) != false, maxLength.map({ $0 >= 0 }) != false,
              minSelections.map({ $0 >= 0 }) != false, maxSelections.map({ $0 >= 0 }) != false,
              (minLength ?? 0) <= (maxLength ?? Int.max), (minSelections ?? 0) <= (maxSelections ?? Int.max) else { return false }
        switch kind {
        case "confirm", "input": return true
        case "select", "multi-select": return !options.isEmpty
        case "questionnaire":
            guard let questions, (1...16).contains(questions.count), Set(questions.map(\.id)).count == questions.count else { return false }
            return questions.allSatisfy { question in
                !question.id.isEmpty && !question.question.isEmpty && question.options.count <= 64 &&
                (!question.options.isEmpty || question.allowOther == true) &&
                Set(question.options.map(\.value)).count == question.options.count && question.options.allSatisfy { !$0.value.isEmpty }
            }
        default: return false
        }
    }

    /// Validation belongs at the command boundary as well as in any UI using this model.
    func acceptsResponse(_ response: [String: Any]) -> Bool {
        guard validForModel, let responseKind = response["kind"] as? String else { return false }
        if responseKind == "cancel" { return response.count == 1 }
        guard responseKind == kind else { return false }
        switch kind {
        case "confirm":
            guard response.count == 2, let value = response["value"] as? NSNumber else { return false }
            return CFGetTypeID(value) == CFBooleanGetTypeID()
        case "select":
            guard response.count == 2, let value = response["value"] as? String else { return false }
            return options?.contains { $0.value == value } == true
        case "multi-select":
            guard response.count == 2, let values = response["values"] as? [String], Set(values).count == values.count else { return false }
            return values.count >= (minSelections ?? 0) && values.count <= (maxSelections ?? Int.max) &&
                values.allSatisfy { value in options?.contains { $0.value == value } == true }
        case "input":
            guard response.count == 2, let value = response["value"] as? String else { return false }
            return value.utf16.count >= (minLength ?? 0) && value.utf16.count <= (maxLength ?? 100_000)
        case "questionnaire":
            guard response.count == 2, let rows = response["answers"] as? [[String: Any]], let questions,
                  rows.count == questions.count, Set(rows.compactMap { $0["id"] as? String }).count == rows.count else { return false }
            for row in rows {
                guard Set(row.keys).isSubset(of: ["id", "values", "other", "notes"]),
                      let id = row["id"] as? String, let question = questions.first(where: { $0.id == id }),
                      let values = row["values"] as? [String], Set(values).count == values.count,
                      values.allSatisfy({ value in question.options.contains { $0.value == value } }),
                      row["other"] == nil || row["other"] is String, row["notes"] == nil || row["notes"] is String else { return false }
                let other = row["other"] as? String, notes = row["notes"] as? String
                if let other, question.allowOther != true || other.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || other.utf16.count > 4_000 { return false }
                if let notes, question.allowNotes != true || notes.utf16.count > 4_000 { return false }
                let count = values.count + (other == nil ? 0 : 1)
                guard count > 0, question.multiSelect == true || count == 1 else { return false }
            }
            return true
        default: return false
        }
    }
}
