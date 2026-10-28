import Foundation
import Combine

struct ToolSource: Codable, Hashable { let epoch: String; let seq: Int64 }
struct ToolVersion: Codable, Hashable { let epoch: String; let revision: Int64 }
struct ToolReference: Codable, Hashable {
    let projectionVersion: Int; let agent: ToolAgent; let version: ToolVersion; let source: ToolSource
    let totalCount: Int; let summaryBytes: Int64
}
struct ToolSnapshot: Codable, Hashable {
    let snapshotId: String; let agent: ToolAgent; let version: ToolVersion; let source: ToolSource; let totalCount: Int?
}
struct ToolInventoryPage: Codable {
    let requestId: String; let runtimeId: String; let snapshot: ToolSnapshot
    let startIndex: Int; let endIndex: Int; let tools: [ToolSummary]; let nextCursor: String?
}
struct ToolInventoryPatch: Codable {
    let runtimeId: String; let agent: ToolAgent; let version: ToolVersion; let source: ToolSource
    let baseRevision: Int64; let upserts: [ToolSummary]; let removes: [String]
}

@MainActor
final class ToolInventories: ObservableObject {
    @Published private(set) var visible: [String: [ToolSummary]] = [:]
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []
    var send: (String, [String: Any]) -> Bool = { _, _ in false }
    var didCover: (String, ToolReference) -> Void = { _, _ in }
    private struct Replica {
        var desired: ToolReference?
        var confirmed: ToolReference?
        var tools: [ToolSummary] = []
        var target: ToolReference?
        var snapshot: ToolSnapshot?
        var incoming: [ToolSummary] = []
        var bytes = 0
        var requestId: String?
        var cursor: String?
        var patches: [ToolInventoryPatch] = []
        var bufferedBytes = 0
        var retired: Set<String> = []
    }
    private var replicas: [String: Replica] = [:]
    private var timeouts: [String: Task<Void, Never>] = [:]

    func covers(_ reference: ToolReference, runtime: String) -> Bool { replicas[runtime]?.confirmed == reference }
    func require(_ reference: ToolReference, runtime: String) {
        guard reference.projectionVersion == 1, (0...4096).contains(reference.totalCount), (0...8_388_608).contains(reference.summaryBytes), reference.version.revision > 0 else { failed(runtime, "工具清单版本或大小无效。" ); return }
        var replica = replicas[runtime] ?? Replica()
        replica.desired = reference
        if replica.confirmed == reference { replicas[runtime] = replica; visible[runtime] = replica.tools; didCover(runtime, reference); return }
        if replica.target == reference { replicas[runtime] = replica; return }
        if let previous = replica.target ?? replica.confirmed {
            if replica.retired.contains(reference.version.epoch) { return }
            if previous.version.epoch == reference.version.epoch, reference.version.revision < previous.version.revision { return }
            if previous.version.epoch != reference.version.epoch {
                guard replica.retired.count < 64 else { failed(runtime, "工具清单代次超限。"); return }
                replica.retired.insert(previous.version.epoch)
            }
        }
        replica.target = reference; replica.snapshot = nil; replica.incoming = []; replica.bytes = 0
        replica.cursor = nil; replica.requestId = UUID().uuidString; replica.patches = []; replica.bufferedBytes = 0
        replicas[runtime] = replica; errors[runtime] = nil; loading.insert(runtime); issue(runtime)
    }
    func retry(_ runtime: String) {
        guard let desired = replicas[runtime]?.desired else { return }
        replicas[runtime]?.target = nil
        require(desired, runtime: runtime)
    }
    func consume(_ event: [String: Any], runtime: String) {
        guard let type = event["type"] as? String, var replica = replicas[runtime], let data = try? JSONSerialization.data(withJSONObject: event), data.count <= 65536 else { return }
        if type == "session.tools.opened", event["requestId"] as? String == replica.requestId,
           let raw = event["snapshot"] as? [String: Any], let snapshot: ToolSnapshot = decode(raw), let target = replica.target {
            guard snapshot.agent == target.agent, snapshot.source == target.source, snapshot.version == target.version, snapshot.totalCount == target.totalCount else { failed(runtime, "工具清单身份不匹配。"); return }
            replica.snapshot = snapshot; replica.requestId = UUID().uuidString
            replicas[runtime] = replica; issue(runtime); return
        }
        if type == "session.tools.page", let page = try? JSONDecoder().decode(ToolInventoryPage.self, from: data),
           page.requestId == replica.requestId, page.runtimeId == runtime, page.snapshot == replica.snapshot, let target = replica.target {
            let all = replica.incoming + page.tools
            let bytes = replica.bytes + page.tools.reduce(0) { $0 + summaryBytes($1) }
            guard page.startIndex == replica.incoming.count, page.endIndex == all.count, page.tools.count <= 128,
                  page.nextCursor == nil || (page.nextCursor != replica.cursor && !page.tools.isEmpty),
                  all.count <= 4096, bytes <= 8_388_608, Set(all.compactMap { $0.tool?.toolCallId }).count == all.count,
                  all == all.sorted(by: toolOrdered), page.tools.allSatisfy({ validSummary($0, agent: target.agent) }) else { failed(runtime, "工具清单分页无效。"); return }
            if page.nextCursor != nil {
                replica.incoming = all; replica.bytes = bytes; replica.cursor = page.nextCursor; replica.requestId = UUID().uuidString
                replicas[runtime] = replica; issue(runtime); return
            }
            guard all.count == target.totalCount, bytes == target.summaryBytes else { failed(runtime, "工具清单未完整接收。"); return }
            replica.confirmed = target; replica.tools = all; replica.target = nil; replica.requestId = nil; replica.snapshot = nil; replica.incoming = []
            for patch in replica.patches {
                guard apply(patch, to: &replica) else { failed(runtime, "工具清单版本不连续。"); return }
            }
            replica.patches = []; replica.bufferedBytes = 0
            replicas[runtime] = replica; timeouts.removeValue(forKey: runtime)?.cancel(); loading.remove(runtime)
            publish(runtime); return
        }
        if type == "session.tools.patch", let patch = try? JSONDecoder().decode(ToolInventoryPatch.self, from: data), patch.runtimeId == runtime {
            guard !replica.retired.contains(patch.version.epoch) else { return }
            if replica.target != nil {
                guard let target = replica.target, patch.agent == target.agent else { return }
                let latestVersion = replica.patches.last?.version ?? target.version
                let latestSource = replica.patches.last?.source ?? target.source
                if patch.version.epoch == latestVersion.epoch && patch.version.revision <= latestVersion.revision { return }
                guard patch.version.epoch == latestVersion.epoch, patch.source.epoch == latestSource.epoch,
                      patch.baseRevision == latestVersion.revision, patch.source.seq > latestSource.seq,
                      replica.patches.count < 64, replica.bufferedBytes + data.count <= 1_048_576 else { failed(runtime, "工具清单更新需要重新读取。"); return }
                replica.patches.append(patch); replica.bufferedBytes += data.count; replicas[runtime] = replica
            } else {
                if let confirmed = replica.confirmed, confirmed.version.epoch == patch.version.epoch && patch.version.revision <= confirmed.version.revision { return }
                guard apply(patch, to: &replica) else { failed(runtime, "工具清单版本不连续。"); return }
                replicas[runtime] = replica; publish(runtime)
            }
        } else if type == "session.tools.changed" {
            // A bounded notice invalidates this read; the following chat checkpoint
            // carries the authoritative complete reference required to reopen it.
            errors[runtime] = "工具清单已更新，等待会话同步。"
        } else if type == "session.tool.read.failed", event["requestId"] as? String == replica.requestId {
            failed(runtime, toolReadFailureTitle(event["reason"] as? String))
        }
    }
    private func apply(_ patch: ToolInventoryPatch, to replica: inout Replica) -> Bool {
        guard let current = replica.confirmed, patch.agent == current.agent, patch.version.epoch == current.version.epoch,
              patch.source.epoch == current.source.epoch, patch.baseRevision == current.version.revision,
              patch.version.revision == current.version.revision + 1, patch.source.seq > current.source.seq,
              patch.upserts.count <= 128, patch.removes.count <= 128,
              patch.upserts.allSatisfy({ validSummary($0, agent: patch.agent) }) else { return false }
        let changes = patch.removes + patch.upserts.compactMap { $0.tool?.toolCallId }
        guard !changes.isEmpty, Set(changes).count == changes.count else { return false }
        var tools = replica.tools.filter { !changes.contains($0.tool?.toolCallId ?? "") }
        tools.append(contentsOf: patch.upserts); tools.sort(by: toolOrdered)
        let bytes = tools.reduce(0) { $0 + summaryBytes($1) }
        guard tools.count <= 4096, bytes <= 8_388_608 else { return false }
        replica.tools = tools
        replica.confirmed = ToolReference(projectionVersion: 1, agent: current.agent, version: patch.version, source: patch.source, totalCount: tools.count, summaryBytes: Int64(bytes))
        return true
    }
    private func publish(_ runtime: String) {
        guard let replica = replicas[runtime], let desired = replica.desired, replica.confirmed == desired else { return }
        visible[runtime] = replica.tools; errors[runtime] = nil; didCover(runtime, desired)
    }
    private func issue(_ runtime: String) {
        guard let replica = replicas[runtime], let target = replica.target, let request = replica.requestId else { return }
        var command: [String: Any] = ["type": replica.snapshot == nil ? "session.tools.open" : "session.tools.read", "runtimeId": runtime, "requestId": request]
        if let snapshot = replica.snapshot { command["snapshot"] = encode(snapshot); command["cursor"] = replica.cursor as Any? ?? NSNull(); command["maxItems"] = 128 }
        else { command["reference"] = encode(target) }
        guard send(runtime, command) else { failed(runtime, "工具清单读取未送达。"); return }
        timeouts[runtime]?.cancel()
        timeouts[runtime] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 30_000_000_000) } catch { return }
            guard let self, self.replicas[runtime]?.requestId == request else { return }
            self.failed(runtime, "工具清单读取超时，请重试。")
        }
    }
    private func failed(_ runtime: String, _ message: String) {
        errors[runtime] = message; loading.remove(runtime); timeouts.removeValue(forKey: runtime)?.cancel()
        replicas[runtime]?.requestId = nil; replicas[runtime]?.target = nil
    }
    func clear(_ runtime: String? = nil) {
        if let runtime { replicas[runtime] = nil; visible[runtime] = nil; errors[runtime] = nil; loading.remove(runtime); timeouts.removeValue(forKey: runtime)?.cancel() }
        else { replicas = [:]; visible = [:]; errors = [:]; loading = []; timeouts.values.forEach { $0.cancel() }; timeouts = [:] }
    }
    private func validSummary(_ summary: ToolSummary, agent: ToolAgent) -> Bool {
        summary.projectionVersion == 1 && summary.tool?.agent == agent && summary.order >= 0 && summaryBytes(summary) <= 4096 &&
            summary.contents.count <= 3 && Set(summary.contents.map(\.part)).count == summary.contents.count &&
            ["started", "running", "finished", "cancelled"].contains(summary.phase)
    }
    private func summaryBytes(_ summary: ToolSummary) -> Int {
        guard let data = try? JSONEncoder().encode(summary), let object = try? JSONSerialization.jsonObject(with: data),
              let wire = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes, .fragmentsAllowed]) else { return Int.max / 8192 }
        return wire.count
    }
    private func toolOrdered(_ a: ToolSummary, _ b: ToolSummary) -> Bool {
        a.order == b.order ? (a.tool?.toolCallId ?? "") < (b.tool?.toolCallId ?? "") : a.order < b.order
    }
    private func encode<T: Encodable>(_ value: T) -> [String: Any] { (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(value))) as? [String: Any] ?? [:] }
    private func decode<T: Decodable>(_ value: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
