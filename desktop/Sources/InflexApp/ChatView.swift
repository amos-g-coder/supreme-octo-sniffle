#if os(macOS)
  import AppKit
  import SwiftUI
  import InflexClient
  import UniformTypeIdentifiers

  struct ChatView: View {
    @Bindable var model: AppModel
    @State private var pickFiles = false
    @State private var rename = false
    @State private var title = ""
    @State private var follow = true
    @FocusState private var composerFocused: Bool
    var body: some View {
      HStack(spacing: 0) {
        if model.showConfiguration {
          AgentConfiguration(model: model).frame(width: 340)
          Divider()
        }
        VStack(spacing: 0) {
          header
          if model.isBusy && model.transcript.items.isEmpty {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
          } else if model.transcript.items.isEmpty {
            EmptyState(title: "How can I help you today?", detail: "")
          } else {
            messages
          }
          composer
        }.frame(maxWidth: .infinity)
      }
      .fileImporter(
        isPresented: $pickFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
      ) { result in
        switch result {
        case .success(let urls): Task { await model.attachFiles(urls) }
        case .failure(let error): model.error = error.localizedDescription
        }
      }
      .alert("Rename chat", isPresented: $rename) {
        TextField("Title", text: $title)
        Button("Save") {
          Task {
            await model.perform {
              try await model.updateSession(.object(["title": .string(title)]))
            }
          }
        }
        Button("Cancel", role: .cancel) {}
      }
    }
    private var header: some View {
      HStack {
        Text(model.selectedSession?["title"].string ?? "New Chat").font(.headline).lineLimit(1)
        Spacer()
        if model.transcript.isLive {
          Text(model.transcript.status.capitalized).font(.caption).foregroundStyle(.secondary)
        }
        Button {
          model.showConfiguration.toggle()
        } label: {
          Image(systemName: "slider.horizontal.3")
        }.help("Agent configuration").accessibilityIdentifier("agent-configuration")
        Menu {
          Button("Rename") {
            title = model.selectedSession?["title"].string ?? ""
            rename = true
          }.disabled(model.selectedSession == nil)
          Button("Share session") {
            Task {
              await model.perform {
                try await model.updateSession(.object(["shared": .bool(true)]))
                guard let id = model.selectedSession?["id"].string else { return }
                var components = URLComponents(
                  url: model.client.baseURL, resolvingAgainstBaseURL: false)
                components?.queryItems = [
                  URLQueryItem(name: "view", value: "shared-session"),
                  URLQueryItem(name: "sessionId", value: id),
                ]
                let link = components?.url?.absoluteString ?? ""
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(link, forType: .string)
              }
            }
          }.disabled(model.selectedSession == nil)
          Button("Export transcript") { exportTranscript() }.disabled(
            model.transcript.items.isEmpty)
          Button("Reconnect") {
            if let turn = model.transcript.turnID { model.subscribe(turn: turn) }
          }.disabled(!model.transcript.isLive)
          Divider()
          Button("Clear chat") { model.newChat() }
          Button("Delete chat", role: .destructive) { model.pendingDelete = model.selectedSession }
            .disabled(model.selectedSession == nil)
        } label: {
          Image(systemName: "ellipsis")
        }.menuStyle(.borderlessButton).frame(width: 24)
      }.padding(.horizontal, 24).frame(height: 48).overlay(alignment: .bottom) { Divider() }
    }
    private var messages: some View {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 24) {
            if model.eventsCursor != nil {
              Button("Load earlier messages") { Task { await model.loadOlder() } }
            }
            ForEach(model.transcript.items) { item in
              MessageView(model: model, item: item)
            }
            Color.clear.frame(height: 1).id("bottom")
          }.frame(maxWidth: 768).padding(.horizontal, 32).padding(.vertical, 24).frame(
            maxWidth: .infinity)
        }
        .simultaneousGesture(DragGesture().onChanged { _ in follow = false })
        .onChange(of: model.transcript.items.last) { _, _ in
          if follow { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .onChange(of: model.selectedSession?["id"]) { _, _ in follow = true }
        .overlay(alignment: .bottomTrailing) {
          if !follow {
            Button {
              follow = true
              proxy.scrollTo("bottom", anchor: .bottom)
            } label: {
              Image(systemName: "arrow.down")
            }.padding(12)
          }
        }
      }.accessibilityIdentifier("transcript")
    }
    private var composer: some View {
      VStack(alignment: .leading, spacing: 10) {
        if model.editingMessage != nil {
          HStack {
            Text("Editing earlier message").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Button("Cancel edit") {
              model.editingMessage = nil
              model.draft = ""
              model.attachments = []
            }
          }
        }
        if !model.attachments.isEmpty {
          ScrollView(.horizontal) {
            HStack {
              ForEach(Array(model.attachments.enumerated()), id: \.offset) { index, file in
                HStack {
                  Image(systemName: "paperclip")
                  Text(file["name"].string ?? "Attachment").lineLimit(1)
                  Button {
                    model.attachments.remove(at: index)
                  } label: {
                    Image(systemName: "xmark")
                  }.buttonStyle(.plain)
                }.padding(6).background(Brand.sidebar, in: RoundedRectangle(cornerRadius: 6))
              }
            }
          }
        }
        TextField("Message Inflex…", text: $model.draft, axis: .vertical)
          .textFieldStyle(.plain).lineLimit(2...8).font(.system(size: 14)).focused($composerFocused)
          .onSubmit { Task { await model.send() } }.accessibilityIdentifier("composer")
        HStack(spacing: 10) {
          Button {
            pickFiles = true
          } label: {
            Image(systemName: "plus")
          }.help("Attach files").accessibilityIdentifier("attach-files")
          modePickers
          Spacer()
          if model.transcript.isLive {
            Button {
              Task { await model.cancel() }
            } label: {
              Image(systemName: "stop.fill")
            }.help("Stop").accessibilityIdentifier("stop")
          } else {
            Button {
              Task { await model.send() }
            } label: {
              Image(systemName: "arrow.up").fontWeight(.bold).frame(width: 16, height: 18)
            }
            .buttonStyle(PrimaryButton()).disabled(
              model.isBusy
                || model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                  && model.attachments.isEmpty
            )
            .keyboardShortcut(.return, modifiers: .command).accessibilityLabel("Send")
            .accessibilityIdentifier("send")
          }
        }.buttonStyle(.borderless)
      }.padding(16).background(Brand.background, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Brand.border))
        .frame(maxWidth: 768).padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 40).frame(
          maxWidth: .infinity)
    }
    private var modePickers: some View {
      Group {
        Picker(
          "Goal mode",
          selection: Binding(
            get: { model.spec["config"]["inflex"]["goal_mode"].string ?? "standard" },
            set: { value in setMode(goal: value) })
        ) {
          ForEach(GoalMode.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0.rawValue) }
        }.frame(width: 120).accessibilityIdentifier("goal-mode")
        Picker(
          "Thinking",
          selection: Binding(
            get: { model.spec["config"]["inflex"]["thinking_tier"].string ?? "balanced" },
            set: { value in setMode(thinking: value) })
        ) {
          ForEach(ThinkingTier.allCases, id: \.self) {
            Text($0.rawValue.capitalized).tag($0.rawValue)
          }
        }.frame(width: 125).accessibilityIdentifier("thinking-tier")
      }.labelsHidden().disabled(
        model.selectedSession?["agent"]["type"].string == "reference" || model.transcript.isLive)
    }
    private func setMode(goal: String? = nil, thinking: String? = nil) {
      model.spec = AgentSettings.changing(
        model.spec,
        goal: GoalMode(
          rawValue: goal ?? model.spec["config"]["inflex"]["goal_mode"].string ?? "standard")
          ?? .standard,
        thinking: ThinkingTier(
          rawValue: thinking ?? model.spec["config"]["inflex"]["thinking_tier"].string ?? "balanced"
        ) ?? .balanced)
    }
    private func exportTranscript() {
      let panel = NSSavePanel()
      panel.nameFieldStringValue = "Inflex transcript.md"
      panel.allowedContentTypes = [.plainText]
      if panel.runModal() == .OK, let url = panel.url {
        do {
          try model.transcript.items.map { "## \($0.title)\n\n\($0.text)" }.joined(
            separator: "\n\n"
          ).write(to: url, atomically: true, encoding: .utf8)
        } catch { model.error = error.localizedDescription }
      }
    }
  }
#endif
