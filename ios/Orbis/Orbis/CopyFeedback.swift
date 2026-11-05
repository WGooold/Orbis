import Foundation
import Combine

/// M05: copy buttons and retained menu rows share the same cancellable success lifetime.
@MainActor
final class OrbisCopyFeedback: ObservableObject {
    static let durationNanoseconds: UInt64 = 2_500_000_000
    typealias Wait = @Sendable (UInt64) async throws -> Void

    @Published private(set) var copied = false
    private let wait: Wait
    private var reset: Task<Void, Never>?

    init(wait: @escaping Wait = { try await Task.sleep(nanoseconds: $0) }) {
        self.wait = wait
    }

    func perform(_ copy: () -> Void) {
        copy()
        reset?.cancel()
        copied = true
        let wait = wait
        reset = Task { @MainActor [weak self] in
            do { try await wait(Self.durationNanoseconds) }
            catch { return }
            guard !Task.isCancelled else { return }
            self?.copied = false
            self?.reset = nil
        }
    }

    func clear() {
        reset?.cancel()
        reset = nil
        copied = false
    }

    deinit { reset?.cancel() }
}
