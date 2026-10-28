import Foundation

enum Base64URLError: LocalizedError {
    case malformed(String)
    case invalidLength(String, Int)
    var errorDescription: String? {
        switch self {
        case .malformed(let label): return "\(label) 不是合法的 base64url"
        case .invalidLength(let label, let bytes): return "\(label) 必须是 \(bytes) 字节"
        }
    }
}

enum Base64URL {
    private static let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")

    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ value: String, label: String = "value") throws -> Data {
        guard !value.isEmpty, value.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw Base64URLError.malformed(label)
        }
        guard value.count % 4 != 1 else { throw Base64URLError.malformed(label) }
        var padded = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
        guard let data = Data(base64Encoded: padded) else { throw Base64URLError.malformed(label) }
        return data
    }

    static func decodeFixed(_ value: String, bytes: Int, label: String) throws -> Data {
        let data = try decode(value, label: label)
        guard data.count == bytes else { throw Base64URLError.invalidLength(label, bytes) }
        return data
    }
}
