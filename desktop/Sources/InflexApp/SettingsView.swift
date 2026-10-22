#if os(macOS)
  import Foundation
  import SwiftUI
  import InflexClient

  struct SettingsView: View {
    @Bindable var model: AppModel
    @AppStorage("appearance") private var appearance = "system"
    @State private var tab = "General"
    @State private var diagnostics = ""
    @State private var signOut = false
    private let tabs = ["General", "Connectors", "Skills", "Models", "Sandboxes", "Web Search"]
    var body: some View {
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Text("Settings").font(.title2.bold())
          Spacer()
        }.padding(24)
        HStack(spacing: 0) {
          VStack(alignment: .leading, spacing: 6) {
            ForEach(tabs, id: \.self) { name in
              Button {
                tab = name
              } label: {
                Text(name).frame(maxWidth: .infinity, alignment: .leading).padding(10)
                  .background(
                    tab == name ? Brand.purple.opacity(0.1) : .clear,
                    in: RoundedRectangle(cornerRadius: 7))
              }.buttonStyle(.plain)
            }
            Spacer()
          }.padding(16).frame(width: 170).background(Brand.sidebar)
          Divider()
          Group {
            switch tab {
            case "Connectors": ResourcePage(model: model, resource: .connectors)
            case "Skills": ResourcePage(model: model, resource: .skills)
            case "Models": ResourcePage(model: model, resource: .providers)
            case "Sandboxes": ResourcePage(model: model, resource: .sandboxes)
            case "Web Search": ResourcePage(model: model, resource: .webSearch)
            default: general
            }
          }.id(tab).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .confirmationDialog("Sign out of ChatGPT on this device?", isPresented: $signOut) {
        Button("Sign out", role: .destructive) { Task { await model.signOut() } }
      }
    }
    private var general: some View {
      Form {
        Section("Appearance") {
          Picker("Theme", selection: $appearance) {
            Text("System").tag("system")
            Text("Light").tag("light")
            Text("Dark").tag("dark")
          }
        }
        Section("Account") {
          Text("ChatGPT plan · local device")
          Button("Sign out") { signOut = true }
        }
        Section("Runtime") {
          Text("Terminal and desktop share the same sessions and permissions.").foregroundStyle(
            .secondary)
          Button("Refresh diagnostics") {
            Task {
              await model.perform {
                diagnostics = try await model.client.send(path: "inflex/diagnostics")["data"]
                  .formatted()
              }
            }
          }
          if !diagnostics.isEmpty {
            Text(diagnostics).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
          }
        }
      }.formStyle(.grouped)
    }
  }

  enum ResourceKind: String, CaseIterable {
    case agents, connectors, skills, providers, sandboxes, webSearch, schedules, environments
    var title: String {
      switch self {
      case .agents: return "Agents"
      case .connectors: return "Connectors"
      case .skills: return "Skills"
      case .providers: return "Models"
      case .sandboxes: return "Sandboxes"
      case .webSearch: return "Web Search"
      case .schedules: return "Schedules"
      case .environments: return "Environments"
      }
    }
    var path: String {
      switch self {
      case .agents: return "agents"
      case .connectors: return "settings/mcp-servers"
      case .skills: return "settings/skills"
      case .providers: return "settings/model-providers"
      case .sandboxes: return "settings/sandbox-providers"
      case .webSearch: return "settings/web-search-providers"
      case .schedules: return "schedules"
      case .environments: return "sandbox-environments"
      }
    }
    var singleton: Bool { self == .sandboxes || self == .webSearch }
    func template(spec: JSON) -> JSON {
      let empty = JSON.string("")
      switch self {
      case .agents: return .object(["name": empty, "description": empty, "manifest": spec])
      case .connectors:
        return .object([
          "manifest": .object([
            "type": .string("remote"), "name": empty, "description": empty,
            "url": .string("https://"),
          ])
        ])
      case .skills:
        return .object([
          "manifest": .object([
            "type": .string("git"), "name": empty, "description": empty,
            "url": .string("https://github.com/"), "ref": .string("main"),
          ])
        ])
      case .providers:
        return .object([
          "manifest": .object([
            "type": .string("custom"), "name": empty, "base_url": .string("https://"),
            "models": .array([]),
          ])
        ])
      case .sandboxes:
        return .object([
          "manifest": .object([
            "type": .string("daytona"), "auth": .object(["api_key": empty]),
            "exec_timeout_ms": .number(120000),
            "auto_stop_interval_in_minutes": .number(15),
            "auto_archive_interval_in_minutes": .number(60),
            "auto_delete_interval_in_minutes": .number(0),
          ])
        ])
      case .webSearch:
        return .object([
          "manifest": .object(["type": .string("parallel"), "auth": .object(["api_key": empty])])
        ])
      case .schedules:
        return .object([
          "name": empty, "agent_name": empty,
          "manifest": .object([
            "task": empty, "cron": .string("0 9 * * 1-5"),
            "timezone": .string(TimeZone.current.identifier), "status": .string("paused"),
          ]),
        ])
      case .environments:
        return .object([
          "manifest": .object([
            "name": empty, "description": empty,
            "image": .object(["type": .string("build"), "build_script": empty]),
            "resources": .object(["cpu": .number(1), "memory": .number(1), "disk": .number(3)]),
          ])
        ])
      }
    }
    func body(item: JSON) -> JSON {
      var body: JSON = .object(["manifest": item["manifest"]])
      if self == .agents { body["description"] = item["description"] }
      if self == .schedules { body["name"] = item["name"] }
      return body
    }
    func updatePath(item: JSON) -> String {
      self == .agents || self == .schedules
        ? "\(path)/\(RuntimeClient.segment(item["id"].string ?? ""))" : path
    }
  }

  struct ResourcePage: View {
    @Bindable var model: AppModel
    let resource: ResourceKind
    @State private var items: [JSON] = []
    @State private var cursor: String?
    @State private var search = ""
    @State private var editor = false
    @State private var editing: JSON?
    @State private var value = JSON.null
    @State private var raw = ""
    @State private var advanced = false
    @State private var deleting: JSON?
    @State private var detail: JSON?
    var body: some View {
      VStack(alignment: .leading, spacing: 20) {
        HStack {
          Text(resource.title).font(.title2.bold())
          Spacer()
          Button("Refresh") { Task { await load() } }
          Button(resource.singleton ? "Configure" : "Add") {
            editing = nil
            value = resource.template(spec: model.spec)
            editor = true
          }.buttonStyle(PrimaryButton())
        }
        TextField("Search \(resource.title.lowercased())", text: $search).textFieldStyle(
          .roundedBorder)
        if items.isEmpty {
          EmptyState(title: resource.title, detail: "No \(resource.title.lowercased()) configured.")
        } else {
          ScrollView {
            LazyVStack(spacing: 12) {
              ForEach(
                items.filter {
                  search.isEmpty || $0.formatted().localizedCaseInsensitiveContains(search)
                }, id: \.recordID
              ) { item in
                resourceRow(item)
              }
              if cursor != nil { Button("Load more") { Task { await load(more: true) } } }
            }
          }
        }
      }.padding(24).task(id: resource) { await load() }
        .sheet(isPresented: $editor) {
          VStack(alignment: .leading, spacing: 16) {
            Text("\(editing == nil ? "Add" : "Edit") \(resource.title)").font(.title2.bold())
            Form {
              JSONFields(value: $value)
              DisclosureGroup("Advanced configuration", isExpanded: $advanced) {
                TextEditor(text: $raw).font(.system(.caption, design: .monospaced)).frame(
                  minHeight: 180)
                Button("Apply configuration") {
                  do { value = try JSON.parse(raw) } catch {
                    model.error = error.localizedDescription
                  }
                }
              }.onChange(of: advanced) { _, expanded in if expanded { raw = value.formatted() } }
            }.formStyle(.grouped)
            HStack {
              Spacer()
              Button("Cancel") { editor = false }
              Button("Save") { Task { await save() } }.buttonStyle(PrimaryButton())
            }
          }.padding(24).frame(width: 680, height: 640)
        }
        .sheet(item: Binding(get: { detail.map(ResourceDetail.init) }, set: { detail = $0?.value }))
      { item in
        VStack(alignment: .leading) {
          Text("Details").font(.headline)
          ScrollView {
            Text(item.value.formatted()).font(.system(.caption, design: .monospaced)).textSelection(
              .enabled)
          }
          Button("Done") { detail = nil }
        }.padding(24).frame(width: 640, height: 540)
      }
        .confirmationDialog(
          "Delete this \(resource.title.lowercased()) entry?",
          isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
        ) {
          Button("Delete", role: .destructive) {
            if let deleting { Task { await remove(deleting) } }
            deleting = nil
          }
        }
    }
    private func resourceRow(_ item: JSON) -> some View {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Image(systemName: resource == .agents ? "sparkles" : "square.stack.3d.up")
            .foregroundStyle(Brand.purple)
          Text(item["name"].string ?? item["manifest"]["name"].string ?? resource.title).font(
            .headline)
          Spacer()
          if resource == .agents {
            Button("Use Agent") {
              Task {
                await model.perform {
                  let session = try await model.client.send(
                    path: "sessions", method: "POST",
                    body: .object(["agent": .object(["name": item["name"]])]))["data"]
                  model.open(session)
                }
              }
            }
          }
          Button("Edit") {
            editing = item
            value = resource.body(item: item)
            editor = true
          }
          if !resource.singleton { Button("Delete", role: .destructive) { deleting = item } }
        }
        Text(
          item["description"].string ?? item["manifest"]["description"].string ?? item["manifest"][
            "task"
          ].string ?? ""
        ).foregroundStyle(.secondary).lineLimit(3)
        HStack {
          if let authorization = item["auth_status"]["authorization_url"].string,
            let url = URL(string: authorization)
          {
            Link("Sign in", destination: url)
          }
          Button("Details") { detail = item }
          if resource == .connectors {
            Button("Tools") {
              Task {
                await model.perform {
                  detail = try await model.client.send(
                    path: "mcp-servers/\(RuntimeClient.segment(item["name"].string ?? ""))/tools")
                }
              }
            }
          }
          if resource == .schedules {
            Button("Runs") {
              Task {
                await model.perform {
                  detail = try await model.client.send(
                    path: "schedules/\(RuntimeClient.segment(item["id"].string ?? ""))/runs")
                }
              }
            }
          }
        }.buttonStyle(.borderless).font(.caption)
      }.padding(16).overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Brand.border))
    }
    private func load(more: Bool = false) async {
      await model.perform {
        let result = try await model.client.send(
          path: resource.path, query: more ? ["page_token": cursor ?? ""] : [:])
        let data = result["data"]
        let loaded = data.array.isEmpty && data != .null && resource.singleton ? [data] : data.array
        items = more ? items + loaded : loaded
        cursor = result["pagination"]["next_page_token"].string
      }
    }
    private func save() async {
      await model.perform {
        let method = editing != nil || resource.singleton ? "PUT" : "POST"
        let path = editing.map { resource.updatePath(item: $0) } ?? resource.path
        _ = try await model.client.send(path: path, method: method, body: value)
        editor = false
        await load()
      }
    }
    private func remove(_ item: JSON) async {
      await model.perform {
        let key =
          resource == .agents || resource == .schedules ? item["id"].string : item["name"].string
        _ = try await model.client.send(
          path: "\(resource.path)/\(RuntimeClient.segment(key ?? ""))", method: "DELETE")
        await load()
      }
    }
  }
  private struct ResourceDetail: Identifiable {
    let value: JSON
    var id: String { value.recordID }
    init(_ value: JSON) { self.value = value }
  }

  // Structured native controls for ordinary fields; complex arrays retain a lossless JSON editor.
  private struct JSONFields: View {
    @Binding var value: JSON
    var body: some View {
      ForEach(value.object.keys.sorted(), id: \.self) { key in
        field(key: key, binding: Binding(get: { value[key] }, set: { value[key] = $0 }))
      }
    }
    private func field(key: String, binding: Binding<JSON>) -> AnyView {
      let label = key.replacingOccurrences(of: "_", with: " ").capitalized
      switch binding.wrappedValue {
      case .object:
        return AnyView(DisclosureGroup(label) { JSONFields(value: binding) })
      case .bool:
        return AnyView(
          Toggle(
            label,
            isOn: Binding(
              get: { binding.wrappedValue.bool }, set: { binding.wrappedValue = .bool($0) })))
      case .number(let number):
        return AnyView(
          TextField(
            label,
            value: Binding(
              get: {
                if case .number(let value) = binding.wrappedValue { return value }
                return number
              }, set: { binding.wrappedValue = .number($0) }), format: .number))
      case .string:
        let text = Binding(
          get: { binding.wrappedValue.string ?? "" }, set: { binding.wrappedValue = .string($0) })
        if key.contains("key") || key == "value" { return AnyView(SecureField(label, text: text)) }
        if key == "instructions" || key == "build_script" || key == "task" {
          return AnyView(
            VStack(alignment: .leading) {
              Text(label)
              TextEditor(text: text).frame(minHeight: 120).font(.system(size: 13))
            })
        }
        return AnyView(TextField(label, text: text))
      default: return AnyView(ArrayEditor(label: label, value: binding))
      }
    }
  }
  private struct ArrayEditor: View {
    let label: String
    @Binding var value: JSON
    @State private var raw = ""
    @State private var invalid: String?
    var body: some View {
      DisclosureGroup(label) {
        TextEditor(text: $raw).font(.system(.caption, design: .monospaced)).frame(minHeight: 130)
        if let invalid { Text(invalid).foregroundStyle(.red).font(.caption) }
        Button("Apply \(label)") {
          do {
            value = try JSON.parse(raw)
            invalid = nil
          } catch { invalid = error.localizedDescription }
        }
      }.onAppear { raw = value.formatted() }
    }
  }
#endif
