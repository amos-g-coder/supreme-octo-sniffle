#if os(macOS)
  import AppKit
  import SwiftUI

  @main @MainActor struct InflexApp: App {
    @NSApplicationDelegateAdaptor(ApplicationDelegate.self) private var delegate
    @State private var model = AppModel()
    @AppStorage("appearance") private var appearance = "system"

    var body: some Scene {
      Window("Inflex", id: "main") {
        RootView(model: model)
          .frame(minWidth: 960, minHeight: 640)
          .preferredColorScheme(
            appearance == "system" ? nil : appearance == "dark" ? .dark : .light
          )
          .tint(Brand.purple)
          .task {
            delegate.model = model
            await model.boot()
          }
      }
      .defaultSize(width: 1200, height: 800)
      .windowStyle(.hiddenTitleBar)
      .commands {
        CommandGroup(replacing: .newItem) {
          Button("New Chat") { model.newChat() }.keyboardShortcut("n")
          Button("Settings…") { model.selection = "settings" }.keyboardShortcut(",")
        }
        CommandMenu("Session") {
          Button("Stop") { Task { await model.cancel() } }.keyboardShortcut(".")
            .disabled(!model.transcript.isLive)
          Button("Media and Evidence") { model.mediaOpen.toggle() }.keyboardShortcut(
            "m", modifiers: [.command, .shift])
          Button("Agent Configuration") { model.showConfiguration.toggle() }.keyboardShortcut(
            "i", modifiers: [.command, .option])
        }
      }
    }
  }

  @MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    var model: AppModel?
    private var terminating = false
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
      guard !terminating, let model else { return .terminateNow }
      terminating = true
      Task {
        await model.owner.stop()
        sender.reply(toApplicationShouldTerminate: true)
      }
      return .terminateLater
    }
  }
#endif
