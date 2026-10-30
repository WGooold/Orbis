import Foundation
import Combine

// Public, bounded Host facts only. Native configuration and credentials stay on the Host.
indirect enum HostJSON: Codable, Equatable {
    case object([String: HostJSON]), array([HostJSON]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let array = try? value.decode([HostJSON].self) { self = .array(array) }
        else { self = .object(try value.decode([String: HostJSON].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .string(let string): try value.encode(string)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .null: try value.encodeNil()
        }
    }
    subscript(_ key: String) -> HostJSON { if case .object(let object) = self { return object[key] ?? .null }; return .null }
    var array: [HostJSON] { if case .array(let array) = self { return array }; return [] }
    var isArray: Bool { if case .array = self { return true }; return false }
    var string: String? { if case .string(let string) = self { return string }; return nil }
    var bool: Bool? { if case .bool(let bool) = self { return bool }; return nil }
    var number: Double? { if case .number(let number) = self { return number }; return nil }
    var object: [String: HostJSON]? { if case .object(let object) = self { return object }; return nil }
    func decoded<T: Decodable>(_ type: T.Type = T.self) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
    var integer: Int64? {
        guard let number, number.isFinite, number >= 0, number <= 9_007_199_254_740_991, number.rounded() == number else { return nil }
        return Int64(number)
    }
}

struct HostDomain: Decodable, Equatable {
    let domain: String
    let modelEpoch: String
    let revision: Int64
    let availability: String
    let completeness: String
    let source: Source
    let checkedAt: Int64
    let value: HostJSON
    let projectionComplete: Bool?
    struct Source: Decodable, Equatable {
        let producer: String
        let sourceId: String
        let sourceEpoch: String
        let sourceRevision: Int64
    }
    var valid: Bool {
        !modelEpoch.isEmpty && revision >= 0 && checkedAt >= 0 &&
        ["ready", "unknown", "unavailable"].contains(availability) && ["complete", "partial", "unknown"].contains(completeness) &&
        ["native", "adapter", "host"].contains(source.producer) && !source.sourceId.isEmpty && !source.sourceEpoch.isEmpty && source.sourceRevision >= 0
    }
    func sameFacts(as other: HostDomain) -> Bool {
        revision == other.revision && modelEpoch == other.modelEpoch && value == other.value && availability == other.availability &&
        completeness == other.completeness && source == other.source && projectionComplete == other.projectionComplete
    }
}

struct AgentProvider: Identifiable, Hashable {
    let id: String
    let kind: String
    let name: String
    let enabled: Bool
    let additive: Bool
    let globalDefault: Bool
    var subscriptionSupported = false
    var official = false
    var removable: Bool { kind == "pi" && enabled && additive }
    var confirmation: String {
        let explanation = additive ? (enabled ? "从 Pi 配置移除；Host 中的卡片和配置仍保留。" : "添加到 Pi 配置，可与其他供应商同时启用。") :
            "将切换 Host 配置，并重新加载后台 Agent。已有会话需要重新打开。"
        return name + "\n" + explanation + (enabled && globalDefault ? "\n这是 Pi 的全局默认供应商，移除后请在 Pi 中重新选择模型。" : "")
    }
}

struct SubscriptionQuota: Decodable {
    struct Window: Decodable, Identifiable {
        let name: String
        let remainingPercent: Double?
        let resetsAt: Int64?
        var id: String { name }
        var title: String { name == "five_hour" ? "5 小时配额" : "周配额" }
    }
    let checkedAt: Int64
    let windows: [Window]
    var valid: Bool {
        checkedAt >= 0 && windows.count == 2 && Set(windows.map(\.name)) == ["five_hour", "seven_day"] &&
        windows.allSatisfy { ($0.remainingPercent.map { $0.isFinite && (0...100).contains($0) } ?? true) && ($0.resetsAt.map { $0 >= 0 } ?? true) }
    }
}

struct ProviderQuotaSnapshot {
    let providerId: String
    let quota: SubscriptionQuota?
    let error: String?
}

struct HostDiagnostic: Decodable, Identifiable {
    let recordId: String
    let hostId: String?
    let category: String
    let severity: String
    let message: String
    let at: Int64
    var id: String { recordId }
}

struct HostDiagnosticPage: Decodable {
    let records: [HostDiagnostic]
    let nextCursor: String?
    let truncated: Bool
}

/// One authenticated connection owns its request IDs and model epoch. Domains merge independently;
/// partial/missing/unavailable publications never masquerade as an empty, current inventory.
@MainActor
final class HostState: ObservableObject {
    nonisolated static let domainNames = ["identity", "backends", "catalog", "providers", "workspaces", "files", "operations", "diagnostics", "connections", "management"]
    @Published private(set) var domains: [String: HostDomain] = [:]
    @Published private(set) var missing: [String: String] = [:]
    @Published private(set) var pendingDomains: Set<String> = []
    @Published private(set) var modelError: String?
    @Published private(set) var truncated = false
    @Published private(set) var connected = false
    @Published private(set) var hostKey: String?
    @Published private(set) var providerKind = "codex"
    @Published private(set) var providerNotice: String?
    @Published private(set) var providerError: String?
    @Published private(set) var changingProvider = false
    @Published private(set) var quota: SubscriptionQuota?
    @Published private(set) var quotaProviderId: String?
    @Published private(set) var queryingQuota = false
    @Published private(set) var quotaError: String?
    @Published private(set) var quotaKind: String?
    @Published private(set) var subscriptionQuotas: [String: ProviderQuotaSnapshot] = [:]
    @Published private(set) var diagnosticPage: HostDiagnosticPage?
    @Published private(set) var diagnosticsLoading = false
    @Published private(set) var diagnosticsError: String?
    var send: (([String: Any]) -> Bool)?
    var didChangeProviders: (() -> Void)?
    var didProject: (([String: HostDomain]) -> Void)?
    var didChangeCatalog: (([SessionSummary], Set<String>) -> Void)?
    @Published private(set) var catalogRange: HostCatalogRange?
    private var catalogRequest: HostCatalogRequest?
    private var catalogTimeout: Task<Void, Never>?

    private var hostId: String?
    private var epoch: String?
    private var retiredEpochs: Set<String> = []
    private var subscriptionId: String?
    private var subscribedDomains: Set<String> = []
    private var modelTimeout: Task<Void, Never>?
    private var providerRequest: (id: String, kind: String, hostKey: String)?
    private var providerTimeout: Task<Void, Never>?
    private var quotaRequest: (id: String, kind: String, providerId: String, hostKey: String)?
    private var quotaTimeout: Task<Void, Never>?
    private var pendingProviderRemovals: [AgentProvider] = []
    private var providerRemovalCount = 0
    private var diagnosticRequest: String?
    private var diagnosticTimeout: Task<Void, Never>?

    func setConnection(_ pairing: HostPairing?, connected: Bool) {
        let key = pairing.map(FileTransfers.pairingKey)
        let changedHost = hostKey != key
        guard changedHost || self.connected != connected else { return }
        cancelRequests()
        self.connected = connected
        hostKey = key; hostId = pairing?.hostId
        // Keep the last facts visible while offline on the same computer, but never actionable.
        if changedHost {
            domains = [:]; missing = [:]; truncated = false
            retiredEpochs = []
            catalogRange = nil
            diagnosticPage = nil; providerNotice = nil; providerError = nil; diagnosticsError = nil
        }
        epoch = nil
        modelError = nil
        if connected { refresh() }
    }

    @discardableResult
    func beginEpoch(_ value: String?) -> Bool {
        guard let value, !value.isEmpty else { return true }
        guard !retiredEpochs.contains(value) else { return false }
        let previous = epoch ?? domains.values.first?.modelEpoch
        if let previous, previous != value {
            retiredEpochs.insert(previous)
            cancelRequests(); domains = [:]; missing = [:]; catalogRange = nil
            epoch = value
            if connected { refresh() }
        } else { epoch = value }
        return true
    }

    func refresh(_ requested: [String] = HostState.domainNames) {
        guard connected else { modelError = "请先连接已配对的电脑"; return }
        let wanted = Set(requested).intersection(Self.domainNames)
        subscribedDomains.formUnion(wanted)
        let id = UUID().uuidString
        subscriptionId = id; pendingDomains = subscribedDomains; modelError = nil
        // Replacing the subscription must retain every domain already requested by this connection.
        let known = domains.values.filter { !wanted.contains($0.domain) && $0.modelEpoch == epoch }.map {
            ["domain": $0.domain, "modelEpoch": $0.modelEpoch, "revision": $0.revision] as [String: Any]
        }
        modelTimeout?.cancel()
        guard send?(["type": "agent.state.request", "protocolVersion": orbisProtocolVersion, "requestId": id,
                     "scope": "host", "subscribe": true, "domains": subscribedDomains.sorted(), "known": known]) == true else {
            subscriptionId = nil; pendingDomains = []; modelError = "状态读取未发送，请重新连接"; return
        }
        modelTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.subscriptionId == id, !self.pendingDomains.isEmpty else { return }
            self.pendingDomains = []; self.modelError = "状态读取超时，请重新读取"
        }
    }

    func loadProviders(_ kind: String) {
        guard ["pi", "codex", "dsh", "claude"].contains(kind), !changingProvider else { return }
        clearQuota()
        providerKind = kind; providerError = nil; providerNotice = nil
        refresh(["providers"])
    }

    var providersLoading: Bool { pendingDomains.contains("providers") }
    var providerSummary: HostJSON? {
        providerSummary(for: providerKind)
    }
    func providerSummary(for kind: String) -> HostJSON? {
        guard let domain = domains["providers"], domain.availability == "ready", missing["providers"] == nil else { return nil }
        return domain.value["providers"].array.first { $0["agentKind"].string == kind }
    }
    var providers: [AgentProvider] {
        providers(for: providerKind)
    }
    func providers(for kind: String) -> [AgentProvider] {
        guard let summary = providerSummary(for: kind) else { return [] }
        return summary["profiles"].array.compactMap { profile in
            guard let id = profile["id"].string, !id.isEmpty, let enabled = profile["enabled"].bool,
                  let globalDefault = profile["globalDefault"].bool else { return nil }
            return AgentProvider(id: id, kind: kind, name: profile["name"].string ?? id, enabled: enabled,
                                 additive: profile["mode"].string == "additive", globalDefault: globalDefault, subscriptionSupported: profile["subscriptionSupported"].bool == true,
                                 official: profile["official"].bool == true || profile["subscriptionSupported"].bool == true)
        }
    }
    var providerCatalogProblem: String? { providerCatalogProblem(for: providerKind) }
    func providerCatalogProblem(for kind: String) -> String? {
        if let problem = problem(for: "providers") { return problem }
        guard let summary = providerSummary(for: kind) else { return "电脑没有报告此 Agent 的供应商配置" }
        if let availability = summary["availability"].string, availability != "ready" { return "电脑尚未核对此 Agent 的供应商配置" }
        if summary["profiles"] == .null { return "尚未读取到供应商清单，请刷新后重试" }
        let profiles = summary["profiles"]
        guard profiles.isArray, profiles.array.count <= 64, Set(profiles.array.compactMap { $0["id"].string }).count == profiles.array.count,
              profiles.array.allSatisfy({ profile in
                  guard let id = profile["id"].string, !id.isEmpty, id.count <= 128,
                        let name = profile["name"].string, name.count <= 256, profile["enabled"].bool != nil,
                        profile["globalDefault"].bool != nil else { return false }
                  return profile["mode"] == .null || ["additive", "exclusive"].contains(profile["mode"].string ?? "")
              }) else { return "供应商清单格式无法识别，请刷新后重试" }
        if summary["profilesTruncated"].bool == true { return "供应商清单不完整，请在电脑端检查配置" }
        return nil
    }
    var canChangeProvider: Bool { canChangeProvider(for: providerKind) }
    func canChangeProvider(for kind: String) -> Bool {
        connected && !providersLoading && !changingProvider && !queryingQuota &&
        providerCatalogProblem(for: kind) == nil &&
        providerSummary(for: kind)?["switching"].bool != true
    }
    func currentProvider(for kind: String) -> AgentProvider? {
        let enabled = providers(for: kind).filter(\.enabled)
        return enabled.first(where: \.globalDefault) ?? (enabled.count == 1 ? enabled.first : nil)
    }
    func providerName(for kind: String) -> String {
        if let current = currentProvider(for: kind) { return current.name }
        if providerCatalogProblem(for: kind) != nil { return "尚未读取" }
        let enabled = providers(for: kind).filter(\.enabled)
        return enabled.isEmpty ? "未启用供应商" : enabled.map(\.name).joined(separator: "、")
    }
    func subscriptionQuota(for kind: String) -> ProviderQuotaSnapshot? {
        guard let snapshot = subscriptionQuotas[kind], currentProvider(for: kind)?.id == snapshot.providerId else { return nil }
        return snapshot
    }
    var currentProviders: [String: String] {
        guard let domain = domains["providers"], domain.availability == "ready", missing["providers"] == nil else { return [:] }
        var result: [String: String] = [:]
        for row in domain.value["providers"].array {
            if let kind = row["agentKind"].string, let provider = row["modelProvider"].string, !provider.isEmpty { result[kind] = provider }
        }
        return result
    }

    func changeProvider(_ provider: AgentProvider, expectedHostKey: String) {
        guard hostKey == expectedHostKey, canChangeProvider(for: provider.kind), providers(for: provider.kind).contains(provider),
              !provider.enabled || provider.additive else { providerError = "目标电脑或供应商列表已变化，请刷新后重试"; return }
        clearQuota(for: provider.kind); providerKind = provider.kind
        sendProviderChange(provider, expectedHostKey: expectedHostKey)
    }

    func querySubscription(_ provider: AgentProvider, expectedHostKey: String) {
        guard hostKey == expectedHostKey, canChangeProvider(for: provider.kind), providers(for: provider.kind).contains(provider), provider.enabled,
              provider.subscriptionSupported else { return }
        quota = subscriptionQuota(for: provider.kind)?.quota
        quotaError = nil
        subscriptionQuotas[provider.kind] = ProviderQuotaSnapshot(providerId: provider.id, quota: quota, error: nil)
        let id = UUID().uuidString
        quotaRequest = (id, provider.kind, provider.id, expectedHostKey)
        quotaProviderId = provider.id; quotaKind = provider.kind; queryingQuota = true
        guard send?(["type": "provider.subscription", "protocolVersion": orbisProtocolVersion, "requestId": id,
                     "kind": provider.kind, "id": provider.id]) == true else {
            finishQuota(error: "配额查询未发送，请重新连接"); return
        }
        quotaTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 45_000_000_000) } catch { return }
            guard let self, self.quotaRequest?.id == id else { return }
            self.finishQuota(error: "配额查询超时，请稍后重试")
        }
    }

    private func finishQuota(error: String? = nil) {
        if let request = quotaRequest {
            subscriptionQuotas[request.kind] = ProviderQuotaSnapshot(providerId: request.providerId, quota: quota, error: error)
        }
        quotaTimeout?.cancel(); quotaRequest = nil; queryingQuota = false; quotaError = error
    }
    private func clearQuota(for kind: String? = nil) {
        if kind == nil || quotaKind == kind {
            quotaRequest = nil; finishQuota(); quota = nil; quotaProviderId = nil; quotaKind = nil
        }
        if let kind { subscriptionQuotas.removeValue(forKey: kind) } else { subscriptionQuotas = [:] }
    }

    func removeProviders(_ selected: [AgentProvider], expectedHostKey: String) {
        guard hostKey == expectedHostKey, canChangeProvider, !selected.isEmpty,
              Set(selected.map(\.id)).count == selected.count,
              selected.allSatisfy({ $0.removable && providers.contains($0) }) else {
            providerError = "目标电脑或供应商列表已变化，请刷新后重试"; return
        }
        pendingProviderRemovals = selected
        providerRemovalCount = selected.count
        sendProviderChange(selected[0], expectedHostKey: expectedHostKey)
    }

    private func stopProviderChange(_ error: String) {
        providerTimeout?.cancel(); providerRequest = nil; changingProvider = false
        providerError = (providerRemovalCount > 0 ? "批量移除已停止：" : "") + error
        pendingProviderRemovals = []; providerRemovalCount = 0
    }

    private func sendProviderChange(_ provider: AgentProvider, expectedHostKey: String) {
        guard connected, hostKey == expectedHostKey, providers(for: provider.kind).contains(provider) else {
            stopProviderChange("目标电脑或供应商列表已变化，请刷新确认结果"); return
        }
        let id = UUID().uuidString
        providerRequest = (id, provider.kind, expectedHostKey)
        changingProvider = true; providerError = nil; providerNotice = nil
        guard send?(["type": "provider.switch", "protocolVersion": orbisProtocolVersion, "requestId": id,
                     "kind": provider.kind, "id": provider.id, "enabled": !provider.enabled]) == true else {
            stopProviderChange("供应商操作未发送，请重新连接"); return
        }
        providerTimeout?.cancel()
        providerTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 90_000_000_000) } catch { return }
            guard let self, self.providerRequest?.id == id else { return }
            self.stopProviderChange("操作超时，请刷新以确认实际状态")
        }
    }

    func readDiagnostics(cursor: String? = nil) {
        guard connected, !diagnosticsLoading else { return }
        let id = UUID().uuidString
        diagnosticRequest = id; diagnosticsLoading = true; diagnosticsError = nil
        var payload: [String: Any] = ["type": "diagnostics.request", "protocolVersion": orbisProtocolVersion, "requestId": id, "limit": 500]
        if let cursor { payload["cursor"] = cursor }
        guard send?(payload) == true else { finishDiagnostics(error: "记录读取未发送，请重新连接"); return }
        diagnosticTimeout?.cancel()
        diagnosticTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
            guard let self, self.diagnosticRequest == id else { return }
            self.finishDiagnostics(error: "记录读取超时，请重试")
        }
    }

    /// Called only after the transport has authenticated/decrypted the payload.
    @discardableResult
    func consume(_ message: [String: Any]) -> Bool {
        guard connected, let type = message["type"] as? String else { return false }
        switch type {
        case "provider.subscription.result":
            guard let request = quotaRequest, request.id == message["requestId"] as? String,
                  request.kind == message["kind"] as? String, request.providerId == message["id"] as? String,
                  request.hostKey == hostKey,
                  providers(for: request.kind).contains(where: { $0.id == request.providerId && $0.enabled && $0.subscriptionSupported }) else { return true }
            if let error = message["error"] as? String { finishQuota(error: error); return true }
            guard let raw = message["quota"] as? [String: Any], let result: SubscriptionQuota = decode(raw), result.valid else {
                finishQuota(error: "配额数据格式无法识别，请升级 Host 后重试"); return true
            }
            quota = result; finishQuota(); return true
        case "agent.state.snapshot":
            guard message["scope"] as? String == "host" else { return false }
            consumeSnapshot(message); return true
        case "agent.state.range.page":
            guard message["scope"] as? String == "host", message["domain"] as? String == "catalog" else { return false }
            consumeCatalogPage(message); return true
        case "provider.result":
            guard let request = providerRequest, request.id == message["requestId"] as? String,
                  request.kind == message["kind"] as? String, request.hostKey == hostKey else { return true }
            if let error = message["error"] as? String { stopProviderChange(error); return true }
            providerTimeout?.cancel(); providerRequest = nil
            if !pendingProviderRemovals.isEmpty { pendingProviderRemovals.removeFirst() }
            if let next = pendingProviderRemovals.first {
                sendProviderChange(next, expectedHostKey: request.hostKey)
            } else {
                changingProvider = false
                let notice = (message["notice"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                providerNotice = providerRemovalCount > 0 ? "已移除 \(providerRemovalCount) 个供应商。" + (notice ?? "") : notice
                providerRemovalCount = 0
                refresh(["providers"]); didChangeProviders?()
            }
            return true
        case "provider.changed":
            clearQuota(for: message["kind"] as? String)
            refresh(["providers"]); didChangeProviders?(); return true
        case "diagnostics.page":
            guard diagnosticRequest != nil, diagnosticRequest == message["requestId"] as? String else { return true }
            if let error = message["error"] as? String { finishDiagnostics(error: error); return true }
            guard let raw = message["page"] as? [String: Any], let page: HostDiagnosticPage = decode(raw), page.records.count <= 500,
                  Set(page.records.map(\.recordId)).count == page.records.count,
                  page.records.allSatisfy({ !$0.recordId.isEmpty && $0.at >= 0 && ["info", "warning", "error"].contains($0.severity) && ($0.hostId == nil || $0.hostId == hostId) }) else {
                finishDiagnostics(error: "电脑端记录格式无法识别，请重新读取"); return true
            }
            diagnosticPage = page; finishDiagnostics(); return true
        case "protocol.error":
            let id = message["requestId"] as? String
            let error = message["message"] as? String ?? "电脑端无法完成读取"
            if let id, id == diagnosticRequest { finishDiagnostics(error: error); return true }
            if let id, id == providerRequest?.id {
                stopProviderChange(error); return true
            }
            if let id, id == subscriptionId { modelTimeout?.cancel(); pendingDomains = []; modelError = error; return true }
            if let id, id == catalogRequest?.id { rejectCatalog(error); return true }
            return false
        default: return false
        }
    }

    func problem(for name: String) -> String? {
        if !connected { return "电脑已离线，以下为最后读取的状态" }
        if let modelError { return modelError }
        if let reason = missing[name] { return reason == "unknown_domain" ? "此 Host 不支持这个状态领域" : "电脑尚未报告这个状态领域" }
        guard let domain = domains[name] else { return pendingDomains.contains(name) ? "正在读取" : "尚未读取" }
        if domain.availability != "ready" { return domain.availability == "unavailable" ? "电脑端暂不支持" : "电脑尚未核对" }
        if name == "catalog", let range = catalogRange, range.modelEpoch == domain.modelEpoch, range.revision == domain.revision {
            if let error = range.error { return "会话目录分页失败：" + error }
            if range.nextCursor != nil { return "正在读取会话目录（已读取 \(range.sessions.count) / \(range.totalSessions)）" }
            if range.truncated || !range.complete { return "会话目录不完整" }
        }
        if domain.completeness != "complete" && domain.projectionComplete != true { return "状态清单不完整" }
        if truncated { return "状态清单被截断，请重新读取" }
        return nil
    }

    private func consumeSnapshot(_ message: [String: Any]) {
        guard let id = message["requestId"] as? String, id == subscriptionId, message["scope"] as? String == "host",
              message["runtimeId"] == nil, message["sessionId"] == nil, message["agentKind"] == nil else { return }
        if let error = message["error"] as? String { modelError = error; pendingDomains = []; modelTimeout?.cancel(); return }
        guard let newEpoch = message["modelEpoch"] as? String, !newEpoch.isEmpty else { rejectModel(); return }
        if retiredEpochs.contains(newEpoch) || epoch.map({ $0 != newEpoch }) == true { return }
        guard let rawDomains = message["domains"] as? [[String: Any]], let rawMissing = message["missing"] as? [[String: Any]],
              let isTruncated = message["truncated"] as? Bool else { rejectModel(); return }
        var decoded: [String: HostDomain] = [:]
        for raw in rawDomains {
            guard let domain: HostDomain = decode(raw), domain.valid, domain.modelEpoch == newEpoch,
                  subscribedDomains.contains(domain.domain), decoded[domain.domain] == nil else { rejectModel(); return }
            decoded[domain.domain] = domain
        }
        var absent: [String: String] = [:]
        for raw in rawMissing {
            guard let name = raw["domain"] as? String, subscribedDomains.contains(name), decoded[name] == nil, absent[name] == nil,
                  let reason = raw["reason"] as? String, ["no_state", "unknown_domain"].contains(reason) else { rejectModel(); return }
            absent[name] = reason
        }
        let unchanged = message["unchanged"] as? [String] ?? []
        guard unchanged.allSatisfy({ subscribedDomains.contains($0) && decoded[$0] == nil && absent[$0] == nil && domains[$0]?.modelEpoch == newEpoch }) else { rejectModel(); return }
        for domain in decoded.values where domain.domain == "catalog" && domain.availability == "ready" && domain.value["sessions"] != .null {
            guard HostCatalogRange(domain: domain) != nil else { rejectModel(); return }
        }
        // Decode every envelope before mutating anything. Lower/equal-version changes cannot roll back facts.
        if epoch == nil { domains = domains.filter { $0.value.modelEpoch == newEpoch }; missing = [:] }
        epoch = newEpoch
        var accepted: [String: HostDomain] = [:]
        for (name, incoming) in decoded {
            if let old = domains[name] {
                if incoming.revision < old.revision { continue }
                if incoming.revision == old.revision && (!incoming.sameFacts(as: old) || incoming.checkedAt < old.checkedAt) { continue }
            }
            domains[name] = incoming; missing[name] = nil
            accepted[name] = incoming
        }
        for (name, reason) in absent { missing[name] = reason }
        pendingDomains.subtract(decoded.keys); pendingDomains.subtract(absent.keys); pendingDomains.subtract(unchanged)
        truncated = isTruncated; modelError = nil
        for name in unchanged { if let value = domains[name] { accepted[name] = value } }
        didProject?(accepted)
        if let catalog = accepted["catalog"] { beginCatalog(catalog) }
        if pendingDomains.isEmpty { modelTimeout?.cancel() }
    }

    private func rejectModel() {
        modelError = "电脑端状态格式无法识别，请重新读取"; pendingDomains = []; modelTimeout?.cancel()
    }
    private func finishDiagnostics(error: String? = nil) {
        diagnosticTimeout?.cancel(); diagnosticRequest = nil; diagnosticsLoading = false; diagnosticsError = error
    }
    private func cancelRequests() {
        clearQuota()
        modelTimeout?.cancel(); providerTimeout?.cancel(); diagnosticTimeout?.cancel(); catalogTimeout?.cancel()
        catalogRequest = nil
        if changingProvider { stopProviderChange("连接已断开，请刷新以确认操作结果") }
        if diagnosticsLoading { diagnosticsError = "连接已断开，请重新读取" }
        subscriptionId = nil; subscribedDomains = []; pendingDomains = []
        providerRequest = nil; changingProvider = false; diagnosticRequest = nil; diagnosticsLoading = false
    }

    private func beginCatalog(_ domain: HostDomain) {
        guard domain.availability == "ready" else { catalogRange = nil; catalogRequest = nil; catalogTimeout?.cancel(); return }
        guard let range = HostCatalogRange(domain: domain) else { return }
        if let old = catalogRange, old.error == nil, old.modelEpoch == range.modelEpoch, old.revision == range.revision,
           old.snapshotId == range.snapshotId {
            publishCatalog(old); requestCatalogPage(); return
        }
        catalogTimeout?.cancel(); catalogRequest = nil; catalogRange = range
        publishCatalog(range); requestCatalogPage()
    }

    private func publishCatalog(_ range: HostCatalogRange) {
        didChangeCatalog?(range.sessions, range.completeKinds)
    }

    func requestCatalogPage() {
        guard connected, catalogRequest == nil, let range = catalogRange,
              range.error == nil, let cursor = range.nextCursor else { return }
        let request = HostCatalogRequest(id: UUID().uuidString, cursor: cursor, modelEpoch: range.modelEpoch,
                                         revision: range.revision, snapshotId: range.snapshotId, offset: range.sessions.count)
        catalogRequest = request
        guard send?(["type": "agent.state.range.request", "protocolVersion": orbisProtocolVersion,
                     "requestId": request.id, "scope": "host", "domain": "catalog", "cursor": cursor, "limit": 200]) == true else {
            rejectCatalog("目录分页请求未发送，请重新连接"); return
        }
        catalogTimeout?.cancel()
        catalogTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard let self, self.catalogRequest?.id == request.id else { return }
            self.rejectCatalog("目录分页读取超时，请刷新重试")
        }
    }

    private func consumeCatalogPage(_ message: [String: Any]) {
        guard let request = catalogRequest, message["requestId"] as? String == request.id,
              let range = catalogRange, range.matches(request) else { return }
        guard let raw = message["page"] as? [String: Any], let page: HostJSON = decode(raw) else { rejectCatalog("invalid_page"); return }
        if let error = page["error"].string { rejectCatalog(error); return }
        guard page["modelEpoch"].string == request.modelEpoch, page["revision"].integer == request.revision,
              page["snapshotId"].string == request.snapshotId, page["offset"].integer == Int64(request.offset),
              page["totalSessions"].integer == Int64(range.totalSessions), epoch == request.modelEpoch else {
            rejectCatalog("snapshot_changed"); return
        }
        guard let updated = range.appending(page, request: request) else { rejectCatalog("invalid_page"); return }
        catalogTimeout?.cancel(); catalogRequest = nil; catalogRange = updated
        publishCatalog(updated); requestCatalogPage()
    }

    private func rejectCatalog(_ error: String) {
        catalogTimeout?.cancel(); catalogRequest = nil
        catalogRange?.error = error
    }
    private func decode<T: Decodable>(_ raw: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

let defaultPathPreference = ["lan", "p2p", "relay"]
func normalizedPathPreference(_ order: [String]) -> [String] {
    var result: [String] = []
    for path in order + defaultPathPreference where defaultPathPreference.contains(path) && !result.contains(path) { result.append(path) }
    return result
}
