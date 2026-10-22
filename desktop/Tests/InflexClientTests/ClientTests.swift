import XCTest

@testable import InflexClient

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

final class ClientTests: XCTestCase {
  func testFragmentedUnicodeCRLFAndMultilineSSE() throws {
    var decoder = SSEDecoder()
    let bytes = Data(
      ": heartbeat\r\nid: 19\r\ndata: {\r\ndata: \"type\":\"model.message.delta\",\"content\":\"位置 🎬\"}\r\n\r\n"
        .utf8)
    var events: [StreamEvent] = []
    for byte in bytes { events += try decoder.append(Data([byte])) }
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(events.first?.sequence, "19")
    XCTAssertEqual(events.first?.event["content"].string, "位置 🎬")
  }
  func testSSEIgnoresHeartbeatAndDoneMarker() throws {
    var decoder = SSEDecoder()
    XCTAssertEqual(try decoder.append(Data(": ping\n\ndata: [DONE]\n\n".utf8)), [])
  }
  func testMalformedSSEThrows() {
    var decoder = SSEDecoder()
    XCTAssertThrowsError(try decoder.append(Data("data: not json\n\n".utf8)))
  }
  func testMessageStreamingFinalReplacementAndReplay() throws {
    var state = Transcript()
    state.apply(
      try event(
        #"{"type":"turn.created","id":"t0","turn_id":"turn-1","input":[{"type":"user.message","content":"Help"}]}"#,
        sequence: "1"))
    state.apply(
      try event(
        #"{"type":"model.message.delta","id":"a","thread_id":"main","content":"Hel"}"#,
        sequence: "2"))
    state.apply(
      try event(
        #"{"type":"model.message.delta","id":"a","thread_id":"main","content":"lo"}"#, sequence: "3"
      ))
    state.apply(
      try event(
        #"{"type":"model.message.delta","id":"a","thread_id":"main","content":"lo"}"#, sequence: "3"
      ))
    XCTAssertEqual(state.items.last?.text, "Hello")
    let final = try event(
      #"{"type":"model.message","id":"a","thread_id":"main","content":"Hello!"}"#, sequence: "4")
    state.apply(final)
    state.apply(final)
    XCTAssertEqual(state.items.count, 2)
    XCTAssertEqual(state.items.last?.text, "Hello!")
    state.apply(
      try event(#"{"type":"turn.done","id":"t1","state":{"status":"done"}}"#, sequence: "5"))
    XCTAssertFalse(state.isLive)
  }
  func testSequenceRestartsOnNewTurn() throws {
    var state = Transcript()
    state.apply(try event(#"{"type":"turn.created","id":"one","turn_id":"one"}"#, sequence: "1"))
    state.apply(
      try event(#"{"type":"turn.done","id":"done","state":{"status":"done"}}"#, sequence: "45"))
    state.apply(try event(#"{"type":"turn.created","id":"two","turn_id":"two"}"#, sequence: "1"))
    XCTAssertEqual(state.turnID, "two")
    XCTAssertTrue(state.isRunning)
  }
  func testPersistedMessageAndReplayDeltasDoNotDuplicateText() throws {
    var state = Transcript()
    state.apply(
      try event(#"{"type":"model.message","id":"a","thread_id":"main","content":"Complete"}"#))
    state.apply(
      try event(
        #"{"type":"model.message.delta","id":"a","thread_id":"main","content":"Complete"}"#,
        sequence: "1"))
    state.apply(
      try event(
        #"{"type":"model.message","id":"a","thread_id":"main","content":"Complete"}"#, sequence: "2"
      ))
    XCTAssertEqual(state.items.count, 1)
    XCTAssertEqual(state.items.first?.text, "Complete")
  }
  func testEditingRetainsAttachmentInputAndBranchParent() throws {
    var state = Transcript()
    state.apply(
      try event(
        #"{"type":"turn.created","id":"input","turn_id":"turn-2","previous_turn_id":"turn-1","input":[{"type":"user.message","content":[{"type":"text","text":"Inspect"},{"type":"file","name":"evidence.png","data":"data:image/png;base64,AA=="}]}]}"#
      ))
    let user = try XCTUnwrap(state.items.first)
    XCTAssertEqual(user.turnID, "turn-2")
    XCTAssertEqual(user.detail["previous_turn_id"].string, "turn-1")
    XCTAssertEqual(user.detail["input"]["content"].array.count, 2)
    state.truncate(before: user)
    XCTAssertTrue(state.items.isEmpty)
  }
  func testChildToolsCannotOverwriteParentToolsWithSameID() throws {
    var state = Transcript()
    for thread in ["main", "child"] {
      state.apply(
        StreamEvent(
          sequence: nil,
          event: .object([
            "type": .string("model.message"), "id": .string(thread), "thread_id": .string(thread),
            "tool_calls": .array([
              .object([
                "id": .string("call"),
                "function": .object(["name": .string(thread), "arguments": .string("{}")]),
              ])
            ]),
          ])))
    }
    state.apply(
      try event(
        #"{"type":"tool.response","id":"r","thread_id":"child","tool_call_id":"call","content":"child result"}"#
      ))
    XCTAssertEqual(
      state.items.first(where: { $0.id == "tool-child-call" })?.detail["response"].string,
      "child result")
    XCTAssertEqual(
      state.items.first(where: { $0.id == "tool-main-call" })?.detail["response"], .null)
  }
  func testMultipleApprovalsAndPauseResume() throws {
    var state = Transcript()
    state.apply(
      try event(
        #"{"type":"tool.approval_required","id":"approval","thread_id":"worker","tool_calls":[{"id":"one"},{"id":"two"}]}"#
      ))
    state.apply(try event(#"{"type":"turn.update","id":"pause","state":{"status":"paused"}}"#))
    XCTAssertTrue(state.isLive)
    XCTAssertFalse(state.isRunning)
    state.apply(
      try event(
        #"{"type":"user.tool_approval","id":"answer","thread_id":"worker","tool_call_id":"one","approval":{"status":"allow"}}"#
      ))
    XCTAssertEqual(state.items.filter(\.pending).count, 1)
    state.apply(try event(#"{"type":"turn.update","id":"resume","state":{"status":"running"}}"#))
    XCTAssertTrue(state.isRunning)
  }
  func testStructuredAttachmentsRefusalsAndUnknownEvents() throws {
    var state = Transcript()
    state.apply(
      try event(
        #"{"type":"turn.created","id":"i","turn_id":"t","input":[{"type":"user.message","content":[{"type":"text","text":"Inspect"},{"type":"file","name":"image.png","data":"data:image/png;base64,AA=="}]}]}"#
      ))
    state.apply(try event(#"{"type":"future.event","id":"unknown"}"#))
    state.apply(try event(#"{"type":"model.message","id":"r","refusal":"Cannot do this"}"#))
    XCTAssertEqual(state.items.first?.text, "Inspect\nAttachment: image.png")
    XCTAssertEqual(state.items.last?.text, "Cannot do this")
  }
  func testSettingsPreserveUnknownConfigurationAndIndependentAxes() throws {
    var spec = AgentSettings.make(model: "chatgpt/model")
    spec["config"]["future"] = .string("retain")
    for goal in GoalMode.allCases {
      for thinking in ThinkingTier.allCases {
        let edited = AgentSettings.changing(spec, goal: goal, thinking: thinking)
        XCTAssertEqual(edited["config"]["future"].string, "retain")
        XCTAssertEqual(edited["config"]["inflex"]["goal_mode"].string, goal.rawValue)
        XCTAssertEqual(edited["config"]["inflex"]["thinking_tier"].string, thinking.rawValue)
        XCTAssertEqual(try JSON.parse(edited.formatted()), edited)
      }
    }
  }
  func testClientRejectsRemoteURLsAndEncodesCursors() throws {
    XCTAssertThrowsError(try RuntimeClient(baseURL: XCTUnwrap(URL(string: "https://example.com"))))
    let client = try makeClient()
    let url = try client.url(path: "sessions/id/events", query: ["page_token": "a+b/=☃"])
    XCTAssertEqual(
      URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "a+b/=☃")
    XCTAssertThrowsError(try client.url(path: "https://example.com"))
    XCTAssertEqual(RuntimeClient.segment("a/b ?"), "a%2Fb%20%3F")
  }
  func testHTTPFixtureSessionStreamingApprovalCancelAndArtifact() async throws {
    guard ProcessInfo.processInfo.environment["INFLEX_TEST_URL"] != nil else {
      throw XCTSkip("Run through pnpm test:desktop to start the schema-checked runtime fixture")
    }
    let client = try makeClient()
    _ = try await client.send(
      path: "inflex/test-reset", method: "POST", body: .object(["authenticated": .bool(true)]))
    let created = try await client.send(
      path: "sessions", method: "POST",
      body: .object(["agent": .object(["spec": AgentSettings.make(model: "chatgpt/test")])]))
    let id = try XCTUnwrap(created["data"]["id"].string)
    let stream = try client.stream(
      path: "sessions/\(id)/turns",
      body: .object([
        "input": .array([
          .object(["type": .string("user.message"), "content": .string("approval")])
        ]), "stream": .bool(true),
      ]))
    var state = Transcript()
    for try await item in stream { state.apply(item) }
    XCTAssertEqual(state.status, "paused")
    let turn = try XCTUnwrap(state.turnID)
    _ = try await client.send(
      path: "sessions/\(id)/turns/\(turn)/events", method: "POST",
      body: .object([
        "events": .array([
          .object([
            "type": .string("user.tool_approval"), "thread_id": .string("main"),
            "tool_call_id": .string("call-1"), "approval": .object(["status": .string("allow")]),
          ])
        ])
      ]))
    for try await item in try client.stream(
      path: "sessions/\(id)/turns/\(turn)/subscribe", method: "GET",
      query: ["after_sequence_number": state.sequence ?? "0"])
    { state.apply(item) }
    XCTAssertEqual(state.status, "done")
    XCTAssertTrue(state.items.contains { $0.text == "Approved and completed." })
    _ = try await client.send(path: "sessions/\(id)/cancel", method: "POST", body: .object([:]))
    let artifact = try await client.downloadArtifact(id: "sample", name: "../evidence.json")
    XCTAssertEqual(artifact.lastPathComponent, "evidence.json")
    XCTAssertEqual(
      try JSON.parse(String(contentsOf: artifact, encoding: .utf8))["verified"].bool, true)
    try FileManager.default.removeItem(at: artifact.deletingLastPathComponent())
    do {
      _ = try await client.send(path: "not-found")
      XCTFail("Expected error")
    } catch ClientError.response(let code, _) { XCTAssertEqual(code, 404) }
  }
  func testHTTPStopClosesLiveStreamWithCancelledState() async throws {
    guard ProcessInfo.processInfo.environment["INFLEX_TEST_URL"] != nil else {
      throw XCTSkip("Run through pnpm test:desktop")
    }
    let client = try makeClient()
    _ = try await client.send(path: "inflex/test-reset", method: "POST", body: .object([:]))
    let created = try await client.send(
      path: "sessions", method: "POST",
      body: .object(["agent": .object(["spec": AgentSettings.make(model: "chatgpt/test")])]))
    let id = try XCTUnwrap(created["data"]["id"].string)
    var state = Transcript()
    let stream = try client.stream(
      path: "sessions/\(id)/turns",
      body: .object([
        "input": .array([
          .object(["type": .string("user.message"), "content": .string("wait for stop")])
        ])
      ]))
    for try await envelope in stream {
      state.apply(envelope)
      if envelope.event["type"].string == "model.message" {
        _ = try await client.send(path: "sessions/\(id)/cancel", method: "POST", body: .object([:]))
      }
    }
    XCTAssertEqual(state.status, "cancelled")
    XCTAssertFalse(state.isLive)
  }
  private func makeClient() throws -> RuntimeClient {
    try RuntimeClient(
      baseURL: XCTUnwrap(
        URL(
          string: ProcessInfo.processInfo.environment["INFLEX_TEST_URL"] ?? "http://127.0.0.1:18790"
        )))
  }
  private func event(_ text: String, sequence: String? = nil) throws -> StreamEvent {
    StreamEvent(sequence: sequence, event: try JSON.parse(text))
  }
}
