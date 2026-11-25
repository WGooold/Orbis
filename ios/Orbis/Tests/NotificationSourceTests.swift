import Foundation
import XCTest
@testable import OrbisCore

final class NotificationSourceTests: XCTestCase {
    // SC111/112: duplicate names and truncation must not make two computers
    // indistinguishable, regardless of pairing order or another phone's labels.
    func testSourcesDisambiguateNamesAndShortFormsStably() throws {
        let inputs = [NotificationSource.Input(hostId: "one", name: "Mac mini", pairingKey: "p1"),
                      .init(hostId: "two", name: "Mac mini", pairingKey: "p2"),
                      .init(hostId: "three", name: "工作电脑", pairingKey: "p3")]
        let sources = NotificationSource.make(inputs, language: "zh-Hans")
        XCTAssertEqual(sources, NotificationSource.make(inputs.reversed(), language: "zh-Hans"))
        XCTAssertNotEqual(sources["one"]?.name, sources["two"]?.name)
        XCTAssertNotEqual(sources["one"]?.compactName, sources["two"]?.compactName)
        XCTAssertNotEqual(sources["one"]?.badge, sources["two"]?.badge)
        XCTAssertEqual(sources["three"]?.name, "工作电脑")
        XCTAssertEqual(sources["three"]?.badge, "工作")
        let prefixes = NotificationSource.make([.init(hostId: "a", name: "Office computer 1", pairingKey: "p1"),
                                               .init(hostId: "b", name: "Office computer 2", pairingKey: "p2")], language: "en")
        XCTAssertNotEqual(prefixes["a"]?.compactName, prefixes["b"]?.compactName)
        XCTAssertNotEqual(prefixes["a"]?.badge, prefixes["b"]?.badge)
        // Keep disambiguation visible even when the system truncates a long
        // notification title, and don't split a Chinese grapheme in the island.
        let longName = String(repeating: "工作电脑", count: 25)
        let long = NotificationSource.make([.init(hostId: "a", name: longName, pairingKey: "a"),
                                           .init(hostId: "b", name: longName, pairingKey: "b")], language: "zh-Hans")
        XCTAssertNotEqual(long["a"]?.name.prefix(4), long["b"]?.name.prefix(4))
        XCTAssertEqual(sources["three"]?.compactName.count, 4)
    }

    // The extension never needs the private pairing or a network request. A
    // removal replaces the directory atomically, with a readable local fallback.
    func testDirectoryRoundTripRemovalAndPrivateDataBoundary() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        var directory = NotificationSourceDirectory(language: "en", hosts: NotificationSource.make([
            .init(hostId: "host", name: "Work Mac", pairingKey: "opaque-fingerprint")], language: "en"))
        try directory.write(to: url)
        XCTAssertEqual(NotificationSourceDirectory.read(from: url), directory)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["language", "hosts"])
        let hosts = try XCTUnwrap(json["hosts"] as? [String: [String: String]])
        XCTAssertEqual(Set(hosts["host"]!.keys), ["name", "compactName", "badge", "pairingKey"])
        let payload: [AnyHashable: Any] = ["orbis": ["v": 1, "hostId": "host", "category": "approval-requested", "eventId": "same"]]
        XCTAssertEqual(directory.alert(payload)?.title, "Work Mac")
        XCTAssertEqual(directory.alert(payload)?.body, "Interaction needed")
        directory.hosts = [:]; try directory.write(to: url)
        let removed = try XCTUnwrap(NotificationSourceDirectory.read(from: url))
        XCTAssertTrue(try XCTUnwrap(removed.alert(payload)?.title).hasPrefix("Computer "))
        XCTAssertNil(removed.alert(["orbis": ["v": 2, "hostId": "host", "category": "approval-requested"]]))
        try Data("broken".utf8).write(to: url)
        XCTAssertNil(NotificationSourceDirectory.read(from: url))
    }

    // Host grouping is independent from event/session IDs, while the wire and
    // local representations use the same SHA256 namespacing contract.
    func testGroupingAndFallbackDoNotExposeRawHostIdentifiers() {
        XCTAssertNotEqual(NotificationSource.threadIdentifier("one"), NotificationSource.threadIdentifier("two"))
        XCTAssertEqual(NotificationSource.threadIdentifier("host"),
            "orbis.host.4740ae6347b0172c01254ff55bae5aff5199f4446e7f6d643d40185b3f475145")
        let source = NotificationSource.fallback(hostId: "private-host-identifier", language: "zh-Hans")
        XCTAssertTrue(source.name.hasPrefix("电脑 "))
        XCTAssertFalse(source.name.contains("private-host-identifier"))
        XCTAssertEqual(source.badge.count, 4)
    }
}
