import XCTest
@testable import OrbisCore

final class AgentIdentityTests: XCTestCase {
    // AGENT-MARK-01: verify every known identity, including desktop aliases, has a
    // dedicated asset instead of inheriting legacy Pi or a generic terminal icon.
    func testKnownKindsUseTheirAgentAsset() {
        for (kind, asset) in [
            "pi": "AgentPi", "codex": "AgentCodex", "codexDesktop": "AgentCodex",
            "dsh": "AgentDeepSeek", "dshDesktop": "AgentDeepSeek", "claude": "AgentClaude",
            "kimiCode": "AgentKimi", "openclaw": "AgentOpenClaw", "hermes": "AgentHermes",
            "opencode": "AgentOpenCode",
        ] {
            XCTAssertEqual(AgentIdentity(kind: kind)?.assetName(dark: false), asset, kind)
        }
        XCTAssertEqual(AgentIdentity(kind: "opencode")?.assetName(dark: true), "AgentOpenCodeDark")
        XCTAssertEqual(AgentIdentity(kind: "kimiCode")?.original, true)
        XCTAssertEqual(AgentIdentity(kind: "opencode")?.original, true)
        XCTAssertNil(AgentIdentity(kind: "future-agent"))
    }
}
