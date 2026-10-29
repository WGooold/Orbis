// Run on macOS: swift branding/orbis/build_macos_icon.swift
// Reuse the approved app master; keep the menu bar and in-app symbol transparent.
import AppKit
import Foundation

let branding = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let assets = branding.deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("packages/windows-host/src/assets", isDirectory: true)
guard let master = NSImage(contentsOf: branding.appendingPathComponent("master/orbis-app-1024.png")) else {
    fatalError("Cannot read the approved Orbis app master")
}

func render(size: Int) -> Data {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let scale = CGFloat(size) / 1024
    let tile = NSRect(x: 100 * scale, y: 100 * scale, width: 824 * scale, height: 824 * scale)
    NSBezierPath(roundedRect: tile, xRadius: 185 * scale, yRadius: 185 * scale).addClip()
    master.draw(in: tile, from: .zero, operation: .copy, fraction: 1)
    context.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

let temporary = FileManager.default.temporaryDirectory
    .appendingPathComponent("orbis-icon-\(UUID().uuidString)", isDirectory: true)
let iconset = temporary.appendingPathComponent("orbis.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }

for points in [16, 32, 128, 256, 512] {
    for density in [1, 2] {
        let suffix = density == 2 ? "@2x" : ""
        try render(size: points * density).write(
            to: iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
        )
    }
}
try render(size: 1024).write(to: assets.appendingPathComponent("orbis-macos.png"))
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["--convert", "icns", "--output", assets.appendingPathComponent("orbis.icns").path, iconset.path]
try process.run()
process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Exported macOS app PNG and ICNS to \(assets.path)")
