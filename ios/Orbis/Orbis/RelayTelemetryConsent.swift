import Foundation

private final class RelayTelemetryRedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum RelayTelemetryConsent {
    /// `nil` means the Relay does not implement the consent endpoint yet.
    static func read(_ relay: RelayCredential) async throws -> Bool? {
        try await request(relay, method: "GET", enabled: nil)
    }

    /// `nil` means the Relay does not implement the consent endpoint yet.
    static func write(_ relay: RelayCredential, enabled: Bool) async throws -> Bool? {
        try await request(relay, method: "PUT", enabled: enabled)
    }

    private static func request(_ relay: RelayCredential, method: String, enabled: Bool?) async throws -> Bool? {
        guard let url = RelayURL.endpoint(relay.relayUrl, path: "v1/device/telemetry-consent", webSocket: false) else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.setValue("Bearer \(relay.credential)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let enabled {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["enabled": enabled])
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let blocker = RelayTelemetryRedirectBlocker()
        let session = URLSession(configuration: configuration, delegate: blocker, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if response.statusCode == 404 { return nil }
        guard (200..<300).contains(response.statusCode),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["enabled"] as? Bool else {
            throw URLError(.badServerResponse)
        }
        return value
    }
}
