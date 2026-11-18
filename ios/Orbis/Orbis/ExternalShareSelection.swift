import Foundation
import UniformTypeIdentifiers

/// An item provider can offer several representations of the same item. Pick only one.
enum ExternalShareRepresentation: Equatable {
    case file(String), fileURL, link, text

    static func choose(_ identifiers: [String], suggestedName: String?) -> Self? {
        let types = identifiers.compactMap(UTType.init)
        if types.contains(.fileURL) { return .fileURL }
        // Prefer a supplied document over caption or webpage alternatives.
        let ext = ((suggestedName as NSString?)?.pathExtension ?? "").lowercased()
        let fileTypes = types.filter { $0.conforms(to: .data) && !$0.conforms(to: .url) && $0 != .webArchive }
        if !ext.isEmpty {
            let namedType = UTType(filenameExtension: ext)
            if let matchingFile = fileTypes.first(where: { type in
                type.preferredFilenameExtension?.lowercased() == ext
                    || namedType.map { type.conforms(to: $0) } == true
            }) {
                return .file(matchingFile.identifier)
            }
        }
        if let formattedFile = fileTypes.first(where: { !$0.conforms(to: .text) && (!ext.isEmpty || $0.preferredFilenameExtension != nil) }) {
            return .file(formattedFile.identifier)
        }
        if types.contains(.url) { return .link }
        if types.contains(where: { $0.conforms(to: .plainText) || $0 == .text }) { return .text }
        if let type = fileTypes.first {
            return .file(type.identifier)
        }
        return nil
    }
}
