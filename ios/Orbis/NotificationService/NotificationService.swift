import Foundation
import UserNotifications

/// APNS-L17: enrich from local display metadata only. No network, credentials,
/// or session content are available to this extension. Timeout keeps the alert.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    private var delivery = UUID()

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        let id = UUID()
        lock.lock(); handler = contentHandler; original = request.content; delivery = id; lock.unlock()
        DispatchQueue.global(qos: .utility).async { [self] in
            guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
                finish(request.content, delivery: id); return
            }
            let directory = NotificationSourceDirectory.read(from: NotificationSourceDirectory.sharedURL())
                ?? NotificationSourceDirectory(language: Locale.preferredLanguages.first ?? "en", hosts: [:])
            if let alert = directory.alert(content.userInfo) {
                content.title = alert.title
                content.subtitle = ""
                content.body = alert.body
                content.threadIdentifier = alert.threadIdentifier
            }
            finish(content, delivery: id)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock(); let id = delivery; lock.unlock()
        finish(nil, delivery: id)
    }

    private func finish(_ content: UNNotificationContent?, delivery id: UUID) {
        lock.lock()
        guard delivery == id else { lock.unlock(); return }
        let callback = handler, best = content ?? original
        handler = nil; original = nil
        lock.unlock()
        if let callback, let best { callback(best) }
    }
}
