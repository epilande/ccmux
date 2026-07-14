// render-icon.swift — regenerate Assets.xcassets/AppIcon.appiconset PNGs from the
// ccmux orb logo. Run: swift scripts/render-icon.swift (from notifier/).
//
// No rsvg-convert / inkscape on the build machines, so we rasterize through
// NSImage, which reads SVG natively on modern macOS. The macOS icon ladder has NO
// automatic squircle mask, so the orb is inset to ~80% of the canvas on a
// transparent background to leave the margin a mac icon expects.
import AppKit
import Foundation

let notifierDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let svgURL = notifierDir.deletingLastPathComponent().appendingPathComponent("assets/logo.svg")
let iconsetDir = notifierDir.appendingPathComponent("Assets.xcassets/AppIcon.appiconset")

guard let svg = NSImage(contentsOf: svgURL) else {
    FileHandle.standardError.write(Data("cannot load SVG at \(svgURL.path)\n".utf8))
    exit(1)
}

// Fraction of the canvas the orb occupies (centered); the rest is transparent margin.
let inset = 0.80

func renderPNG(pixels: Int, to url: URL) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                              colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: pixels, height: pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let side = Double(pixels) * inset
    let origin = (Double(pixels) - side) / 2.0
    let dst = NSRect(x: origin, y: origin, width: side, height: side)
    svg.draw(in: dst, from: .zero, operation: .copy, fraction: 1.0)
    NSGraphicsContext.restoreGraphicsState()
    guard let data = rep.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write(Data("png encode failed at \(pixels)\n".utf8)); exit(1)
    }
    try! data.write(to: url)
}

// (filename, pixel dimension) — the standard 10-entry macOS ladder.
let ladder: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
for (name, px) in ladder {
    renderPNG(pixels: px, to: iconsetDir.appendingPathComponent(name))
    print("rendered \(name) (\(px)px)")
}
