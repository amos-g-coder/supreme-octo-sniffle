#if os(macOS)
  import AppKit
  import SwiftUI
  import AVKit
  import PDFKit
  import InflexClient

  struct MediaPanel: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
      VStack(alignment: .leading, spacing: 16) {
        HStack {
          Text("Media and evidence").font(.title2.bold())
          Spacer()
          Button("Refresh") { Task { await model.refreshMedia() } }.accessibilityIdentifier(
            "refresh-media")
          Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
        }
        if model.artifacts.isEmpty {
          EmptyState(
            title: "Media and evidence",
            detail:
              "Video analysis frames and published exports appear here. Ask Inflex to analyze footage or edit and export a composition."
          )
        } else {
          ScrollView {
            LazyVStack(spacing: 20) {
              ForEach(model.artifacts, id: \.recordID) { artifact in
                ArtifactView(model: model, artifact: artifact)
              }
            }
          }
        }
      }.padding(24).task { await model.refreshMedia() }
    }
  }

  private struct ArtifactView: View {
    let model: AppModel
    let artifact: JSON
    @State private var local: URL?
    @State private var loading = false
    @State private var player: AVPlayer?
    @State private var downloadTask: Task<Void, Never>?
    var body: some View {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text(artifact["name"].string ?? "Artifact").font(.headline).textSelection(.enabled)
          Spacer()
          if let local {
            Button("Open") { NSWorkspace.shared.open(local) }
            Button("Save…") { save(local) }
          } else {
            Button("Preview") { downloadTask = Task { await load() } }.disabled(loading)
          }
        }
        if loading { ProgressView() }
        if let local {
          if let player {
            VideoPlayer(player: player).frame(
              height: ["wav", "mp3", "m4a"].contains(local.pathExtension.lowercased()) ? 64 : 280)
          } else if local.pathExtension.lowercased() == "pdf" {
            PDFPreview(url: local).frame(height: 360)
          } else if let image = NSImage(contentsOf: local) {
            Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 360)
          } else {
            Text("Ready to open or save.").foregroundStyle(.secondary)
          }
        }
      }.padding(16).overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Brand.border))
        .onDisappear {
          downloadTask?.cancel()
          downloadTask = nil
          player?.pause()
          player = nil
          if let local {
            try? FileManager.default.removeItem(at: local.deletingLastPathComponent())
          }
          local = nil
        }
    }
    private func load() async {
      loading = true
      defer { loading = false }
      await model.perform {
        let url = try await model.client.downloadArtifact(
          id: artifact["id"].string ?? "", name: artifact["name"].string ?? "artifact")
        local = url
        if ["mp4", "webm", "mov", "m4a", "wav", "mp3"].contains(url.pathExtension.lowercased()) {
          player = AVPlayer(url: url)
        }
      }
    }
    private func save(_ local: URL) {
      let panel = NSSavePanel()
      panel.nameFieldStringValue = local.lastPathComponent
      if panel.runModal() == .OK, let target = panel.url {
        Task {
          await model.perform {
            try await Task.detached {
              let manager = FileManager.default
              let staging = target.deletingLastPathComponent().appendingPathComponent(
                ".inflex-save-\(UUID().uuidString)")
              defer { try? manager.removeItem(at: staging) }
              try manager.copyItem(at: local, to: staging)
              if manager.fileExists(atPath: target.path) {
                _ = try manager.replaceItemAt(target, withItemAt: staging)
              } else {
                try manager.moveItem(at: staging, to: target)
              }
            }.value
          }
        }
      }
    }
  }
  private struct PDFPreview: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> PDFView {
      let view = PDFView()
      view.autoScales = true
      view.document = PDFDocument(url: url)
      return view
    }
    func updateNSView(_ view: PDFView, context: Context) {}
  }
#endif
