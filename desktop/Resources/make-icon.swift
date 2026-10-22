import AppKit

let directory = URL(fileURLWithPath: CommandLine.arguments[1])
for (points, scale) in [
  (16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2),
] {
  let size = CGFloat(points * scale)
  let image = NSImage(size: NSSize(width: size, height: size))
  image.lockFocus()
  let rect = NSRect(x: size * 0.06, y: size * 0.06, width: size * 0.88, height: size * 0.88)
  let path = NSBezierPath(roundedRect: rect, xRadius: size * 0.2, yRadius: size * 0.2)
  NSGradient(colors: [
    NSColor(srgbRed: 0.7, green: 0.48, blue: 1, alpha: 1),
    NSColor(srgbRed: 0.08, green: 0.36, blue: 0.99, alpha: 1),
    NSColor(srgbRed: 0.39, green: 0.4, blue: 0.95, alpha: 1),
  ])?.draw(in: path, angle: -45)
  let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size * 0.6, weight: .bold), .foregroundColor: NSColor.white,
  ]
  let text = "I" as NSString
  let measure = text.size(withAttributes: attributes)
  text.draw(
    at: NSPoint(x: (size - measure.width) / 2, y: (size - measure.height) / 2),
    withAttributes: attributes)
  image.unlockFocus()
  guard let tiff = image.tiffRepresentation, let representation = NSBitmapImageRep(data: tiff),
    let png = representation.representation(using: .png, properties: [:])
  else { fatalError("Cannot create app icon") }
  try png.write(
    to: directory.appendingPathComponent("icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"))
}
