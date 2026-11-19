import Foundation
import Testing
@testable import OrbisCore

@Suite("Voice text cleanup rules")
struct VoiceTextCleanupTests {
    @Test func removesOnlyClearFillerInterjections() {
        #expect(VoiceTextCleanupRules.clean("嗯，我想说，呃，明天上午十点开会。") == "我想说，明天上午十点开会。")
        #expect(VoiceTextCleanupRules.clean("Um, I think, uh, we should meet tomorrow.") == "I think, we should meet tomorrow.")
    }

    @Test func preservesMeaningfulText() {
        #expect(VoiceTextCleanupRules.clean("这是额外的内容。") == "这是额外的内容。")
        #expect(VoiceTextCleanupRules.clean("嗯？你刚才说什么？") == "嗯？你刚才说什么？")
        #expect(VoiceTextCleanupRules.clean("我就是这么想的。") == "我就是这么想的。")
    }

    @Test func customRequestTreatsTranscriptAsJSONData() throws {
        let config = VoiceCleanupAPIConfig(endpoint: "https://example.com/edit", model: "", key: "test-key",
            custom: .init(headers: #"{"x-api-key":"{{key}}"}"#, body: #"{"input":"{{transcript}}"}"#,
                          responsePath: "/content/0/text"))
        let transcript = "引号 \"\\\n{{model}}"
        let request = try VoiceTextCleanupAPI.makeRequest(config, text: transcript)
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "x-api-key") == "test-key")
        let body = try #require(request.httpBody)
        let parsed = try JSONSerialization.jsonObject(with: body) as? [String: String]
        #expect(parsed?["input"] == transcript)
        let output = try VoiceTextCleanupAPI.parseResponse(config, input: transcript,
            data: Data(#"{"content":[{"text":"保留原意。"}]}"#.utf8))
        #expect(output == "保留原意。")
    }

    @Test func defaultIsLocalAndInvalidAPIConfigurationFallsBack() async {
        let input = "嗯，明天见！"
        let local = await VoiceTextCleanupAPI.clean(input, config: nil)
        #expect(local == .init(text: "明天见！", method: .rules))
        let config = VoiceCleanupAPIConfig(endpoint: "http://example.com/edit", model: "test", key: "", custom: nil)
        #expect(!VoiceTextCleanupAPI.isValid(config))
        let fallback = await VoiceTextCleanupAPI.clean(input, config: config)
        #expect(fallback == .init(text: "明天见！", method: .apiFallback))
    }
}
