import Foundation

// Unknown fields survive edits so newer runtime settings are never silently discarded.
public enum JSON: Codable, Equatable, Sendable {
  case object([String: JSON])
  case array([JSON])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  public init(from decoder: Decoder) throws {
    let value = try decoder.singleValueContainer()
    if value.decodeNil() {
      self = .null
    } else if let v = try? value.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? value.decode(String.self) {
      self = .string(v)
    } else if let v = try? value.decode(Double.self) {
      self = .number(v)
    } else if let v = try? value.decode([JSON].self) {
      self = .array(v)
    } else {
      self = .object(try value.decode([String: JSON].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var value = encoder.singleValueContainer()
    switch self {
    case .object(let v): try value.encode(v)
    case .array(let v): try value.encode(v)
    case .string(let v): try value.encode(v)
    case .number(let v): try value.encode(v)
    case .bool(let v): try value.encode(v)
    case .null: try value.encodeNil()
    }
  }

  public subscript(_ key: String) -> JSON {
    get {
      if case .object(let v) = self { return v[key] ?? .null }
      return .null
    }
    set {
      var v = object
      v[key] = newValue
      self = .object(v)
    }
  }
  public var object: [String: JSON] {
    if case .object(let v) = self { return v }
    return [:]
  }
  public var array: [JSON] {
    if case .array(let v) = self { return v }
    return []
  }
  public var string: String? {
    if case .string(let v) = self { return v }
    return nil
  }
  public var bool: Bool {
    if case .bool(let v) = self { return v }
    return false
  }
  public var recordID: String { self["id"].string ?? self["name"].string ?? "" }
  public var text: String {
    if let string { return string }
    return array.compactMap { part in
      switch part["type"].string {
      case "text": return part["text"].string
      case "refusal": return part["refusal"].string
      case "file": return part["name"].string.map { "Attachment: \($0)" }
      case "image_url": return part["image_url"]["url"].string.map { "![Image](\($0))" }
      default: return nil
      }
    }.joined(separator: "\n")
  }
  public func formatted() -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self) else { return "null" }
    return String(decoding: data, as: UTF8.self)
  }
  public static func parse(_ text: String) throws -> JSON {
    try JSONDecoder().decode(JSON.self, from: Data(text.utf8))
  }
}

public enum GoalMode: String, CaseIterable, Sendable { case standard, enhanced, advanced }
public enum ThinkingTier: String, CaseIterable, Sendable {
  case light, balanced, deep, intensive, ultra
}

public enum AgentSettings {
  public static func make(model: String) -> JSON {
    .object([
      "model": .object(["name": .string(model)]),
      "config": .object([
        "inflex": .object(["goal_mode": .string("standard"), "thinking_tier": .string("balanced")]),
        "sandbox": .object(["enabled": .bool(false)]),
      ]),
    ])
  }
  public static func changing(_ spec: JSON, goal: GoalMode, thinking: ThinkingTier) -> JSON {
    var result = spec
    var config = result["config"]
    var inflex = config["inflex"]
    inflex["goal_mode"] = .string(goal.rawValue)
    inflex["thinking_tier"] = .string(thinking.rawValue)
    config["inflex"] = inflex
    result["config"] = config
    return result
  }
}
