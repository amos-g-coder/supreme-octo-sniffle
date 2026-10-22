import Foundation

public struct TranscriptItem: Identifiable, Equatable, Sendable {
  public var id: String
  public var kind: String
  public var thread: String
  public var title: String
  public var text: String
  public var detail: JSON = .null
  public var turnID: String? = nil
  public var pending = false
}

public struct Transcript: Sendable {
  public private(set) var items: [TranscriptItem] = []
  public private(set) var status = "idle"
  public private(set) var turnID: String?
  public private(set) var sequence: String?
  private var positions: [String: Int] = [:]
  private var seen = Set<String>()
  public init() {}
  public var isRunning: Bool { status == "running" }
  public var isLive: Bool { status == "running" || status == "paused" }
  public mutating func setStatus(_ value: String) { status = value }
  public mutating func truncate(before item: TranscriptItem) {
    guard let index = positions[item.id] else { return }
    items = Array(items.prefix(index))
    positions = Dictionary(
      uniqueKeysWithValues: items.enumerated().map { ($0.element.id, $0.offset) })
    sequence = nil
    status = "idle"
  }
  private mutating func upsert(_ item: TranscriptItem) {
    var item = item
    item.turnID = turnID
    if let index = positions[item.id] {
      items[index] = item
    } else {
      positions[item.id] = items.count
      items.append(item)
    }
  }
  public mutating func apply(_ envelope: StreamEvent) {
    let event = envelope.event
    let type = event["type"].string ?? ""
    let id = event["id"].string ?? UUID().uuidString
    let thread = event["thread_id"].string ?? "main"
    if type == "turn.created", let incomingTurn = event["turn_id"].string, incomingTurn != turnID {
      sequence = nil
    }
    if let incoming = envelope.sequence, let old = sequence, let a = Int(incoming),
      let b = Int(old), a <= b
    {
      return
    }
    if let incoming = envelope.sequence { sequence = incoming }
    if type == "model.message.delta", seen.contains(id) { return }
    if type != "model.message.delta", !seen.insert(id).inserted { return }
    switch type {
    case "turn.created":
      turnID = event["turn_id"].string
      sequence = envelope.sequence
      status = "running"
      for (offset, input) in event["input"].array.enumerated()
      where input["type"].string == "user.message" {
        upsert(
          TranscriptItem(
            id: "\(id)-input-\(offset)", kind: "user", thread: "main", title: "You",
            text: input["content"].text,
            detail: .object(["input": input, "previous_turn_id": event["previous_turn_id"]])))
      }
    case "turn.update", "turn.done":
      status = event["state"]["status"].string ?? "done"
      if status == "error" || status == "cancelled" {
        upsert(
          TranscriptItem(
            id: id, kind: "status", thread: thread, title: status.capitalized,
            text: event["state"]["message"].string ?? event["state"]["reason"].string ?? ""))
      }
    case "model.message", "model.message.delta":
      let content = event["content"].text + (event["refusal"].string ?? "")
      let key = "message-\(thread)-\(id)"
      let previous = positions[key].map { items[$0].text } ?? ""
      let full = type == "model.message" ? content : previous + content
      upsert(
        TranscriptItem(
          id: key, kind: "assistant", thread: thread, title: thread == "main" ? "Inflex" : thread,
          text: full, detail: event))
      for call in event["tool_calls"].array {
        guard let callID = call["id"].string else { continue }
        upsert(
          TranscriptItem(
            id: "tool-\(thread)-\(callID)", kind: "tool", thread: thread,
            title: call["function"]["name"].string ?? "Tool",
            text: call["function"]["arguments"].string ?? "", detail: call))
      }
    case "tool.response":
      let key = "tool-\(thread)-\(event["tool_call_id"].string ?? id)"
      if let index = positions[key] {
        items[index].detail["response"] = event["content"]
        items[index].pending = false
      } else {
        upsert(
          TranscriptItem(
            id: key, kind: "tool", thread: thread, title: "Tool result", text: event["content"].text
          ))
      }
    case "tool.approval_required", "tool.response_required":
      for call in event["tool_calls"].array {
        guard let callID = call["id"].string else { continue }
        let key = "action-\(thread)-\(callID)"
        let tool = positions["tool-\(thread)-\(callID)"].map { items[$0] }
        upsert(
          TranscriptItem(
            id: key, kind: type, thread: thread, title: tool?.title ?? "Tool request",
            text: tool?.text ?? "",
            detail: .object(["tool_call_id": .string(callID), "tool": tool?.detail ?? .null]),
            pending: true))
      }
    case "user.tool_approval", "user.tool_response":
      let key = "action-\(thread)-\(event["tool_call_id"].string ?? "")"
      if let index = positions[key] { items[index].pending = false }
    case "thread.created":
      upsert(
        TranscriptItem(
          id: "thread-\(thread)", kind: "thread", thread: thread,
          title: event["title"].string ?? "Subagent",
          text: event["agent_info"]["input"].string ?? "", detail: event["agent_info"],
          pending: true))
    case "thread.done":
      if let index = positions["thread-\(thread)"] {
        items[index].pending = false
        items[index].detail["state"] = event["state"]
      }
    case "mcp.auth_required":
      upsert(
        TranscriptItem(
          id: id, kind: type, thread: thread, title: "Connect account",
          text: "Complete sign-in, then continue.", detail: event, pending: true))
    case "user.mcp_auth_continue":
      for index in items.indices where items[index].kind == "mcp.auth_required" {
        items[index].pending = false
      }
    default: break
    }
  }
}
