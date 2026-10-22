#if os(macOS)
  import AppKit
  import InflexClient
  import Observation

  @MainActor @Observable final class AppModel {
    enum Phase { case loading, signIn, ready, failed }
    let client: RuntimeClient
    let owner = RuntimeOwner()
    let externalRuntime: Bool
    var phase = Phase.loading
    var error: String?
    var notice: String?
    var sessions: [JSON] = []
    var sessionsCursor: String?
    var models: [JSON] = []
    var selectedSession: JSON?
    var transcript = Transcript()
    var olderEvents: [JSON] = []
    var eventsCursor: String?
    var spec = AgentSettings.make(model: "")
    var savedSpec: JSON?
    var draft = ""
    var editingMessage: TranscriptItem?
    var attachments: [JSON] = []
    var selection = "chat"
    var isBusy = false
    var showConfiguration = false
    var mediaOpen = false
    var artifacts: [JSON] = []
    var pendingDelete: JSON?
    private var streamTask: Task<Void, Never>?
    private var loadTask: Task<Void, Never>?
    private var generation = UUID()

    init() {
      let environment = ProcessInfo.processInfo.environment
      let arguments = ProcessInfo.processInfo.arguments
      let override = arguments.firstIndex(of: "--runtime-url").flatMap { index in
        arguments.indices.contains(index + 1) ? arguments[index + 1] : nil
      }
      let address = override ?? "http://127.0.0.1:\(environment["PORT"] ?? "8790")"
      externalRuntime = override != nil
      // Invalid launch configuration is displayed, never silently sent to a remote host.
      do {
        guard let url = URL(string: address) else { throw ClientError.invalidURL }
        client = try RuntimeClient(
          baseURL: url, credential: environment["TRUEFORGE_API_KEY"] ?? "trueforge-standalone")
      } catch {
        // A known local URL lets the error view offer a retry after relaunch.
        do {
          guard let fallback = URL(string: "http://127.0.0.1:8790") else {
            preconditionFailure("Invalid built-in URL")
          }
          client = try RuntimeClient(baseURL: fallback)
        } catch { preconditionFailure("Invalid built-in local client: \(error)") }
        self.error = error.localizedDescription
      }
    }

    func boot() async {
      guard error == nil else {
        phase = .failed
        return
      }
      phase = .loading
      do {
        try await owner.start(client: client, external: externalRuntime)
        let credentials = try await client.send(path: "inflex/credentials")
        guard credentials["data"]["authenticated"].bool else {
          phase = .signIn
          return
        }
        models = try await client.send(path: "models")["data"].array
        guard let model = models.first(where: { $0["name"].string?.hasPrefix("chatgpt/") == true })
        else {
          phase = .signIn
          notice = "No entitled ChatGPT models were returned."
          return
        }
        spec = AgentSettings.make(model: model["name"].string ?? "")
        try await refreshSessions()
        phase = .ready
      } catch {
        self.error = error.localizedDescription
        phase = .failed
      }
    }
    func retry() async {
      error = nil
      await boot()
    }
    func signIn() async {
      await perform {
        _ = try await self.client.send(
          path: "inflex/sign-ins", method: "POST", body: .object([:]))
        self.notice = "Complete sign-in in your browser, then reload."
      }
    }
    func signOut() async {
      await perform {
        _ = try await self.client.send(path: "inflex/credentials", method: "DELETE")
        self.newChat()
        self.phase = .signIn
      }
    }
    func perform(_ operation: () async throws -> Void) async {
      do { try await operation() } catch is CancellationError {} catch {
        if !Task.isCancelled { self.error = error.localizedDescription }
      }
    }
    func refreshSessions(more: Bool = false) async throws {
      var query = ["limit": "50"]
      if more, let cursor = sessionsCursor { query["page_token"] = cursor }
      let result = try await client.send(path: "sessions", query: query)
      sessions = more ? sessions + result["data"].array : result["data"].array
      sessionsCursor = result["pagination"]["next_page_token"].string
    }
    func newChat() {
      generation = UUID()
      streamTask?.cancel()
      loadTask?.cancel()
      selectedSession = nil
      savedSpec = nil
      transcript = Transcript()
      olderEvents = []
      eventsCursor = nil
      draft = ""
      editingMessage = nil
      attachments = []
      selection = "chat"
      isBusy = false
    }
    func open(_ session: JSON) {
      streamTask?.cancel()
      loadTask?.cancel()
      generation = UUID()
      let token = generation
      selection = "chat"
      selectedSession = session
      transcript = Transcript()
      olderEvents = []
      eventsCursor = nil
      draft = ""
      editingMessage = nil
      attachments = []
      isBusy = true
      loadTask = Task {
        defer { if generation == token { isBusy = false } }
        await perform {
          let id = RuntimeClient.segment(session["id"].string ?? "")
          let detail = try await self.client.send(path: "sessions/\(id)")["data"]
          try Task.checkCancellation()
          guard self.generation == token else { return }
          self.selectedSession = detail
          if detail["agent"]["type"].string == "inline" {
            self.spec = detail["agent"]["spec"]
            self.savedSpec = self.spec
          } else {
            if let agentID = detail["agent"]["id"].string {
              let agent = try await self.client.send(
                path: "agents/\(RuntimeClient.segment(agentID))")["data"]
              try Task.checkCancellation()
              guard self.generation == token else { return }
              self.spec = agent["manifest"]
            }
            self.savedSpec = nil
          }
          try await self.loadHistory(token: token)
          if detail["last_turn_details"]["state"]["status"].string == "running"
            || detail["last_turn_details"]["state"]["status"].string == "paused",
            let turn = detail["last_turn_details"]["id"].string
          {
            self.transcript.setStatus(
              detail["last_turn_details"]["state"]["status"].string ?? "running")
            self.subscribe(turn: turn)
          }
        }
      }
    }
    private func loadHistory(token: UUID, more: Bool = false) async throws {
      guard let id = selectedSession?["id"].string else { return }
      var query = ["limit": "100"]
      if more, let eventsCursor { query["page_token"] = eventsCursor }
      let result = try await client.send(
        path: "sessions/\(RuntimeClient.segment(id))/events", query: query)
      try Task.checkCancellation()
      guard generation == token else { return }
      olderEvents = more ? olderEvents + result["data"].array : result["data"].array
      eventsCursor = result["pagination"]["next_page_token"].string
      var restored = Transcript()
      for item in olderEvents.reversed() {
        restored.apply(StreamEvent(sequence: nil, event: item["event"]))
      }
      transcript = restored
    }
    func loadOlder() async {
      // Pause the transport while rebuilding persisted history, then resume from durable events.
      let turn = transcript.turnID
      let live = transcript.isLive
      streamTask?.cancel()
      await perform { try await self.loadHistory(token: self.generation, more: true) }
      if live, let turn { subscribe(turn: turn) }
    }
    func send(previousTurn: String? = nil) async {
      guard !isBusy, !transcript.isRunning,
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
      else { return }
      isBusy = true
      let token = generation
      let message = draft
      let files = attachments
      await perform {
        if self.selectedSession == nil {
          let body: JSON = .object(["agent": .object(["spec": self.spec])])
          let created = try await self.client.send(path: "sessions", method: "POST", body: body)[
            "data"]
          guard self.generation == token else { return }
          self.selectedSession = created
          self.savedSpec = self.spec
        } else if self.selectedSession?["agent"]["type"].string == "inline",
          self.spec != self.savedSpec
        {
          try await self.updateSession(.object(["agent": .object(["spec": self.spec])]))
          guard self.generation == token else { return }
          self.savedSpec = self.spec
        }
        var content: JSON = .string(message)
        if !files.isEmpty {
          content = .array([.object(["type": .string("text"), "text": .string(message)])] + files)
        }
        var body: JSON = .object([
          "input": .array([.object(["type": .string("user.message"), "content": content])]),
          "stream": .bool(true),
        ])
        if let previousTurn { body["previous_turn_id"] = .string(previousTurn) }
        if let editing = self.editingMessage {
          body["previous_turn_id"] =
            editing.detail["previous_turn_id"].string.map(JSON.string) ?? .string("none")
        }
        guard let id = self.selectedSession?["id"].string else { return }
        let stream = try self.client.stream(
          path: "sessions/\(RuntimeClient.segment(id))/turns", body: body)
        if let editing = self.editingMessage { self.transcript.truncate(before: editing) }
        self.draft = ""
        self.editingMessage = nil
        self.attachments = []
        self.transcript.setStatus("running")
        self.consume(stream)
      }
      if generation == token { isBusy = false }
    }
    func edit(_ message: TranscriptItem) {
      guard !transcript.isLive else { return }
      let user =
        message.kind == "user"
        ? message
        : transcript.items.last(where: { $0.kind == "user" && $0.turnID == message.turnID })
      guard let user else { return }
      editingMessage = user
      let input = user.detail["input"]
      draft =
        input["content"].string
        ?? input["content"].array.filter { $0["type"].string == "text" }.map {
          $0["text"].string ?? ""
        }.joined(separator: "\n")
      attachments = input["content"].array.filter { $0["type"].string == "file" }
    }
    private func consume(_ stream: AsyncThrowingStream<StreamEvent, Error>) {
      streamTask?.cancel()
      let token = generation
      streamTask = Task {
        await perform {
          var state = self.transcript
          var published = ContinuousClock.now
          for try await envelope in stream {
            try Task.checkCancellation()
            guard self.generation == token else { return }
            state.apply(envelope)
            // Coalesce fast text deltas, but publish approvals/lifecycle immediately. No idle timer.
            if envelope.event["type"].string != "model.message.delta"
              || published.duration(to: .now) >= .milliseconds(33)
            {
              self.transcript = state
              published = .now
            }
          }
          try Task.checkCancellation()
          guard self.generation == token else { return }
          self.transcript = state
          if state.isRunning { throw ClientError.disconnected }
          try await self.refreshSessions()
          try await self.loadHistory(token: token)
        }
      }
    }
    func subscribe(turn: String) {
      guard let id = selectedSession?["id"].string else { return }
      do {
        // Replay is deduplicated against history. The sequence cursor is local to this turn.
        let query = transcript.sequence.map { ["after_sequence_number": $0] } ?? [:]
        consume(
          try client.stream(
            path:
              "sessions/\(RuntimeClient.segment(id))/turns/\(RuntimeClient.segment(turn))/subscribe",
            method: "GET", query: query))
      } catch { self.error = error.localizedDescription }
    }
    func cancel() async {
      guard let id = selectedSession?["id"].string else { return }
      await perform {
        _ = try await self.client.send(
          path: "sessions/\(RuntimeClient.segment(id))/cancel", method: "POST", body: .object([:]))
      }
    }
    func respond(
      _ item: TranscriptItem, allow: Bool? = nil, content: String = "", always: Bool = false
    ) async {
      guard let id = selectedSession?["id"].string, let turn = transcript.turnID else { return }
      let token = generation
      var input: JSON
      if item.kind == "mcp.auth_required" {
        input = .object(["type": .string("user.mcp_auth_continue")])
      } else {
        input = .object([
          "type": .string(allow == nil ? "user.tool_response" : "user.tool_approval"),
          "thread_id": .string(item.thread), "tool_call_id": item.detail["tool_call_id"],
        ])
        if let allow {
          input["approval"] = .object(["status": .string(allow ? "allow" : "deny")])
        } else {
          input["content"] = .string(content)
        }
      }
      var inputs = [input]
      let info = item.detail["tool"]["tool_info"]
      if always, let server = info["server_name"].string, let name = info["name"].string {
        inputs.insert(
          .object([
            "type": .string("user.tool_approval_policy"),
            "policies": .array([
              .object([
                "server_name": .string(server), "name": .string(name),
                "action": .object(["type": .string("allow_session")]),
              ])
            ]),
          ]), at: 0)
      }
      await perform {
        if self.transcript.isLive {
          _ = try await self.client.send(
            path:
              "sessions/\(RuntimeClient.segment(id))/turns/\(RuntimeClient.segment(turn))/events",
            method: "POST", body: .object(["events": .array(inputs)]))
          if self.generation == token { self.subscribe(turn: turn) }
        } else {
          self.consume(
            try self.client.stream(
              path: "sessions/\(RuntimeClient.segment(id))/turns",
              body: .object(["input": .array(inputs), "stream": .bool(true)])))
        }
      }
    }
    func updateSession(_ body: JSON) async throws {
      guard let id = selectedSession?["id"].string else { return }
      let token = generation
      let updated = try await client.send(
        path: "sessions/\(RuntimeClient.segment(id))", method: "PATCH", body: body)["data"]
      if generation == token, selectedSession?["id"].string == id { selectedSession = updated }
      try await refreshSessions()
    }
    func deleteSession(_ value: JSON) async {
      await perform {
        _ = try await self.client.send(
          path: "sessions/\(RuntimeClient.segment(value["id"].string ?? ""))", method: "DELETE")
        if self.selectedSession?["id"] == value["id"] { self.newChat() }
        try await self.refreshSessions()
      }
    }
    func refreshMedia() async {
      await perform {
        self.artifacts = try await self.client.send(path: "inflex/artifacts")["data"].array
      }
    }
    func attachFiles(_ urls: [URL]) async {
      await perform {
        for url in urls {
          let scoped = url.startAccessingSecurityScopedResource()
          defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
          guard let size = attributes[.size] as? NSNumber, size.intValue <= 20 * 1024 * 1024 else {
            throw ClientError.response(413, "Choose an attachment smaller than 20 MiB.")
          }
          let data = try await Task.detached { try Data(contentsOf: url) }.value
          let mime = mimeType(url)
          self.attachments.append(
            .object([
              "type": .string("file"), "name": .string(url.lastPathComponent),
              "data": .string("data:\(mime);base64,\(data.base64EncodedString())"),
            ]))
        }
      }
    }
  }
#endif
