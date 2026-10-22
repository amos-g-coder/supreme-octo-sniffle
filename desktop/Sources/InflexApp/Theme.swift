#if os(macOS)
  import AppKit
  import SwiftUI
  import UniformTypeIdentifiers

  // Match the existing host's brand, rail, history width, and content measure.
  enum Brand {
    static let purple = Color(red: 99 / 255, green: 102 / 255, blue: 241 / 255)
    static let gradient = LinearGradient(
      colors: [
        Color(red: 178 / 255, green: 122 / 255, blue: 1),
        Color(red: 21 / 255, green: 93 / 255, blue: 252 / 255), purple,
      ], startPoint: .topLeading, endPoint: .bottomTrailing)
    static let background = Color(
      nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
          ? NSColor(srgbRed: 31 / 255, green: 31 / 255, blue: 34 / 255, alpha: 1) : .white
      })
    static let sidebar = background
    static let border = Color.primary.opacity(0.12)
  }
  struct BrandIcon: View {
    var size: CGFloat = 32
    var body: some View {
      Text("I").font(.system(size: size * 0.63, weight: .bold)).foregroundStyle(.white)
        .frame(width: size, height: size).background(
          Brand.gradient, in: RoundedRectangle(cornerRadius: size * 0.24)
        )
        .accessibilityLabel("Inflex")
    }
  }
  struct PrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
      configuration.label.padding(.horizontal, 16).padding(.vertical, 9)
        .foregroundStyle(.white).background(
          Brand.gradient.opacity(configuration.isPressed ? 0.7 : 1),
          in: RoundedRectangle(cornerRadius: 8))
    }
  }
  func mimeType(_ url: URL) -> String {
    UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
  }
  struct EmptyState: View {
    let title: String
    let detail: String
    var body: some View {
      VStack(spacing: 12) {
        BrandIcon(size: 40)
        Text(title).font(.system(size: 24, weight: .semibold))
        Text(detail).foregroundStyle(.secondary)
      }
      .multilineTextAlignment(.center).padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
#endif
