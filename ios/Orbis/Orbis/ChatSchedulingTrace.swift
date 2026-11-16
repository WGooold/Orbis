import Foundation
import os

/// IOS-CHAT-06: opt-in Instruments events, including Release builds. The disabled
/// path performs only the signpost-enabled check: no clocks, counters or strings.
@MainActor
enum ChatSchedulingTrace {
    enum Region: Int {
        case navigation, page, header, transcript, composer, notices, workspace, row, markdown
    }

    /// Bit positions used by screenCommitEnded's invalidatedRegions argument.
    enum RegionMask {
        static let navigation = 1 << 0
        static let shell = 1 << 1
        static let header = 1 << 2
        static let transcript = 1 << 3
        static let composer = 1 << 4
        static let notices = 1 << 5
        static let workspace = 1 << 6
    }

    nonisolated private static let signposter = OSSignposter(subsystem: "com.orbis.app", category: .dynamicTracing)
    private static var bucketStarted: TimeInterval?
    private static var deltas = 0
    private static var transcriptCommits = 0
    private static var screenCommits = 0
    private static var pageBodyTokens = Set<UUID>()
    private static var pageArrivalToken: Int?
    private static var pageArrivalInterval: OSSignpostIntervalState?

    static func deltaBegan() -> OSSignpostIntervalState? {
        guard signposter.isEnabled else { return nil }
        count(delta: 1)
        return signposter.beginInterval("RemoteDelta", id: signposter.makeSignpostID())
    }

    static func deltaEnded(_ interval: OSSignpostIntervalState?) {
        guard let interval else { return }
        signposter.endInterval("RemoteDelta", interval)
    }

    static func transcriptCommitBegan() -> OSSignpostIntervalState? {
        guard signposter.isEnabled else { return nil }
        count(transcript: 1)
        return signposter.beginInterval("TranscriptCommit", id: signposter.makeSignpostID())
    }

    static func transcriptCommitEnded(_ interval: OSSignpostIntervalState?) {
        guard let interval else { return }
        signposter.endInterval("TranscriptCommit", interval)
    }

    static func nativeInputsBegan() -> OSSignpostIntervalState? {
        guard signposter.isEnabled else { return nil }
        return signposter.beginInterval("NativeTranscriptInputs", id: signposter.makeSignpostID())
    }

    static func nativeInputsEnded(_ interval: OSSignpostIntervalState?, rows: Int) {
        guard let interval else { return }
        signposter.endInterval("NativeTranscriptInputs", interval, "rows=\(rows)")
    }

    static func screenCommitBegan() -> OSSignpostIntervalState? {
        guard signposter.isEnabled else { return nil }
        count(screen: 1)
        return signposter.beginInterval("ChatScreenCommit", id: signposter.makeSignpostID())
    }

    static func screenCommitEnded(_ interval: OSSignpostIntervalState?, invalidatedRegions: Int) {
        guard let interval else { return }
        signposter.endInterval("ChatScreenCommit", interval, "regions=\(invalidatedRegions)")
    }

    /// Entrance timing markers for a chat page. These are opt-in Instruments events; the
    /// disabled path does not build identifiers or payload strings.
    static func pageOpenRequested(target: String) {
        guard signposter.isEnabled else { return }
        signposter.emitEvent("ChatPageOpenRequested", "target=\(target)")
    }

    static func pageBodyRendered(target: String, mountToken: UUID) {
        guard signposter.isEnabled, pageBodyTokens.insert(mountToken).inserted else { return }
        signposter.emitEvent("ChatPageFirstBody", "target=\(target) mount=\(mountToken.uuidString)")
    }

    static func pageArrive(token: Int, phase: String) {
        guard signposter.isEnabled else { return }
        if let previous = pageArrivalInterval {
            signposter.endInterval("ChatPageArriveToFirstIdle", previous, "superseded=true")
        }
        pageArrivalToken = token
        pageArrivalInterval = signposter.beginInterval("ChatPageArriveToFirstIdle", id: signposter.makeSignpostID())
        signposter.emitEvent("ChatPageArrive", "token=\(token) phase=\(phase)")
    }

    static func pageFirstIdleFrame(token: Int) {
        guard signposter.isEnabled else { return }
        signposter.emitEvent("ChatPageFirstIdleFrame", "token=\(token)")
        guard pageArrivalToken == token, let interval = pageArrivalInterval else { return }
        signposter.endInterval("ChatPageArriveToFirstIdle", interval)
        pageArrivalToken = nil
        pageArrivalInterval = nil
    }

    static func pageArrivalCancelled(token: Int) {
        guard signposter.isEnabled, pageArrivalToken == token, let interval = pageArrivalInterval else { return }
        signposter.endInterval("ChatPageArriveToFirstIdle", interval, "cancelled=true")
        pageArrivalToken = nil
        pageArrivalInterval = nil
    }

    static func nativeSnapshotBegan(rows: Int, reconfigured: Int) -> OSSignpostIntervalState? {
        guard signposter.isEnabled else { return nil }
        return signposter.beginInterval("NativeSnapshotCommit", id: signposter.makeSignpostID())
    }

    static func nativeSnapshotEnded(_ interval: OSSignpostIntervalState?, rows: Int, reconfigured: Int) {
        guard let interval else { return }
        signposter.endInterval("NativeSnapshotCommit", interval, "rows=\(rows) reconfigured=\(reconfigured)")
    }

    static func regionBody(_ region: Region) {
        guard signposter.isEnabled else { return }
        signposter.emitEvent("ChatRegionBody", "region=\(region.rawValue)")
    }

    static func replyHeightRetargeted(_ height: Double, animated: Bool) {
        guard signposter.isEnabled else { return }
        signposter.emitEvent("ReplyHeightRetarget", "height=\(height) animated=\(animated)")
    }

    /// Pair with settled-row draw probes before enabling IOS-CHAT-12.
    nonisolated static func markdownRowDrawn(base: Int, settled: @autoclosure () -> Bool) {
        guard signposter.isEnabled else { return }
        let isSettled = settled()
        signposter.emitEvent("MarkdownRowDraw", "base=\(base) settled=\(isSettled)")
    }

    private static func count(delta: Int = 0, transcript: Int = 0, screen: Int = 0) {
        let now = ProcessInfo.processInfo.systemUptime
        if let start = bucketStarted, now - start >= 1 {
            // Emit the elapsed window as well as raw counts. Sparse windows must
            // not be misrepresented as a one-second sampling interval.
            signposter.emitEvent("ChatRates",
                "seconds=\(now - start) deltas=\(deltas) transcriptCommits=\(transcriptCommits) screenCommits=\(screenCommits)")
            bucketStarted = now
            deltas = 0; transcriptCommits = 0; screenCommits = 0
        } else if bucketStarted == nil {
            bucketStarted = now
        }
        deltas += delta; transcriptCommits += transcript; screenCommits += screen
    }
}
