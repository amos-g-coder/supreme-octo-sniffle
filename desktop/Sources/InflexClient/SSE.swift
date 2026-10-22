import Foundation

public struct StreamEvent: Sendable, Equatable {
  public let sequence: String?
  public let event: JSON
  public init(sequence: String?, event: JSON) {
    self.sequence = sequence
    self.event = event
  }
}

public enum ClientError: Error, LocalizedError {
  case invalidURL
  case response(Int, String)
  case malformedStream, oversizedEvent, disconnected
  public var errorDescription: String? {
    switch self {
    case .invalidURL: return "Inflex requires a loopback runtime URL."
    case .response(let code, let text): return "Runtime error (\(code)): \(text)"
    case .malformedStream: return "The runtime sent an invalid event."
    case .oversizedEvent: return "The runtime event exceeded the 32 MiB transport limit."
    case .disconnected:
      return "The connection ended before the turn finished. Reopen the session to reconnect."
    }
  }
}

// Parse bytes, not individual UTF-8 chunks: network boundaries may split a character or CRLF.
public struct SSEDecoder {
  private var line = Data()
  private var fields: [String] = []
  private var sequence: String?
  private var afterCR = false
  private var eventBytes = 0
  private let limit = 32 * 1024 * 1024
  public init() {}
  public mutating func append(_ bytes: Data) throws -> [StreamEvent] {
    var events: [StreamEvent] = []
    for byte in bytes {
      if afterCR {
        afterCR = false
        if byte == 10 { continue }
      }
      if byte == 10 || byte == 13 {
        if let event = try finishLine() { events.append(event) }
        afterCR = byte == 13
      } else {
        line.append(byte)
        if line.count + eventBytes > limit { throw ClientError.oversizedEvent }
      }
    }
    return events
  }
  private mutating func finishLine() throws -> StreamEvent? {
    defer { line.removeAll(keepingCapacity: true) }
    if line.isEmpty {
      defer {
        fields.removeAll(keepingCapacity: true)
        eventBytes = 0
      }
      guard !fields.isEmpty else { return nil }
      let text = fields.joined(separator: "\n")
      if text == "[DONE]" { return nil }
      return StreamEvent(sequence: sequence, event: try JSON.parse(text))
    }
    let text = String(decoding: line, as: UTF8.self)
    guard !text.hasPrefix(":") else { return nil }
    let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    var value = parts.count > 1 ? String(parts[1]) : ""
    if value.hasPrefix(" ") { value.removeFirst() }
    if parts[0] == "data" {
      fields.append(value)
      eventBytes += line.count
    } else if parts[0] == "id", !value.contains("\0") {
      sequence = value
    }
    return nil
  }
}
