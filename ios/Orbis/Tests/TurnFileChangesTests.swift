import Foundation
import Testing
@testable import OrbisCore

@MainActor
struct TurnFileChangesTests {
    private let agent = ToolAgent(hostId: "host", agentKind: "codex", sessionId: "session")
    private var file: TurnFileMetadata {
        TurnFileMetadata(fileId: "f1", path: "src/VeryLongFeature.test.ts", oldPath: nil, changeKind: "modified", fileKind: "text", additions: 1, deletions: 1, beforeBytes: 4, afterBytes: 4, contentVersion: "content1", detail: "available")
    }
    private func summary(version: Int = 1, revision: Int = 1, files: [TurnFileMetadata]? = nil) -> TurnChangeSummary {
        let second = TurnFileMetadata(fileId: "f2", path: "README.md", oldPath: nil, changeKind: "added", fileKind: "text", additions: 1, deletions: 0, beforeBytes: nil, afterBytes: 4, contentVersion: "content2", detail: "available")
        let preview = files ?? [file, second]
        return TurnChangeSummary(projectionVersion: 1, agent: agent, reviewTurnId: "review", sourceTurnIds: ["native-turn"], changeSetId: "set", manifestVersion: version, revision: revision, anchorEntryId: "entry", startedAt: 1, finishedAt: 2, state: "ready", outcome: "completed", coverage: "complete", scope: "git-visible-files", attribution: "workspace-window", reasons: [], fileCount: preview.count, addedFiles: preview.filter { $0.changeKind == "added" }.count, modifiedFiles: 1, deletedFiles: 0, additions: 2, deletions: 1, preview: preview)
    }
    private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
    }
    private func detailPage(_ request: [String: Any], text: String, cursor: String? = nil, read: String = "read1") -> [String: Any] {
        var result = request
        result["type"] = "session.change.detail.page"; result["readId"] = read; result["text"] = text
        result["nextCursor"] = cursor as Any? ?? NSNull(); result["eof"] = cursor == nil
        result["cursor"] = nil; result["maxBytes"] = nil
        return result
    }
    private func receiveDetail(_ event: [String: Any], in changes: TurnFileChanges) async {
        await changes.consume(event, runtimeId: "runtime")
    }
    private func expired(_ request: [String: Any]) -> [String: Any] {
        ["type": "session.changes.failed", "requestId": request["requestId"]!, "runtimeId": "runtime", "reason": "expired"]
    }
    @Test func nativeToolMetadataExplainsCoverageAndRequiresExplicitDetailReads() async throws {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: [], turnIds: [])
        var raw = try object(summary())
        raw["attribution"] = "native-tool"; raw["scope"] = "native-file-tools"; raw["coverage"] = "partial"
        raw["reasons"] = ["native-file-tools-only"]
        await changes.consume(["type": "session.changes.updated", "summary": raw], runtimeId: "runtime")
        let native = try #require(changes.summaries["set"])
        #expect(turnChangeCoverageNote(native) == "仅记录 Codex 文件工具变更")
        #expect(turnChangeScopeTitle(native.scope) == "范围：Codex 文件工具")
        #expect(sent.isEmpty)
        raw["coverage"] = "complete"; raw["revision"] = 2
        await changes.consume(["type": "session.changes.updated", "summary": raw], runtimeId: "runtime")
        #expect(changes.summaries["set"] == native)
        changes.open(native)
        #expect(sent.last?["type"] as? String == "session.change.detail.read")
        changes.clear()
    }
    @Test func expiredLeaseReopensAtTheSameCursorWithoutLosingContentOrPosition() async {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: [], turnIds: [])
        changes.open(summary())
        await receiveDetail(detailPage(sent.last!, text: "@@ -1 +1 @@\n-old\n+new\n", cursor: "immutable-next"), in: changes)
        changes.rememberScroll(2, file: file)
        changes.loadNext(); let old = sent.last!; let count = sent.count
        await changes.consume(expired(old), runtimeId: "runtime")
        #expect(sent.count == count + 1)
        let reopened = sent.last!
        #expect(reopened["readId"] is NSNull)
        #expect(reopened["requestId"] as? String != old["requestId"] as? String)
        for key in ["viewerId", "changeSetId", "fileId", "contentVersion", "cursor"] {
            #expect(reopened[key] as? String == old[key] as? String)
        }
        #expect(reopened["manifestVersion"] as? Int == old["manifestVersion"] as? Int)
        #expect(changes.currentDetail.lines.count == 3)
        #expect(changes.currentDetail.scrollLine == 2)
        await receiveDetail(detailPage(old, text: "stale"), in: changes)
        #expect(changes.currentDetail.lines.count == 3)
        await receiveDetail(detailPage(reopened, text: " context\n", read: "renewed-read"), in: changes)
        #expect(changes.currentDetail.lines.count == 4)
        #expect(changes.currentDetail.readId == "renewed-read")
        #expect(changes.currentDetail.scrollLine == 2)
        changes.clear()
    }
    @Test func expiredReopenStopsAfterOneAttemptAndCannotRestartAnotherViewer() async {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: [], turnIds: [])
        changes.open(summary())
        await receiveDetail(detailPage(sent.last!, text: " cached\n", cursor: "next"), in: changes)
        changes.loadNext(); await changes.consume(expired(sent.last!), runtimeId: "runtime")
        let reopened = sent.last!; let count = sent.count
        await changes.consume(expired(reopened), runtimeId: "runtime")
        #expect(sent.count == count)
        #expect(changes.currentDetail.error == turnChangeFailureTitle("expired"))
        #expect(changes.currentDetail.lines.map(\.text) == [" cached"])
        #expect(changes.currentDetail.nextCursor == "next")
        changes.loadNext(); let late = sent.last!
        changes.open(summary(version: 2)); let afterSwitch = sent.count
        await changes.consume(expired(late), runtimeId: "runtime")
        #expect(sent.count == afterSwitch)
        #expect(changes.opened?.manifestVersion == 2)
        #expect(changes.currentDetail.lines.isEmpty)
        changes.clear()
    }
    @Test func everyPageEnforcesTotalBudgetAndPreservesTheSelectedAndMostRecentFiles() async {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: [], turnIds: [])
        let third = TurnFileMetadata(fileId: "f3", path: "Third.swift", oldPath: nil, changeKind: "added", fileKind: "text", additions: 1, deletions: 0, beforeBytes: nil, afterBytes: 4, contentVersion: "content3", detail: "available")
        let files = summary().preview + [third]
        changes.open(summary(files: files))
        let page = String(repeating: "x", count: 32_767) + "\n"
        func fillSelectedFile(_ id: String) async {
            for index in 0..<96 {
                if index > 0 { changes.loadNext() }
                await receiveDetail(detailPage(sent.last!, text: page, cursor: "\(id)-\(index)", read: "read-\(id)"), in: changes)
                #expect(changes.details.values.reduce(0) { $0 + $1.bytes } <= 8 * 1024 * 1024)
            }
        }
        await fillSelectedFile("f1"); changes.rememberScroll(2, file: file)
        changes.selectFile("f2"); await fillSelectedFile("f2")
        changes.selectFile("f1")
        #expect(changes.currentDetail.scrollLine == 2)
        changes.selectFile("f3"); changes.rememberScroll(1, file: third); await fillSelectedFile("f3")
        #expect(changes.detail(for: file).bytes == 3 * 1024 * 1024)
        #expect(changes.detail(for: file).scrollLine == 2)
        #expect(changes.detail(for: files[1]).bytes == 0)
        #expect(changes.currentDetail.bytes == 3 * 1024 * 1024)
        #expect(changes.currentDetail.scrollLine == 1)
        changes.clear()
    }
    @Test func aPageThatExceedsTheSingleFileLimitIsNotAppendedOrRetried() async {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: [], turnIds: [])
        changes.open(summary())
        let page = String(repeating: "x", count: 32_767) + "\n"
        for index in 0..<256 {
            if index > 0 { changes.loadNext() }
            let text = index == 255 ? String(page.dropFirst()) : page
            await receiveDetail(detailPage(sent.last!, text: text, cursor: "next-\(index)"), in: changes)
        }
        changes.rememberScroll(255, file: file)
        let before = changes.currentDetail
        #expect(before.bytes == 8 * 1024 * 1024 - 1)
        changes.loadNext()
        await receiveDetail(detailPage(sent.last!, text: "+x\n"), in: changes)
        #expect(changes.currentDetail.bytes == before.bytes)
        #expect(changes.currentDetail.lines == before.lines)
        #expect(changes.currentDetail.nextCursor == before.nextCursor)
        #expect(changes.currentDetail.scrollLine == 255)
        #expect(changes.currentDetail.limitReached)
        #expect(changes.currentDetail.error?.contains("8 MiB") == true)
        let count = sent.count; changes.loadNext()
        #expect(sent.count == count)
        changes.clear()
    }
    @Test func delayedSummaryListCannotReplaceCompletedMetadata() async throws {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: ["entry"], turnIds: [])
        let ready = summary(revision: 3)
        await changes.consume(["type": "session.changes.updated", "summary": try object(ready)], runtimeId: "runtime")
        var collecting = try object(summary(revision: 2))
        collecting["state"] = "collecting"; collecting["anchorEntryId"] = NSNull(); collecting["finishedAt"] = NSNull()
        var delayedList = sent[0]
        delayedList["type"] = "session.changes.summaries"; delayedList["summaries"] = [collecting]; delayedList["nextCursor"] = NSNull()
        await changes.consume(delayedList, runtimeId: "runtime")
        #expect(changes.summaries["set"] == ready)
        let worker = TurnChangeBackgroundWorker()
        let query = TurnChangeSummaryQuery(owner: UUID(), revision: changes.summaryRevision, anchors: ["entry"])
        #expect(await worker.matching(query, summaries: changes.summaries, agent: changes.summaryProjectionAgent) == [ready])

        let revised = summary(revision: 4)
        await changes.consume(["type": "session.changes.updated", "summary": try object(revised)], runtimeId: "runtime")
        #expect(changes.summaries["set"] == revised)
        await changes.consume(["type": "session.changes.updated", "summary": try object(summary(version: 0, revision: 5))], runtimeId: "runtime")
        #expect(changes.summaries["set"] == revised)
        await changes.consume(["type": "session.changes.updated", "summary": try object(ready)], runtimeId: "runtime")
        #expect(changes.summaries["set"] == revised)
        changes.clear()
    }
    @Test func summaryRequiresNonnegativeRevision() async throws {
        let changes = TurnFileChanges()
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: [], turnIds: [])
        var missing = try object(summary()); missing["revision"] = nil
        await changes.consume(["type": "session.changes.updated", "summary": missing], runtimeId: "runtime")
        #expect(changes.summaries.isEmpty)
        await changes.consume(["type": "session.changes.updated", "summary": try object(summary(revision: -1))], runtimeId: "runtime")
        #expect(changes.summaries.isEmpty)
        await changes.consume(["type": "session.changes.updated", "summary": try object(summary(revision: 0))], runtimeId: "runtime")
        #expect(changes.summaries["set"]?.revision == 0)
        changes.clear()
    }
    @Test func metadataAndAdjacentPagesNeverFetchDetails() async throws {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: ["entry"], turnIds: [])
        await changes.consume(["type": "session.changes.updated", "summary": try object(summary())], runtimeId: "runtime")
        let worker = TurnChangeBackgroundWorker()
        let query = TurnChangeSummaryQuery(owner: UUID(), revision: changes.summaryRevision, anchors: ["entry"])
        #expect(await worker.matching(query, summaries: changes.summaries, agent: changes.summaryProjectionAgent).count == 1)
        let noAnchor = TurnChangeSummaryQuery(owner: query.owner, revision: query.revision, anchors: [])
        #expect(await worker.matching(noAnchor, summaries: changes.summaries, agent: changes.summaryProjectionAgent).isEmpty)
        await worker.removeSummaryQueries(owner: query.owner)
        #expect(await worker.matching(query, summaries: [:], agent: nil).isEmpty)
        _ = changes.manifest(summary()); changes.loadFiles(summary())
        #expect(sent.allSatisfy { $0["type"] as? String != "session.change.detail.read" })
        changes.open(summary())
        let count = sent.filter { $0["type"] as? String == "session.change.detail.read" }.count
        _ = changes.viewerFiles.map { changes.detail(for: $0) }
        #expect(sent.filter { $0["type"] as? String == "session.change.detail.read" }.count == count)
        #expect(count == 1)
        changes.clear()
    }
    @Test func swipingCancelsAndIgnoresLateResponsesThenReusesVisitedRanges() async throws {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: ["entry"], turnIds: [])
        changes.open(summary()); let first = sent.last!
        await receiveDetail(detailPage(first, text: "@@ -1 +1 @@\n-old\n+new\n", cursor: "next"), in: changes)
        changes.rememberScroll(2, file: file)
        changes.loadNext(); let stale = sent.last!
        changes.selectFile("f2")
        #expect(sent.contains { $0["type"] as? String == "session.change.detail.cancel" })
        await receiveDetail(detailPage(stale, text: "bad"), in: changes)
        #expect(changes.currentDetail.lines.isEmpty)
        let reads = sent.filter { $0["type"] as? String == "session.change.detail.read" }.count
        changes.selectFile("f1")
        #expect(changes.currentDetail.lines.count == 3)
        #expect(changes.currentDetail.scrollLine == 2)
        #expect(sent.filter { $0["type"] as? String == "session.change.detail.read" }.count == reads)
        changes.loadNext()
        #expect(sent.last?["cursor"] as? String == "next")
        #expect(sent.last?["readId"] is NSNull)
        changes.clear()
    }
    @Test func scopeVersionAndViewerAreChecked() async throws {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: ["entry"], turnIds: [])
        changes.open(summary()); let request = sent.last!
        var wrong = detailPage(request, text: "wrong")
        wrong["contentVersion"] = "different"
        await receiveDetail(wrong, in: changes)
        #expect(changes.currentDetail.lines.isEmpty)
        wrong = detailPage(request, text: "wrong"); wrong["viewerId"] = "another"
        await receiveDetail(wrong, in: changes)
        #expect(changes.currentDetail.lines.isEmpty)
        await changes.consume(["type": "session.changes.updated", "summary": try object(summary(version: 2))], runtimeId: "runtime")
        #expect(changes.newerVersionAvailable)
        #expect(changes.opened?.manifestVersion == 1)
        changes.observe(runtimeId: "runtime", agent: ToolAgent(hostId: "host", agentKind: "codex", sessionId: "different"), entryIds: [], turnIds: [])
        await receiveDetail(detailPage(request, text: "stale"), in: changes)
        #expect(changes.opened == nil); #expect(changes.details.isEmpty)
        changes.clear()
    }
    @Test func backgroundSuspendsWithoutAutomaticContinuation() async {
        let changes = TurnFileChanges(); var sent: [[String: Any]] = []
        changes.send = { _, value in sent.append(value); return true }
        changes.observe(runtimeId: "runtime", agent: agent, entryIds: [], turnIds: [])
        changes.open(summary()); let request = sent.last!
        changes.suspend(); let count = sent.count
        await receiveDetail(detailPage(request, text: "late"), in: changes)
        changes.loadNext()
        #expect(changes.suspended); #expect(sent.count == count); #expect(changes.currentDetail.lines.isEmpty)
        changes.resume(); #expect(sent.count == count + 1)
        changes.clear()
    }
    @Test func parserPreservesHunksSplitLinesCRLFAndNoNewlineMarker() {
        var parser = UnifiedDiffParser()
        parser.append("--- a/file\n+++ b/file\n@@ -2,2 +4,2 @@\n con", eof: false)
        parser.append("text\r\n-old\n+新", eof: false)
        #expect(parser.lines.last?.text == "-old")
        parser.append("\n\\ No newline at end of file\n@@ -9 +10 @@\n-x\n+y", eof: true)
        #expect(parser.lines.first(where: { $0.kind == .context })?.text == " context\r")
        #expect(parser.lines.first(where: { $0.kind == .context })?.oldLine == 2)
        #expect(parser.lines.first(where: { $0.kind == .context })?.newLine == 4)
        #expect(parser.lines.first(where: { $0.kind == .addition })?.newLine == 5)
        #expect(parser.lines.last?.newLine == 10)
        #expect(parser.lines.filter { $0.kind == .note }.count == 1)
        #expect(parser.maxLineNumber == 10)
    }
    @Test func parserBoundsLongLineFragmentsWithoutLosingText() {
        var parser = UnifiedDiffParser()
        let long = "+" + String(repeating: "字", count: 20_000)
        parser.append("@@ -0,0 +1 @@\n" + long, eof: false)
        #expect(parser.lines.count > 2)
        parser.append("\n", eof: true)
        #expect(parser.lines.dropFirst().map(\.text).joined() == long)
        #expect(parser.lines.filter { $0.newLine == 1 }.count == 1)
        // Only the first fragment carries the marker and number; the viewer must not strip later fragments.
        #expect(parser.lines.dropFirst().first?.continuation == false)
        #expect(parser.lines.dropFirst(2).allSatisfy { $0.continuation })
    }
    @Test func extensionPartsPreserveCompoundNamesAndUnicode() {
        #expect(reviewFileNameParts("very-long-module.d.ts").ext == ".d.ts")
        #expect(reviewFileNameParts("archive.tar.gz").ext == ".tar.gz")
        #expect(reviewFileNameParts("👩🏽‍💻模块.swift").stem == "👩🏽‍💻模块")
        #expect(reviewFileNameParts(".gitignore").ext.isEmpty)
        #expect(reviewFileNameParts("file.").ext.isEmpty)
        #expect(reviewFileNameParts(".config.json").ext == ".json")
    }
}
