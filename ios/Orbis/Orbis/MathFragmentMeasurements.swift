import Foundation

/// IOS-CHAT-13-R3: a recycled host restores its measured math height for exactly
/// the same render inputs, including the actual CSS viewport width.
struct MathRenderSettings: Hashable, Sendable {
    let html: String
    let size: CGFloat
    let bold: Bool
    let color: String
    let linkColor: String
    let alignment: String
}

struct MathFragmentMeasurementKey: Hashable, Sendable {
    let settings: MathRenderSettings
    let width: CGFloat
    let displayScale: CGFloat
    init(settings: MathRenderSettings, width: CGFloat, displayScale: CGFloat) {
        self.settings = settings
        // WebKit reports fractional CSS pixels; native layout uses CGFloat.
        // Compare their viewport widths at the device's actual pixel precision.
        self.width = displayScale.isFinite && displayScale > 0 ? (width * displayScale).rounded() / displayScale : width
        self.displayScale = displayScale
    }
}

final class MathFragmentMeasurements: @unchecked Sendable {
    static let shared = MathFragmentMeasurements()
    private final class Key: NSObject {
        let value: MathFragmentMeasurementKey
        init(_ value: MathFragmentMeasurementKey) { self.value = value }
        override var hash: Int { value.hashValue }
        override func isEqual(_ object: Any?) -> Bool { (object as? Key)?.value == value }
    }
    private let cache = NSCache<Key, NSNumber>()

    init() { cache.countLimit = 256; cache.totalCostLimit = 4 * 1024 * 1024 }
    func height(for key: MathFragmentMeasurementKey) -> CGFloat? {
        cache.object(forKey: Key(key)).map { CGFloat($0.doubleValue) }
    }
    func insert(_ height: CGFloat, for key: MathFragmentMeasurementKey) {
        guard height.isFinite, (1...32768).contains(height), key.width.isFinite, key.width > 0,
              key.displayScale.isFinite, key.displayScale > 0 else { return }
        cache.setObject(NSNumber(value: Double(height)), forKey: Key(key), cost: key.settings.html.utf16.count * 2 + 128)
    }
}
