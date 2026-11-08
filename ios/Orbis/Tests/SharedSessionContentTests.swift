import Foundation
import Testing
@testable import OrbisCore

/// FT-G07: Host, Android and iOS consume one contract fixture. Rehydration must
/// finish before storage/projection; a missing applied base requests recovery.
@Suite("FT-G07 shared session content")
struct SharedSessionContentTests {
    private func fixture() throws -> [String: Any] {
        let url = try #require(Bundle.module.url(forResource: "field-transport-session", withExtension: "json", subdirectory: "Fixtures"))
        return try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func json(_ value: Any) throws -> HostJSON {
        try JSONDecoder().decode(HostJSON.self, from: JSONSerialization.data(withJSONObject: value))
    }
    @Test func sharedBodiesAndUnicodeStreamMatchTheCompleteEvent() throws {
        let f = try fixture(), codec = SharedSessionContent()
        let wire = try #require(f["wireInitial"] as? [String: Any]), patch = try #require(f["wirePatch"] as? [String: Any])
        let initial = try codec.expand(wire, epoch: nil, seq: nil)
        #expect(try json(initial) == json(f["initial"]!))
        #expect(throws: (any Error).self) { try codec.expand(patch, epoch: "source", seq: 1) }
        codec.remember(try #require(initial["event"] as? [String: Any]), runtime: "runtime")
        let expanded = try codec.expand(patch, epoch: "source", seq: 1)
        #expect(try json(expanded) == json(f["patch"]!))
        #expect(throws: (any Error).self) { try codec.expand(patch, epoch: "source", seq: 2) }
        #expect(throws: (any Error).self) { try codec.expand(patch, epoch: "other", seq: 1) }
        codec.clear()
        #expect(throws: (any Error).self) { try codec.expand(patch, epoch: "source", seq: 1) }
    }
    @Test func invalidReferenceFailsBeforeChangingTheOriginal() throws {
        let f = try fixture(); var wire = try #require(f["wireInitial"] as? [String: Any])
        wire["sharedContent"] = ["format": "shared-v1", "references": [["path": ["missing"], "target": ["missing"]]]]
        #expect(throws: (any Error).self) { try SharedSessionContent().expand(wire, epoch: nil, seq: nil) }
        #expect(try json(f["wireInitial"]!)["event"]["live"]["messages"].array[0]["message"]["content"].array[0]["text"] == .string(""))
    }
    // Optional outcome is preserved by generic live projection, and an older
    // complete checkpoint without it continues to decode unchanged.
    @Test func optionalTurnOutcomeSurvivesSharedLiveRehydration() throws {
        let f = try fixture(), codec = SharedSessionContent()
        var wire = try #require(f["wireInitial"] as? [String: Any])
        var event = try #require(wire["event"] as? [String: Any])
        var live = try #require(event["live"] as? [String: Any])
        live["turn"] = ["turnId": "t1", "startedAt": 1, "durationMs": 10, "outcome": "completed"]
        event["live"] = live; wire["event"] = event
        let expanded = try codec.expand(wire, epoch: nil, seq: nil)
        #expect(try json(expanded)["event"]["live"]["turn"]["outcome"] == .string("completed"))
        #expect(try json(codec.expand(try #require(f["wireInitial"] as? [String: Any]), epoch: nil, seq: nil)) == json(f["initial"]!))
    }

}
