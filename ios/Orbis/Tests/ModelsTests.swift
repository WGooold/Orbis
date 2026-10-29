import Foundation
import Testing
@testable import OrbisCore

@Suite("Wire model fidelity")
struct ModelsTests {
    @Test func chatRoundTripPreservesTruncationAndToolIdentity() throws {
        let wire = Data(#"{"messageId":"tool-result","role":"tool","content":[{"type":"text","text":"partial…","truncated":true,"originalBytes":100000}],"timestamp":1,"toolCallId":"call-1","toolName":"shell","isError":false}"#.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: wire)
        #expect(message.content.first?.truncated == true)
        #expect(message.content.first?.originalBytes == 100_000)
        #expect(message.toolCallId == "call-1")
        #expect(message.toolName == "shell")
        #expect(try JSONDecoder().decode(ChatMessage.self, from: JSONEncoder().encode(message)) == message)
        let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any])
        let content = try #require(encoded["content"] as? [[String: Any]])
        #expect(content.first?["truncated"] as? Bool == true)
        #expect(content.first?["originalBytes"] as? Int == 100_000)
        #expect(encoded["toolCallId"] as? String == "call-1")
        #expect(encoded["toolName"] as? String == "shell")
    }

    @Test func toolArgumentsRetainNestedValuesAndLargeIntegers() throws {
        let wire = Data(#"{"type":"tool_call","toolCallId":"call","toolName":"native","arguments":{"signed":-9223372036854775808,"unsigned":18446744073709551615,"fraction":1.25,"values":[true,false,null,"你好",{"id":9007199254740993}]}}"#.utf8)
        let content = try JSONDecoder().decode(ChatContent.self, from: wire)
        #expect(content.arguments == .object([
            "signed": .integer(Int64.min), "unsigned": .unsigned(UInt64.max), "fraction": .number(1.25),
            "values": .array([.bool(true), .bool(false), .null, .string("你好"), .object(["id": .integer(9_007_199_254_740_993)])])
        ]))
        #expect(try JSONDecoder().decode(ChatContent.self, from: JSONEncoder().encode(content)) == content)
    }

    @Test func legacyMessagesRemainReadableAndNullArgumentsRemainExplicit() throws {
        let legacy = try JSONDecoder().decode(ChatMessage.self, from: Data(#"{"messageId":"old","role":"assistant","content":[{"type":"text","text":"hello"}],"timestamp":0}"#.utf8))
        #expect(legacy.toolCallId == nil)
        #expect(legacy.toolName == nil)
        #expect(legacy.content.first?.truncated == nil)
        #expect(legacy.content.first?.arguments == nil)
        let explicit = try JSONDecoder().decode(ChatContent.self, from: Data(#"{"type":"tool_call","toolCallId":"c","toolName":"t","arguments":null}"#.utf8))
        #expect(explicit.arguments == .null)
        let encoded = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(explicit)) as? [String: Any])
        #expect(encoded["arguments"] is NSNull)
    }

    @Test func desktopAttachmentKeepsHostReasonAndValidatesKnownStates() throws {
        for state in ["unsupported", "notInstalled", "closed", "attached", "error"] {
            let attach = CodexDesktopAttach(state: state, reason: "电脑端提供的接入原因")
            #expect(attach.valid)
            #expect(try JSONDecoder().decode(CodexDesktopAttach.self, from: JSONEncoder().encode(attach)) == attach)
        }
        #expect(!CodexDesktopAttach(state: "ready", reason: "unknown state").valid)
        #expect(!CodexDesktopAttach(state: "error", reason: "").valid)
        #expect(!CodexDesktopAttach(state: "error", reason: String(repeating: "😀", count: 129)).valid)
    }

    @Test func interactionsPreserveHostToolName() throws {
        let request = try JSONDecoder().decode(InteractionRequest.self, from: Data(#"{"runtimeId":"runtime","requestId":"request","extensionId":"extension","kind":"confirm","title":"Approval","expiresAt":9999999999999,"toolName":"shell"}"#.utf8))
        #expect(request.toolName == "shell")
        #expect(try JSONDecoder().decode(InteractionRequest.self, from: JSONEncoder().encode(request)) == request)
    }
}
