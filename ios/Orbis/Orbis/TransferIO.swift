import Foundation
import CryptoKit

struct TransferDiskSnapshot: Equatable {
    let generation: UUID
    let durableOffset: Int64
    let path: String
}
struct TransferPreparedUpload: Equatable {
    let generation: UUID
    let path: String
    let size: Int64
    let sha256: String
}
private final class TransferDiskFence: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UUID?
    func set(_ value: UUID?) { lock.lock(); generation = value; lock.unlock() }
    func check(_ value: UUID) throws { lock.lock(); defer { lock.unlock() }; guard generation == value else { throw transferDiskError("文件操作已经失效") } }
    func commit<T>(_ value: UUID, _ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard generation == value else { throw transferDiskError("文件操作已经失效") }
        return try body()
    }
}
private func transferDiskError(_ value: String) -> Error { NSError(domain: "OrbisTransferIO", code: 1, userInfo: [NSLocalizedDescriptionKey: value]) }

/// One instance per transfer. Independent downloads use independent actors; writes, truncation,
/// hashing, resume and final rename for the same .part file share one ordered owner. A callback
/// carries its generation and cannot publish progress for a cancelled/restarted transfer.
actor TransferDiskWorker {
    private let file: URL
    private let fence = TransferDiskFence()
    private var handle: FileHandle?
    private var expectedSize: Int64?
    private var openGeneration: UUID?
    init(file: URL) { self.file = file }
    nonisolated func setGeneration(_ value: UUID) { fence.set(value) }
    nonisolated func invalidate() { fence.set(nil) }
    deinit { try? handle?.close() }

    func resume(generation: UUID, expectedSize: Int64? = nil) throws -> TransferDiskSnapshot {
        try fence.check(generation)
        try closeHandle()
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: file.path) { guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw transferDiskError("下载临时文件无法创建") } }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = (attributes[.size] as? NSNumber)?.int64Value, size >= 0,
              expectedSize.map({ $0 >= size && $0 <= 9_007_199_254_740_991 }) != false else { throw transferDiskError("下载临时文件长度无效") }
        self.expectedSize = expectedSize
        handle = try FileHandle(forUpdating: file); openGeneration = generation
        return try fence.commit(generation) { TransferDiskSnapshot(generation: generation, durableOffset: size, path: file.path) }
    }

    func append(offset: Int64, bytes: Data, generation: UUID) throws -> TransferDiskSnapshot {
        try fence.check(generation)
        guard offset >= 0, offset <= 9_007_199_254_740_991, !bytes.isEmpty, bytes.count <= 1_048_576,
              Int64(bytes.count) <= 9_007_199_254_740_991 - offset,
              expectedSize.map({ offset + Int64(bytes.count) <= $0 }) != false else { throw transferDiskError("下载分片偏移或长度无效") }
        guard let handle else { throw transferDiskError("下载文件尚未打开") }
        let durable = try handle.seekToEnd()
        guard UInt64(offset) <= durable else { throw transferDiskError("下载分片尚未连续") }
        if UInt64(offset) < durable {
            guard UInt64(offset) + UInt64(bytes.count) <= durable else { throw transferDiskError("下载分片与已写范围重叠") }
            try handle.seek(toOffset: UInt64(offset))
            guard try handle.read(upToCount: bytes.count) == bytes else { throw transferDiskError("重复下载分片内容冲突") }
            return try fence.commit(generation) { TransferDiskSnapshot(generation: generation, durableOffset: Int64(durable), path: file.path) }
        }
        do {
            try handle.write(contentsOf: bytes)
            try handle.synchronize()
            return try fence.commit(generation) { TransferDiskSnapshot(generation: generation, durableOffset: offset + Int64(bytes.count), path: file.path) }
        } catch {
            // A cancelled write has no committed prefix. No new generation can mutate the file
            // until this actor finishes rollback, so truncation cannot erase a successor's data.
            try? handle.truncate(atOffset: durable)
            try? handle.synchronize()
            throw error
        }
    }

    func read(offset: Int64, length: Int, generation: UUID) throws -> Data {
        try fence.check(generation)
        guard offset >= 0, length > 0, length <= 1_048_576 else { throw transferDiskError("上传读取范围无效") }
        let reader = try FileHandle(forReadingFrom: file); defer { try? reader.close() }
        let size = try reader.seekToEnd()
        guard UInt64(offset) < size else { throw transferDiskError("上传读取偏移超出文件") }
        try reader.seek(toOffset: UInt64(offset))
        let bytes = try reader.read(upToCount: min(length, Int(size - UInt64(offset)))) ?? Data()
        guard !bytes.isEmpty else { throw transferDiskError("上传文件读取未推进") }
        return try fence.commit(generation) { bytes }
    }

    func truncate(to offset: Int64, generation: UUID) throws -> TransferDiskSnapshot {
        try fence.check(generation)
        guard offset >= 0, let handle else { throw transferDiskError("下载文件尚未打开") }
        let size = try handle.seekToEnd()
        guard UInt64(offset) <= size else { throw transferDiskError("下载截断偏移无效") }
        try fence.commit(generation) { try handle.truncate(atOffset: UInt64(offset)) }
        try handle.synchronize()
        return TransferDiskSnapshot(generation: generation, durableOffset: offset, path: file.path)
    }

    func finalize(size: Int64, sha256 expectedHash: String?, destination: URL, generation: UUID) throws -> TransferDiskSnapshot {
        try fence.check(generation)
        try handle?.synchronize(); try closeHandle()
        let inspected = try inspect(file, generation: generation)
        guard inspected.size == size, expectedHash.map({ $0.lowercased() == inspected.sha256 }) != false else { throw transferDiskError("下载长度或 SHA-256 校验失败") }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        return try fence.commit(generation) {
            guard !FileManager.default.fileExists(atPath: destination.path) else { throw transferDiskError("下载目标文件已存在") }
            try FileManager.default.moveItem(at: file, to: destination)
            return TransferDiskSnapshot(generation: generation, durableOffset: size, path: destination.path)
        }
    }

    /// Security-scoped input is copied and hashed in bounded chunks. A cancelled preparation
    /// removes only its own staging file; it cannot replace a newer generation's upload source.
    func prepareUpload(source: URL, generation: UUID, maximumBytes: Int64? = nil) throws -> TransferPreparedUpload {
        try fence.check(generation)
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = (attributes[.size] as? NSNumber)?.int64Value, size >= 0,
              maximumBytes.map({ size <= $0 }) != false else { throw transferDiskError("上传源文件格式或大小无效") }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let staging = file.deletingLastPathComponent().appendingPathComponent(file.lastPathComponent + ".prepare-" + UUID().uuidString)
        guard FileManager.default.createFile(atPath: staging.path, contents: nil) else { throw transferDiskError("上传缓存无法创建") }
        do {
            let input = try FileHandle(forReadingFrom: source), output = try FileHandle(forWritingTo: staging)
            defer { try? input.close(); try? output.close() }
            var hasher = SHA256(), copied: Int64 = 0
            while let bytes = try input.read(upToCount: 1_048_576), !bytes.isEmpty {
                try fence.check(generation)
                copied += Int64(bytes.count)
                guard copied <= size else { throw transferDiskError("上传源文件在复制期间改变") }
                hasher.update(data: bytes); try output.write(contentsOf: bytes)
            }
            guard copied == size else { throw transferDiskError("上传源文件在复制期间改变") }
            try output.synchronize()
            let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
            return try fence.commit(generation) {
                guard !FileManager.default.fileExists(atPath: file.path) else { throw transferDiskError("上传缓存已存在") }
                try FileManager.default.moveItem(at: staging, to: file)
                return TransferPreparedUpload(generation: generation, path: file.path, size: size, sha256: digest)
            }
        } catch { try? FileManager.default.removeItem(at: staging); throw error }
    }
    func pause(generation: UUID? = nil) throws {
        if let generation, openGeneration != generation { return }
        try closeHandle()
    }
    func remove(generation: UUID) throws {
        try fence.check(generation); try closeHandle()
        try fence.commit(generation) { if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) } }
    }
    private func closeHandle() throws { try handle?.close(); handle = nil; openGeneration = nil }
    private func inspect(_ url: URL, generation: UUID) throws -> TransferPreparedUpload {
        let reader = try FileHandle(forReadingFrom: url); defer { try? reader.close() }
        var hasher = SHA256(), size: Int64 = 0
        while let bytes = try reader.read(upToCount: 1_048_576), !bytes.isEmpty {
            try fence.check(generation); size += Int64(bytes.count); hasher.update(data: bytes)
        }
        return TransferPreparedUpload(generation: generation, path: url.path, size: size, sha256: hasher.finalize().map { String(format: "%02x", $0) }.joined())
    }
}

/// Task metadata has one root-scoped writer. Monotonic revisions prevent an older async save
/// from replacing a newer pause/remove/restart snapshot even when caller Tasks are scheduled out
/// of order. The .part file's length remains the resume authority, independently of this file.
actor TransferMetadataWorker {
    private let file: URL
    private var revision: UInt64 = 0
    init(file: URL) { self.file = file }
    func load(fallback: URL? = nil) throws -> Data? {
        if FileManager.default.fileExists(atPath: file.path) { return try Data(contentsOf: file) }
        if let fallback, FileManager.default.fileExists(atPath: fallback.path) { return try Data(contentsOf: fallback) }
        return nil
    }
    @discardableResult
    func save(_ data: Data, revision: UInt64) throws -> Bool {
        guard revision > self.revision else { return false }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
        self.revision = revision; return true
    }
}
