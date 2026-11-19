import Foundation
import Testing
import UniformTypeIdentifiers
@testable import OrbisCore

@Suite("OI-03 share representations")
struct ExternalShareSelectionTests {
    @Test func fileWinsOverTextFallback() throws {
        let type = try #require(UTType(filenameExtension: "pdf"))
        #expect(ExternalShareRepresentation.choose([UTType.plainText.identifier, type.identifier], suggestedName: "memo.pdf") == .file(type.identifier))
    }

    @Test func webUrlWinsOverTextAlternative() {
        #expect(ExternalShareRepresentation.choose([UTType.plainText.identifier, UTType.url.identifier], suggestedName: nil) == .link)
    }

    @Test func fileUrlIsNotMistakenForAWebLink() {
        #expect(ExternalShareRepresentation.choose([UTType.fileURL.identifier, UTType.url.identifier], suggestedName: "scan.pdf") == .fileURL)
    }

    @Test func genericDataWinsOverTextFallbackWhenNamedAsAFile() {
        #expect(ExternalShareRepresentation.choose([UTType.plainText.identifier, UTType.data.identifier], suggestedName: "archive.bin") == .file(UTType.data.identifier))
    }

    @Test func plainTextWithoutFileNameRemainsEditableText() {
        #expect(ExternalShareRepresentation.choose([UTType.plainText.identifier], suggestedName: nil) == .text)
    }

    @Test func documentFallbackRemainsAFile() {
        let type = UTType.data
        #expect(ExternalShareRepresentation.choose([type.identifier], suggestedName: "archive.bin") == .file(type.identifier))
    }
}
