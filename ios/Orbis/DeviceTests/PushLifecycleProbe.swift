#if DEBUG
import SwiftUI
import UserNotifications
import Combine

/// APNS-L13: simulator-only install/reinstall evidence. The runner stages a
/// separate app ID and random Keychain namespace; normal Orbis cannot enable it.
enum PushLifecycleProbe {
    static let bundleId = "com.orbising.orbis.pushqa"
    static var phase: String? {
        guard Bundle.main.bundleIdentifier == bundleId else { return nil }
        return ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--push-lifecycle-probe=") }
            .map { String($0.dropFirst("--push-lifecycle-probe=".count)) }
    }
    static var scope: String {
        let value = ProcessInfo.processInfo.arguments.first { $0.hasPrefix("--push-probe-scope=") }
            .map { String($0.dropFirst("--push-probe-scope=".count)) } ?? "missing"
        return "orbis.pushqa." + value.filter { $0.isLetter || $0.isNumber || $0 == "-" }
    }
    @MainActor static func run() async -> String {
        var result: [String: Any] = ["phase": phase ?? "missing", "bundleId": Bundle.main.bundleIdentifier ?? ""]
        do {
            let storage = SecureStore(testNamespace: scope)
            let host = HostPairing(hostId: "push-qa-host", hostName: "Push QA", hostPub: "public-fixture", pskRoot: "fixture-root",
                relay: RelayCredential(relayUrl: "wss://push.invalid", deviceId: "push-qa-device", credential: "synthetic-credential"), lan: [])
            if phase == "seed" {
                try storage.savePairings([host])
                try storage.savePendingPushRemovals([PushRegistrationTarget(host)])
                UserDefaults.standard.set("installed", forKey: "push-qa-container-marker")
                result["notificationPermissionGranted"] = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .provisional])
            }
            result["identityPublic"] = try storage.deviceIdentity().publicText
            result["pairingCount"] = storage.pairings().count
            result["pendingRemovalCount"] = try storage.pendingPushRemovals().count
            result["containerMarker"] = UserDefaults.standard.string(forKey: "push-qa-container-marker") as Any? ?? NSNull()
            if phase == "inspect" {
                var requests: [URLRequest] = []
                let state = PushRegistrationCoordinator(environment: "sandbox", send: { requests.append($0); return 204 })
                state.updatePairings(storage.pairings()); state.setAuthorizationAllowed(true); state.refresh()
                try await Task.sleep(nanoseconds: 30_000_000)
                result["registrationsBeforeFreshToken"] = requests.count
                state.receiveToken(String(repeating: "b", count: 64))
                for _ in 0..<100 where requests.isEmpty { try await Task.sleep(nanoseconds: 5_000_000) }
                result["registrationsAfterFreshToken"] = requests.count
                state.shutdown()
            }
            if phase == "collect" {
                let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
                let matching = delivered.filter { ($0.request.content.userInfo["orbis"] as? [String: Any])?["eventId"] as? String == "simulator-push-lifecycle" }
                result["deliveredFixtureCount"] = matching.count
                if let notification = matching.first {
                    // Queue before subscribing, as happens on a cold notification open.
                    let queue = PushNotificationOpenQueue()
                    queue.receive(notification.request.content.userInfo)
                    var observed: String?
                    let subscription = queue.publisher.sink { observed = $0 }
                    result["coldOpenHost"] = observed as Any? ?? NSNull()
                    subscription.cancel()
                }
            }
            if phase == "cleanup" {
                storage.clearPushTestingNamespace()
                UserDefaults.standard.removeObject(forKey: "push-qa-container-marker")
                UNUserNotificationCenter.current().removeAllDeliveredNotifications()
                result["remainingPairings"] = storage.pairings().count
                result["remainingRemovals"] = try storage.pendingPushRemovals().count
            }
            result["success"] = true
        } catch { result["success"] = false; result["error"] = String(describing: error) }
        do {
            let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("push-lifecycle-result.json")
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: path, options: .atomic)
        } catch { return "Evidence write failed" }
        return (result["success"] as? Bool == true) ? "Push QA: \(phase ?? "") complete" : "Push QA failed"
    }
}

struct PushLifecycleProbeView: View {
    @State private var result = "Push QA running"
    var body: some View { Text(result).task { result = await PushLifecycleProbe.run() } }
}
#endif
