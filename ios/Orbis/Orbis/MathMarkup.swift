import Foundation
import JavaScriptCore

struct MathMarkup {
    let text: String
    let prefix: String
    let tokens: [(marker: String, raw: String)]
    let value: [String: Any]
    var bypass: Bool { value["bypass"] as? Bool == true }

    func restore(_ text: String) -> String {
        tokens.reduce(text) { $0.replacingOccurrences(of: $1.marker, with: $1.raw) }
    }
    func restore(_ value: AttributedString) -> AttributedString {
        var result = AttributedString()
        for run in value.runs {
            result.append(AttributedString(restore(String(value[run.range].characters)), attributes: run.attributes))
        }
        return result
    }
}

enum MathResources {
    static var root: URL? {
        #if SWIFT_PACKAGE
        Bundle.module.url(forResource: "MathResources", withExtension: nil)
        #else
        Bundle.main.url(forResource: "MathResources", withExtension: nil)
        #endif
    }
}

/// Shared ES5 scanner runs under the existing Markdown worker, never in View.body.
/// JavaScriptCore access is serialized even when independent test workers call it.
final class MathMarkupEngine: @unchecked Sendable {
    static let shared = MathMarkupEngine()
    private let lock = NSLock()
    private var context: JSContext?
    /// Why the engine fell back to plain text; shown by the tests so a broken runner says so.
    private(set) var diagnosis = ""

    private func call(_ method: String, _ arguments: [Any]) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        if context == nil {
            diagnose("")
            guard let root = MathResources.root else { diagnose("缺少 MathResources 资源包"); return nil }
            let url = root.appendingPathComponent("core.js")
            guard let source = try? String(contentsOf: url, encoding: .utf8) else {
                diagnose("读不到 \(url.path)"); return nil
            }
            guard let next = JSContext() else { diagnose("JavaScriptCore 不可用"); return nil }
            next.evaluateScript(source)
            if let exception = next.exception {
                diagnose("core.js 抛出 \(exception)"); return nil
            }
            context = next
        }
        guard let context else { return nil }
        context.exception = nil
        let result = context.objectForKeyedSubscript("OrbisMath")?.invokeMethod(method, withArguments: arguments)
        guard context.exception == nil else { context.exception = nil; return nil }
        // Convert inside the lock: JSValue must not cross into another worker.
        return result?.toDictionary() as? [String: Any]
    }

    private func diagnose(_ reason: String) {
        diagnosis = reason
    }

    func protect(_ text: String) -> MathMarkup? {
        guard text.contains("$") || text.contains(#"\("#) || text.contains(#"\["#)
                || text.contains(#"\begin{"#) || text.contains("math") else { return nil }
        guard let value = call("protect", [text]),
              let transformed = value["text"] as? String, let prefix = value["prefix"] as? String,
              let tokens = value["tokens"] as? [[String: Any]] else {
            return MathMarkup(text: text, prefix: "", tokens: [],
                              value: ["bypass": true, "bypassReason": diagnosis.isEmpty ? "引擎没有返回结果" : diagnosis])
        }
        return MathMarkup(text: transformed, prefix: prefix, tokens: tokens.compactMap {
            guard let marker = $0["marker"] as? String, let raw = $0["raw"] as? String else { return nil }
            return (marker, raw)
        }, value: value)
    }

    func html(_ text: AttributedString, prepared: MathMarkup) -> String? {
        guard !prepared.bypass, String(text.characters).contains(prepared.prefix) else { return nil }
        let runs: [[String: Any]] = text.runs.map { run in
            let intent = run.inlinePresentationIntent ?? []
            var result: [String: Any] = [
                "text": String(text[run.range].characters),
                "bold": intent.contains(.stronglyEmphasized),
                "italic": intent.contains(.emphasized),
                "strike": intent.contains(.strikethrough),
                "code": intent.contains(.code),
            ]
            if let link = run.link { result["link"] = link.absoluteString }
            return result
        }
        guard let value = call("inlineHTML", [runs, prepared.value]),
              value["hasMath"] as? Bool == true else { return nil }
        return value["html"] as? String
    }
}
