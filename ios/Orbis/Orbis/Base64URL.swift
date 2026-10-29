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
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ value: String, label: String = "value") throws -> Data {
        // One pass over the UTF-8 bytes: frames carry large base64url payloads, and per-scalar
        // CharacterSet lookups, Character counting and string replacement kept the main thread
        // busy while a session loaded.
        var bytes = Array(value.utf8)
        guard !bytes.isEmpty, bytes.count % 4 != 1 else { throw Base64URLError.malformed(label) }
        for index in bytes.indices {
            switch bytes[index] {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "0")...UInt8(ascii: "9"): continue
            case UInt8(ascii: "-"): bytes[index] = UInt8(ascii: "+")
            case UInt8(ascii: "_"): bytes[index] = UInt8(ascii: "/")
            default: throw Base64URLError.malformed(label)
            }
        }
        bytes.append(contentsOf: repeatElement(UInt8(ascii: "="), count: (4 - bytes.count % 4) % 4))
        guard let data = Data(base64Encoded: Data(bytes)) else { throw Base64URLError.malformed(label) }
        return data
    }

    static func decodeFixed(_ value: String, bytes: Int, label: String) throws -> Data {
        let data = try decode(value, label: label)
        guard data.count == bytes else { throw Base64URLError.invalidLength(label, bytes) }
        return data
    }
}
