// swift-tools-version: 6.0
import PackageDescription

var products: [Product] = [.library(name: "InflexClient", targets: ["InflexClient"])]
var targets: [Target] = [
  .target(name: "InflexClient"),
  .testTarget(name: "InflexClientTests", dependencies: ["InflexClient"]),
]
#if os(macOS)
  products.append(.executable(name: "InflexApp", targets: ["InflexApp"]))
  targets.append(
    .executableTarget(
      name: "InflexApp",
      dependencies: ["InflexClient", .product(name: "MarkdownUI", package: "swift-markdown-ui")]))
#endif

let package = Package(
  name: "InflexDesktop",
  platforms: [.macOS(.v14)],
  products: products,
  dependencies: [
    .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", exact: "2.4.1")
  ],
  targets: targets,
  swiftLanguageModes: [.v5]
)
