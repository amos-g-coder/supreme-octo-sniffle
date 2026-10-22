#if os(macOS)
  import SwiftUI
  import InflexClient

  struct RootView: View {
    @Bindable var model: AppModel
    var body: some View {
      Group {
        switch model.phase {
        case .loading:
          VStack(spacing: 16) {
            BrandIcon(size: 40)
            ProgressView("Starting Inflex…")
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        case .signIn: signIn
        case .failed:
          VStack(spacing: 16) {
            EmptyState(
              title: "Inflex could not start", detail: model.error ?? "Runtime unavailable")
            Button("Retry") { Task { await model.retry() } }.buttonStyle(PrimaryButton()).padding(
              .bottom, 40)
          }
        case .ready: shell
        }
      }
      .background(Brand.background)
      .alert(
        "Inflex",
        isPresented: Binding(
          get: { model.error != nil && model.phase != .failed },
          set: { if !$0 { model.error = nil } })
      ) {
        Button("OK") { model.error = nil }
      } message: {
        Text(model.error ?? "")
      }
      .confirmationDialog(
        "Delete this session and its history?",
        isPresented: Binding(
          get: { model.pendingDelete != nil }, set: { if !$0 { model.pendingDelete = nil } })
      ) {
        Button("Delete", role: .destructive) {
          if let session = model.pendingDelete { Task { await model.deleteSession(session) } }
          model.pendingDelete = nil
        }
      }
    }
    private var signIn: some View {
      VStack(spacing: 18) {
        BrandIcon(size: 48)
        Text("Inflex").font(.system(size: 32, weight: .bold))
        Text("Sign in with your ChatGPT plan to use Inflex on this device.").foregroundStyle(
          .secondary)
        Button("Sign in with ChatGPT") { Task { await model.signIn() } }.buttonStyle(
          PrimaryButton()
        ).accessibilityIdentifier("sign-in")
        Button("Reload after sign-in") { Task { await model.retry() } }.accessibilityIdentifier(
          "reload-sign-in")
        if let notice = model.notice { Text(notice).font(.callout).foregroundStyle(.secondary) }
      }.padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var shell: some View {
      HStack(spacing: 0) {
        rail
        if model.selection == "chat" {
          history
          Divider()
        }
        Group {
          switch model.selection {
          case "settings": SettingsView(model: model)
          case "agents": ResourcePage(model: model, resource: .agents)
          case "schedules": ResourcePage(model: model, resource: .schedules)
          case "environments": ResourcePage(model: model, resource: .environments)
          case "sessions": sessionBrowser
          default: ChatView(model: model)
          }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .safeAreaInset(edge: .top, spacing: 0) {
        Color.clear.frame(height: 24).background(Brand.sidebar)
      }
      .overlay(alignment: .bottomTrailing) {
        Button("Media") { model.mediaOpen.toggle() }.padding(16).accessibilityIdentifier("media")
      }
      .sheet(isPresented: $model.mediaOpen) {
        MediaPanel(model: model).frame(minWidth: 560, minHeight: 500)
      }
    }
    private var rail: some View {
      VStack(spacing: 5) {
        BrandIcon(size: 20).padding(.vertical, 18)
        railButton("New Chat", icon: "square.and.pencil", selected: model.selection == "chat") {
          model.newChat()
        }
        railButton("Build Agent", icon: "person.crop.square.badge.plus") {
          model.selection = "chat"
          model.showConfiguration = true
        }
        railButton("Agents", icon: "square.grid.2x2", selected: model.selection == "agents") {
          model.selection = "agents"
        }
        railButton(
          "Sessions", icon: "bubble.left.and.bubble.right", selected: model.selection == "sessions"
        ) { model.selection = "sessions" }
        railButton("Schedules", icon: "calendar", selected: model.selection == "schedules") {
          model.selection = "schedules"
        }
        railButton("Environments", icon: "shippingbox", selected: model.selection == "environments")
        { model.selection = "environments" }
        Spacer()
        railButton("Settings", icon: "gearshape", selected: model.selection == "settings") {
          model.selection = "settings"
        }
      }.padding(.horizontal, 4).padding(.bottom, 12).frame(width: 80).background(Brand.sidebar)
        .overlay(alignment: .trailing) { Divider() }
    }
    private func railButton(
      _ title: String, icon: String, selected: Bool = false, action: @escaping () -> Void
    ) -> some View {
      Button(action: action) {
        VStack(spacing: 5) {
          Image(systemName: icon).font(.system(size: 15))
          Text(title).font(.system(size: 10)).lineLimit(1)
        }
        .frame(maxWidth: .infinity).frame(height: 52).background(
          selected ? Brand.purple.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8))
      }.buttonStyle(.plain).foregroundStyle(selected ? Brand.purple : .primary).help(title)
        .accessibilityIdentifier("nav-\(title)")
    }
    @State private var search = ""
    private var filteredSessions: [JSON] {
      model.sessions.filter {
        search.isEmpty
          || ($0["title"].string ?? "New chat").localizedCaseInsensitiveContains(search)
      }
    }
    private var history: some View {
      VStack(alignment: .leading, spacing: 12) {
        Text("Recent chats").font(.headline).padding(.top, 16)
        TextField("Search chats", text: $search).textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("session-search")
        ScrollView {
          LazyVStack(spacing: 4) {
            ForEach(filteredSessions, id: \.recordID) { session in sessionRow(session) }
            if model.sessionsCursor != nil {
              Button("Load more") {
                Task { await model.perform { try await model.refreshSessions(more: true) } }
              }
            }
          }
        }
        Button {
          Task { await model.perform { try await model.refreshSessions() } }
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
      }.padding(.horizontal, 12).padding(.bottom, 16).frame(width: 256).background(Brand.sidebar)
    }
    private func sessionRow(_ session: JSON) -> some View {
      Button {
        model.open(session)
      } label: {
        HStack {
          Text(session["title"].string ?? "New chat").lineLimit(1)
          Spacer(minLength: 0)
          if session["last_turn_details"]["state"]["status"].string == "running" {
            Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(Brand.purple)
          }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
          .background(
            model.selectedSession?["id"] == session["id"] ? Brand.purple.opacity(0.1) : .clear,
            in: RoundedRectangle(cornerRadius: 7))
      }.buttonStyle(.plain).accessibilityIdentifier("session-\(session["id"].string ?? "")")
        .contextMenu { Button("Delete", role: .destructive) { model.pendingDelete = session } }
    }
    private var sessionBrowser: some View {
      VStack(alignment: .leading, spacing: 20) {
        Text("Sessions").font(.title2.bold())
        TextField("Search chats", text: $search).textFieldStyle(.roundedBorder)
        List(filteredSessions, id: \.recordID) { session in sessionRow(session) }
        if model.sessionsCursor != nil {
          Button("Load more") {
            Task { await model.perform { try await model.refreshSessions(more: true) } }
          }
        }
      }.padding(24)
    }
  }
#endif
