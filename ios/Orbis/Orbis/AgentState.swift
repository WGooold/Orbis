import Foundation
import Combine
import CoreFoundation

/// FT-G07: keep only bounded, applied live bodies; missing caches recover a full checkpoint.
final class SharedSessionContent {
    private struct Live { let session: String; let epoch: String; let seq: Int64; let value: HostJSON; let bytes: Int }
    private var live: [String: Live] = [:]
    private var order: [String] = []
    func clear() { live = [:]; order = [] }
    private func json(_ value: Any) throws -> HostJSON {
        try JSONDecoder().decode(HostJSON.self, from: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
    }
    private func object(_ value: HostJSON) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: [.fragmentsAllowed])
    }
    func expand(_ envelope: [String: Any], epoch: String?, seq: Int64?) throws -> [String: Any] {
        guard let shared = envelope["sharedContent"] as? [String: Any] else { return envelope }
        guard shared["format"] as? String == "shared-v1", let runtime = envelope["runtimeId"] as? String,
              let raw = envelope["event"] as? [String: Any], let type = raw["type"] as? String,
              ["session.snapshot", "session.patch"].contains(type), let refs = shared["references"] as? [[String: Any]], refs.count <= 512 else { throw StateDeltas.Failure.invalid }
        var event = try json(raw)
        if let delta = shared["liveDelta"] as? [String: Any] {
            guard type == "session.patch", let cached = live[runtime], cached.epoch == epoch, cached.seq == seq,
                  event["sessionId"].string == cached.session, event["source"]["epoch"].string == epoch,
                  event["source"]["ready"].bool == true, event["baseSeq"].integer == seq,
                  try json(delta["baseRevision"] ?? NSNull()).integer == seq,
                  let edits = delta["operations"] as? [[String: Any]] else { throw StateDeltas.Failure.invalid }
            let value = try StateDeltas.apply(cached.value, edits: edits)
            event = try StateDeltas.apply(event, edits: [["op": "set", "path": ["live"], "value": object(value)]])
        }
        func at(_ path: [String]) throws -> HostJSON {
            guard path.count <= 32 else { throw StateDeltas.Failure.invalid }
            var value = event
            for key in path {
                if let object = value.object, let child = object[key] { value = child }
                else if value.isArray, let index = Int(key), String(index) == key, value.array.indices.contains(index) { value = value.array[index] }
                else { throw StateDeltas.Failure.invalid }
            }
            return value
        }
        for ref in refs {
            guard let path = ref["path"] as? [String], let target = ref["target"] as? [String],
                  let text = try at(target).string, !text.isEmpty, try at(path) == .string("") else { throw StateDeltas.Failure.invalid }
            event = try StateDeltas.apply(event, edits: [["op": "set", "path": path, "value": text]])
        }
        guard try JSONEncoder().encode(event).count <= 4 * 1024 * 1024 else { throw StateDeltas.Failure.invalid }
        var result = envelope; result["event"] = try object(event); result["sharedContent"] = nil; return result
    }
    /// Called only after history commit and projection validation succeed.
    func remember(_ event: [String: Any], runtime: String) {
        guard let parsed = try? json(event), let session = parsed["sessionId"].string, let epoch = parsed["source"]["epoch"].string,
              let seq = parsed["source"]["seq"].integer, parsed["source"]["ready"].bool == true,
              parsed["live"]["complete"].bool == true, let data = try? JSONEncoder().encode(parsed["live"]), data.count <= 4 * 1024 * 1024 else { return }
        if let old = live[runtime], old.epoch == epoch, old.seq > seq { return }
        live[runtime] = Live(session: session, epoch: epoch, seq: seq, value: parsed["live"], bytes: data.count)
        order.removeAll { $0 == runtime }; order.append(runtime)
        while order.count > 64 || live.values.reduce(0, { $0 + $1.bytes }) > 16 * 1024 * 1024 {
            live[order.removeFirst()] = nil
        }
    }
}

/// FT-G03: independent view owners retain and release their own domain interest.
struct ModelInterests: Equatable {
    private var values: [String: Set<String>] = [:]
    mutating func set(_ owner: String, domains: Set<String>) { values[owner] = domains.isEmpty ? nil : domains }
    var domains: Set<String> { values.values.reduce(into: []) { $0.formUnion($1) } }
}

/// FT-G05: fixed-catalog paging with a single active selector and atomic completion.
struct MenuOptionsLoader {
    private struct Read {
        let runtimeId: String
        let name: String
        let catalog: MenuOptionCatalog
        var requestId = UUID().uuidString
        var items: [RuntimeOption] = []
        var cursors: Set<String> = []
        var bytes = 0
    }
    struct Result {
        let runtimeId: String
        let name: String
        let catalogId: String
        var options: [RuntimeOption]?
        var next: [String: Any]?
        var error: String?
    }
    private var read: Read?
    mutating func expire(_ requestId: String) -> Bool {
        guard read?.requestId == requestId else { return false }; read = nil; return true
    }
    mutating func cancel(runtimeId: String? = nil, name: String? = nil) {
        if runtimeId == nil || read?.runtimeId == runtimeId && (name == nil || read?.name == name) { read = nil }
    }
    mutating func start(runtimeId: String, command: SlashCommand) -> [String: Any]? {
        guard let catalog = command.argument?.optionCatalog, catalog.count != (command.argument?.options?.count ?? 0),
              (0...100_000).contains(catalog.count), !catalog.id.isEmpty else { return nil }
        if let read, read.runtimeId == runtimeId, read.name == command.name, read.catalog == catalog { return nil }
        let next = Read(runtimeId: runtimeId, name: command.name, catalog: catalog)
        read = next; return request(next, cursor: nil)
    }
    private func request(_ read: Read, cursor: String?) -> [String: Any] {
        ["type": "agent.menu.options.read", "protocolVersion": orbisProtocolVersion, "requestId": read.requestId,
         "runtimeId": read.runtimeId, "commandName": read.name, "catalogId": read.catalog.id, "cursor": cursor as Any? ?? NSNull()]
    }
    mutating func consume(_ message: [String: Any]) -> Result? {
        guard var current = read, message["requestId"] as? String == current.requestId,
              message["runtimeId"] as? String == current.runtimeId, message["commandName"] as? String == current.name,
              message["catalogId"] as? String == current.catalog.id else { return nil }
        var result = Result(runtimeId: current.runtimeId, name: current.name, catalogId: current.catalog.id)
        let data = try? JSONSerialization.data(withJSONObject: message["options"] ?? NSNull())
        guard message["error"] == nil, message["totalCount"] as? Int == current.catalog.count,
              let data, let items = try? JSONDecoder().decode([RuntimeOption].self, from: data), items.count <= 200,
              current.bytes + data.count <= 16 * 1024 * 1024, current.items.count + items.count <= current.catalog.count else {
            read = nil; result.error = message["error"] as? String ?? "invalid_options"; return result
        }
        current.items += items; current.bytes += data.count
        if let cursor = message["nextCursor"] as? String {
            guard !items.isEmpty, !current.cursors.contains(cursor), current.items.count < current.catalog.count else {
                read = nil; result.error = "invalid_cursor"; return result
            }
            current.cursors.insert(cursor); current.requestId = UUID().uuidString
            read = current; result.next = request(current, cursor: cursor)
        } else {
            read = nil
            if current.items.count == current.catalog.count { result.options = current.items }
            else { result.error = "incomplete_options" }
        }
        return result
    }
}

struct AgentSnapshot {
    let runtimeId: String
    let sessionId: String
    var modelEpoch: String?
    var domains: [String: HostDomain] = [:]
    var missing: [String: String] = [:]
    var pending: Set<String> = []
    var truncated = false
    var error: String?
    var stateFormat: String?
}

/// Mirrors the same committed per-domain model as Android. Chat ranges remain owned by session.sync.
@MainActor
final class AgentState: ObservableObject {
    nonisolated static let domainNames = ["identity", "availability", "execution", "delivery", "interactions", "permissions",
        "model", "context", "capabilities", "resources", "providerBinding", "workspaceRef", "artifacts", "records"]
    // The home Close action still needs the exact quit target from the catalog.
    nonisolated static let homeDomains: Set<String> = ["identity", "execution", "interactions", "capabilities"]
    nonisolated static let chatDomains: Set<String> = ["delivery", "model", "context", "permissions"]
    @Published private(set) var snapshots: [String: AgentSnapshot] = [:]
    var send: (([String: Any]) -> Bool)?
    var didProject: ((String, String, [String: HostDomain]) -> Bool)?
    private var hostKey: String?
    private var connected = false
    private var epoch: String?
    private var retiredEpochs: Set<String> = []
    private var reads: [String: Read] = [:]
    private var interests: [String: ModelInterests] = [:]
    private var preferredFormat: String? = "compact-v2"
    private var timeouts: [String: Task<Void, Never>] = [:]
    private struct Read {
        let id: String
        let runtimeId: String
        let sessionId: String
        let agentKind: String?
        let domains: Set<String>
        let stateFormat: String?
        let runtime: RuntimeSummary
    }

    func setConnection(_ pairing: HostPairing?, connected: Bool) {
        let key = pairing.map(FileTransfers.pairingKey)
        guard hostKey != key || self.connected != connected else { return }
        timeouts.values.forEach { $0.cancel() }; timeouts = [:]; reads = [:]
        if key != hostKey { snapshots = [:]; retiredEpochs = []; interests = [:] }
        for id in snapshots.keys { snapshots[id]?.pending = [] }
        hostKey = key; self.connected = connected; epoch = nil
        preferredFormat = "compact-v2"
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

    func setInterest(runtime: RuntimeSummary, owner: String, domains: Set<String>) {
        var next = interests[runtime.runtimeId] ?? ModelInterests()
        next.set(owner, domains: domains.intersection(Self.domainNames))
        guard next != (interests[runtime.runtimeId] ?? ModelInterests()) else { return }
        interests[runtime.runtimeId] = next
        subscribe(runtime: runtime)
    }

    func subscribe(runtime: RuntimeSummary, force: Bool = false) {
        guard connected, let session = runtime.sessionId, !session.isEmpty else { return }
        let wanted = Self.homeDomains.union(interests[runtime.runtimeId]?.domains ?? [])
        // A request without agentKind is already bound by runtime/session. Learning the kind
        // from identity must not replace that live subscription and restart its pending reads.
        if !force, reads.values.contains(where: { $0.runtimeId == runtime.runtimeId && $0.sessionId == session &&
            ($0.agentKind == nil || $0.agentKind == runtime.agentKind) && $0.domains == wanted }) { return }
        removeRead(runtime.runtimeId)
        var snapshot = snapshots[runtime.runtimeId].flatMap { $0.sessionId == session ? $0 : nil }
            ?? AgentSnapshot(runtimeId: runtime.runtimeId, sessionId: session)
        snapshot.pending = wanted; snapshot.error = nil
        snapshots[runtime.runtimeId] = snapshot
        let id = UUID().uuidString
        let format = preferredFormat
        let read = Read(id: id, runtimeId: runtime.runtimeId, sessionId: session, agentKind: runtime.agentKind, domains: wanted, stateFormat: format, runtime: runtime)
        reads[id] = read
        let known: [[String: Any]] = force || snapshot.stateFormat != format ? [] : snapshot.domains.values.filter { wanted.contains($0.domain) }.map {
            ["domain": $0.domain, "modelEpoch": $0.modelEpoch, "revision": $0.revision]
        }
        var payload: [String: Any] = ["type": "agent.state.request", "protocolVersion": orbisProtocolVersion,
            "requestId": id, "scope": "agent", "runtimeId": runtime.runtimeId, "sessionId": session,
            "subscribe": true, "domains": Self.domainNames.filter(wanted.contains), "known": known]
        if let kind = runtime.agentKind { payload["agentKind"] = kind }
        if let format { payload["stateFormat"] = format }
        guard send?(payload) == true else { reject(read, L10n.tr("状态读取未发送，请重新连接")); reads[id] = nil; return }
        timeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.reads[id] != nil, self.snapshots[runtime.runtimeId]?.pending.isEmpty == false else { return }
            self.reject(read, L10n.tr("状态读取超时，请重新读取"))
            self.reads[id] = nil
        }
    }

    func remove(runtimeId: String) { removeRead(runtimeId); snapshots[runtimeId] = nil; interests[runtimeId] = nil }
    func owns(_ domain: String, runtimeId: String) -> Bool {
        snapshots[runtimeId]?.domains[domain] != nil && reads.values.contains { $0.runtimeId == runtimeId && $0.domains.contains(domain) }
    }

    @discardableResult
    func consume(_ message: [String: Any]) -> Bool {
        guard connected, let type = message["type"] as? String else { return false }
        if let id = message["requestId"] as? String, let read = reads[id], read.stateFormat != nil,
           type == "protocol.error" && ["invalid_request", "unsupported_request"].contains(message["code"] as? String ?? "") ||
           type == "agent.state.snapshot" && message["stateFormat"] == nil {
            preferredFormat = read.stateFormat == "compact-v2" ? "compact-v1" : nil
            subscribe(runtime: read.runtime, force: true)
            return true
        }
        if type == "protocol.error", let id = message["requestId"] as? String, let read = reads[id] {
            reject(read, message["message"] as? String ?? L10n.tr("电脑端无法完成读取")); reads[id] = nil; return true
        }
        guard type == "agent.state.snapshot", message["scope"] as? String == "agent" else { return false }
        guard let id = message["requestId"] as? String, let read = reads[id],
              message["runtimeId"] as? String == read.runtimeId, message["sessionId"] as? String == read.sessionId,
              read.agentKind == nil || message["agentKind"] as? String == read.agentKind else { return true }
        guard message["stateFormat"] as? String == read.stateFormat else { reject(read); return true }
        if let error = message["error"] as? String { reject(read, error); return true }
        guard let newEpoch = message["modelEpoch"] as? String, !newEpoch.isEmpty else { reject(read); return true }
        if retiredEpochs.contains(newEpoch) || epoch.map({ $0 != newEpoch }) == true { return true }
        guard let rawDomains = message["domains"] as? [[String: Any]], rawDomains.count <= 64,
              let rawMissing = message["missing"] as? [[String: Any]], rawMissing.count <= 64,
              let truncated = message["truncated"] as? Bool,
              message["unchanged"] == nil || message["unchanged"] is [String] else { reject(read); return true }
        var snapshot = snapshots[read.runtimeId] ?? AgentSnapshot(runtimeId: read.runtimeId, sessionId: read.sessionId)
        if snapshot.modelEpoch != newEpoch || snapshot.stateFormat != read.stateFormat { snapshot.domains = [:]; snapshot.missing = [:] }
        var incoming: [String: HostDomain] = [:]
        for source in rawDomains {
            let raw: [String: Any]
            do {
                if source["delta"] != nil && read.stateFormat != "compact-v2" { throw StateDeltas.Failure.invalid }
                guard let expanded = try StateDeltas.expand(source, old: snapshot.domains[source["domain"] as? String ?? ""], epoch: newEpoch) else { continue }
                raw = expanded
            } catch { subscribe(runtime: read.runtime, force: true); return true }
            guard let data = try? JSONSerialization.data(withJSONObject: raw),
                  let domain = try? JSONDecoder().decode(HostDomain.self, from: data), domain.valid,
                  domain.modelEpoch == newEpoch, read.domains.contains(domain.domain), incoming[domain.domain] == nil else { reject(read); return true }
            incoming[domain.domain] = domain
        }
        var missing: [String: String] = [:]
        for raw in rawMissing {
            guard let name = raw["domain"] as? String, read.domains.contains(name), incoming[name] == nil, missing[name] == nil,
                  let reason = raw["reason"] as? String, ["unknown_domain", "no_state"].contains(reason) else { reject(read); return true }
            missing[name] = reason
        }
        let unchanged = message["unchanged"] as? [String] ?? []
        guard Set(unchanged).count == unchanged.count, unchanged.allSatisfy({ read.domains.contains($0) && incoming[$0] == nil && missing[$0] == nil && snapshot.domains[$0] != nil }) else { reject(read); return true }
        var accepted: [String: HostDomain] = [:]
        for (name, domain) in incoming {
            if let old = snapshot.domains[name], domain.revision < old.revision || domain.revision == old.revision &&
                (!domain.sameFacts(as: old) || domain.checkedAt < old.checkedAt) { continue }
            accepted[name] = domain; snapshot.domains[name] = domain; snapshot.missing[name] = nil
        }
        for name in unchanged { accepted[name] = snapshot.domains[name] }
        guard didProject?(read.runtimeId, read.sessionId, accepted) != false else { reject(read); return true }
        snapshot.modelEpoch = newEpoch; snapshot.error = nil; snapshot.truncated = truncated
        snapshot.stateFormat = read.stateFormat
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
    private func reject(_ read: Read, _ reason: String = L10n.tr("电脑端状态格式无法识别，请重新读取")) {
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
                if name == "execution" {
                    result.runtime.status = "unknown"; result.runtime.compactionPhase = nil
                    result.runtime.executionTurnId = nil
                    result.runtime.backgroundTasks?.availability = "unknown"
                    result.runtime.backgroundTasks?.truncated = false
                }
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
                result.runtime.executionTurnId = value["turn"]["turnId"].string
                result.runtime.compactionPhase = value["compaction"]["phase"].string
                if value["tasks"] != .null {
                    guard let tasks: BackgroundTaskInventory = value["tasks"].decoded(), tasks.valid else { return nil }
                    result.runtime.backgroundTasks = tasks.reconciled(previous: result.runtime.backgroundTasks)
                } else if complete, result.runtime.backgroundTasks != nil {
                    result.runtime.backgroundTasks = BackgroundTaskInventory(availability: "unknown",
                        items: result.runtime.backgroundTasks?.items ?? [], truncated: false)
                }
            case "model":
                if value["currentTurn"] != .null {
                    guard let current: RuntimeTurnConfiguration = value["currentTurn"].decoded(), !current.turnId.isEmpty else { return nil }
                    result.runtime.currentTurnConfiguration = current
                } else { result.runtime.currentTurnConfiguration = nil }
                result.runtime.currentTurnConfigurationSupported = value["currentTurnSupported"].bool
                result.runtime.modelSelection = value["selection"].decoded()
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
                        guard var command: SlashCommand = row.decoded(), command.name == key, !key.isEmpty else { return nil }
                        if let catalog = command.argument?.optionCatalog,
                           let cached = commands.first(where: { $0.name == key && $0.argument?.optionCatalog == catalog }) {
                            command.argument?.options = cached.argument?.options
                        }
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
