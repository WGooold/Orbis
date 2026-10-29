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
private struct ToolInventoryChanged: Decodable {
    let runtimeId: String; let agent: ToolAgent; let version: ToolVersion; let source: ToolSource
}

@MainActor
final class ToolInventories: ObservableObject {
    @Published private(set) var visible: [String: [ToolSummary]] = [:]
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []
    var send: (String, [String: Any]) -> Bool = { _, _ in false }
    var didCover: (String, ToolReference) -> Void = { _, _ in }
    /// An inventory failure also terminates source reads waiting for its coverage.
    var didFail: (String, ToolReference?, String) -> Void = { _, _, _ in }
    private struct Replica {
        var desired: ToolReference?
        var confirmed: ToolReference?
        // Exact completed versions may still own an in-flight source ACK after a newer version arrives.
        var verified: [ToolReference] = []
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
    private let readTimeoutNanoseconds: UInt64

    init(readTimeoutNanoseconds: UInt64 = 30_000_000_000) {
        self.readTimeoutNanoseconds = readTimeoutNanoseconds
    }

    func covers(_ reference: ToolReference, runtime: String) -> Bool { replicas[runtime]?.verified.contains(reference) == true }
    func require(_ reference: ToolReference, runtime: String) {
        guard reference.projectionVersion == 1, (0...4096).contains(reference.totalCount), (0...8_388_608).contains(reference.summaryBytes),
              validToolId(reference.version.epoch), (1...9_007_199_254_740_991).contains(reference.version.revision),
              validToolId(reference.source.epoch), (0...9_007_199_254_740_991).contains(reference.source.seq) else { failed(runtime, "工具清单版本或大小无效。", reference: reference); return }
        var replica = replicas[runtime] ?? Replica()
        if replica.verified.contains(reference) {
            if replica.target == nil, replica.confirmed == reference,
               replica.desired.map({ $0.version.epoch == reference.version.epoch && $0.version.revision <= reference.version.revision }) ?? true {
                replica.desired = reference
                replicas[runtime] = replica; publish(runtime); didCover(runtime, reference)
            }
            return
        }
        if let previous = replica.desired ?? replica.target ?? replica.confirmed {
            if replica.retired.contains(reference.version.epoch) { return }
            if previous.version.epoch == reference.version.epoch, reference.version.revision < previous.version.revision { return }
            if previous.version.epoch != reference.version.epoch {
                guard replica.retired.count < 64 else { failed(runtime, "工具清单代次超限。", reference: reference); return }
                replica.retired.insert(previous.version.epoch)
            }
        }
        replica.desired = reference
        // Keep a fixed snapshot alive while newer checkpoints arrive. Continuous
        // patches or a subsequent fixed read bring it to the desired reference.
        if let target = replica.target, target.source.epoch == reference.source.epoch { replicas[runtime] = replica; return }
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
            guard event["runtimeId"] as? String == runtime, validToolId(snapshot.snapshotId), snapshot.agent == target.agent,
                  snapshot.source == target.source, snapshot.version == target.version, snapshot.totalCount == target.totalCount else { failed(runtime, "工具清单身份不匹配。"); return }
            replica.snapshot = snapshot; replica.requestId = UUID().uuidString
            replicas[runtime] = replica; issue(runtime); return
        }
        if type == "session.tools.page", let page = try? JSONDecoder().decode(ToolInventoryPage.self, from: data),
           page.requestId == replica.requestId, page.runtimeId == runtime, page.snapshot == replica.snapshot, let target = replica.target {
            let all = replica.incoming + page.tools
            let bytes = replica.bytes + page.tools.reduce(0) { $0 + summaryBytes($1) }
            guard page.startIndex == replica.incoming.count, page.endIndex == all.count, page.tools.count <= 128,
                  page.nextCursor == nil || (page.nextCursor != replica.cursor && !page.tools.isEmpty),
                  all.count <= target.totalCount, bytes <= target.summaryBytes, Set(all.compactMap { $0.tool?.toolCallId }).count == all.count,
                  all == all.sorted(by: toolOrdered), page.tools.allSatisfy({ validSummary($0, agent: target.agent) }) else { failed(runtime, "工具清单分页无效。"); return }
            if page.nextCursor != nil {
                replica.incoming = all; replica.bytes = bytes; replica.cursor = page.nextCursor; replica.requestId = UUID().uuidString
                replicas[runtime] = replica; issue(runtime); return
            }
            guard all.count == target.totalCount, bytes == target.summaryBytes else { failed(runtime, "工具清单未完整接收。"); return }
            replica.confirmed = target; replica.tools = all; replica.target = nil; replica.requestId = nil; replica.snapshot = nil; replica.incoming = []
            var verified: [ToolReference] = []
            if rememberVerified(target, in: &replica) { verified.append(target) }
            for patch in replica.patches {
                guard apply(patch, to: &replica), let reference = replica.confirmed else {
                    replicas[runtime] = replica
                    failed(runtime, "工具清单版本不连续。")
                    notifyCovered(runtime, references: verified)
                    return
                }
                if rememberVerified(reference, in: &replica) { verified.append(reference) }
            }
            replica.patches = []; replica.bufferedBytes = 0; replica.bytes = 0; replica.cursor = nil
            replicas[runtime] = replica; timeouts.removeValue(forKey: runtime)?.cancel(); loading.remove(runtime)
            publish(runtime)
            notifyCovered(runtime, references: verified)
            // Notifications may synchronously begin another read or clear this runtime.
            if let current = replicas[runtime], current.target == nil, let desired = current.desired,
               !current.verified.contains(desired) { require(desired, runtime: runtime) }
            return
        }
        if type == "session.tools.patch", let patch = try? JSONDecoder().decode(ToolInventoryPatch.self, from: data), patch.runtimeId == runtime {
            guard !replica.retired.contains(patch.version.epoch) else { return }
            if replica.target != nil {
                guard let target = replica.target, patch.agent == target.agent else { return }
                let latestVersion = replica.patches.last?.version ?? target.version
                let latestSource = replica.patches.last?.source ?? target.source
                if patch.version.epoch == latestVersion.epoch && patch.version.revision <= latestVersion.revision { return }
                guard patch.version.epoch == latestVersion.epoch, patch.source.epoch == latestSource.epoch,
                      patch.baseRevision == latestVersion.revision, latestVersion.revision < 9_007_199_254_740_991,
                      patch.version.revision == latestVersion.revision + 1, patch.source.seq <= 9_007_199_254_740_991,
                      patch.source.seq > latestSource.seq, patch.upserts.count + patch.removes.count <= 128,
                      replica.patches.count < 63, replica.bufferedBytes + data.count <= 1_048_576 else { failed(runtime, "工具清单更新需要重新读取。"); return }
                replica.patches.append(patch); replica.bufferedBytes += data.count; replicas[runtime] = replica
            } else {
                if let confirmed = replica.confirmed, confirmed.version.epoch == patch.version.epoch && patch.version.revision <= confirmed.version.revision { return }
                guard apply(patch, to: &replica), let reference = replica.confirmed else { failed(runtime, "工具清单版本不连续。"); return }
                let verified = rememberVerified(reference, in: &replica)
                replicas[runtime] = replica; publish(runtime)
                if verified { notifyCovered(runtime, references: [reference]) }
            }
        } else if type == "session.tools.changed", let notice: ToolInventoryChanged = decode(event), notice.runtimeId == runtime {
            let latest = replica.patches.last.map { ($0.agent, $0.version, $0.source) }
                ?? replica.target.map { ($0.agent, $0.version, $0.source) }
                ?? replica.confirmed.map { ($0.agent, $0.version, $0.source) }
            guard !replica.retired.contains(notice.version.epoch), let latest, notice.agent == latest.0,
                  validToolId(notice.version.epoch), notice.version.revision > 0,
                  validToolId(notice.source.epoch), notice.source.seq >= 0 else { return }
            if notice.version.epoch == latest.1.epoch, notice.source.epoch == latest.2.epoch,
               notice.version.revision <= latest.1.revision { return }
            // A missing delta invalidates this read. A following chat checkpoint supplies the exact replacement reference.
            failed(runtime, "工具清单已更新，等待会话同步。")
        } else if type == "session.tool.read.failed", event["requestId"] as? String == replica.requestId {
            failed(runtime, toolReadFailureTitle(event["reason"] as? String))
        }
    }
    private func apply(_ patch: ToolInventoryPatch, to replica: inout Replica) -> Bool {
        guard let current = replica.confirmed, patch.agent == current.agent, patch.version.epoch == current.version.epoch,
              patch.source.epoch == current.source.epoch, patch.baseRevision == current.version.revision,
              current.version.revision < 9_007_199_254_740_991, patch.version.revision == current.version.revision + 1,
              patch.source.seq > current.source.seq, patch.source.seq <= 9_007_199_254_740_991,
              patch.upserts.count + patch.removes.count <= 128,
              patch.upserts.allSatisfy({ validSummary($0, agent: patch.agent) }) else { return false }
        let changes = patch.removes + patch.upserts.compactMap { $0.tool?.toolCallId }
        guard !changes.isEmpty, Set(changes).count == changes.count,
              patch.removes.allSatisfy({ id in validToolId(id) && replica.tools.contains { $0.tool?.toolCallId == id } }) else { return false }
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
        visible[runtime] = replica.tools; errors[runtime] = nil
    }
    private func rememberVerified(_ reference: ToolReference, in replica: inout Replica) -> Bool {
        guard !replica.verified.contains(reference) else { return false }
        replica.verified.append(reference)
        if replica.verified.count > 64 { replica.verified.removeFirst(replica.verified.count - 64) }
        return true
    }
    private func notifyCovered(_ runtime: String, references: [ToolReference]) {
        for reference in references where covers(reference, runtime: runtime) { didCover(runtime, reference) }
    }
    private func issue(_ runtime: String) {
        guard let replica = replicas[runtime], let target = replica.target, let request = replica.requestId else { return }
        var command: [String: Any] = ["type": replica.snapshot == nil ? "session.tools.open" : "session.tools.read", "runtimeId": runtime, "requestId": request]
        if let snapshot = replica.snapshot { command["snapshot"] = encode(snapshot); command["cursor"] = replica.cursor as Any? ?? NSNull(); command["maxItems"] = 128 }
        else { command["reference"] = encode(target) }
        guard send(runtime, command) else { failed(runtime, "工具清单读取未送达。"); return }
        timeouts[runtime]?.cancel()
        let delay = readTimeoutNanoseconds
        timeouts[runtime] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: delay) } catch { return }
            guard let self, self.replicas[runtime]?.requestId == request else { return }
            self.failed(runtime, "工具清单读取超时，请重试。")
        }
    }
    private func failed(_ runtime: String, _ message: String, reference: ToolReference? = nil) {
        let failedReference = reference ?? replicas[runtime]?.desired
        errors[runtime] = message; loading.remove(runtime); timeouts.removeValue(forKey: runtime)?.cancel()
        replicas[runtime]?.requestId = nil; replicas[runtime]?.target = nil; replicas[runtime]?.snapshot = nil
        replicas[runtime]?.incoming = []; replicas[runtime]?.bytes = 0; replicas[runtime]?.patches = []; replicas[runtime]?.bufferedBytes = 0
        // Publish after cleanup so the owner can retry safely from this callback.
        didFail(runtime, failedReference, message)
    }
    func clear(_ runtime: String? = nil) {
        if let runtime { replicas[runtime] = nil; visible[runtime] = nil; errors[runtime] = nil; loading.remove(runtime); timeouts.removeValue(forKey: runtime)?.cancel() }
        else { replicas = [:]; visible = [:]; errors = [:]; loading = []; timeouts.values.forEach { $0.cancel() }; timeouts = [:] }
    }
    private func validSummary(_ summary: ToolSummary, agent: ToolAgent) -> Bool {
        summary.projectionVersion == 1 && summary.tool?.agent == agent && validToolId(summary.tool?.toolCallId ?? "") &&
            validToolId(summary.toolName) && summary.order >= 0 && summaryBytes(summary) <= 4096 &&
            summary.contents.count <= 3 && Set(summary.contents.map(\.part)).count == summary.contents.count &&
            summary.contents.allSatisfy { part in
                ["arguments", "output", "result"].contains(part.part) && ["text", "json", "media-references"].contains(part.format) &&
                ["absent", "pending", "readable", "temporarily-unavailable", "unrecoverable"].contains(part.availability) &&
                ["range", "whole-source", "none"].contains(part.readCapability) && (part.availability != "readable" || part.readCapability != "none")
            } && ["started", "running", "finished", "cancelled"].contains(summary.phase)
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
