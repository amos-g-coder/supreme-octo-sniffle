#if os(macOS)
  import SwiftUI
  import InflexClient

  struct AgentConfiguration: View {
    @Bindable var model: AppModel
    @State private var raw = ""
    @State private var name = ""
    @State private var description = ""
    @State private var connectors: [JSON] = []
    @State private var skills: [JSON] = []
    @State private var showAdvanced = false
    private var readOnly: Bool {
      model.transcript.isLive || model.selectedSession?["agent"]["type"].string == "reference"
    }
    var body: some View {
      VStack(spacing: 0) {
        HStack {
          Text("Agent Configuration").font(.headline)
          Spacer()
          Button {
            model.showConfiguration = false
          } label: {
            Image(systemName: "xmark")
          }
        }.padding(16)
        Divider()
        Form {
          Section("Model") {
            Picker("Model", selection: field(path: ["model", "name"])) {
              ForEach(model.models, id: \.recordID) {
                Text($0["name"].string ?? "").tag($0["name"].string ?? "")
              }
            }
          }
          Section("Workspace") {
            TextField("Workspace path", text: field(path: ["config", "inflex", "workspace"]))
              .accessibilityIdentifier("workspace")
          }
          Section("Instructions") {
            TextEditor(text: field(path: ["instructions"])).font(.system(size: 13)).frame(
              minHeight: 140
            ).accessibilityIdentifier("instructions")
          }
          Section("Connectors") {
            ForEach(connectors, id: \.recordID) { connector in
              let name = connector["name"].string ?? ""
              Toggle(name, isOn: collectionSelection(key: "mcp_servers", name: name))
            }
            if connectors.isEmpty {
              Text("Add connected MCP servers in Settings. CAD uses a connected server.")
                .foregroundStyle(.secondary).font(.caption)
            }
          }
          Section("Skills") {
            ForEach(skills, id: \.recordID) { skill in
              let name = skill["name"].string ?? ""
              Toggle(name, isOn: collectionSelection(key: "skills", name: name))
            }
            if skills.isEmpty {
              Text("Register skills in Settings.").foregroundStyle(.secondary).font(.caption)
            }
          }
          Section {
            DisclosureGroup("Advanced configuration", isExpanded: $showAdvanced) {
              TextEditor(text: $raw).font(.system(size: 11, design: .monospaced)).frame(
                minHeight: 200)
              Button("Apply configuration") {
                do { model.spec = try JSON.parse(raw) } catch {
                  model.error = error.localizedDescription
                }
              }
            }.onChange(of: showAdvanced) { _, value in if value { raw = model.spec.formatted() } }
          }
          Section("Save agent") {
            TextField("Name", text: $name)
            TextField("Description", text: $description, axis: .vertical)
            Button("Save Agent") {
              Task {
                await model.perform {
                  _ = try await model.client.send(
                    path: "agents", method: "POST",
                    body: .object([
                      "name": .string(name), "description": .string(description),
                      "manifest": model.spec,
                    ]))
                  model.selection = "agents"
                }
              }
            }.disabled(name.isEmpty || description.isEmpty)
          }
        }.formStyle(.grouped).disabled(readOnly)
        if readOnly {
          Text("Finish the turn to edit an inline agent. Named agents are edited in Agents.").font(
            .caption
          ).foregroundStyle(.secondary).padding(12)
        }
      }.background(Brand.sidebar).task {
        await model.perform {
          connectors = try await model.client.send(path: "mcp-servers")["data"].array
          skills = try await model.client.send(path: "skills")["data"].array
        }
      }
    }
    private func field(path: [String]) -> Binding<String> {
      Binding(
        get: { path.reduce(model.spec) { $0[$1] }.string ?? "" },
        set: { value in
          func changed(_ json: JSON, path: ArraySlice<String>) -> JSON {
            guard let head = path.first else { return .string(value) }
            var copy = json
            if head == "workspace", value.isEmpty {
              var object = copy.object
              object.removeValue(forKey: head)
              return .object(object)
            }
            copy[head] = changed(copy[head], path: path.dropFirst())
            return copy
          }
          model.spec = changed(model.spec, path: path[...])
        })
    }
    private func collectionSelection(key: String, name: String) -> Binding<Bool> {
      Binding(
        get: { model.spec[key].array.contains { $0["name"].string == name } },
        set: { enabled in
          var items = model.spec[key].array.filter { $0["name"].string != name }
          if enabled { items.append(.object(["name": .string(name)])) }
          model.spec[key] = .array(items)
        })
    }
  }
#endif
